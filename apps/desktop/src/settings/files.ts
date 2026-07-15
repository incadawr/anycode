/**
 * Atomic file IO + on-disk formats for ~/.anycode/settings.json (0644) and
 * ~/.anycode/secrets.json (0600) — design slice-2.2-cut.md §1.1, frozen by task
 * 2.2.1. node-only.
 *
 * SCOPE BOUNDARY: this module owns the FILE FORMAT + atomic durability
 * (tmp+rename) + exact permissions + corrupt-quarantine only. It never
 * encrypts/decrypts a secret VALUE: the `value` of each secrets.json entry is an
 * OPAQUE ciphertext string produced/consumed by main/vault.ts (task 2.2.2, the
 * sole holder of safeStorage). files.ts treats it as bytes. Main is the ONLY
 * writer of both files (§1.1); the host reads settings.json fail-soft on boot.
 *
 * All entry points take an explicit path so main/host inject the real
 * ~/.anycode location and tests point at a scratch dir. `defaultSettingsPath()`
 * / `defaultSecretsPath()` provide the production paths.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AnycodeSettings, SecretKey } from "../shared/settings.js";
import { cloneDefaults, parseSettings } from "./schema.js";

/**
 * Repairs the `activeConnectionId` <-> non-empty `connections` invariant on
 * load (TASK.45 W12-FIX2 §2, codex W12-FIX review #2): `settingsSchema` only
 * validates FORM (both fields are independently optional/required-array), so
 * a non-empty `connections` with a missing/dangling `activeConnectionId`, or
 * an empty `connections` with a leftover `activeConnectionId`, both parse as
 * valid and would otherwise live on disk forever. The repair is deterministic
 * and mirrors the existing delete-path promotion (`handleConnectionDelete`,
 * W12-FIX §2): non-empty + missing/dangling active -> `connections[0].id`;
 * empty + active present -> active is dropped. A settings object that already
 * satisfies the invariant is returned byte-for-byte (no gratuitous promotion
 * away from an already-valid non-first active connection). In-memory only —
 * the caller decides whether/when to persist the repair.
 */
export function normalizeActiveConnection(settings: AnycodeSettings): AnycodeSettings {
  const { connections, activeConnectionId } = settings.provider;
  const first = connections[0];
  if (first === undefined) {
    return activeConnectionId === undefined ? settings : { ...settings, provider: { connections } };
  }
  const activeExists = activeConnectionId !== undefined && connections.some((c) => c.id === activeConnectionId);
  return activeExists ? settings : { ...settings, provider: { connections, activeConnectionId: first.id } };
}

/** ~/.anycode directory permissions (owner-only traversal). */
const ANYCODE_DIR_MODE = 0o700;
/** settings.json is human-editable/diffable (design §1.1). */
export const SETTINGS_FILE_MODE = 0o644;
/** secrets.json holds vault blobs — owner read/write only. */
export const SECRETS_FILE_MODE = 0o600;

/** secrets.json custody format version (frozen — design §1.1). */
export const SECRETS_FILE_VERSION = 1 as const;

export function anycodeDir(home: string = homedir()): string {
  return join(home, ".anycode");
}

export function defaultSettingsPath(home: string = homedir()): string {
  return join(anycodeDir(home), "settings.json");
}

export function defaultSecretsPath(home: string = homedir()): string {
  return join(anycodeDir(home), "secrets.json");
}

/** Minimal warn-only sink so load paths can report soft failures without a hard dep. */
export interface FileIoLogger {
  warn(message: string, err?: unknown): void;
}

// ── secrets.json v1 format (FROZEN custody shape — design §1.1) ──

/**
 * How a secret value is stored. `safeStorage` = base64 of
 * `safeStorage.encryptString` (OS keychain-bound); `plaintext` = the raw value
 * (only ever written under the `allowWeakSecretStorage` consent flag, §4). The
 * cipher is per-entry so migrating one entry between backends/machines never
 * invalidates the whole file.
 */
export type SecretCipher = "safeStorage" | "plaintext";

export interface SecretEntry {
  cipher: SecretCipher;
  /** Opaque to files.ts: base64(encryptString) for safeStorage, raw value for plaintext. */
  value: string;
}

export interface SecretsFileV1 {
  version: 1;
  /** Keyed by the vault allow-list; a missing key means "not set". */
  entries: Partial<Record<SecretKey, SecretEntry>>;
}

const secretEntrySchema = z.object({
  cipher: z.enum(["safeStorage", "plaintext"]),
  value: z.string(),
});

const secretsFileSchema: z.ZodType<SecretsFileV1> = z.object({
  version: z.literal(1),
  // record over the string key namespace; SecretKey is a subtype of string.
  entries: z.record(z.string(), secretEntrySchema),
}) as unknown as z.ZodType<SecretsFileV1>;

/** An empty vault (no entries). */
export function emptySecrets(): SecretsFileV1 {
  return { version: SECRETS_FILE_VERSION, entries: {} };
}

// ── load / save results ──

export interface LoadSettingsResult {
  settings: AnycodeSettings;
  readOnly: boolean;
  /** set when the on-disk file was unreadable/corrupt and was quarantined here. */
  corruptBackupPath?: string;
}

export interface LoadSecretsResult {
  file: SecretsFileV1;
  /** set when the on-disk secrets file was corrupt and was quarantined here. */
  corruptBackupPath?: string;
}

// ── atomic write primitives ──

/**
 * Durable write: write a sibling `*.tmp-*` then `rename` over the target (atomic
 * on the same filesystem), enforcing exact perms with an explicit chmod because
 * writeFile's mode is masked by umask.
 */
async function atomicWrite(path: string, data: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: ANYCODE_DIR_MODE });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/** Rename a bad file out of the way so it is never silently overwritten (design §2). */
async function quarantine(path: string): Promise<string | undefined> {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    await rename(path, backup);
    return backup;
  } catch {
    return undefined;
  }
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

// ── settings.json ──

/**
 * Load settings fail-soft (design §2): missing file -> defaults; corrupt JSON or
 * schema-invalid -> defaults AND the bad file is quarantined to `*.corrupt-<ts>`
 * so its bytes are preserved before the next write reuses the path. A
 * newer-than-CURRENT file yields `readOnly: true` and is NOT quarantined (it is
 * valid, just unwritable by this binary).
 */
export async function loadSettings(path: string, logger?: FileIoLogger): Promise<LoadSettingsResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (errno(err) !== "ENOENT") {
      logger?.warn(`settings: read failed for ${path}`, err);
    }
    return { settings: cloneDefaults(), readOnly: false };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    logger?.warn(`settings: corrupt JSON at ${path}; using defaults`, err);
    const corruptBackupPath = await quarantine(path);
    return { settings: cloneDefaults(), readOnly: false, ...(corruptBackupPath ? { corruptBackupPath } : {}) };
  }

  const result = parseSettings(json);
  if (result.status === "corrupt") {
    logger?.warn(`settings: schema-invalid at ${path}; using defaults`);
    const corruptBackupPath = await quarantine(path);
    return { settings: result.settings, readOnly: false, ...(corruptBackupPath ? { corruptBackupPath } : {}) };
  }
  // TASK.45 W12-FIX2 §2: repair the active<->non-empty invariant on BOTH
  // success arms (ok and read_only) in memory — a newer-version file must
  // read out healed too, without this binary ever writing it back.
  return { settings: normalizeActiveConnection(result.settings), readOnly: result.readOnly };
}

/** Atomically persist settings.json (0644). Caller is responsible for the read-only guard. */
export async function saveSettings(path: string, settings: AnycodeSettings): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(settings, null, 2)}\n`, SETTINGS_FILE_MODE);
}

// ── secrets.json ──

/**
 * Load the vault fail-soft: missing file -> empty vault; corrupt/schema-invalid
 * -> empty vault AND quarantine (every secret status becomes "not set", §2/§1.1).
 * Decryption of individual entry values is main/vault.ts's job (2.2.2).
 */
export async function loadSecrets(path: string, logger?: FileIoLogger): Promise<LoadSecretsResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (errno(err) !== "ENOENT") {
      logger?.warn(`secrets: read failed for ${path}`, err);
    }
    return { file: emptySecrets() };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    logger?.warn(`secrets: corrupt JSON at ${path}; treating vault as empty`, err);
    const corruptBackupPath = await quarantine(path);
    return { file: emptySecrets(), ...(corruptBackupPath ? { corruptBackupPath } : {}) };
  }

  const parsed = secretsFileSchema.safeParse(json);
  if (!parsed.success) {
    logger?.warn(`secrets: schema-invalid at ${path}; treating vault as empty`);
    const corruptBackupPath = await quarantine(path);
    return { file: emptySecrets(), ...(corruptBackupPath ? { corruptBackupPath } : {}) };
  }
  return { file: parsed.data };
}

/** Atomically persist secrets.json (0600). Values must already be ciphered by main/vault.ts. */
export async function saveSecrets(path: string, file: SecretsFileV1): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`, SECRETS_FILE_MODE);
}

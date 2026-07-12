/**
 * Secret custody — the SOLE holder of Electron's `safeStorage` in the whole app

 * refuse-by-default consent gate for weak storage, encrypt/decrypt, and the
 * on-disk secrets.json read/write (through the frozen settings/files.ts custody
 * format — the entry `value` it writes is opaque ciphertext). A decrypted secret
 * value is produced ONLY here and never crosses an IPC boundary (custody

 * value.
 *
 * TIER (§4, ruling §1):
 *  - !isEncryptionAvailable()                       -> "unavailable"
 *  - Linux + getSelectedStorageBackend()==="basic_text" -> "obfuscated"
 *  - otherwise (real OS keychain)                   -> "os_encrypted"
 * `getSelectedStorageBackend` is a Linux-only API, so it is platform-gated.
 *

 * `setSecret` with `weak_storage_needs_consent` unless the caller passes
 * `allowWeak` (persisted as settings.security.allowWeakSecretStorage). With
 * consent: obfuscated still encrypts via safeStorage (better than nothing;
 * honestly marked by the tier), unavailable writes cipher:"plaintext" (0600).
 *
 * DECRYPT-FAIL (§1.1, NB 2.6): a keychain-identity change (dev<->packaged, other
 * machine) makes decrypt throw; the vault treats that entry as UNSET (returns
 * undefined) and never throws to the caller — the user re-enters the key.
 */

import type { FileIoLogger, SecretEntry, SecretsFileV1 } from "../settings/files.js";
import {
  defaultSecretsPath,
  emptySecrets,
  loadSecrets,
  saveSecrets,
} from "../settings/files.js";
import type { SecretKey, SecretSource, SecretStatus, SecretTier } from "../shared/settings.js";
import { isKnownSecretKey, secretEnvFor } from "./host-env.js";

/**
 * Structural subset of Electron's `safeStorage` (injected so tests use a fake and
 * never touch the OS keychain). `getSelectedStorageBackend` is optional and
 * Linux-only — the vault only calls it after platform-gating.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface VaultDeps {
  safeStorage: SafeStorageLike;
  /** Path to secrets.json; defaults to ~/.anycode/secrets.json. */
  secretsPath?: string;
  /** Overridable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  logger?: FileIoLogger;
}

/** Result of a `setSecret`: refusal is the frozen weak-storage consent reason. */
export type SecretSetResult = { ok: true } | { ok: false; reason: "weak_storage_needs_consent" };

/**
 * OAuth token set for a provider (design slice-2.5-cut.md §3.3). Stored as ONE
 * encrypted value under the `provider.<id>.oauth` vault key — the whole blob is
 * a single `secrets.json` v1 entry `value` (the file format does NOT change; it
 * just holds a JSON string as the plaintext-before-cipher). Never crosses IPC.
 */
export interface OAuthTokenBlob {
  refreshToken: string;
  accessToken: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
}

/** Structural JSON parse of a decrypted oauth blob (bad shape / bad JSON -> undefined). */
function parseOAuthBlob(raw: string): OAuthTokenBlob | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const obj = json as Record<string, unknown>;
  if (
    typeof obj.accessToken !== "string" ||
    typeof obj.refreshToken !== "string" ||
    typeof obj.expiresAt !== "number"
  ) {
    return undefined;
  }
  return { accessToken: obj.accessToken, refreshToken: obj.refreshToken, expiresAt: obj.expiresAt };
}

export class Vault {
  private readonly safeStorage: SafeStorageLike;
  private readonly secretsPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly logger: FileIoLogger | undefined;

  constructor(deps: VaultDeps) {
    this.safeStorage = deps.safeStorage;
    this.secretsPath = deps.secretsPath ?? defaultSecretsPath();
    this.platform = deps.platform ?? process.platform;
    this.logger = deps.logger;
  }

  /** Backend storage tier of this machine (§4). */
  tier(): SecretTier {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return "unavailable";
    }
    // getSelectedStorageBackend is Linux-only; never call it on macOS/Windows.
    if (this.platform === "linux" && this.safeStorage.getSelectedStorageBackend !== undefined) {
      if (this.safeStorage.getSelectedStorageBackend() === "basic_text") {
        return "obfuscated";
      }
    }
    return "os_encrypted";
  }

  /** Load the vault file fail-soft (missing/corrupt -> empty). */
  async load(): Promise<SecretsFileV1> {
    const result = await loadSecrets(this.secretsPath, this.logger);
    return result.file;
  }

  /**

   * without consent (no write, `weak_storage_needs_consent`). With consent /
   * strong tier it writes the appropriate cipher and persists atomically.
   */
  async setSecret(
    key: SecretKey,
    value: string,
    opts: { allowWeak: boolean },
  ): Promise<SecretSetResult> {
    const tier = this.tier();
    const encoded = this.encode(value, tier, opts.allowWeak);
    if (!encoded.ok) {
      return encoded;
    }
    const file = await this.load();
    const entries = { ...file.entries, [key]: encoded.entry };
    await saveSecrets(this.secretsPath, { version: 1, entries });
    return { ok: true };
  }

  /** Removes a secret from the vault (idempotent). */
  async clearSecret(key: SecretKey): Promise<void> {
    const file = await this.load();
    if (file.entries[key] === undefined) {
      return; // nothing to clear.
    }
    const entries = { ...file.entries };
    delete entries[key];
    await saveSecrets(this.secretsPath, { version: 1, entries });
  }

  /**
   * The decrypted value that would win from the vault for this key (design §1,

   * Used by host-env composition and the readiness gate — the ONLY places a
   * decrypted value is produced, and it never leaves main.
   */
  async getSecretValue(key: SecretKey): Promise<string | undefined> {
    const file = await this.load();
    return this.decrypt(file.entries[key]);
  }

  /**
   * Reads + parses a provider's OAuth token blob (design §3.3). Fail-soft: unset,
   * undecryptable (keychain-identity change), or a corrupt/legacy value all yield
   * undefined. The ONLY place a decrypted token is produced, and it never leaves

   */
  async getOAuthTokens(providerId: string): Promise<OAuthTokenBlob | undefined> {
    const raw = await this.getSecretValue(`provider.${providerId}.oauth`);
    if (raw === undefined) {
      return undefined;
    }
    return parseOAuthBlob(raw);
  }

  /**
   * Persists a provider's OAuth token blob as ONE encrypted value under
   * `provider.<id>.oauth` (design §3.3). Same weak-storage consent gate as any
   * other secret (a weak tier without consent refuses and writes nothing).
   */
  async setOAuthTokens(
    providerId: string,
    blob: OAuthTokenBlob,
    opts: { allowWeak: boolean },
  ): Promise<SecretSetResult> {
    return this.setSecret(`provider.${providerId}.oauth`, JSON.stringify(blob), opts);
  }

  /** Removes a provider's OAuth blob (sign-out, or a revoked-refresh cleanup). */
  async clearOAuthTokens(providerId: string): Promise<void> {
    return this.clearSecret(`provider.${providerId}.oauth`);
  }

  /**
   * SecretStatus[] for the keys the renderer cares about (design §3, slice 2.5
   * multi-key). The legacy `provider.apiKey` is ALWAYS present and first
   * (byte-for-byte 2.2 — a legacy renderer still sees exactly that one status),
   * followed by every per-provider entry actually ON DISK whose id passes
   * `isKnownSecretKey` (against `catalogIds`); a stale/tampered unknown-id entry
   * is skipped, never surfaced. `set` = an entry exists on disk; `source` = what
   * wins at spawn (env override visible), computed from the effective decryptable
   * value so a present-but-undecryptable entry reads source "none" while still
   * `set`. NEVER carries a value (custody invariant).
   */
  async statuses(bootEnv: NodeJS.ProcessEnv, catalogIds: readonly string[] = []): Promise<SecretStatus[]> {
    const file = await this.load();
    const tier = this.tier();
    return this.statusKeys(file, catalogIds).map((key) => {
      const entry = file.entries[key];
      const effective = this.decrypt(entry);
      return {
        key,
        set: entry !== undefined,
        source: this.sourceFor(key, entry, effective, bootEnv),
        tier,
      } satisfies SecretStatus;
    });
  }

  /** Legacy key (always, first) + every on-disk per-provider key with a catalog id. */
  private statusKeys(file: SecretsFileV1, catalogIds: readonly string[]): SecretKey[] {
    const keys: SecretKey[] = ["provider.apiKey"];
    for (const key of Object.keys(file.entries)) {
      if (key === "provider.apiKey") {
        continue;
      }
      if (isKnownSecretKey(key, catalogIds)) {
        keys.push(key);
      }
    }
    return keys;
  }

  /** cipher/consent decision for a value at a given tier (pure). */
  private encode(value: string, tier: SecretTier, allowWeak: boolean): SecretSetResult & { entry?: SecretEntry } {
    // Strong tier: always encrypt, no questions.
    if (tier === "os_encrypted") {
      return { ok: true, entry: this.encryptEntry(value) };
    }

    if (!allowWeak) {
      return { ok: false, reason: "weak_storage_needs_consent" };
    }
    if (tier === "obfuscated") {
      // Chromium still "encrypts" with a hardcoded key — better than plaintext;
      // the obfuscated tier honestly marks what it is.
      return { ok: true, entry: this.encryptEntry(value) };
    }
    // "unavailable" (or the residual "plaintext" tier): store raw at 0600.
    return { ok: true, entry: { cipher: "plaintext", value } };
  }

  private encryptEntry(value: string): SecretEntry {
    const cipher = this.safeStorage.encryptString(value);
    return { cipher: "safeStorage", value: cipher.toString("base64") };
  }

  /** Decrypt one entry fail-soft (decrypt-fail -> undefined, never throws). */
  private decrypt(entry: SecretEntry | undefined): string | undefined {
    if (entry === undefined) {
      return undefined;
    }
    if (entry.cipher === "plaintext") {
      return entry.value;
    }
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.value, "base64"));
    } catch (err) {
      // Keychain-identity change / corrupt blob: treat as unset (§1.1, NB 2.6).
      this.logger?.warn(`vault: failed to decrypt secret; treating as unset`, err);
      return undefined;
    }
  }

  private sourceFor(
    key: SecretKey,
    entry: SecretEntry | undefined,
    effective: string | undefined,
    bootEnv: NodeJS.ProcessEnv,
  ): SecretSource {
    const envName = secretEnvFor(key);
    const fromEnv = bootEnv[envName];
    if (fromEnv !== undefined && fromEnv.trim() !== "") {
      return "env";
    }
    if (entry === undefined || effective === undefined) {
      return "none"; // no entry, or present-but-undecryptable.
    }
    return entry.cipher === "plaintext" ? "plaintext" : "vault";
  }
}

/** Empty-vault helper re-export (tests + boot pre-check). */
export { emptySecrets };

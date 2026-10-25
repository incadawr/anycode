/**
 * Per-folder workspace trust decisions (Taskana 4736, design 2.3). One small
 * file `~/.anycode/workspace-trust.json`, shared by the desktop host and the
 * CLI, shaped `{ version: 1, folders: { [canonicalPath]: { decision, hash,
 * decidedAt } } }`. Reads are fail-soft (missing or corrupt = nothing trusted);
 * writes are tmp+rename with a private 0600 mode. "Trust once" is never
 * written here — it lives in the caller's memory only.
 */

import { resolve } from "node:path";
import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";

/**
 * The only file operations the decision store needs. Narrower than
 * FileSystemPort so the Electron main process can persist a decision with a
 * four-method adapter and never pull the full core barrel.
 */
export type TrustStoreFs = Pick<FileSystemPort, "exists" | "readFile" | "writeFile" | "rename">;

export type WorkspaceTrustDecision = "trusted" | "denied";

export interface WorkspaceTrustRecord {
  decision: WorkspaceTrustDecision;
  /** Hash of the project spawn config the decision was made for. */
  hash: string;
  decidedAt: string;
}

export interface WorkspaceTrustStore {
  version: 1;
  folders: Record<string, WorkspaceTrustRecord>;
}

const recordSchema = z.object({
  decision: z.enum(["trusted", "denied"]),
  hash: z.string().min(1),
  decidedAt: z.string(),
});

const storeSchema = z.object({
  version: z.literal(1),
  folders: z.record(z.string(), recordSchema),
});

/** `~/.anycode/workspace-trust.json` for the given home directory. */
export function defaultTrustStorePath(home: string): string {
  return `${home.replace(/[/\\]+$/, "")}/.anycode/workspace-trust.json`;
}

/**
 * Canonical folder key: `path.resolve` (normalises `.`/`..`, trailing
 * separators). Symlink resolution is the host's job when it has realpath; the
 * core module stays on the FileSystemPort surface.
 */
export function canonicalWorkspacePath(workspace: string): string {
  return resolve(workspace);
}

/**
 * Canonical TRUST key (Taskana 4739): `realpathSync(resolve(workspace))` when a
 * realpath is injected and succeeds, so a symlinked workspace and its target
 * share one key. Fails SAFE, not loose: when realpath throws (missing dir,
 * EACCES, …) the key falls back to today's `resolve` behaviour — never to a
 * parent or otherwise broader key. Without an injector this is exactly
 * `canonicalWorkspacePath` (callers without realpath keep byte-identical
 * behaviour).
 */
export function canonicalWorkspaceKey(
  workspace: string,
  realpathSync?: (path: string) => string,
): string {
  const resolved = resolve(workspace);
  if (!realpathSync) return resolved;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Empty store. Used for missing and corrupt files alike (fail-soft: nothing trusted). */
export function emptyTrustStore(): WorkspaceTrustStore {
  return { version: 1, folders: {} };
}

export async function readTrustStore(
  fs: TrustStoreFs,
  storePath: string,
): Promise<WorkspaceTrustStore> {
  try {
    if (!(await fs.exists(storePath))) return emptyTrustStore();
    const parsed = storeSchema.safeParse(JSON.parse(await fs.readFile(storePath)));
    return parsed.success ? parsed.data : emptyTrustStore();
  } catch {
    return emptyTrustStore();
  }
}

/**
 * Shared atomic write: tmp + rename, private 0600 mode. Every mutation of the
 * store file goes through here so decide/forget/migrate cannot drift apart.
 */
async function writeTrustStore(
  fs: TrustStoreFs,
  storePath: string,
  store: WorkspaceTrustStore,
): Promise<void> {
  const tmpPath = `${storePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  if (fs.rename) {
    await fs.rename(tmpPath, storePath);
  } else {
    await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }
}

/**
 * Persists one decision for `workspace` (keeps other folders' records). The
 * caller is responsible for never passing `"once"` here — that is not a
 * persisted state.
 */
export async function writeTrustDecision(
  fs: TrustStoreFs,
  storePath: string,
  workspace: string,
  decision: WorkspaceTrustDecision,
  hash: string,
  decidedAt: string = new Date().toISOString(),
): Promise<void> {
  const store = await readTrustStore(fs, storePath);
  store.folders[canonicalWorkspacePath(workspace)] = { decision, hash, decidedAt };
  await writeTrustStore(fs, storePath, store);
}

/**
 * Removes ONE decision record (Taskana 4739, Settings → Permissions →
 * "Forget"). The `key` is an opaque lookup handle into the freshly-read store
 * — never resolved, never used as a file path. Returns `true` when the record
 * existed and was removed; `false` (writing NOTHING) when the store is
 * missing/corrupt (fail-soft read returned an empty store — a corrupt file is
 * never overwritten with an empty store) or the key is not an own property of
 * its `folders` (guards `__proto__`/`constructor`).
 */
export async function forgetTrustDecision(
  fs: TrustStoreFs,
  storePath: string,
  key: string,
): Promise<boolean> {
  const store = await readTrustStore(fs, storePath);
  if (!Object.prototype.hasOwnProperty.call(store.folders, key)) {
    return false;
  }
  delete store.folders[key];
  await writeTrustStore(fs, storePath, store);
  return true;
}

/**
 * One-shot migration (Taskana 4739, decision 4): rewrites legacy
 * non-realpath keys to their realpath so a symlink and its target converge on
 * one entry. Only keys whose realpath SUCCEEDS and DIFFERS are moved; on a
 * collision with an existing real-key record the one with the later
 * `decidedAt` wins and the other is dropped; unresolvable keys are left
 * untouched (S7: migration never deletes a record it cannot re-key). Writes
 * only when something actually changed (tmp+rename, 0600). A missing or
 * corrupt store migrates nothing and writes nothing.
 */
export async function migrateTrustStoreKeys(
  fs: TrustStoreFs,
  storePath: string,
  realpathSync: (path: string) => string,
): Promise<{ migrated: number }> {
  const store = await readTrustStore(fs, storePath);
  const keys = Object.keys(store.folders);
  if (keys.length === 0) {
    return { migrated: 0 };
  }
  let migrated = 0;
  let changed = false;
  for (const key of keys) {
    let realKey: string;
    try {
      realKey = realpathSync(key);
    } catch {
      continue; // Unresolvable (folder deleted, EACCES): leave the record as-is.
    }
    if (realKey === key) continue;
    changed = true;
    const legacy = store.folders[key]!;
    const existing = store.folders[realKey];
    if (existing && existing.decidedAt > legacy.decidedAt) {
      // The real-key record is newer: keep it, drop the legacy record.
      delete store.folders[key];
    } else {
      // The legacy record is newer (or equal, or no collision): it takes over
      // the real key; the legacy key disappears either way.
      delete store.folders[key];
      store.folders[realKey] = legacy;
    }
    migrated++;
  }
  if (!changed) {
    return { migrated: 0 };
  }
  await writeTrustStore(fs, storePath, store);
  return { migrated };
}

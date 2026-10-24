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

/** Empty store. Used for missing and corrupt files alike (fail-soft: nothing trusted). */
export function emptyTrustStore(): WorkspaceTrustStore {
  return { version: 1, folders: {} };
}

export async function readTrustStore(
  fs: FileSystemPort,
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
 * Persists one decision for `workspace` (keeps other folders' records). The
 * caller is responsible for never passing `"once"` here — that is not a
 * persisted state.
 */
export async function writeTrustDecision(
  fs: FileSystemPort,
  storePath: string,
  workspace: string,
  decision: WorkspaceTrustDecision,
  hash: string,
  decidedAt: string = new Date().toISOString(),
): Promise<void> {
  const store = await readTrustStore(fs, storePath);
  store.folders[canonicalWorkspacePath(workspace)] = { decision, hash, decidedAt };
  const tmpPath = `${storePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  if (fs.rename) {
    await fs.rename(tmpPath, storePath);
  } else {
    await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }
}

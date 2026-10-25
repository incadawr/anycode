/**
 * LSP config writer (Taskana 4743): read-modify-write patchers over the
 * `lspServers` ARRAY of `.anycode/config.json`, mirroring mcp/config-write.ts
 * exactly. They touch ONLY the `lspServers` array and preserve every other
 * top-level key and every unrelated array item — the file is SHARED with
 * mcpServers/hooks/telemetry/skills (util/config-file.ts header), so a naive
 * overwrite would corrupt unrelated config. Within `lspServers` itself,
 * unrelated/invalid items are ALSO left untouched (a hand-edited half-finished
 * entry must not block writes or be silently dropped by them).
 *
 * Writes are atomic (tmp + rename via util/config-file.ts) and serialized per
 * path (`serializeConfigWrite`), so a concurrent MCP patch and an LSP patch
 * targeting the same config.json cannot lose an update.
 *
 * Shape discipline (Taskana 4743 brief §2.2): `lspServers` is an ARRAY, not a
 * keyed record. A MISSING key is simply created on upsert; a PRESENT key that
 * is not an array is refused (`invalid_shape`) — we never clobber a value we
 * do not understand, and we never "repair" it into an array either.
 */

import type { FileSystemPort } from "../ports/file-system.js";
import {
  atomicWriteJson,
  isDangerousKey,
  readRawConfig,
  serializeConfigWrite,
} from "../util/config-file.js";
import { lspServerEntrySchema, type LspServerEntry } from "./config.js";

/** Result of a guarded write: `unsafe_name` rejects a reserved prototype-key name. */
export type LspUpsertResult = { ok: true } | { ok: false; reason: "unsafe_name" | "invalid_shape" };

/**
 * Upserts one server into `lspServers`: replaces the first entry with the same
 * `name`, else appends. The entry is validated with `lspServerEntrySchema`
 * first (this is the same validation the loader applies when reading back —
 * what upsert writes, the next boot can load). Refuses a dangerous `name`
 * (`__proto__`/`constructor`/`prototype`) and a non-array `lspServers` value
 * it cannot understand. Every other top-level key and every unrelated array
 * item is preserved.
 */
export async function upsertLspServer(
  fs: FileSystemPort,
  configPath: string,
  entry: LspServerEntry,
): Promise<LspUpsertResult> {
  const validated = lspServerEntrySchema.safeParse(entry);
  if (!validated.success) {
    // The caller validated at its own boundary; a failure here is a bug, and
    // refusing beats writing an entry the loader would skip with an issue.
    return { ok: false, reason: "invalid_shape" };
  }
  if (isDangerousKey(validated.data.name)) {
    return { ok: false, reason: "unsafe_name" };
  }
  return serializeWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);
    const existing = config.lspServers;
    if (existing !== undefined && !Array.isArray(existing)) {
      return { ok: false as const, reason: "invalid_shape" as const };
    }
    const list = existing !== undefined ? [...existing] : [];
    const name = validated.data.name;
    // Raw-entry replace (NOT the normalized spec): the written object keeps
    // optional `initializationOptions` and absent-args exactly as given, the
    // same shape a hand-edit would produce.
    const index = list.findIndex((item) => isNamedEntry(item, name));
    if (index >= 0) {
      list[index] = entry;
    } else {
      list.push(entry);
    }
    config.lspServers = list;
    await atomicWriteJson(fs, configPath, config);
    return { ok: true as const };
  });
}

/**
 * Deletes the first `lspServers` entry named `name`, preserving every other
 * top-level key and every unrelated array item. Deleting a missing name (or a
 * missing file, or an absent `lspServers` key) is a silent no-op — the pane's
 * Remove must be idempotent against an out-of-band edit. A non-array
 * `lspServers` is left untouched (nothing to delete; never clobber).
 */
export async function deleteLspServer(
  fs: FileSystemPort,
  configPath: string,
  name: string,
): Promise<void> {
  await serializeWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);
    const existing = config.lspServers;
    if (!Array.isArray(existing)) {
      return;
    }
    const index = existing.findIndex((item) => isNamedEntry(item, name));
    if (index < 0) {
      return;
    }
    const list = [...existing];
    list.splice(index, 1);
    config.lspServers = list;
    await atomicWriteJson(fs, configPath, config);
  });
}

/** Structural `name` check over a possibly-anything array item (never parses it). */
function isNamedEntry(item: unknown, name: string): boolean {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  return (item as { name?: unknown }).name === name;
}

// Local alias keeps the call sites symmetric with mcp/config-write.ts.
const serializeWrite = serializeConfigWrite;

/**
 * MCP config writer (design slice-P7.19-cut.md §4 W1). Read-modify-write patchers
 * over `.anycode/config.json` that touch ONLY the `mcpServers` subtree and
 * preserve every other top-level key byte-semantically — the file is SHARED with
 * the hooks/telemetry/repoMap/LSP/websearch loaders (config.ts header), so a naive
 * overwrite would corrupt unrelated config.
 *
 * Writes are atomic (tmp + rename) when the FileSystemPort supports `rename`,
 * else a direct writeFile fallback (2-space pretty JSON either way).
 *
 * Trust gate (§3, acceptance criterion): `applyMcpImport` FORCES `enabled: false`
 * on every written entry unconditionally, and strips env/header VALUES unless the
 * caller passes `includeEnvValues: true` (explicit consent). Never silently
 * enable; never silently copy secrets. Name collisions are skipped (no overwrite).
 */

import type { FileSystemPort } from "../ports/file-system.js";
import type { McpServerEntry } from "./config.js";
import type { HarnessImportCandidate, HarnessKind } from "./harness-import.js";
import {
  atomicWriteJson,
  isDangerousKey,
  isPlainObject,
  readRawConfig,
  serializeConfigWrite,
} from "../util/config-file.js";

// Local aliases keep the call sites below byte-identical to the pre-extraction
// code; the primitives themselves now live in util/config-file.ts and are shared
// with the skills `skills.disabled` patcher.
const isDangerousServerName = isDangerousKey;
const serializeWrite = serializeConfigWrite;

/** Returns the live `mcpServers` object, creating it in place if absent/invalid. */
function ensureMcpServers(config: Record<string, unknown>): Record<string, unknown> {
  const existing = config.mcpServers;
  if (isPlainObject(existing)) {
    return existing;
  }
  const fresh: Record<string, unknown> = {};
  config.mcpServers = fresh;
  return fresh;
}

/** Result of a name-guarded write: `unsafe_name` rejects a reserved-key server name (W5-FIX, finding 7). */
export type UpsertResult = { ok: true } | { ok: false; reason: "unsafe_name" };

/**
 * Upserts a single server: `mcpServers[name] = entry`, preserving every other
 * top-level key. `entry.enabled` is taken as-given (this is the add/edit/toggle
 * path — the caller controls enabled state).
 *
 * W5-FIX (finding 7): a reserved name (`__proto__`/`constructor`/`prototype`)
 * is REFUSED (`{ ok: false, reason: "unsafe_name" }`) — assigning it would hit a
 * prototype setter and either report a phantom success or pollute the prototype.
 * W5-FIX (finding 6): the whole read-modify-write runs through the per-path
 * serialization queue.
 */
export async function upsertMcpServer(
  fs: FileSystemPort,
  configPath: string,
  name: string,
  entry: McpServerEntry,
): Promise<UpsertResult> {
  if (isDangerousServerName(name)) {
    return { ok: false, reason: "unsafe_name" };
  }
  return serializeWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);
    const servers = ensureMcpServers(config);
    // Safe assignment: `name` is guaranteed not to be a prototype-setter key above.
    servers[name] = entry;
    await atomicWriteJson(fs, configPath, config);
    return { ok: true } as const;
  });
}

/**
 * Patches ONLY `mcpServers[name].enabled` — every other field of that entry
 * (command/args/cwd/env/headers/url/inheritEnv) and every other top-level key
 * are preserved byte-semantically (P7.19/F22 W3-FIX). This is the toggle
 * path's primitive: unlike `upsertMcpServer` (full-replace), it never
 * requires the caller to reconstruct the entry from a display-only view that
 * lacks secret env/header values and `cwd` — the common "flip enable" action
 * is lossless even for a server carrying secrets or a working directory.
 */
export async function setMcpServerEnabled(
  fs: FileSystemPort,
  configPath: string,
  name: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  return serializeWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);
    const servers = config.mcpServers;
    if (!isPlainObject(servers) || !Object.prototype.hasOwnProperty.call(servers, name)) {
      return { ok: false, reason: "not_found" } as const;
    }
    const existing = servers[name];
    if (!isPlainObject(existing)) {
      return { ok: false, reason: "not_found" } as const;
    }
    servers[name] = { ...existing, enabled };
    await atomicWriteJson(fs, configPath, config);
    return { ok: true } as const;
  });
}

/** Deletes `mcpServers[name]` if present, preserving every other top-level key. */
export async function deleteMcpServer(
  fs: FileSystemPort,
  configPath: string,
  name: string,
): Promise<void> {
  await serializeWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);
    const existing = config.mcpServers;
    if (isPlainObject(existing) && Object.prototype.hasOwnProperty.call(existing, name)) {
      delete existing[name];
    }
    await atomicWriteJson(fs, configPath, config);
  });
}

/** Per-candidate outcome of an `applyMcpImport` call. */
export interface ApplyMcpImportResult {
  name: string;
  harness: HarnessKind;
  applied: boolean;
  /**
   * Set when the candidate was NOT written: `exists` (target already defines
   * the name — no overwrite in v1) or `unsafe_name` (a reserved prototype key,
   * W5-FIX finding 7).
   */
  skipped?: "exists" | "unsafe_name";
}

/** Builds the entry actually written on import: enabled forced off; env/headers stripped unless consented. */
function buildImportEntry(entry: McpServerEntry, includeEnvValues: boolean): McpServerEntry {
  const written: McpServerEntry = { ...entry, enabled: false };
  if (!includeEnvValues) {
    delete written.env;
    delete written.headers;
  }
  return written;
}

/**
 * Applies import candidates into the target config. For each candidate: if the
 * name already exists in the target it is SKIPPED (`skipped: "exists"`, no
 * overwrite); otherwise it is written with `enabled: false` forced, and its
 * env/header values stripped unless `includeEnvValues` is true. All other
 * top-level keys are preserved; the whole patch is written atomically once.
 */
export async function applyMcpImport(
  fs: FileSystemPort,
  configPath: string,
  candidates: HarnessImportCandidate[],
  opts: { includeEnvValues: boolean },
): Promise<ApplyMcpImportResult[]> {
  return serializeWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);
    const servers = ensureMcpServers(config);
    const results: ApplyMcpImportResult[] = [];

    for (const candidate of candidates) {
      // W5-FIX (finding 7): never write a reserved prototype-key name.
      if (isDangerousServerName(candidate.name)) {
        results.push({ name: candidate.name, harness: candidate.harness, applied: false, skipped: "unsafe_name" });
        continue;
      }
      // Live check catches BOTH names already in the file AND names written earlier
      // in this same call (two harnesses defining the same server → first wins).
      if (Object.prototype.hasOwnProperty.call(servers, candidate.name)) {
        results.push({ name: candidate.name, harness: candidate.harness, applied: false, skipped: "exists" });
        continue;
      }
      servers[candidate.name] = buildImportEntry(candidate.entry, opts.includeEnvValues);
      results.push({ name: candidate.name, harness: candidate.harness, applied: true });
    }

    await atomicWriteJson(fs, configPath, config);
    return results;
  });
}

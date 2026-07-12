/**
 * Shared `.anycode/config.json` read-modify-write primitives (design
 * slice-P7.20-cut.md §5 W1). Extracted from `mcp/config-write.ts` so BOTH the
 * MCP config patchers and the skills `skills.disabled` patcher operate over the
 * exact same atomic-write / serialization / proto-key discipline — the file is
 * SHARED (mcpServers + hooks + telemetry + skills.disabled all live in one
 * config.json), so a naive overwrite from either subsystem would corrupt the
 * other's keys.
 *
 * Nothing here is MCP- or skills-specific: each patcher reads the whole config
 * object, mutates ONLY its own subtree, and writes the object back with every
 * other top-level key preserved value/semantically (formatting is normalized —
 * JSON is re-serialized 2-space-pretty, not byte-preserved).
 */

import { resolve } from "node:path";

import type { FileSystemPort } from "../ports/file-system.js";

export function describeConfigError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reserved keys that hit a prototype setter/built-in (`__proto__`) or a
 * built-in member (`constructor`/`prototype`) rather than defining a plain data
 * property. Assigning `obj["__proto__"] = x` reports success but serializes
 * nothing (the setter swallows it) and risks prototype pollution — reject these
 * names outright wherever a foreign-supplied string becomes an object key.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isDangerousKey(name: string): boolean {
  return DANGEROUS_KEYS.has(name);
}

/** New files that may carry secret env/header values are created private (owner rw only). */
export const PRIVATE_CONFIG_MODE = 0o600;

/**
 * Reads the raw config object. Absent (or empty) file ⇒ `{}`. A present file
 * that is not valid JSON, or whose top-level value is not an object, THROWS — we
 * must never clobber a config we cannot understand (the caller surfaces this as
 * an io_error). Preserves the parsed object's VALUES exactly (a re-serialize
 * round-trip normalizes formatting; values, not bytes, are preserved).
 */
export async function readRawConfig(
  fs: FileSystemPort,
  path: string,
): Promise<Record<string, unknown>> {
  if (!(await fs.exists(path))) {
    return {};
  }
  const raw = await fs.readFile(path);
  if (raw.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot patch ${path}: file is not valid JSON (${describeConfigError(error)})`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Cannot patch ${path}: top-level value is not a JSON object`);
  }
  return parsed;
}

/**
 * Reads the existing target's permission bits, or `undefined` if it does not
 * exist / the port can't stat mode. Best-effort — never throws.
 */
async function existingMode(fs: FileSystemPort, path: string): Promise<number | undefined> {
  try {
    if (!(await fs.exists(path))) {
      return undefined;
    }
    const st = await fs.stat(path);
    return typeof st.mode === "number" ? st.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Atomic text write (tmp + rename) with a plain-writeFile fallback. The temp file
 * is chmod'd to match the existing target's mode before the rename (never
 * DOWNGRADE a 0600 secrets-bearing config to world-readable); a freshly created
 * file is 0600. All chmod is best-effort (guarded on the optional `chmod` port
 * capability). Generalized (P7.21 W1, design §2-D8) from the JSON-only writer so
 * the subagents editor writes profile `*.md` files with the same atomicity and
 * private-mode discipline; `atomicWriteJson` is now a byte-compatible wrapper.
 */
export async function atomicWriteText(
  fs: FileSystemPort,
  path: string,
  content: string,
): Promise<void> {
  const targetMode = await existingMode(fs, path);
  const desiredMode = targetMode ?? PRIVATE_CONFIG_MODE;

  if (typeof fs.rename === "function") {
    const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Create the temp file with the desired (possibly-private) mode UP FRONT so
    // the rename can never WIDEN a 0600 secrets-bearing config — this holds even
    // on a port that implements `rename` but omits the optional `chmod`. `chmod`
    // still runs when available to pin the exact bits regardless of umask.
    await fs.writeFile(tmp, content, { mode: desiredMode });
    if (typeof fs.chmod === "function") {
      try {
        await fs.chmod(tmp, desiredMode);
      } catch {
        // best-effort — see the writeFile mode above; the tmp is already private.
      }
    }
    await fs.rename(tmp, path);
    return;
  }

  const existed = targetMode !== undefined;
  // A brand-new file is created private up front (mode option), so it lands 0600
  // even when `chmod` is unavailable; an existing file keeps its own mode.
  await fs.writeFile(path, content, existed ? undefined : { mode: PRIVATE_CONFIG_MODE });
  if (!existed && typeof fs.chmod === "function") {
    try {
      await fs.chmod(path, PRIVATE_CONFIG_MODE);
    } catch {
      // best-effort — the writeFile mode above already created it private.
    }
  }
}

/**
 * Atomic 2-space-pretty JSON write. A byte-compatible wrapper over
 * `atomicWriteText` (unchanged output for every existing MCP/skills caller).
 */
export async function atomicWriteJson(
  fs: FileSystemPort,
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await atomicWriteText(fs, path, JSON.stringify(config, null, 2));
}

/**
 * Per-path write serialization. Concurrent read-modify-write mutations to the
 * SAME config file otherwise race — each reads the pre-mutation file and the
 * last `rename` silently discards the others' updates (lost update). Every
 * mutator runs its whole read-modify-write body through this promise-chain
 * queue keyed by resolved path, so same-path mutations run strictly
 * sequentially. The queue is MODULE-GLOBAL and shared across subsystems on
 * purpose: an MCP patch and a skills-disabled patch targeting the same
 * config.json must not interleave. A failing task does not poison the queue.
 */
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Canonicalizes a config path for the serialization key so lexical aliases of
 * the SAME file share one queue: `node:path.resolve` collapses `.`/`..` and
 * normalizes separators (`/w/x/../.anycode/config.json` ⇒ `/w/.anycode/config.json`).
 * Without this the MCP patcher and the skills patcher can pick different raw
 * strings for one file and race a lost update. Resolution is lexical (sync, no
 * fs) — symlink aliases that name the same inode via different real paths are
 * NOT collapsed here (the queue has no fs handle); that residual is acceptable
 * because both known callers derive the path the same way per subsystem.
 *
 * P2-7 (ACCEPTED residual): a symlink-aliased workspace root reached via two
 * different real paths could still lose a cross-subsystem (skills + MCP)
 * concurrent update. Narrow (symlinked workspace AND concurrent writes to it) and
 * un-fixable here without a syscall — the queue key must be computed
 * synchronously while `realpath` is async fs I/O.
 */
function queueKey(path: string): string {
  return resolve(path);
}

export function serializeConfigWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = queueKey(path);
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const run = prev.then(() => task(), () => task());
  writeQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

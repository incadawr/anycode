/**
 * tgrep-backed Grep tier (Taskana 4160, microsoft/tgrep). Opt-in ONLY:
 * `ANYCODE_GREP_BACKEND=tgrep` or `settings.tools.grepBackend: "tgrep"`
 * (env > settings, default "rg"). tgrep is resolved as an ABSOLUTE path:
 * `ANYCODE_TGREP_BIN` verbatim, else one `tgrep`/`tgrep.exe` join per PATH
 * entry (executed through ExecutionPort.runBinary, argv only — no shell).
 *
 * No daemon lifecycle here (owner decision 09.09): AnyCode never runs
 * `tgrep serve`/`tgrep index`, never touches `.tgrep/`. With a live daemon
 * `tgrep` answers from the warm index; without one it transparently reads
 * the on-disk index or scans — the caller cannot tell and must not care.
 * The user runs the daemon themselves.
 *
 * Binary trust: `resolveTgrepPath` executes a PATH-resolved binary through
 * the exec port — same trust class as Bash. Acceptable for an explicit
 * opt-in flag; not enabled for anyone by default.
 *
 * Zero-match re-check (Taskana 4160 follow-up): a trigram index can be
 * STALE — files written moments ago may not be in it yet — so "no matches"
 * from tgrep is not a final answer. tools/grep.ts re-runs every zero-match
 * tgrep result through the rg tier (always a fresh scan), then the JS path
 * if rg is unavailable — a zero-match tgrep answer is never returned
 * directly; a non-zero tgrep match count is returned as-is.
 *
 * Fallback contract (card, mandatory): `undefined` — NEVER a partial result —
 * on: resolution failure, spawn error, timeout, cancellation, or any exit
 * code other than 0/1 (tgrep exit 2 = error, e.g. bad regex/daemon refused).
 * The caller (tools/grep.ts) then falls through to rg, then JS.
 *
 * Bypass-flag note: if the Grep input schema ever gains `-a/--text`,
 * `--hidden`, `--no-ignore*` or `-E/--encoding`, `tryTgrep` in tools/grep.ts
 * must return `undefined` for inputs carrying them — off-index searches are
 * the rg tier's job, and a silently trimmed tgrep answer is worse. None of
 * the five can be expressed by the schema today, so the rule holds vacuously.
 */

import { isAbsolute, posix, win32 } from "node:path";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import type { ToolContext } from "../types/tools.js";
import type { GrepInput, GrepOutput } from "./schemas.js";
import { buildTgrepArgs, shapeRgJsonOutput } from "./grep-rg.js";

/**
 * The `--version` probe is metadata, not search: it gets its own short
 * budget instead of the full tool timeout, so a wedged binary cannot burn
 * two minutes of a Grep call before the rg fallback even starts.
 */
const TGREP_VERSION_TIMEOUT_MS = 5_000;

/**
 * The tgrep SEARCH gets half the tool budget (Taskana 4160 cross-review F3).
 * tools/grep.ts may re-run a zero-match answer through rg on the SAME call,
 * and the dispatcher kills the call at DEFAULT_TOOL_TIMEOUT_MS + grace: two
 * full-budget spawns in sequence could exceed it and turn a correct answer
 * into `timed_out`. Half for tgrep leaves the rg re-check the remainder.
 */
export const TGREP_SEARCH_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS / 2;

/**
 * Successful `--version` probes, keyed by resolved binary path, kept for the
 * process lifetime (4160 follow-up: the probe used to run on EVERY opt-in
 * call — one extra spawn per Grep, and an aborted call could kill it). A
 * FAILED probe is never cached: tgrep can appear mid-session (user installs
 * it, starts serving), and caching a miss would pin "no tgrep" for the whole
 * process. Cost asymmetry: a stale SUCCESS cache wastes one spawn per call
 * (bounded: a search that keeps timing out suspends the tier, see
 * `TGREP_SEARCH_TIMEOUT_SUSPEND_AFTER`); a stale MISS cache would disable the
 * tier outright.
 */
const tgrepProbeCache = new Map<string, Promise<string | undefined>>();

/**
 * Consecutive search TIMEOUTS per resolved binary (Taskana 4160 cross-review
 * F2). A healthy probe is cached, but a binary whose searches keep hanging
 * (no daemon and a huge corpus, say) would otherwise cost a full tool-timeout
 * spawn on EVERY Grep call before the rg fallback answers. After this many
 * consecutive timeouts the tier is suspended for the process; any completed
 * search resets the count.
 */
const TGREP_SEARCH_TIMEOUT_SUSPEND_AFTER = 2;
const tgrepSearchTimeouts = new Map<string, number>();

/** Test-only: clears the memoized probe outcomes so a fresh probe run can be exercised. */
export function __resetTgrepPathCacheForTests(): void {
  tgrepProbeCache.clear();
  tgrepSearchTimeouts.clear();
}

/**
 * Absolute tgrep candidates, mirroring `candidatesFromPath` in the codex
 * binary resolver (apps/desktop/src/main/codex-binary.ts): `ANYCODE_TGREP_BIN`
 * verbatim, else one `join(entry, "tgrep"|"tgrep.exe")` per PATH entry
 * (`;` separator on win32). A bare `tgrep` name is NEVER used: on Windows
 * CreateProcess resolves a bare name against the CURRENT DIRECTORY before
 * PATH (POSIX execvp does not), so a planted `.\tgrep.exe` in cwd would win —
 * the same reason the codex resolver rejects non-absolute paths.
 */
export function tgrepPathCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const explicit = env.ANYCODE_TGREP_BIN?.trim();
  if (explicit) return [explicit];
  const pathEnv = env.PATH;
  if (pathEnv === undefined || pathEnv.trim() === "") return [];
  const separator = platform === "win32" ? ";" : ":";
  const fileName = platform === "win32" ? "tgrep.exe" : "tgrep";
  const join = platform === "win32" ? win32.join : posix.join;
  return pathEnv
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .map((segment) => join(segment, fileName));
}

/**
 * One `--version` probe with the call's abort signal and the probe's own
 * short timeout. The in-flight promise is shared through `tgrepProbeCache`
 * (concurrent calls dedupe); only a SUCCESS outlives the call — a failure
 * (spawn error, non-zero exit, timeout, cancellation, throw) deletes its
 * cache entry so the next call re-probes.
 */
function probeTgrepVersion(
  runBinary: NonNullable<ToolContext["ports"]["exec"]["runBinary"]>,
  file: string,
  abortSignal: AbortSignal | undefined,
): Promise<string | undefined> {
  const attempt = Promise.resolve(
    runBinary({
      file,
      args: ["--version"],
      timeoutMs: TGREP_VERSION_TIMEOUT_MS,
      abortSignal,
    }),
  )
    .then((result): string | undefined =>
      result.status === "completed" && result.exitCode === 0 ? file : undefined,
    )
    .catch(() => undefined);
  tgrepProbeCache.set(file, attempt);
  void attempt.then((outcome) => {
    if (outcome === undefined) tgrepProbeCache.delete(file);
  });
  return attempt;
}

/**
 * Resolves a usable tgrep executable, or `undefined` when none exists.
 * Walks `tgrepPathCandidates` in order and probes each; a non-absolute
 * candidate is refused outright (never probed — see
 * `tgrepPathCandidates`), and an explicit `ANYCODE_TGREP_BIN` that is not
 * absolute therefore disables the tier instead of leaking to PATH lookup.
 *
 * Never throws: any rejection from the exec port maps to `undefined` so the
 * caller can silently fall back to rg.
 */
export async function resolveTgrepPath(
  exec: ToolContext["ports"]["exec"],
  env: NodeJS.ProcessEnv = process.env,
  opts: { abortSignal?: AbortSignal; platform?: NodeJS.Platform } = {},
): Promise<string | undefined> {
  try {
    const runBinary = exec.runBinary;
    if (!runBinary) return undefined;

    const platform = opts.platform ?? process.platform;
    const isAbsolutePath = (value: string): boolean =>
      platform === "win32" ? win32.isAbsolute(value) : isAbsolute(value);

    for (const candidate of tgrepPathCandidates(env, platform)) {
      if (!isAbsolutePath(candidate)) continue; // non-absolute is refused, never executed (cwd-hijack guard)

      const inFlight = tgrepProbeCache.get(candidate);
      if (inFlight) {
        const hit = await inFlight;
        if (hit !== undefined) return hit;
        continue; // failed probe (never cached) or a concurrent call's abort — try the next entry
      }

      const probed = await probeTgrepVersion(runBinary, candidate, opts.abortSignal);
      if (probed !== undefined) return probed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs one Grep search through tgrep's rg-compatible `--json` output.
 * Mirrors `searchWithRipgrep` but with the tgrep fallback contract: every
 * failure mode (spawn error, timeout, cancellation, exit code ≥ 2 — tgrep's
 * error code, e.g. bad regex or a daemon that refused the query) returns
 * `undefined` instead of throwing, so tools/grep.ts falls through to rg and
 * then the JS path. Exit code 1 is a normal "no matches" answer, not an
 * error — the ZERO-match re-check happens one level up (tools/grep.ts), not
 * here. NEVER a partial/trimmed result on this boundary.
 */
export async function searchWithTgrep(
  input: GrepInput,
  ctx: ToolContext,
  tgrepPath: string,
  root: string,
  isDirectory: boolean,
): Promise<GrepOutput | undefined> {
  const runBinary = ctx.ports.exec.runBinary;
  if (!runBinary) return undefined;

  if ((tgrepSearchTimeouts.get(tgrepPath) ?? 0) >= TGREP_SEARCH_TIMEOUT_SUSPEND_AFTER) return undefined;

  const args = buildTgrepArgs(input, root, isDirectory);
  let result;
  try {
    result = await runBinary({
      file: tgrepPath,
      args,
      cwd: ctx.cwd,
      timeoutMs: TGREP_SEARCH_TIMEOUT_MS,
      abortSignal: ctx.abortSignal,
    });
  } catch {
    return undefined;
  }

  if (result.status === "timed_out") {
    tgrepSearchTimeouts.set(tgrepPath, (tgrepSearchTimeouts.get(tgrepPath) ?? 0) + 1);
    return undefined;
  }
  if (result.status === "spawn_error" || result.status === "cancelled") {
    return undefined;
  }
  tgrepSearchTimeouts.delete(tgrepPath);
  if (result.status === "failed" && result.exitCode !== 0 && result.exitCode !== 1) {
    return undefined; // exit 2 = tgrep error (bad regex, daemon refused); anything but 0/1 is not ours to interpret
  }
  // A capped stream is a TRIMMED answer (Taskana 4160 cross-review F1): never
  // final; the rg tier answers instead (rg's own cap is the default path's
  // long-standing behaviour — falling to the unbounded JS walk on every broad
  // search in a large repo would be a regression, so rg keeps it).
  if (result.stdoutTruncated) return undefined;

  return shapeRgJsonOutput(input, result.stdout);
}

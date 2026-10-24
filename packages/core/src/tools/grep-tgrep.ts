/**
 * tgrep-backed Grep tier (Taskana 4160, microsoft/tgrep). Opt-in ONLY:
 * `ANYCODE_GREP_BACKEND=tgrep` or `settings.tools.grepBackend: "tgrep"`
 * (env > settings, default "rg"). tgrep is resolved from PATH via
 * `which`-style probing of `ANYCODE_TGREP_BIN` (absolute override) then
 * "tgrep" (executed through ExecutionPort.runBinary, argv only — no shell).
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

import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import type { ToolContext } from "../types/tools.js";
import type { GrepInput, GrepOutput } from "./schemas.js";
import { buildTgrepArgs, shapeRgJsonOutput } from "./grep-rg.js";

export type TgrepImporter = (port: ToolContext["ports"]["exec"]) => Promise<string | undefined>;

/**
 * Resolves a usable tgrep executable, or `undefined` when none exists.
 *
 * Deliberately NOT memoized (unlike resolveRgPath's rgPathCache): the tgrep
 * daemon/binary can appear mid-session (user installs it, starts serving),
 * and the `--version` probe is cheap; caching a miss would pin "no tgrep"
 * for the whole process lifetime on a first-call race. The per-call probe
 * cost is one short-lived process spawn on the tgrep-selected path only.
 *
 * Never throws: any rejection from the exec port maps to `undefined` so the
 * caller can silently fall back to rg.
 */
export async function resolveTgrepPath(
  exec: ToolContext["ports"]["exec"],
  explicitBin?: string,
): Promise<string | undefined> {
  try {
    const runBinary = exec.runBinary;
    if (!runBinary) return undefined;

    const file = explicitBin ?? "tgrep";
    const result = await runBinary({
      file,
      args: ["--version"],
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
    if (result.status === "completed" && result.exitCode === 0) return file;
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
 * error. NEVER a partial/trimmed result on this boundary.
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

  const args = buildTgrepArgs(input, root, isDirectory);
  let result;
  try {
    result = await runBinary({
      file: tgrepPath,
      args,
      cwd: ctx.cwd,
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      abortSignal: ctx.abortSignal,
    });
  } catch {
    return undefined;
  }

  if (result.status === "spawn_error" || result.status === "timed_out" || result.status === "cancelled") {
    return undefined;
  }
  if (result.status === "failed" && result.exitCode !== 0 && result.exitCode !== 1) {
    return undefined; // exit 2 = tgrep error (bad regex, daemon refused); anything but 0/1 is not ours to interpret
  }

  return shapeRgJsonOutput(input, result.stdout);
}

/**
 * ripgrep-backed Grep implementation. `resolveRgPath` lazily imports
 * `@vscode/ripgrep` (a standalone-binary, non-ABI dependency — no
 * electron-rebuild) and memoizes the result for the process lifetime;
 * import failure caches `undefined` so every subsequent call short-circuits
 * to the JS fallback in tools/grep.ts without re-attempting the import.
 *
 * Spawning goes through `ExecutionPort.runBinary` (argv, no shell) — the
 * regex pattern and path are attacker-influenced-adjacent (model-proposed
 * tool input), so a shell string would be a quoting/injection surface.
 *
 * Always requests `--json` regardless of output_mode (rather than rg's own
 * `-l`/`--count` text formats): one NDJSON parser covers all three
 * GrepOutput shapes, matches the JS backend's "lines matched, not raw
 * occurrences" counting semantics exactly, and is what the fixture-based
 * unit tests below exercise.
 */

import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import type { ToolContext } from "../types/tools.js";
import type { GrepInput, GrepMatch, GrepOutput } from "./schemas.js";

export type RgImporter = () => Promise<{ rgPath: string }>;

const defaultImporter: RgImporter = () => import("@vscode/ripgrep");

let rgPathCache: Promise<string | undefined> | undefined;

/**
 * Memoized lazy resolver: first call imports @vscode/ripgrep, later calls reuse
 * the cached outcome (path or undefined on failure).
 *
 * In a packaged Electron app the resolved rg binary lives inside `app.asar`,
 * which cannot be exec'd (the archive is not a real directory). electron-builder
 * unpacks the binary to a sibling `app.asar.unpacked` tree (asarUnpack glob), so
 * the rg path is rewritten `app.asar` -> `app.asar.unpacked` to point at the
 * real on-disk file. The substring never occurs outside packaged Electron, so
 * the rewrite is a no-op for the CLI and tests. node-pty applies the same rewrite
 * to its own spawn-helper internally; ripgrep has no such built-in fix.
 */
export async function resolveRgPath(importer: RgImporter = defaultImporter): Promise<string | undefined> {
  if (!rgPathCache) {
    rgPathCache = importer()
      .then((mod) => mod.rgPath.replace(/\bapp\.asar\b/, "app.asar.unpacked"))
      .catch(() => undefined);
  }
  return rgPathCache;
}

/** Test-only: clears the memoized rgPath so a fresh resolver run can be exercised. */
export function __resetRgPathCacheForTests(): void {
  rgPathCache = undefined;
}

/* */
const FORCED_EXCLUDE_GLOBS = ["!node_modules", "!.git", "!dist"];

/** Builds ripgrep argv for one Grep call. Exported for direct unit testing of the flag mapping. */
export function buildRgArgs(input: GrepInput, target: string, isDirectory: boolean): string[] {
  const args: string[] = ["--json", "--no-config"];

  if (input["-i"]) args.push("-i");
  if (input.multiline) args.push("-U", "--multiline-dotall");

  if (input.output_mode === "content") {
    const before = input["-C"] ?? input["-B"] ?? 0;
    const after = input["-C"] ?? input["-A"] ?? 0;
    if (before > 0) args.push("-B", String(before));
    if (after > 0) args.push("-A", String(after));
  }

  if (isDirectory) {
    for (const glob of FORCED_EXCLUDE_GLOBS) args.push("--glob", glob);
    if (input.glob) args.push("-g", input.glob);
  }

  args.push("--", input.pattern, target);
  return args;
}

interface RgEvent {
  type: "match" | "context";
  path: string;
  lineNumber: number;
  line: string;
}

/** Parses ripgrep's `--json` NDJSON stream, keeping only match/context lines (begin/end/summary carry no per-line data we need). */
export function parseRgJsonEvents(stdout: string): RgEvent[] {
  const events: RgEvent[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // stray non-JSON line; ignore rather than fail the whole search
    }
    const obj = parsed as { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
    if (obj.type !== "match" && obj.type !== "context") continue;
    const lineText = obj.data?.lines?.text ?? "";
    events.push({
      type: obj.type,
      path: obj.data?.path?.text ?? "",
      lineNumber: obj.data?.line_number ?? 0,
      line: lineText.endsWith("\n") ? lineText.slice(0, -1) : lineText,
    });
  }
  return events;
}

function applyLimit<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  if (limit > 0 && items.length > limit) {
    return { items: items.slice(0, limit), truncated: true };
  }
  return { items, truncated: false };
}

function buildContentOutput(events: RgEvent[], includeLineNumber: boolean, limit: number): GrepOutput {
  const allMatches: GrepMatch[] = events.map((e) => ({
    path: e.path,
    lineNumber: includeLineNumber ? e.lineNumber : undefined,
    line: e.line,
  }));
  const totalMatches = events.filter((e) => e.type === "match").length;
  const { items: matches, truncated } = applyLimit(allMatches, limit);
  return { mode: "content", matches, totalMatches, truncated };
}

function buildFilesWithMatchesOutput(events: RgEvent[], limit: number): GrepOutput {
  const seen = new Set<string>();
  const allFiles: string[] = [];
  for (const e of events) {
    if (e.type !== "match" || seen.has(e.path)) continue;
    seen.add(e.path);
    allFiles.push(e.path);
  }
  const totalMatches = allFiles.length;
  const { items: files, truncated } = applyLimit(allFiles, limit);
  return { mode: "files_with_matches", files, totalMatches, truncated };
}

function buildCountOutput(events: RgEvent[], limit: number): GrepOutput {
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const e of events) {
    if (e.type !== "match") continue;
    if (!(e.path in counts)) {
      counts[e.path] = 0;
      order.push(e.path);
    }
    counts[e.path] = (counts[e.path] ?? 0) + 1;
  }
  const totalMatches = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const { items: finalOrder, truncated } = applyLimit(order, limit);
  const finalCounts = Object.fromEntries(finalOrder.map((path) => [path, counts[path] ?? 0]));
  return { mode: "count", counts: finalCounts, totalMatches, truncated };
}

/**
 * Runs one Grep search through ripgrep. Throws on spawn failure, timeout,
 * cancellation, or an unexpected non-zero/non-one exit code (exit code 1 is
 * ripgrep's normal "no matches" outcome, not an error) — the caller
 * (tools/grep.ts) catches and falls back to the JS backend.
 */
export async function searchWithRipgrep(
  input: GrepInput,
  ctx: ToolContext,
  rgPath: string,
  root: string,
  isDirectory: boolean,
): Promise<GrepOutput> {
  const runBinary = ctx.ports.exec.runBinary;
  if (!runBinary) {
    throw new Error("ExecutionPort.runBinary is not available");
  }

  const args = buildRgArgs(input, root, isDirectory);
  const result = await runBinary({
    file: rgPath,
    args,
    cwd: ctx.cwd,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    abortSignal: ctx.abortSignal,
  });

  if (result.status === "spawn_error" || result.status === "timed_out" || result.status === "cancelled") {
    throw new Error(`ripgrep ${result.status}: ${result.stderr}`);
  }
  if (result.status === "failed" && result.exitCode !== 1) {
    throw new Error(`ripgrep exited with code ${String(result.exitCode)}: ${result.stderr}`);
  }

  const events = parseRgJsonEvents(result.stdout);
  const limit = input.head_limit;

  if (input.output_mode === "files_with_matches") return buildFilesWithMatchesOutput(events, limit);
  if (input.output_mode === "count") return buildCountOutput(events, limit);
  return buildContentOutput(events, input["-n"] ?? true, limit);
}

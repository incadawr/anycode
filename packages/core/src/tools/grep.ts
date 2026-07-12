import type { ToolContext, ToolDefinition } from "../types/tools.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import type { FileSystemPort } from "../ports/index.js";
import { grepInputSchema, type GrepInput, type GrepMatch, type GrepOutput } from "./schemas.js";
import { resolveRgPath, searchWithRipgrep } from "./grep-rg.js";

const IGNORED_DIR_NAMES = new Set([".git", "node_modules", "dist"]);

function joinPath(dir: string, entry: string): string {
  if (dir.length === 0) return entry;
  return dir.endsWith("/") ? `${dir}${entry}` : `${dir}/${entry}`;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Minimal glob support: '*' matches any run of characters; everything else is literal. Matched against the basename. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/** Recursively lists file paths under `dir`, skipping ignored directory names at any depth. */
async function walk(fs: FileSystemPort, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIR_NAMES.has(entry)) continue;
    const full = joinPath(dir, entry);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue; // broken symlink or race with deletion
    }
    if (stat.isDirectory) {
      out.push(...(await walk(fs, full)));
    } else if (stat.isFile) {
      out.push(full);
    }
  }
  return out;
}

interface LineEntry {
  lineNumber: number;
  line: string;
}

/** Line-by-line search (default mode): '.' does not cross line boundaries. */
function searchLines(
  content: string,
  regex: RegExp,
  before: number,
  after: number,
): { entries: LineEntry[]; matchCount: number } {
  const rawLines = content.split("\n");
  const flagged = rawLines.map((line) => regex.test(line));
  const matchCount = flagged.filter(Boolean).length;
  if (matchCount === 0) return { entries: [], matchCount: 0 };

  const includeIdx = new Set<number>();
  for (let i = 0; i < rawLines.length; i++) {
    if (!flagged[i]) continue;
    const from = Math.max(0, i - before);
    const to = Math.min(rawLines.length - 1, i + after);
    for (let c = from; c <= to; c++) includeIdx.add(c);
  }
  const entries = Array.from(includeIdx)
    .sort((a, b) => a - b)
    .map((idx) => ({ lineNumber: idx + 1, line: rawLines[idx] ?? "" }));
  return { entries, matchCount };
}

/** Multiline search: pattern may span line boundaries ('.' matches '\n'). No context-line support in Phase 0. */
function searchMultiline(content: string, pattern: string, caseInsensitive: boolean): { entries: LineEntry[]; matchCount: number } {
  const regex = new RegExp(pattern, `gs${caseInsensitive ? "i" : ""}`);
  const rawLines = content.split("\n");
  const lineStartOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineStartOffsets.push(i + 1);
  }

  const entries: LineEntry[] = [];
  let matchCount = 0;
  for (const m of content.matchAll(regex)) {
    matchCount++;
    const idx = m.index ?? 0;
    let lineNumber = 1;
    for (let i = 0; i < lineStartOffsets.length; i++) {
      const offset = lineStartOffsets[i] ?? 0;
      if (offset <= idx) lineNumber = i + 1;
      else break;
    }
    entries.push({ lineNumber, line: rawLines[lineNumber - 1] ?? "" });
  }
  return { entries, matchCount };
}

/**
 * Attempts the ripgrep backend; returns `undefined` (never throws) whenever
 * it isn't available or fails, signaling the caller to fall back to the JS
 * path — the only outcomes that skip the JS path are a successful ripgrep
 * run or a genuine "path not found"-style input error already handled
 * upstream.
 */
async function tryRipgrep(
  input: GrepInput,
  ctx: ToolContext,
  root: string,
  isDirectory: boolean,
): Promise<GrepOutput | undefined> {
  if (!ctx.ports.exec.runBinary) return undefined;
  const rgPath = await resolveRgPath();
  if (!rgPath) return undefined;
  try {
    return await searchWithRipgrep(input, ctx, rgPath, root, isDirectory);
  } catch {
    return undefined; // import/spawn/exit-code failure — JS path takes over
  }
}

/**
 * Prefers a ripgrep backend (tools/grep-rg.ts) when `@vscode/ripgrep`
 * resolves and `ExecutionPort.runBinary` is available; ripgrep additionally
 * respects .gitignore and hidden files (a documented improvement over the
 * JS path, not a regression — the forced node_modules/.git/dist excludes
 * are kept as a floor either way). Any resolution/spawn failure (import
 * fails, non-hermetic CI, exotic platform, unexpected exit code) falls back
 * to the pure-JS path below, which walks FileSystemPort directly
 * (readdir/stat/readFile) with a fixed ignore list: .git, node_modules,
 * dist. `GrepOutput`'s shape (mode/matches/files/counts/totalMatches/
 * truncated) is identical regardless of which backend served the request.
 */
export const grepTool: ToolDefinition<GrepInput, GrepOutput> = {
  metadata: {
    name: "Grep",
    description:
      "Search file contents with a regular expression. Returns matching lines, file paths, or per-file counts.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  inputSchema: grepInputSchema,
  handler: async (input, ctx) => {
    const root = input.path ?? ctx.cwd;

    const rootExists = await ctx.ports.fs.exists(root);
    if (!rootExists) {
      return { ok: false, error: `path not found: ${root}` };
    }

    const rootStat = await ctx.ports.fs.stat(root);

    const rgOutput = await tryRipgrep(input, ctx, root, rootStat.isDirectory);
    if (rgOutput) {
      return { ok: true, output: rgOutput };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input["-i"] ? "i" : "");
    } catch (err) {
      return {
        ok: false,
        error: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let candidates: string[];
    if (rootStat.isFile) {
      candidates = [root];
    } else {
      const all = await walk(ctx.ports.fs, root);
      const globRe = input.glob ? globToRegExp(input.glob) : undefined;
      candidates = globRe ? all.filter((p) => globRe.test(basename(p))) : all;
    }

    const before = input["-C"] ?? input["-B"] ?? 0;
    const after = input["-C"] ?? input["-A"] ?? 0;

    const matches: GrepMatch[] = [];
    const files: string[] = [];
    const counts: Record<string, number> = {};
    let totalMatches = 0;

    for (const filePath of candidates) {
      let content: string;
      try {
        content = await ctx.ports.fs.readFile(filePath);
      } catch {
        continue; // unreadable (binary/permissions) — skip in Phase 0
      }

      const { entries, matchCount } = input.multiline
        ? searchMultiline(content, input.pattern, input["-i"] ?? false)
        : searchLines(content, regex, before, after);

      if (matchCount === 0) continue;

      if (input.output_mode === "files_with_matches") {
        files.push(filePath);
        totalMatches += 1;
      } else if (input.output_mode === "count") {
        counts[filePath] = matchCount;
        totalMatches += matchCount;
      } else {
        for (const entry of entries) {
          matches.push({
            path: filePath,
            lineNumber: input["-n"] ? entry.lineNumber : undefined,
            line: entry.line,
          });
        }
        totalMatches += matchCount;
      }
    }

    let truncated = false;
    const limit = input.head_limit;

    if (input.output_mode === "files_with_matches") {
      if (limit > 0 && files.length > limit) {
        files.length = limit;
        truncated = true;
      }
      return { ok: true, output: { mode: "files_with_matches", files, totalMatches, truncated } };
    }

    if (input.output_mode === "count") {
      const entries = Object.entries(counts);
      const finalEntries = limit > 0 && entries.length > limit ? entries.slice(0, limit) : entries;
      truncated = finalEntries.length !== entries.length;
      return {
        ok: true,
        output: { mode: "count", counts: Object.fromEntries(finalEntries), totalMatches, truncated },
      };
    }

    // "content" mode: head_limit bounds the number of returned line entries
    // (matches plus any context lines), a Phase-0 simplification.
    if (limit > 0 && matches.length > limit) {
      matches.length = limit;
      truncated = true;
    }
    return { ok: true, output: { mode: "content", matches, totalMatches, truncated } };
  },
};

/**
 * Glob tool (design §2.14): picomatch over a FileSystemPort walk, ignoring
 * .git/node_modules/dist (same rule as Grep), results sorted by mtime
 * descending and capped at 1000.
 */

import picomatch from "picomatch";
import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import type { FileSystemPort } from "../ports/index.js";
import { globInputSchema, type GlobInput, type GlobOutput } from "./schemas.js";

const metadata: ToolMetadata = {
  name: "Glob",
  description:
    "Find files whose paths match a glob pattern (e.g. \"src/**/*.ts\"), sorted by modification time (most recent first).",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: 30_000,
};

/** Result cap (frozen, design §2.14). */
export const GLOB_MAX_RESULTS = 1_000;

const IGNORED_DIR_NAMES = new Set([".git", "node_modules", "dist"]);

function joinPath(dir: string, entry: string): string {
  if (dir.length === 0) return entry;
  return dir.endsWith("/") ? `${dir}${entry}` : `${dir}/${entry}`;
}

/** Strips the root prefix so patterns like "src/**\/*.ts" match relative to `path`. */
function toRelative(root: string, full: string): string {
  const withSlash = root.endsWith("/") ? root : `${root}/`;
  return full.startsWith(withSlash) ? full.slice(withSlash.length) : full;
}

interface WalkedFile {
  path: string;
  mtimeMs: number;
}

/** Recursively lists files under `dir` with their mtime, skipping ignored directory names at any depth. */
async function walk(fs: FileSystemPort, dir: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
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
      out.push({ path: full, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

export const globTool: ToolDefinition<GlobInput, GlobOutput> = {
  metadata,
  inputSchema: globInputSchema,
  handler: async (input, ctx) => {
    const root = input.path ?? ctx.cwd;

    const rootExists = await ctx.ports.fs.exists(root);
    if (!rootExists) {
      return { ok: false, error: `path not found: ${root}` };
    }
    const rootStat = await ctx.ports.fs.stat(root);
    if (!rootStat.isDirectory) {
      return { ok: false, error: `path is not a directory: ${root}` };
    }

    const isMatch = picomatch(input.pattern);
    const walked = await walk(ctx.ports.fs, root);
    const matched = walked.filter((f) => isMatch(toRelative(root, f.path)));

    // mtime desc, path asc as a deterministic tiebreak for equal mtimes.
    matched.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    const totalMatched = matched.length;
    const truncated = totalMatched > GLOB_MAX_RESULTS;
    const files = matched.slice(0, GLOB_MAX_RESULTS).map((f) => f.path);

    return { ok: true, output: { files, totalMatched, truncated } };
  },
};

import type { Tokenizer } from "../context/tokenizer.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { REPO_MAP_MAX_TOKENS, REPO_MAP_MIN_TOKENS } from "../types/config.js";
import type { RepoFile } from "./walk.js";

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".rs", ".go",
  ".py", ".rb", ".java", ".kt", ".c", ".h", ".hpp", ".cpp", ".cc", ".cs", ".css", ".scss",
  ".html", ".vue", ".svelte", ".yml", ".yaml", ".toml", ".sh", ".sql", ".txt",
]);
const ROOT_MANIFESTS = new Set(["package.json", "tsconfig.json", "cargo.toml", "go.mod", "pyproject.toml", "pom.xml", "build.gradle"]);

function priority(file: RepoFile): number {
  const lower = file.relativePath.toLowerCase();
  if (!lower.includes("/") && (ROOT_MANIFESTS.has(lower) || lower.startsWith("readme"))) return 0;
  if (lower.startsWith("src/") || lower.startsWith("lib/") || /^packages\/[^/]+\/src\//.test(lower)) return 1;
  return 2;
}

function compareFiles(a: RepoFile, b: RepoFile): number {
  const priorityDifference = priority(a) - priority(b);
  if (priorityDifference !== 0) return priorityDifference;
  if (priority(a) !== 0 && a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return a.relativePath.localeCompare(b.relativePath);
}

function join(base: string, relative: string): string {
  return `${base.replace(/[/\\]+$/, "")}/${relative}`;
}

/** Sorts once, then reads at most topN eligible text files to add line counts. */
export async function prioritizeAndEnrich(
  fs: FileSystemPort,
  files: readonly RepoFile[],
  topN: number,
  root = "",
): Promise<RepoFile[]> {
  const sorted = files.map((file) => ({ ...file })).sort(compareFiles);
  for (const file of sorted.slice(0, Math.max(0, topN))) {
    if (!TEXT_EXTENSIONS.has(file.extension)) continue;
    try {
      const content = await fs.readFile(root ? join(root, file.relativePath) : file.relativePath);
      file.lines = content.split("\n").length;
    } catch {
      // A racing deletion or unreadable file only loses LOC metadata.
    }
  }
  return sorted;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)}KB`;
}

function fileMetadata(file: RepoFile, mtimeRank: number): string {
  const values = file.lines === undefined ? [formatSize(file.size)] : [`${file.lines}L`, file.extension.slice(1)];
  values.push(`mtime#${mtimeRank}`);
  return values.join(", ");
}

function contributionFor(file: RepoFile, emittedDirs: Set<string>, mtimeRank: number): { text: string; dirs: string[] } {
  const parts = file.relativePath.split("/");
  const lines: string[] = [];
  const dirs: string[] = [];
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index]!;
    if (!emittedDirs.has(current)) {
      lines.push(`${"  ".repeat(index)}- ${parts[index]}/\n`);
      dirs.push(current);
    }
  }
  lines.push(`${"  ".repeat(parts.length - 1)}- ${parts.at(-1)} (${fileMetadata(file, mtimeRank)})\n`);
  return { text: lines.join(""), dirs };
}

export interface BuildRepoMapOptions {
  maxTokens: number;
  tokenizer: Tokenizer;
  workspace: string;
}

export interface BuiltRepoMapSection {
  section: string;
  truncated: boolean;
  omittedCount: number;
}

/** Pure synchronous formatter with incremental per-file token accounting. */
export function buildRepoMapPromptSection(
  files: readonly RepoFile[],
  opts: BuildRepoMapOptions,
): BuiltRepoMapSection {
  if (files.length === 0) return { section: "", truncated: false, omittedCount: 0 };
  const maxTokens = Math.max(REPO_MAP_MIN_TOKENS, Math.min(REPO_MAP_MAX_TOKENS, Math.floor(opts.maxTokens)));
  const header = `<repo-map>\nWorkspace structure under ${opts.workspace} (relative paths; ~${maxTokens}-token budget — large repos show priority files):\n\n`;
  const closing = "</repo-map>";
  const ranks = new Map(
    [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath))
      .map((file, index) => [file.relativePath, index + 1]),
  );
  const emittedDirs = new Set<string>();
  const accepted: Array<{ text: string; tokens: number; dirs: string[] }> = [];
  let tokens = opts.tokenizer.count(header) + opts.tokenizer.count(closing);

  for (const file of files) {
    const contribution = contributionFor(file, emittedDirs, ranks.get(file.relativePath) ?? 1);
    const contributionTokens = opts.tokenizer.count(contribution.text);
    if (tokens + contributionTokens > maxTokens) break;
    accepted.push({ ...contribution, tokens: contributionTokens });
    tokens += contributionTokens;
    for (const dir of contribution.dirs) emittedDirs.add(dir);
  }

  let omittedCount = files.length - accepted.length;
  let omitted = omittedCount > 0 ? `\n(${omittedCount} files omitted — use Glob/Grep to explore further)\n` : "\n";
  let omittedTokens = opts.tokenizer.count(omitted);
  while (accepted.length > 0 && tokens + omittedTokens > maxTokens) {
    const removed = accepted.pop()!;
    tokens -= removed.tokens;
    omittedCount += 1;
    omitted = `\n(${omittedCount} files omitted — use Glob/Grep to explore further)\n`;
    omittedTokens = opts.tokenizer.count(omitted);
  }
  if (tokens + omittedTokens > maxTokens) return { section: "", truncated: true, omittedCount: files.length };
  return {
    section: header + accepted.map((entry) => entry.text).join("") + omitted + closing,
    truncated: omittedCount > 0,
    omittedCount,
  };
}

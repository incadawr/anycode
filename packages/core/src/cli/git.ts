/**
 * `/status`, `/diff`, `/commit` CLI helpers (design slice-5.4-cut.md §2.4):
 * pure formatting/parsing functions consumed by cli/commands.ts's
 * handleStatusCommand/handleDiffCommand/handleCommitCommand (wave C) and,
 * indirectly, cli/main.ts's deps.git wiring. This file owns zero I/O and zero
 * git-spawns (NodeGitAdapter, wave A, owns the spawn path) — it only shapes
 * strings already fetched by the caller. Mirrors cli/rewind.ts's split
 * (pure helpers here; enabled-gate/confirm/act orchestration lives in the
 * command handler) and reuses the stripSurroundingQuotes precedent from
 * cli/commands.ts's `/allow`-parsing (duplicated locally rather than imported,
 * since commands.ts imports FROM this file — an import in the other direction
 * would be circular).
 */

import type { GitChangeKind, GitFileChange, GitHead, GitStatusSummary } from "../ports/git.js";

/** `/status` file-list cap per group (staged/unstaged/untracked), design §2.4. */
export const GIT_STATUS_MAX_FILES_PER_GROUP = 20;
/** `/diff` output line cap, design §2.4. */
export const GIT_DIFF_MAX_LINES = 400;

/** Strips one layer of matching outer "..."/'...' quotes, if present (mirrors cli/commands.ts). */
function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export type CommitCommandParse = { kind: "invalid" } | { kind: "commit"; message: string };

/**
 * Parses the raw text after `/commit` (design §2.4). Whitespace-only rest ->
 * `{kind:"invalid"}` (caller prints usage — a commit needs a message). A
 * single layer of surrounding quotes is stripped (same precedent as
 * `/allow`'s stripSurroundingQuotes) so `/commit "fix bug"` and
 * `/commit fix bug` both yield message `fix bug`; a quoted-empty message
 * (`/commit ""`) collapses to `{kind:"invalid"}` too, same as `/allow`'s
 * quoted-empty-tool-name rule. Only ONE layer is stripped — a message that
 * itself starts and ends with a mismatched or nested quote character keeps
 * whatever survives after that single strip (e.g. `'"nested"'` -> `"nested"`).
 */
export function parseCommitCommand(rest: string): CommitCommandParse {
  const trimmed = rest.trim();
  if (trimmed === "") {
    return { kind: "invalid" };
  }
  const message = stripSurroundingQuotes(trimmed);
  if (message === "") {
    return { kind: "invalid" };
  }
  return { kind: "commit", message };
}

/**
 * Parses the raw text after `/diff` (design §2.4). Whitespace-only rest ->
 * `{}` (no `path` field — the handler passes this straight through as

 * non-empty rest is quote-stripped (so a path containing spaces can be
 * written `/diff "some file.ts"`) and returned as `path`. The entire rest is

 * the path is passed to the port as a single `--` argv element downstream,
 * never split/parsed further here).
 */
export function parseDiffCommand(rest: string): { path?: string } {
  const trimmed = rest.trim();
  if (trimmed === "") {
    return {};
  }
  return { path: stripSurroundingQuotes(trimmed) };
}

/** Single-letter status symbol per change kind (mirrors classic git status short-format letters). */
const KIND_SYMBOLS: Record<GitChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  unmerged: "U",
};

/** Renders one file-change row: `<symbol> <path>`, or `R <from> -> <path>` for renames. */
function formatFileChange(change: GitFileChange): string {
  const symbol = KIND_SYMBOLS[change.kind];
  if (change.kind === "renamed" && change.renamedFrom !== undefined) {
    return `${symbol} ${change.renamedFrom} -> ${change.path}`;
  }
  return `${symbol} ${change.path}`;
}

/**
 * `on <branch>` / `on detached@<sha7>` label shared by renderGitStatus's
 * header and renderCommitSummary (design §2.4: "<branch|detached@sha7>").
 * Falls back to "unknown" for the pathological (invariant-violating) case of
 * a null branch/sha outside detached HEAD, so this never throws on a
 * malformed GitHead.
 */
function formatHeadLabel(head: GitHead): string {
  if (head.detached) {
    const sha7 = (head.sha ?? "unknown").slice(0, 7);
    return `detached@${sha7}`;
  }
  return head.branch ?? "unknown";
}

/**
 * Renders one capped file group (design §2.4: cap GIT_STATUS_MAX_FILES_PER_GROUP
 * with a `… +N more` tail). Returns an empty array for an empty group (the
 * caller omits the group heading entirely rather than printing an empty
 * section) — mirrors how renderCheckpointsTable leaves empty-list handling to
 * its caller.
 */
function renderGroup(label: string, rows: readonly string[]): string[] {
  if (rows.length === 0) {
    return [];
  }
  const capped = rows.slice(0, GIT_STATUS_MAX_FILES_PER_GROUP);
  const overflow = rows.length - capped.length;
  const lines = [`${label}:`, ...capped.map((row) => `  ${row}`)];
  if (overflow > 0) {
    lines.push(`  … +${overflow} more`);
  }
  return lines;
}

/**
 * Renders a `GitStatusSummary` as `/status` output (design §2.4). Header:
 * `[git] on <branch|detached@sha7> (+A ~M ?U)`, where A is the count of
 * `added`-kind changes across staged+unstaged (a file can legitimately appear
 * in both lists per the porcelain XY code, so these are entry counts, not
 * deduplicated path counts), M is every OTHER change kind combined
 * (modified/deleted/renamed/copied/typechange/unmerged — the "~" mnemonic for
 * "changed"), and U is `untracked.length`. When both `head.ahead` and
 * `head.behind` are non-null (an upstream is configured) the header gains a
 * trailing ` ahead N/behind M`. Below the header: staged/unstaged/untracked
 * groups (each `renderGroup`-capped), omitted entirely when empty — a clean
 * repo renders as just the one header line.
 */
export function renderGitStatus(summary: GitStatusSummary): string {
  const allTracked = [...summary.staged, ...summary.unstaged];
  const added = allTracked.filter((change) => change.kind === "added").length;
  const modified = allTracked.length - added;
  const untracked = summary.untracked.length;

  let header = `[git] on ${formatHeadLabel(summary.head)} (+${added} ~${modified} ?${untracked})`;
  if (summary.head.ahead !== null && summary.head.behind !== null) {
    header += ` ahead ${summary.head.ahead}/behind ${summary.head.behind}`;
  }

  const lines = [
    header,
    ...renderGroup("staged", summary.staged.map(formatFileChange)),
    ...renderGroup("unstaged", summary.unstaged.map(formatFileChange)),
    ...renderGroup("untracked", summary.untracked.map((path) => `? ${path}`)),
  ];
  return lines.join("\n") + "\n";
}

/**

 * single optional trailing newline is treated as a line terminator, not an
 * extra empty line, so a diff of exactly GIT_DIFF_MAX_LINES lines (with or
 * without a final newline) is returned byte-identical (NOT truncated) — the
 * cap is a strict `>`, not `>=`. When truncated, the surviving lines are
 * joined back with a trailing newline followed by the honest marker
 * `… diff truncated (N more lines)\n`, N being the hidden line count. An
 * empty string is returned unchanged (nothing to truncate).
 */
export function truncateDiff(text: string): string {
  if (text === "") {
    return text;
  }
  const hasTrailingNewline = text.endsWith("\n");
  const body = hasTrailingNewline ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (lines.length <= GIT_DIFF_MAX_LINES) {
    return text;
  }
  const kept = lines.slice(0, GIT_DIFF_MAX_LINES);
  const hidden = lines.length - GIT_DIFF_MAX_LINES;
  return `${kept.join("\n")}\n… diff truncated (${hidden} more lines)\n`;
}

/**
 * Renders the y/N-confirm question for `/commit` (design §2.4): total file
 * count is staged+unstaged+untracked (the handler runs `stageAll()` before
 * committing, so every currently-dirty file — regardless of its current
 * staged/unstaged/untracked bucket — ends up in the commit) plus the same
 * `on <branch>` label used by renderGitStatus's header.
 */
export function renderCommitSummary(summary: GitStatusSummary): string {
  const count = summary.staged.length + summary.unstaged.length + summary.untracked.length;
  const label = count === 1 ? "file" : "files";
  return `commit ${count} ${label} on ${formatHeadLabel(summary.head)}?`;
}

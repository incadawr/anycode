/**
 * Hand-rolled line-diff rendering for Edit/Write tool calls (design
 * slice-4.2-cut.md §2.4/§3.1). Zero dependencies — a classic line-LCS with a

 * DP-backtrack LCS + the Edit/Write format blocks; render.ts's
 * tool_execution_start branch calls into this module only when
 * `transcript?.diffs` and the input duck-validates. No module outside cli/
 * imports from here.
 */

import { collapseLinesRaw } from "./render.js";
import type { CliStyleRole, CliTheme } from "./theme.js";

export type DiffLineKind = "add" | "remove" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Cap on the number of visible Edit diff lines before an overflow marker (design §3.1). */
export const CLI_DIFF_MAX_LINES = 80;
/* */
export const CLI_DIFF_MAX_INPUT_LINES = 500;

/**
 * Line-diff of `oldText` -> `newText` (design §2.4/§3.1): a classic line-LCS
 * (DP matrix over line equality + backtrack). Split is `"\n"`-literal — no
 * trailing-newline reconstruction (design §3.1: `oldText.split("\n")` as-is).
 *
 * Either side longer than CLI_DIFF_MAX_INPUT_LINES falls back to a flat
 * "remove every old line, then add every new line" block — same DiffLine[]

 * DP before it's even allocated, not after).
 *
 * Backtrack tie-break (prefer consuming the new side first when the LCS
 * lengths are equal) is what gives "remove-before-add" ordering inside a
 * contiguous replacement block without a separate reordering pass — see the
 * unit tests for the concrete before/after trace.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length > CLI_DIFF_MAX_INPUT_LINES || newLines.length > CLI_DIFF_MAX_INPUT_LINES) {
    return [
      ...oldLines.map((text): DiffLine => ({ kind: "remove", text })),
      ...newLines.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }
  return lcsDiff(oldLines, newLines);
}

/**
 * DP-matrix + backtrack line-LCS. `dp[i][j]` = LCS length of `oldLines[0..i)`
 * and `newLines[0..j)`. Backtracking from `(n, m)` down to `(0, 0)`: equal
 * lines are context; otherwise prefer the "add" move (consume a new-side
 * line) whenever the two candidate LCS lengths tie, else "remove" — pushed
 * in backward order, then reversed once at the end (cheaper than repeated
 * unshift).
 */
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const result: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ kind: "context", text: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ kind: "add", text: newLines[j - 1]! });
      j--;
    } else {
      result.push({ kind: "remove", text: oldLines[i - 1]! });
      i--;
    }
  }
  result.reverse();
  return result;
}

/** Maps a DiffLine kind to its themed prefix + role (design §3.1). Context is unpainted. */
function paintDiffLine(line: DiffLine, theme?: CliTheme): string {
  const paint = (role: CliStyleRole, text: string): string => theme?.paint(role, text) ?? text;
  switch (line.kind) {
    case "add":
      return paint("diffAdd", `  + ${line.text}`);
    case "remove":
      return paint("diffRemove", `  - ${line.text}`);
    case "context":
      return `    ${line.text}`;
  }
}

/** Themed dim overflow marker shared by the Edit 80-line cap and the Write collapse cap. */
function overflowMarker(theme: CliTheme | undefined, text: string): string {
  return theme?.paint("dim", text) ?? text;
}

/**
 * Full Edit diff block: an honest header (`[tool] Edit <path>` with the
 * toolName role, `(replace_all)` suffix only when set) followed by the
 * coloured ±/context lines, capped at CLI_DIFF_MAX_LINES visible lines with a
 * dim `  … (+K more diff lines)` overflow marker (design §3.1). Hunk headers
 * are deliberately absent — the event carries a string fragment, not file

 * file-diff.
 */
export function formatEditDiff(opts: {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  theme?: CliTheme;
}): string {
  const { filePath, oldString, newString, replaceAll, theme } = opts;
  const name = theme?.paint("toolName", "Edit") ?? "Edit";
  const suffix = replaceAll ? " (replace_all)" : "";
  const diffLines = computeLineDiff(oldString, newString);
  const truncated = diffLines.length > CLI_DIFF_MAX_LINES;
  const visible = truncated ? diffLines.slice(0, CLI_DIFF_MAX_LINES) : diffLines;
  const bodyLines = visible.map((line) => paintDiffLine(line, theme));
  if (truncated) {
    const hidden = diffLines.length - CLI_DIFF_MAX_LINES;
    bodyLines.push(overflowMarker(theme, `  … (+${hidden} more diff lines)`));
  }
  return `\n[tool] ${name} ${filePath}${suffix}\n${bodyLines.join("\n")}\n`;
}

/**
 * Full Write diff block: an honest header (`[tool] Write <path>` — never

 * the content rendered as "+"-prefixed diffAdd lines. Length is capped by the
 * SAME head/tail collapse mechanism as tool_result output (render.ts's
 * `collapseLinesRaw`, design §3.1/§3.2) — Write has no remove side, so the
 * Edit 80-line diff cap does not apply here; head+tail is more informative
 * for a plain content dump than a hard line cut.
 */
export function formatWriteDiff(opts: { filePath: string; content: string; theme?: CliTheme }): string {
  const { filePath, content, theme } = opts;
  const name = theme?.paint("toolName", "Write") ?? "Write";
  const { head, tail, hiddenCount } = collapseLinesRaw(content.split("\n"));
  const addLine = (text: string): string => paintDiffLine({ kind: "add", text }, theme);
  const bodyLines = [
    ...head.map(addLine),
    ...(hiddenCount > 0 ? [overflowMarker(theme, `  … (+${hiddenCount} more lines)`)] : []),
    ...tail.map(addLine),
  ];
  return `\n[tool] ${name} ${filePath}\n${bodyLines.join("\n")}\n`;
}

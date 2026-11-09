/**
 * Short user-facing reason for a failed background child. The host's
 * `failureReason` is a full report for the parent model (worktree path, branch,
 * disposition, then the actual cause as the last paragraph); the strip shows
 * only the cause and keeps the full text in the tooltip.
 */
export function failureSummary(reason: string | undefined): string {
  if (reason === undefined) return "";
  const paragraphs = reason
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return "";
  const cause = last
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ")
    .replace(/^Agent:\s*/, "");
  return cause.charAt(0).toUpperCase() + cause.slice(1);
}

/** Visible failure line: always starts with "Failed" so failure is not colour-only. */
export function failureLine(reason: string | undefined): string {
  const summary = failureSummary(reason);
  return summary === "" ? "Failed" : `Failed: ${summary}`;
}

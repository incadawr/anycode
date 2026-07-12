/** Shared Git label formatters for the environment context and its unit gate. */
import type { GitHead } from "@anycode/core";
import type { WireGitStatus } from "../../../shared/protocol.js";

/**
 * Pure label for the pill's primary text (design §2.6): a detached HEAD shows
 * `detached @<sha7>` (falling back to the bare word if a detached HEAD
 * somehow carries no sha — defensive, not reachable from real git); an
 * unborn HEAD (no commits yet, `head.sha === null`) shows `unborn` regardless
 * of whether a not-yet-existent branch name is already known; otherwise the
 * branch name itself (falling back to `unborn` if it's somehow null too).
 * Exported for the unit gate (§6-style pure-helper coverage, no DOM).
 */
export function gitPillLabel(status: WireGitStatus): string {
  const { head } = status;
  if (head.detached) {
    return head.sha ? `detached @${head.sha.slice(0, 7)}` : "detached";
  }
  if (head.sha === null) {
    return "unborn";
  }
  return head.branch ?? "unborn";
}

/**
 * Pure ahead/behind formatter: `↑N` when ahead of upstream, `↓N` when behind,
 * both when both are non-zero, `null` when there is no upstream (`ahead`/
 * `behind` are `null`) or the branch is fully in sync (both zero) — the pill
 * has nothing worth drawing attention to in either case.
 */
export function gitAheadBehindLabel(head: GitHead): string | null {
  const parts: string[] = [];
  if (head.ahead) {
    parts.push(`↑${head.ahead}`);
  }
  if (head.behind) {
    parts.push(`↓${head.behind}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

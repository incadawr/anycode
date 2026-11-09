/**
 * Pure transitions for the failed detached-child rows kept next to the live
 * background strip. A failed row is local presentation: it carries the task
 * description and start time of the retained child snapshot, a frozen end
 * time, and the failure reason, and stays until the user dismisses it.
 */
import type { WireBackgroundChild } from "../../shared/protocol.js";

export const FAILED_BACKGROUND_CHILD_LIMIT = 20;
export const DISMISSED_FAILED_REPORT_LIMIT = 100;

export interface FailedChildTerminal {
  /** The report identity (the spawning tool call id). */
  reportId: string;
  failureReason: string;
  durationMs?: number;
}

/**
 * Returns the next failed list, or null when nothing changes: no retained
 * snapshot to take a description from (the report text/card stays the only
 * record), or the report was already dismissed in this session. A duplicate
 * report keeps the first endedAt.
 */
export function recordFailedChild(
  failed: readonly WireBackgroundChild[],
  dismissedReportIds: readonly string[],
  snapshots: readonly WireBackgroundChild[],
  terminal: FailedChildTerminal,
  now: number,
): WireBackgroundChild[] | null {
  if (dismissedReportIds.includes(terminal.reportId)) return null;
  const existing = failed.find((item) => item.spawnToolCallId === terminal.reportId);
  const child = snapshots.find((item) => item.spawnToolCallId === terminal.reportId) ?? existing;
  if (!child) return null;
  const endedAt =
    existing?.endedAt ??
    (terminal.durationMs !== undefined && Number.isFinite(terminal.durationMs)
      ? child.startedAt + Math.max(0, terminal.durationMs)
      : now);
  const row: WireBackgroundChild = { ...child, failureReason: existing?.failureReason ?? terminal.failureReason, endedAt };
  return [...failed.filter((item) => item.childSessionId !== child.childSessionId), row].slice(-FAILED_BACKGROUND_CHILD_LIMIT);
}

/** Removes only the dismissed row and remembers its report identity (bounded). */
export function dismissFailedChild(
  failed: readonly WireBackgroundChild[],
  dismissedReportIds: readonly string[],
  childSessionId: string,
): { failed: WireBackgroundChild[]; dismissedReportIds: string[] } | null {
  const target = failed.find((item) => item.childSessionId === childSessionId);
  if (!target) return null;
  const identity = target.spawnToolCallId ?? target.childSessionId;
  const ids = dismissedReportIds.includes(identity) ? [...dismissedReportIds] : [...dismissedReportIds, identity];
  return {
    failed: failed.filter((item) => item.childSessionId !== childSessionId),
    dismissedReportIds: ids.slice(-DISMISSED_FAILED_REPORT_LIMIT),
  };
}

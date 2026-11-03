import type { ChildBadgeKind } from "../child-layout.js";

type Row = { spawnToolCallId: string; badge: ChildBadgeKind };
type Terminal = "done" | "error";
export type ActivityMemory = { previous: Record<string, ChildBadgeKind>; unseen: Record<string, Terminal> };

export function deriveSubagentActivity(rows: readonly Row[], active: boolean, memory: ActivityMemory) {
  const previous: Record<string, ChildBadgeKind> = {};
  const unseen = active ? {} : { ...memory.unseen };
  for (const row of rows) {
    previous[row.spawnToolCallId] = row.badge;
    const before = memory.previous[row.spawnToolCallId];
    if (!active && (row.badge === "done" || row.badge === "error") && before !== row.badge) {
      unseen[row.spawnToolCallId] = row.badge;
    } else if (row.badge !== "done" && row.badge !== "error") {
      delete unseen[row.spawnToolCallId];
    }
  }
  const running = rows.filter((row) => row.badge === "running").length;
  const waiting = rows.filter((row) => row.badge === "waiting_permission").length;
  const failed = Object.values(unseen).filter((badge) => badge === "error").length;
  const done = Object.values(unseen).filter((badge) => badge === "done").length;
  const details = [running && `${running} running`, waiting && `${waiting} waiting for permission`, failed && `${failed} failed`, done && `${done} finished`].filter(Boolean);
  return { memory: { previous, unseen }, running, waiting, failed, done, label: details.length ? `Subagents — ${details.join(", ")}` : "Subagents" };
}

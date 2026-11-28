/**
 * Pure helpers over the host's `background_children` rows. Kept apart from
 * components/BackgroundAgents.tsx so tab-status-store.ts can use them without
 * pulling in the component graph.
 */
import type { WireBackgroundChild } from "../../shared/protocol.js";

/** A failed row carries a frozen end time (or a failure reason); a running one never does. */
export function isFailedBackgroundChild(child: Pick<WireBackgroundChild, "endedAt" | "failureReason">): boolean {
  return child.endedAt !== undefined || child.failureReason !== undefined;
}

/** How many of the rows are still running (the composer strip's running rows). */
export function countRunningBackgroundChildren(
  children: readonly Pick<WireBackgroundChild, "endedAt" | "failureReason">[],
): number {
  let running = 0;
  for (const child of children) {
    if (!isFailedBackgroundChild(child)) {
      running += 1;
    }
  }
  return running;
}

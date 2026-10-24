import type { ChildReportQueue, ChildReportQueueSnapshot } from "./child-report-queue.js";

/**
 * Taskana 4123 (TASK.145 residual): wires the host's pending detached-child
 * report queue to the parent session's row. Restores first (silently — a
 * corrupt snapshot logs and is discarded, never throws), then persists the
 * queue's snapshot on every change, null when it empties. Fire-and-forget
 * saves with a console.error catch, mirroring Session's own touch seam.
 *
 * The structural `persistence` Pick below is the whole seam — no import of
 * SqlitePersistenceAdapter needed (the host holds that concretely), which
 * also keeps this module unit-testable against any object with the two
 * methods.
 */
export async function attachChildReportDurability(options: {
  queue: ChildReportQueue;
  persistence: {
    loadPendingChildReports(id: string): Promise<string | null>;
    savePendingChildReports(id: string, json: string | null): Promise<void>;
  };
  sessionId: string;
}): Promise<void> {
  const { queue, persistence, sessionId } = options;
  try {
    const saved = await persistence.loadPendingChildReports(sessionId);
    if (saved !== null) {
      queue.restore(JSON.parse(saved) as ChildReportQueueSnapshot);
    }
  } catch (error) {
    console.error(`[host] restoring pending child reports for session ${sessionId} failed: ${String(error)}`);
  }
  // Restore failure must NOT skip the persistence attach — a fresh snapshot
  // still needs to overwrite whatever unreadable state sits in the column.
  queue.onChange(() => {
    const snapshot = queue.snapshot();
    void persistence
      .savePendingChildReports(sessionId, snapshot.reports.length > 0 ? JSON.stringify(snapshot) : null)
      .catch((error) => {
        console.error(`[host] saving pending child reports for session ${sessionId} failed: ${String(error)}`);
      });
  });
}

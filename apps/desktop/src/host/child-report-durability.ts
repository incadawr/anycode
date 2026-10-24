import type { ChildReportQueue, ChildReportQueueSnapshot } from "./child-report-queue.js";
import type { PendingChildReportsOptions } from "./session.js";

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
  // One implementation: the engine twin below with the adapter as both seams.
  await attachEngineChildReportDurability({
    queue,
    loadJson: () => persistence.loadPendingChildReports(sessionId),
    saveJson: (json) => persistence.savePendingChildReports(sessionId, json),
    logLabel: ` for session ${sessionId}`,
  });
}

/**
 * Taskana 4123 follow-up: the engine-boot twin of `attachChildReportDurability`
 * — wires the SAME `pending_child_reports_json` column (migration v20, no new
 * migration) behind a codex/claude root session. Both engine boots were the
 * last writers still keeping detached-child reports in memory only: their
 * `deliverDetachedChildReport` enqueues into the same module-level
 * `childReportQueue`, but nothing ever restored or persisted it, so a host
 * restart silently dropped every still-unacknowledged report.
 *
 * Two engine-specific facts shape this helper's seams:
 *
 * 1. RESTORE needs a session ROW to read from, and only CODEX guarantees one
 *    at boot (its row-creation point runs strictly before Session is built).
 *    CLAUDE creates the row NATIVE-FIRST (session-row.ts: nothing exists until
 *    the first turn-scoped `system/init`), so `loadPendingChildReports` is an
 *    injected seam: codex passes the adapter directly; claude passes a closure
 *    that reads through the row's existence gate — null (nothing restorable
 *    yet) exactly until the row materializes, never a conjured early read.
 *
 * 2. PERSIST faces the mirror problem for SAVE: a write against a not-yet-
 *    existing claude row is a silent no-op UPDATE. `savePendingChildReports` is
 *    therefore injected too: codex again passes the adapter; claude routes
 *    saves through its row's own serialized write chain, so a queued report
 *    written before the row exists lands strictly after the CREATE — same
 *    never-drop-never-conjure posture `ClaudeSessionRowWriter.touch` already
 *    holds for title patches.
 *
 * A CHILD-mode engine boot passes nothing (callers gate on `args.child`) — a
 * child never spawns detached children of its own, so its column stays null.
 *
 * Durability boundary (Taskana 4123 cross-review F2, stated honestly): this
 * attach survives and recovers from every restart where the process exits
 * AFTER a mutation's save settled (main's graceful shutdown, a later crash).
 * It does NOT cover a SIGKILL-class kill (OOM, reap deadline, power loss)
 * landing inside the sub-millisecond window between the queue's in-memory
 * mutation and the synchronous sqlite write committing — no fsync happens
 * per write under WAL `synchronous=NORMAL`, so that window cannot be closed
 * by ordering alone, only narrowed. The claude fresh-boot BUFFER path adds no
 * further window in practice: a detached child can only exist after a parent
 * turn ran, and a turn's `system/init` (the row's materialize point) strictly
 * precedes any tool call that could spawn one — so real reports always take
 * the live save path, and the buffer is defense-in-depth for synthetic
 * orderings only.
 */
export async function attachEngineChildReportDurability(options: {
  queue: ChildReportQueue;
  loadJson: () => Promise<string | null>;
  saveJson: (json: string | null) => Promise<void>;
  /** Appended to the log lines (the core path names its session id). */
  logLabel?: string;
}): Promise<PendingChildReportsOptions> {
  const { queue, loadJson, saveJson } = options;
  const label = options.logLabel ?? "";
  try {
    const saved = await loadJson();
    if (saved !== null) {
      queue.restore(JSON.parse(saved) as ChildReportQueueSnapshot);
    }
  } catch (error) {
    console.error(`[host] restoring pending child reports${label} failed: ${String(error)}`);
  }
  // Restore failure must NOT skip the persistence attach (same contract as
  // attachChildReportDurability): a fresh snapshot still needs to overwrite
  // whatever unreadable state sits in the column.
  queue.onChange(() => {
    const snapshot = queue.snapshot();
    void saveJson(snapshot.reports.length > 0 ? JSON.stringify(snapshot) : null).catch((error) => {
      console.error(`[host] saving pending child reports${label} failed: ${String(error)}`);
    });
  });
  return {
    resendAll: () => queue.resendAll(),
    ack: (id) => queue.ack(id),
  };
}

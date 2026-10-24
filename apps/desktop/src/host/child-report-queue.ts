/**
 * Host-side pending queue for a detached child's terminal report (TASK.145
 * срез 2, spec §4 point 1). Closes the gap left by срез 1's bare
 * `outbound.sendDirect({type:"child_report", ...})`: a direct send writes to
 * whatever port is CURRENTLY attached and is silently lost if the renderer
 * has disconnected/is mid-reload at the exact moment a detached child's
 * terminal event arrives (`Outbound.write()` swallows a post to a dead port —
 * see session.ts's `Outbound` doc). `Outbound.emit`'s replay ring cannot fix
 * this either: it resends the WHOLE buffered event log on every `ui_ready`
 * with no per-message identity, so a report already safely enqueued by the
 * renderer would be re-enqueued (and eventually re-sent as a second turn) on
 * the very next reconnect — see protocol.ts's `child_report` doc.
 *
 * This queue is the alternative: a small, per-host-process (= per-PARENT-
 * session, this file's whole reason to exist) list of reports still awaiting
 * the renderer's own enqueue-acknowledgement (`child_report_ack`). `add()`
 * attempts an immediate best-effort `sendDirect`; `resendAll()` (wired to
 * Session's `ui_ready` handler) re-posts everything still pending — so a lost
 * `add()`-time send is recovered on the renderer's very next (re)connect,
 * with no risk of a DUPLICATE turn, because removal never depends on delivery
 * succeeding — only on the renderer's own ack, which fires once the report is
 * durably enqueued renderer-side (store.ts dedupes a re-delivered id against
 * its own `promptQueue`/`queueInFlight` before ever acking twice).
 *
 * Bounded at `CHILD_REPORT_QUEUE_MAX_PENDING` (spec §4 point 4: "тихо резать
 * нельзя" — a cap must never silently drop). Overflow does not evict any
 * already-pending REAL report (each one's own content stays intact and
 * eventually delivered); instead it reserves exactly one extra pending slot
 * for a single coalescing "N reports dropped" notice (child-notification.ts's
 * `formatChildReportCapNotice`), which follows the SAME add/ack/resend
 * lifecycle as a real report — so the drop itself is never silent, and a
 * fresh overflow after the notice is acked starts a clean new one.
 */

import { formatChildReportCapNotice } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import type { ChildCeilingSummary } from "../shared/child-sessions.js";

/** Narrow seam this file actually needs — mirrors the SessionPersistence/tasks/lsp narrow-interface posture elsewhere in host/session.ts. */
export interface ChildReportOutbound {
  sendDirect(message: HostToUiMessage): void;
}

/** Cap on reports awaiting the renderer's `child_report_ack`, per parent session (one `ChildReportQueue` per host process). "Reasonable number" per spec §4 point 4 — this is a disaster-recovery bound (a live renderer acks within one event-loop turn), not a throughput limit. */
export const CHILD_REPORT_QUEUE_MAX_PENDING = 20;

/** Sentinel id for the coalesced overflow notice — never collides with a real report's id (spawnToolCallId is always a randomUUID-shaped tool_call id). */
const CAP_NOTICE_ID = "__child_report_cap_notice__";

/** Terminal metadata a detached child's report carries onto the wire (child_report.childTerminal). */
export interface ChildReportTerminalMeta {
  status: "completed" | "max_turns" | "cancelled" | "error";
  durationMs: number;
  finalTurnFinishReason?: "length";
  ceiling?: ChildCeilingSummary;
}

/** Serializable state of the queue (Taskana 4123): everything a host restart needs to resume delivery. */
export interface ChildReportQueueSnapshot {
  reports: Array<{ id: string; text: string; childTerminal?: ChildReportTerminalMeta }>;
  /** Dropped-since-notice counter, restored so a recovered cap-notice keeps an honest count. */
  droppedSinceNotice: number;
}

export class ChildReportQueue {
  private readonly pending: Array<{ id: string; text: string; childTerminal?: ChildReportTerminalMeta }> = [];
  /** Reports dropped since the current cap-notice entry (if any) was created; reset when that notice is acked. */
  private droppedSinceNotice = 0;
  /** Taskana 4123: durability listeners — fire at the END of every mutation path (add/upsert/ack/upsertCapNotice). */
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly outbound: ChildReportOutbound) {}

  /**
   * Enqueues a real report and attempts an immediate best-effort delivery.
   * Refuses admission once `pending.length` reaches the cap (the cap notice
   * itself occupies one of those slots once overflow has happened at least
   * once) — the refused report's own content is lost, but its occurrence is
   * never silent (see `upsertCapNotice`).
   */
  add(id: string, text: string, childTerminal?: ChildReportTerminalMeta): void {
    if (this.pending.length >= CHILD_REPORT_QUEUE_MAX_PENDING) {
      this.droppedSinceNotice += 1;
      console.error(
        `[host] detached-child report queue full (cap ${CHILD_REPORT_QUEUE_MAX_PENDING}); dropping report ${id} (${this.droppedSinceNotice} dropped since the last acked notice)`,
      );
      this.upsertCapNotice();
      return;
    }
    this.pending.push({ id, text, ...(childTerminal !== undefined ? { childTerminal } : {}) });
    this.outbound.sendDirect({
      type: "child_report",
      id,
      text,
      ...(childTerminal !== undefined ? { childTerminal } : {}),
    });
    this.notifyChanged();
  }

  /**
   * Enqueues or refreshes a report identified by `id`, coalescing repeat
   * calls for the SAME id into the ONE pending slot they already occupy
   * instead of growing the queue (TASK.148 slice 2: a detached child's stall
   * clock can re-arm and report again many times over one long run — see
   * `stall-clock.ts`'s own re-arm contract — and every stall notice for one
   * child shares a single stable id, so a long flapping run consumes at most
   * ONE pending slot here, no matter how many times it stalls and recovers).
   * When `id` is not already pending, this is exactly `add()` — same
   * admission/overflow/cap-notice discipline, including the honest drop when
   * the queue is genuinely full; the in-place replace above is purely a
   * fast path ahead of that for an id this queue already knows about.
   */
  upsert(id: string, text: string): void {
    const existing = this.pending.find((report) => report.id === id);
    if (existing) {
      existing.text = text;
      this.outbound.sendDirect({ type: "child_report", id, text });
      this.notifyChanged();
      return;
    }
    this.add(id, text);
  }

  /**
   * Clears one report the renderer confirmed it enqueued. Chosen removal
   * point over "the corresponding turn actually went out" (spec §4 point 1's
   * open choice): an enqueue ack fires unconditionally and immediately
   * (tab-registry.ts's `attach`, right after `applyHostMessage`), while "the
   * turn went out" never fires AT ALL for a report queued behind a paused/
   * busy renderer that the human never resumes — that would leave a
   * perfectly-delivered report stuck resending on every reconnect forever.
   * Acking at enqueue time bounds this queue's lifetime to "renderer is
   * reachable", not "human eventually acts on it".
   */
  ack(id: string): void {
    if (id === CAP_NOTICE_ID) {
      // The notice itself was durably enqueued -> the drop count it reported
      // is now "on the record" renderer-side; a fresh overflow starts a new
      // notice with a fresh count rather than silently continuing the old one.
      this.droppedSinceNotice = 0;
    }
    const index = this.pending.findIndex((report) => report.id === id);
    if (index !== -1) {
      this.pending.splice(index, 1);
    }
    this.notifyChanged();
  }

  /** Re-posts every still-unacknowledged report — called on every `ui_ready` (Session). */
  resendAll(): void {
    for (const report of this.pending) {
      this.outbound.sendDirect({
        type: "child_report",
        id: report.id,
        text: report.text,
        ...(report.childTerminal !== undefined ? { childTerminal: report.childTerminal } : {}),
      });
    }
  }

  /**
   * Reserves (or refreshes) the ONE coalescing overflow-notice slot. A fresh
   * overflow while a notice is already pending just updates its text in
   * place (same id, so this never grows the queue past `MAX + 1`) and
   * re-sends the updated count immediately — an un-acked notice's count
   * staying current matters more than avoiding a redundant send here.
   */
  private upsertCapNotice(): void {
    const text = formatChildReportCapNotice(this.droppedSinceNotice);
    const existing = this.pending.find((report) => report.id === CAP_NOTICE_ID);
    if (existing) {
      existing.text = text;
    } else {
      this.pending.push({ id: CAP_NOTICE_ID, text });
    }
    this.outbound.sendDirect({ type: "child_report", id: CAP_NOTICE_ID, text });
    this.notifyChanged();
  }

  /**
   * Taskana 4123: deep-copies the queue's whole state for persistence. The
   * cap notice rides as its sentinel-id row (`CAP_NOTICE_ID`) — no special
   * casing; `droppedSinceNotice` travels alongside so a recovered notice
   * keeps counting honestly. Mutating the returned snapshot can never affect
   * the queue (every row, and each row's `childTerminal`, is a fresh copy).
   */
  snapshot(): ChildReportQueueSnapshot {
    return {
      reports: this.pending.map((report) => ({
        id: report.id,
        text: report.text,
        ...(report.childTerminal !== undefined ? { childTerminal: { ...report.childTerminal } } : {}),
      })),
      droppedSinceNotice: this.droppedSinceNotice,
    };
  }

  /**
   * Taskana 4123: replaces the queue's state from a persisted snapshot
   * (called once, at boot, BEFORE the Session's first `ui_ready` — whose
   * `resendAll` then delivers the recovered reports exactly like
   * live-queued ones). Sends NOTHING here: delivery stays the Session's
   * `ui_ready` contract. Defensive against a corrupt/foreign snapshot:
   * rows without a non-empty string `id` or with a non-string `text` are
   * dropped, a negative `droppedSinceNotice` is clamped to 0, and an
   * implausibly long row list (past `MAX_PENDING + 1`, the cap notice's one
   * extra slot) is truncated with a loud discarded-count error.
   */
  restore(snapshot: ChildReportQueueSnapshot): void {
    const rows = Array.isArray(snapshot?.reports) ? snapshot.reports : [];
    const kept: ChildReportQueueSnapshot["reports"] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      if (typeof row.text !== "string") continue;
      kept.push({
        id: row.id,
        text: row.text,
        ...(row.childTerminal !== null && typeof row.childTerminal === "object"
          ? { childTerminal: { ...row.childTerminal } }
          : {}),
      });
    }
    const limit = CHILD_REPORT_QUEUE_MAX_PENDING + 1;
    if (kept.length > limit) {
      console.error(
        `[host] restored detached-child report snapshot had ${kept.length} rows (cap ${limit}); discarding ${kept.length - limit} and keeping the first ${limit}`,
      );
      kept.length = limit;
    }
    this.pending.length = 0;
    this.pending.push(...kept);
    this.droppedSinceNotice =
      typeof snapshot?.droppedSinceNotice === "number" && snapshot.droppedSinceNotice > 0
        ? snapshot.droppedSinceNotice
        : 0;
  }

  /**
   * Taskana 4123: subscribes a durability listener fired at the END of every
   * mutation path (`add` admit AND overflow, `upsert` existing-id AND
   * fall-through-to-add, `ack`, `upsertCapNotice`) — unconditionally per
   * method call, so a no-op ack re-persisting an identical snapshot is
   * harmless and the persistence contract stays deterministic. Returns an
   * unsubscribe fn; mirrors the port's `onBackgroundChildrenChanged` shape.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }
}

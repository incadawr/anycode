/**
 * TASK.145 срез 2: `ChildReportQueue` unit tests. A stub `ChildReportOutbound`
 * records every `sendDirect` call so delivery attempts (immediate, resend,
 * cap-notice) can be asserted without a real Session/WirePort.
 */
import { describe, expect, it, vi } from "vitest";
import { CHILD_REPORT_QUEUE_MAX_PENDING, ChildReportQueue, type ChildReportOutbound } from "./child-report-queue.js";
import type { HostToUiMessage } from "../shared/protocol.js";

function stubOutbound(): ChildReportOutbound & { sent: Extract<HostToUiMessage, { type: "child_report" }>[] } {
  const sent: Extract<HostToUiMessage, { type: "child_report" }>[] = [];
  return {
    sent,
    sendDirect(message) {
      if (message.type === "child_report") {
        sent.push(message);
      }
    },
  };
}

describe("ChildReportQueue (TASK.145 срез 2 §4 point 1)", () => {
  it("add() attempts an immediate best-effort sendDirect", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);

    queue.add("report-1", "hello");

    expect(outbound.sent).toEqual([{ type: "child_report", id: "report-1", text: "hello" }]);
  });

  it("add() with childTerminal sends {id, text, childTerminal} and resendAll() re-sends it after ui_ready; without meta the payload equals today's shape", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const meta = { status: "completed" as const, durationMs: 42, finalTurnFinishReason: "length" as const };

    queue.add("report-meta", "cut short", meta);

    expect(outbound.sent).toEqual([{ type: "child_report", id: "report-meta", text: "cut short", childTerminal: meta }]);
    // A resend after ui_ready re-sends the SAME payload, meta included.
    outbound.sent.length = 0;
    queue.resendAll();
    expect(outbound.sent).toEqual([{ type: "child_report", id: "report-meta", text: "cut short", childTerminal: meta }]);
    // Without meta, the payload equals today's shape (no childTerminal key).
    queue.add("report-plain", "plain");
    expect(outbound.sent.at(-1)).toEqual({ type: "child_report", id: "report-plain", text: "plain" });
  });

  // Taskana 4055 cross-review F2: the ceiling summary rides the detached
  // report's childTerminal too (the only terminal channel a detached child has).
  it("add() with a ceiling summary in childTerminal sends and resends it verbatim (Taskana 4055 F2)", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const meta = {
      status: "max_turns" as const,
      durationMs: 7,
      ceiling: { rounds: 1, grantedTurns: 1, lastRefusal: "stalled" as const },
    };

    queue.add("report-ceiling", "stopped", meta);
    expect(outbound.sent).toEqual([{ type: "child_report", id: "report-ceiling", text: "stopped", childTerminal: meta }]);
    outbound.sent.length = 0;
    queue.resendAll();
    expect(outbound.sent).toEqual([{ type: "child_report", id: "report-ceiling", text: "stopped", childTerminal: meta }]);
  });

  it("ack() removes the report so a later resendAll() never re-sends it", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    queue.add("report-1", "hello");

    queue.ack("report-1");
    outbound.sent.length = 0;
    queue.resendAll();

    expect(outbound.sent).toEqual([]);
  });

  it("ack() of an unknown id is a harmless no-op", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    queue.add("report-1", "hello");

    queue.ack("ghost");

    outbound.sent.length = 0;
    queue.resendAll();
    expect(outbound.sent).toEqual([{ type: "child_report", id: "report-1", text: "hello" }]);
  });

  it("resendAll() re-posts every still-unacknowledged report — recovers a delivery lost while the renderer was disconnected", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    queue.add("report-1", "first");
    queue.add("report-2", "second");
    outbound.sent.length = 0; // simulate: the add()-time sends never reached a live renderer

    queue.resendAll();

    expect(outbound.sent).toEqual([
      { type: "child_report", id: "report-1", text: "first" },
      { type: "child_report", id: "report-2", text: "second" },
    ]);
  });

  it("resendAll() on an empty queue sends nothing", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);

    queue.resendAll();

    expect(outbound.sent).toEqual([]);
  });

  it(`accepts up to ${CHILD_REPORT_QUEUE_MAX_PENDING} pending reports without dropping any`, () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);

    for (let i = 0; i < CHILD_REPORT_QUEUE_MAX_PENDING; i += 1) {
      queue.add(`report-${i}`, `text-${i}`);
    }

    expect(outbound.sent).toHaveLength(CHILD_REPORT_QUEUE_MAX_PENDING);
    outbound.sent.length = 0;
    queue.resendAll();
    expect(outbound.sent).toHaveLength(CHILD_REPORT_QUEUE_MAX_PENDING);
  });

  it("does NOT silently drop a report past the cap — it delivers an honest coalesced cap-notice instead", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < CHILD_REPORT_QUEUE_MAX_PENDING; i += 1) {
      queue.add(`report-${i}`, `text-${i}`);
    }
    outbound.sent.length = 0;
    queue.add("overflow-1", "this content is lost");

    // The overflow report's own text never reaches the wire...
    expect(outbound.sent.some((m) => m.id === "overflow-1")).toBe(false);
    // ...but a distinct, honest notice does, mentioning the drop.
    const notice = outbound.sent.find((m) => m.id !== "overflow-1");
    expect(notice).toBeDefined();
    expect(notice!.text).toContain("1 background child session report could not be delivered");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a second overflow before the notice is acked updates the SAME notice slot (never grows past cap+1)", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < CHILD_REPORT_QUEUE_MAX_PENDING; i += 1) {
      queue.add(`report-${i}`, `text-${i}`);
    }
    queue.add("overflow-1", "lost-1");
    queue.add("overflow-2", "lost-2");

    outbound.sent.length = 0;
    queue.resendAll();
    // cap-worth of real reports + exactly ONE notice slot, never two.
    expect(outbound.sent).toHaveLength(CHILD_REPORT_QUEUE_MAX_PENDING + 1);
    const notice = outbound.sent.find((m) => m.id !== `report-0` && m.id.startsWith("__"));
    expect(notice!.text).toContain("2 background child session reports could not be delivered");

    vi.restoreAllMocks();
  });

  it("acking the cap-notice resets the drop counter — a fresh overflow afterwards starts a clean new notice", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < CHILD_REPORT_QUEUE_MAX_PENDING; i += 1) {
      queue.add(`report-${i}`, `text-${i}`);
    }
    queue.add("overflow-1", "lost-1");
    const noticeId = outbound.sent.find((m) => m.id.startsWith("__"))!.id;
    queue.ack(noticeId);
    // Free up room by acking one real report too, so the next overflow's
    // notice text is unambiguously "1", not stacked on the old count.
    queue.ack("report-0");
    // Back to 19 pending (20 real - report-0). Refill exactly ONE slot to
    // reach the cap again WITHOUT itself triggering the overflow branch.
    queue.add("refill-0", "x");

    outbound.sent.length = 0;
    queue.add("overflow-2", "lost-2");

    const notice = outbound.sent.find((m) => m.id.startsWith("__"));
    expect(notice!.text).toContain("1 background child session report could not be delivered");

    vi.restoreAllMocks();
  });
});

describe("ChildReportQueue.upsert (TASK.148 slice 2 — coalesces repeat notices for the SAME id into one pending slot)", () => {
  it("upsert() of a brand-new id behaves like add(): admits and sends immediately", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);

    queue.upsert("stall:child-1", "first stall notice");

    expect(outbound.sent).toEqual([{ type: "child_report", id: "stall:child-1", text: "first stall notice" }]);
  });

  it("a second upsert() for the SAME id, still unacked, REPLACES the pending entry in place rather than growing the queue", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    queue.upsert("stall:child-1", "first stall notice");
    queue.upsert("stall:child-1", "second stall notice (child still silent)");

    outbound.sent.length = 0;
    queue.resendAll();

    expect(outbound.sent).toEqual([
      { type: "child_report", id: "stall:child-1", text: "second stall notice (child still silent)" },
    ]);
  });

  it("many repeated upsert() calls for ONE id never consume more than ONE pending slot — a flapping child cannot exhaust the queue cap", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);

    for (let i = 0; i < CHILD_REPORT_QUEUE_MAX_PENDING * 5; i += 1) {
      queue.upsert("stall:flapping-child", `silence report #${i}`);
    }

    outbound.sent.length = 0;
    queue.resendAll();
    expect(outbound.sent).toHaveLength(1);
    expect(outbound.sent[0]!.text).toBe(`silence report #${CHILD_REPORT_QUEUE_MAX_PENDING * 5 - 1}`);
  });

  it("upsert() for a brand-new id once the cap is already full still goes through the normal overflow/cap-notice path — the coalescing fast path only applies to an id ALREADY pending", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < CHILD_REPORT_QUEUE_MAX_PENDING; i += 1) {
      queue.add(`report-${i}`, `text-${i}`);
    }
    outbound.sent.length = 0;
    queue.upsert("stall:new-child", "brand new notice");

    expect(outbound.sent.some((m) => m.id === "stall:new-child")).toBe(false);
    const notice = outbound.sent.find((m) => m.id !== "stall:new-child");
    expect(notice).toBeDefined();
    expect(notice!.text).toContain("could not be delivered");
    warn.mockRestore();
  });

  it("ack() of an upserted id works exactly like a normal report — a later resendAll() no longer includes it", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    queue.upsert("stall:child-2", "notice");

    queue.ack("stall:child-2");
    outbound.sent.length = 0;
    queue.resendAll();

    expect(outbound.sent).toEqual([]);
  });

  // taskana 4181: the supervisor idle reminder rides the same coalescing
  // discipline — every repeat shares the ONE "supervisor-idle-reminder" id,
  // so a long-ignored supervisor consumes at most one pending slot (latest
  // text wins), exactly like a flapping child's stall notices above.
  it("upsert(\"supervisor-idle-reminder\", …) twice unacked -> ONE pending slot, latest text wins", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);

    queue.upsert("supervisor-idle-reminder", "reminder 1 (normal)");
    queue.upsert("supervisor-idle-reminder", "reminder 3 (escalated)");

    outbound.sent.length = 0;
    queue.resendAll();

    expect(outbound.sent).toEqual([
      { type: "child_report", id: "supervisor-idle-reminder", text: "reminder 3 (escalated)" },
    ]);
  });
});

describe("ChildReportQueue snapshot/restore/onChange (Taskana 4123)", () => {
  it("empty queue: snapshot() is {reports: [], droppedSinceNotice: 0}; onChange fires on nothing until a mutation", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const listener = vi.fn();

    expect(queue.snapshot()).toEqual({ reports: [], droppedSinceNotice: 0 });
    const unsubscribe = queue.onChange(listener);
    // No mutation happened — the listener must stay silent.
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("add() two reports -> snapshot() deep-equals both rows; mutating the snapshot does not affect the queue (copy check)", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const meta = { status: "completed" as const, durationMs: 42, finalTurnFinishReason: "length" as const };

    queue.add("report-1", "first", meta);
    queue.add("report-2", "second");

    expect(queue.snapshot()).toEqual({
      reports: [
        { id: "report-1", text: "first", childTerminal: meta },
        { id: "report-2", text: "second" },
      ],
      droppedSinceNotice: 0,
    });

    // Copy check: mutating the returned snapshot (rows, childTerminal, counter) never touches the queue.
    const snap = queue.snapshot();
    snap.reports[0]!.id = "hacked";
    snap.reports[0]!.text = "hacked";
    snap.reports[0]!.childTerminal!.durationMs = 999;
    snap.droppedSinceNotice = 77;
    const fresh = queue.snapshot();
    expect(fresh.reports[0]).toEqual({ id: "report-1", text: "first", childTerminal: meta });
    expect(fresh.droppedSinceNotice).toBe(0);
  });

  it("ack(one) fires the listener and leaves the other row in the snapshot", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const listener = vi.fn();
    queue.onChange(listener);

    queue.add("report-1", "first");
    queue.add("report-2", "second");
    expect(listener).toHaveBeenCalledTimes(2);

    queue.ack("report-1");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(queue.snapshot().reports).toEqual([{ id: "report-2", text: "second" }]);
  });

  it("listener fires for every mutation path: add admit, add overflow (cap-notice sentinel row), upsert new id, upsert existing id, ack (incl. unknown-id no-op)", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const listener = vi.fn();
    queue.onChange(listener);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // add admit
    for (let i = 0; i < CHILD_REPORT_QUEUE_MAX_PENDING; i += 1) {
      queue.add(`report-${i}`, `text-${i}`);
    }
    expect(listener).toHaveBeenCalledTimes(CHILD_REPORT_QUEUE_MAX_PENDING);

    // add overflow -> upsertCapNotice path (sentinel row present in snapshot)
    queue.add("overflow-1", "lost");
    expect(listener).toHaveBeenCalledTimes(CHILD_REPORT_QUEUE_MAX_PENDING + 1);
    const snap = queue.snapshot();
    expect(snap.reports).toHaveLength(CHILD_REPORT_QUEUE_MAX_PENDING + 1);
    expect(snap.reports.some((r) => r.id === "__child_report_cap_notice__")).toBe(true);
    expect(snap.droppedSinceNotice).toBe(1);

    // upsert existing id (the cap notice row itself is not needed here — use a real pending id)
    queue.upsert("report-0", "updated text");
    expect(listener).toHaveBeenCalledTimes(CHILD_REPORT_QUEUE_MAX_PENDING + 2);

    // ack an unknown id — unconditional contract: still notifies
    queue.ack("ghost");
    expect(listener).toHaveBeenCalledTimes(CHILD_REPORT_QUEUE_MAX_PENDING + 3);

    // ack a real id to free a slot, then upsert a brand-new id (fall-through-to-add path)
    queue.ack("report-1");
    expect(listener).toHaveBeenCalledTimes(CHILD_REPORT_QUEUE_MAX_PENDING + 4);
    queue.upsert("stall:new-child", "brand new notice");
    expect(listener).toHaveBeenCalledTimes(CHILD_REPORT_QUEUE_MAX_PENDING + 5);

    errSpy.mockRestore();
  });

  it("restore() round-trips: snapshot() deep-equals the input; resendAll() sends exactly the restored rows in order; a later add() appends after them", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const meta = { status: "error" as const, durationMs: 7 };

    queue.restore({
      reports: [
        { id: "r1", text: "hello" },
        { id: "r2", text: "world", childTerminal: meta },
      ],
      droppedSinceNotice: 0,
    });

    expect(queue.snapshot()).toEqual({
      reports: [
        { id: "r1", text: "hello" },
        { id: "r2", text: "world", childTerminal: meta },
      ],
      droppedSinceNotice: 0,
    });

    // restore() itself sends NOTHING — the outbound spy stays empty until resendAll().
    expect(outbound.sent).toEqual([]);
    queue.resendAll();
    expect(outbound.sent).toEqual([
      { type: "child_report", id: "r1", text: "hello" },
      { type: "child_report", id: "r2", text: "world", childTerminal: meta },
    ]);

    // A later add() appends after the restored rows.
    outbound.sent.length = 0;
    queue.add("r3", "appended");
    expect(outbound.sent.at(-1)).toEqual({ type: "child_report", id: "r3", text: "appended" });
    outbound.sent.length = 0;
    queue.resendAll();
    expect(outbound.sent.map((m) => m.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("restored droppedSinceNotice survives: restore with a pending cap-notice row + counter N, one more overflow updates the SAME notice to N+1", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // A snapshot from a host that had hit the cap once: MAX real rows + the notice row + counter 3.
    queue.restore({
      reports: [
        ...Array.from({ length: CHILD_REPORT_QUEUE_MAX_PENDING }, (_, i) => ({
          id: `report-${i}`,
          text: `text-${i}`,
        })),
        { id: "__child_report_cap_notice__", text: "stale notice text (3)" },
      ],
      droppedSinceNotice: 3,
    });

    // One more overflow: the existing-notice path of upsertCapNotice must update the SAME row to count 4.
    queue.add("overflow-after-restore", "lost");
    const snap = queue.snapshot();
    expect(snap.reports).toHaveLength(CHILD_REPORT_QUEUE_MAX_PENDING + 1);
    const notice = snap.reports.find((r) => r.id === "__child_report_cap_notice__")!;
    expect(notice.text).toContain("4 background child session reports could not be delivered");
    expect(snap.droppedSinceNotice).toBe(4);

    errSpy.mockRestore();
  });

  it("defensive restore: malformed rows dropped, negative counter clamped to 0, > MAX+1 rows truncated with a console.error naming the discarded count", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Malformed rows: missing id, empty id, non-string text, non-object row.
    queue.restore({
      reports: [
        { text: "no id" } as unknown as { id: string; text: string },
        { id: "", text: "empty id" },
        { id: "bad-text", text: 42 } as unknown as { id: string; text: string },
        null as unknown as { id: string; text: string },
        { id: "good-1", text: "kept" },
      ],
      droppedSinceNotice: -5,
    });
    expect(queue.snapshot()).toEqual({ reports: [{ id: "good-1", text: "kept" }], droppedSinceNotice: 0 });

    // Truncation: MAX+2 valid rows -> keep the first MAX+1, console.error the 1 discarded.
    errSpy.mockClear();
    const tooMany = Array.from({ length: CHILD_REPORT_QUEUE_MAX_PENDING + 2 }, (_, i) => ({
      id: `r-${i}`,
      text: `t-${i}`,
    }));
    queue.restore({ reports: tooMany, droppedSinceNotice: 0 });
    const snap = queue.snapshot();
    expect(snap.reports).toHaveLength(CHILD_REPORT_QUEUE_MAX_PENDING + 1);
    expect(snap.reports[0]!.id).toBe("r-0");
    expect(snap.reports.at(-1)!.id).toBe(`r-${CHILD_REPORT_QUEUE_MAX_PENDING}`);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("discarding 1"));

    errSpy.mockRestore();
  });

  it("restore() sends NOTHING (outbound stays empty until resendAll) and onChange's unsubscribe stops notifications", () => {
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const listener = vi.fn();

    const unsubscribe = queue.onChange(listener);
    queue.restore({ reports: [{ id: "r1", text: "hello" }], droppedSinceNotice: 0 });
    // restore() is initial state replacement, not a delivery: nothing goes out...
    expect(outbound.sent).toEqual([]);
    // ...and restore() itself does not fire change listeners (only mutations do).
    expect(listener).not.toHaveBeenCalled();

    queue.resendAll();
    expect(outbound.sent).toEqual([{ type: "child_report", id: "r1", text: "hello" }]);

    unsubscribe();
    queue.add("r2", "after unsubscribe");
    expect(listener).not.toHaveBeenCalled();
  });
});

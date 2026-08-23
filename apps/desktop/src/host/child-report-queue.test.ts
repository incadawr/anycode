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

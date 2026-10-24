/**
 * Taskana 4123 (TASK.145 residual): integration tests for
 * `attachChildReportDurability` — the REAL SqlitePersistenceAdapter
 * (`:memory:`, session row created first) against a REAL ChildReportQueue
 * over a recording outbound stub. Covers the two halves of the contract:
 * restore (a persisted snapshot reappears in the queue and resends) and
 * persist (every mutation lands in the column, null once it drains).
 */
import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { ChildReportQueue, type ChildReportOutbound } from "./child-report-queue.js";
import { attachChildReportDurability } from "./child-report-durability.js";
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

/** One macrotask: enough for the fire-and-forget save's microtask chain to settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function makeAdapter(): Promise<{ adapter: SqlitePersistenceAdapter; sessionId: string }> {
  const adapter = new SqlitePersistenceAdapter(":memory:");
  const meta = await adapter.createSession({ id: "parent-1", workspace: "/w", model: "m", mode: "build" });
  return { adapter, sessionId: meta.id };
}

describe("attachChildReportDurability (Taskana 4123)", () => {
  it("persists on every mutation: add lands in the column, ack drains it back to null", async () => {
    const { adapter, sessionId } = await makeAdapter();
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);

    await attachChildReportDurability({ queue, persistence: adapter, sessionId });

    queue.add("id-1", "text-1", { status: "completed", durationMs: 5 });
    await tick();
    const saved = await adapter.loadPendingChildReports(sessionId);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).reports[0]).toEqual({
      id: "id-1",
      text: "text-1",
      childTerminal: { status: "completed", durationMs: 5 },
    });

    queue.ack("id-1");
    await tick();
    expect(await adapter.loadPendingChildReports(sessionId)).toBeNull();

    await adapter.close();
  });

  it("restores a pre-seeded snapshot: after attach, resendAll() sends exactly the persisted rows", async () => {
    const { adapter, sessionId } = await makeAdapter();
    await adapter.savePendingChildReports(
      sessionId,
      JSON.stringify({ reports: [{ id: "r1", text: "hello" }], droppedSinceNotice: 0 }),
    );

    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    await attachChildReportDurability({ queue, persistence: adapter, sessionId });

    queue.resendAll();
    expect(outbound.sent).toEqual([{ type: "child_report", id: "r1", text: "hello" }]);

    await adapter.close();
  });

  it("corrupt JSON in the column: attach does not throw, queue stays empty, a subsequent add still persists (the persistence attach survived the failed restore)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { adapter, sessionId } = await makeAdapter();
    await adapter.savePendingChildReports(sessionId, "{not json at all");

    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    await expect(
      attachChildReportDurability({ queue, persistence: adapter, sessionId }),
    ).resolves.toBeUndefined();

    // Restore failed -> queue starts empty...
    queue.resendAll();
    expect(outbound.sent).toEqual([]);
    // ...but the persistence attach is still live: a fresh add lands in the column,
    // overwriting the unreadable snapshot.
    queue.add("fresh-1", "fresh text");
    await tick();
    const saved = await adapter.loadPendingChildReports(sessionId);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).reports.map((r: { id: string }) => r.id)).toEqual(["fresh-1"]);
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
    await adapter.close();
  });

  it("null column: attach is a clean no-op restore; the persistence attach is still live (proved by an add)", async () => {
    const { adapter, sessionId } = await makeAdapter();

    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    await attachChildReportDurability({ queue, persistence: adapter, sessionId });

    // Nothing to restore: the queue is empty and sends nothing.
    queue.resendAll();
    expect(outbound.sent).toEqual([]);

    queue.add("live-1", "live text");
    await tick();
    const saved = await adapter.loadPendingChildReports(sessionId);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).reports[0]).toEqual({ id: "live-1", text: "live text" });

    await adapter.close();
  });
});

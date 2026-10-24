/**
 * Taskana 4123 follow-up: integration tests for
 * `attachEngineChildReportDurability` — the codex/claude boots' pending
 * detached-child report durability. Each engine's wiring shape is reproduced
 * EXACTLY as host/index.ts builds it (index.ts itself is not importable —
 * process.parentPort at module scope, see index.test.ts's header for the
 * established idiom):
 *
 *  - CODEX: the row always exists by the attach point (its create seam runs
 *    strictly before Session), so the REAL SqlitePersistenceAdapter
 *    (`:memory:`) is the whole load/save seam.
 *  - CLAUDE: the row is NATIVE-FIRST (session-row.ts — nothing exists until
 *    the first turn-scoped system/init materializes it), so load reads
 *    through `writer.materialized` and save rides the writer's own
 *    serialized write chain. Both the RESUME shape (row exists) and the
 *    FRESH shape (save buffered before the row exists) are covered, against
 *    a REAL ClaudeSessionRowWriter over the REAL adapter.
 *
 * The three brief-mandated scenarios run per engine: a restart with one
 * pending report delivers it once; after an ack, a restart delivers nothing;
 * a corrupt stored value is ignored and logged.
 */
import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { ChildReportQueue, type ChildReportOutbound } from "./child-report-queue.js";
import { attachEngineChildReportDurability } from "./child-report-durability.js";
import { ClaudeSessionRowWriter } from "./engines/claude/session-row.js";
import type { HostToUiMessage } from "../shared/protocol.js";

type ChildReportMessage = Extract<HostToUiMessage, { type: "child_report" }>;

function stubOutbound(): ChildReportOutbound & { sent: ChildReportMessage[] } {
  const sent: ChildReportMessage[] = [];
  return {
    sent,
    sendDirect(message) {
      if (message.type === "child_report") {
        sent.push(message);
      }
    },
  };
}

/** One macrotask: enough for the fire-and-forget save's microtask chain (and the row writer's serialized chain) to settle. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function makeAdapter(): Promise<SqlitePersistenceAdapter> {
  const adapter = new SqlitePersistenceAdapter(":memory:");
  await adapter.createSession({ id: "engine-root-1", workspace: "/w", model: "m", mode: "build" });
  return adapter;
}

/** The codex attach shape: the row exists, the adapter is the whole seam. */
async function attachCodex(
  adapter: SqlitePersistenceAdapter,
  queue: ChildReportQueue,
): Promise<void> {
  await attachEngineChildReportDurability({
    queue,
    loadJson: () => adapter.loadPendingChildReports("engine-root-1"),
    saveJson: (json) => adapter.savePendingChildReports("engine-root-1", json),
  });
}

/** The claude attach shape verbatim (host/index.ts): both seams ride the row's existence gate. */
async function attachClaude(
  adapter: SqlitePersistenceAdapter,
  queue: ChildReportQueue,
  writer: ClaudeSessionRowWriter,
  rowId: string,
): Promise<void> {
  await attachEngineChildReportDurability({
    queue,
    loadJson: () =>
      writer.materialized ? adapter.loadPendingChildReports(rowId) : Promise.resolve(null),
    saveJson: (json) => writer.savePendingChildReports(json).then(() => undefined),
  });
}

function claudeWriter(adapter: SqlitePersistenceAdapter, rowExists: boolean): ClaudeSessionRowWriter {
  return new ClaudeSessionRowWriter({
    rowId: "engine-root-1",
    identity: { workspace: "/w", engineId: "claude", externalSessionRef: "native-ref-1" },
    rowExists,
    port: {
      create: (id, row) => adapter.createSession({ id, ...row } as Parameters<SqlitePersistenceAdapter["createSession"]>[0]),
      touch: async () => undefined,
    },
    pendingChildReportsPort: {
      savePendingChildReports: (id, json) => adapter.savePendingChildReports(id, json),
    },
    onError: () => {},
  });
}

/** One engine "run": a queue over its own outbound, the attach, and the restart semantics under test. */
interface Run {
  queue: ChildReportQueue;
  seam: { resendAll(): void; ack(id: string): void };
  sent: ChildReportMessage[];
}

for (const engine of ["codex", "claude"] as const) {
  describe(`attachEngineChildReportDurability — ${engine} root session (Taskana 4123 follow-up)`, () => {
    /** Restart #1: run with a pending report; Restart #2: fresh queue+attach, then the ui_ready resend. */
    async function restartCycle(adapter: SqlitePersistenceAdapter, ackBeforeRestart: boolean): Promise<{ first: Run; second: Run }> {
      // ── run 1 (pre-restart): a detached child's report is queued; a renderer
      // reload means the add-time send may or may not have landed.
      const firstOutbound = stubOutbound();
      const firstQueue = new ChildReportQueue(firstOutbound);
      const writer1 = claudeWriter(adapter, true);
      const firstSeam =
        engine === "codex"
          ? await (async () => {
              await attachCodex(adapter, firstQueue);
              return { resendAll: () => firstQueue.resendAll(), ack: (id: string) => firstQueue.ack(id) };
            })()
          : await (async () => {
              await attachClaude(adapter, firstQueue, writer1, "engine-root-1");
              return { resendAll: () => firstQueue.resendAll(), ack: (id: string) => firstQueue.ack(id) };
            })();
      const first: Run = { queue: firstQueue, seam: firstSeam, sent: firstOutbound.sent };

      first.queue.add("call-1", "child finished: fixed the flaky test", { status: "completed", durationMs: 5 });
      await tick();
      if (ackBeforeRestart) {
        // The renderer enqueued it durably before the host died.
        first.seam.ack("call-1");
        await tick();
      }

      // ── run 2 (post-restart): a fresh queue + attach; the Session's first
      // ui_ready then resendAll()s whatever was restored.
      const secondOutbound = stubOutbound();
      const secondQueue = new ChildReportQueue(secondOutbound);
      const writer2 = claudeWriter(adapter, true);
      if (engine === "codex") {
        await attachCodex(adapter, secondQueue);
      } else {
        await attachClaude(adapter, secondQueue, writer2, "engine-root-1");
      }
      const second: Run = {
        queue: secondQueue,
        seam: { resendAll: () => secondQueue.resendAll(), ack: (id: string) => secondQueue.ack(id) },
        sent: secondOutbound.sent,
      };
      second.seam.resendAll();
      return { first, second };
    }

    it("a restart with one pending report delivers it once (exactly one child_report after the ui_ready resend)", async () => {
      const adapter = await makeAdapter();
      const { second } = await restartCycle(adapter, false);

      expect(second.sent).toEqual([
        { type: "child_report", id: "call-1", text: "child finished: fixed the flaky test", childTerminal: { status: "completed", durationMs: 5 } },
      ]);
      // ...and an ack in the new run clears the column, so the NEXT restart has nothing.
      second.seam.ack("call-1");
      await tick();
      expect(await adapter.loadPendingChildReports("engine-root-1")).toBeNull();

      await adapter.close();
    });

    it("after an ack, a restart delivers nothing (the column drained back to null)", async () => {
      const adapter = await makeAdapter();
      const { second } = await restartCycle(adapter, true);

      expect(second.sent).toEqual([]);
      expect(await adapter.loadPendingChildReports("engine-root-1")).toBeNull();

      await adapter.close();
    });

    it("a corrupt stored value is ignored and logged: attach resolves, resendAll sends nothing, a fresh add still persists over the unreadable column", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const adapter = await makeAdapter();
      await adapter.savePendingChildReports("engine-root-1", "{not json at all");

      const outbound = stubOutbound();
      const queue = new ChildReportQueue(outbound);
      if (engine === "codex") {
        await attachCodex(adapter, queue);
      } else {
        await attachClaude(adapter, queue, claudeWriter(adapter, true), "engine-root-1");
      }

      queue.resendAll();
      expect(outbound.sent).toEqual([]);
      expect(errSpy).toHaveBeenCalled();

      // The persistence attach survived the failed restore: a fresh add
      // overwrites the unreadable snapshot.
      queue.add("fresh-1", "fresh text");
      await tick();
      const saved = await adapter.loadPendingChildReports("engine-root-1");
      expect(saved).not.toBeNull();
      expect(JSON.parse(saved!).reports.map((r: { id: string }) => r.id)).toEqual(["fresh-1"]);

      errSpy.mockRestore();
      await adapter.close();
    });
  });
}

describe("attachEngineChildReportDurability — save failures never escape the fire-and-forget onChange (Taskana 4123 cross-review)", () => {
  it("a rejecting saveJson inside onChange is caught and logged, the attach survives, and a later successful save still persists", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = await makeAdapter();

    // A save seam that rejects the FIRST save (SQLITE_BUSY at the moment the
    // report is queued) then behaves. The durability helper's own posture —
    // `void saveJson(...).catch(console.error)` — is the code under test.
    let failFirst = true;
    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    await attachEngineChildReportDurability({
      queue,
      loadJson: () => adapter.loadPendingChildReports("engine-root-1"),
      saveJson: async (json) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("SQLITE_BUSY");
        }
        await adapter.savePendingChildReports("engine-root-1", json);
      },
    });

    // The add-time save rejects; the catch must swallow it (no unhandled
    // rejection under the host's Node defaults) and log it.
    queue.add("call-busy", "report whose first save hit SQLITE_BUSY");
    await tick();
    await tick();

    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]![0])).toContain("saving pending child reports");
    expect(String(errSpy.mock.calls[0]![0])).toContain("SQLITE_BUSY");
    expect(await adapter.loadPendingChildReports("engine-root-1")).toBeNull();

    // The attach survived: the NEXT mutation's save lands normally.
    queue.add("call-2", "second report");
    await tick();
    const saved = await adapter.loadPendingChildReports("engine-root-1");
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).reports.map((r: { id: string }) => r.id)).toEqual(["call-busy", "call-2"]);

    errSpy.mockRestore();
    await adapter.close();
  });
});

describe("attachEngineChildReportDurability — claude FRESH boot (row not yet materialized, session-row.ts native-first)", () => {
  it("a report queued before the row exists is buffered, lands after materialize, and a restart then delivers it once", async () => {
    const adapter = await makeAdapter();
    // A fresh claude boot: the row does NOT exist yet — the writer was built
    // rowExists:false and materialize only fires on the first system/init.
    // Drop the row makeAdapter created so the writer really starts unmaterialized.
    // (Recreate the adapter without a session row: use a distinct id space.)
    const adapterFresh = new SqlitePersistenceAdapter(":memory:");

    const outbound = stubOutbound();
    const queue = new ChildReportQueue(outbound);
    const writer = new ClaudeSessionRowWriter({
      rowId: "claude-fresh-1",
      identity: { workspace: "/w", engineId: "claude", externalSessionRef: "native-ref-2" },
      rowExists: false,
      port: {
        create: (id, row) => adapterFresh.createSession({ id, ...row } as Parameters<SqlitePersistenceAdapter["createSession"]>[0]),
        touch: async () => undefined,
      },
      pendingChildReportsPort: {
        savePendingChildReports: (id, json) => adapterFresh.savePendingChildReports(id, json),
      },
      onError: () => {},
    });
    await attachClaude(adapterFresh, queue, writer, "claude-fresh-1");

    // Restore read the gate honestly: nothing restorable before the row exists.
    expect(writer.materialized).toBe(false);
    expect(await adapterFresh.loadPendingChildReports("claude-fresh-1")).toBeNull();

    // A detached child's report lands while the row still does not exist.
    queue.add("call-9", "child finished: buffered behind the create");
    await tick();
    // Still no row -> nothing could be written, and the newest snapshot is buffered.
    expect(await adapterFresh.loadPendingChildReports("claude-fresh-1")).toBeNull();

    // The first turn-scoped system/init materializes the row; the buffered
    // snapshot flushes through the serialized chain right after the CREATE.
    writer.materialize({ model: "opus[1m]", mode: "workspace" });
    await writer.settled();
    await tick();
    const saved = await adapterFresh.loadPendingChildReports("claude-fresh-1");
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).reports.map((r: { id: string }) => r.id)).toEqual(["call-9"]);

    // Restart (a resume always has its row): the report is restored and the
    // first ui_ready delivers it exactly once.
    const restartOutbound = stubOutbound();
    const restartQueue = new ChildReportQueue(restartOutbound);
    const restartWriter = new ClaudeSessionRowWriter({
      rowId: "claude-fresh-1",
      identity: { workspace: "/w", engineId: "claude", externalSessionRef: "native-ref-2" },
      rowExists: true,
      port: { create: async () => undefined, touch: async () => undefined },
      pendingChildReportsPort: {
        savePendingChildReports: (id, json) => adapterFresh.savePendingChildReports(id, json),
      },
      onError: () => {},
    });
    await attachClaude(adapterFresh, restartQueue, restartWriter, "claude-fresh-1");
    restartQueue.resendAll();
    expect(restartOutbound.sent).toEqual([
      { type: "child_report", id: "call-9", text: "child finished: buffered behind the create" },
    ]);

    await adapter.close();
    await adapterFresh.close();
  });
});

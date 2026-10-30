import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPACTION_RECORD_MAX_PER_SESSION,
  SqlitePersistenceAdapter,
  type CompactionRecord,
  type HistoryItem,
} from "@anycode/core";
import { CompactionRecordLog, type CompactionRecordStore } from "./compaction-records.js";

/** In-memory stand-in for the SQLite store's two methods. */
function fakeStore(initial: CompactionRecord[] = [], failWrites = false) {
  const rows = new Map(initial.map((record) => [record.id, record]));
  const order: string[] = initial.map((record) => record.id);
  let highWater = Math.max(0, ...initial.map((record) => record.seq ?? 0));
  const store: CompactionRecordStore & { rows: Map<string, CompactionRecord>; highWater: number } = {
    rows,
    get highWater() {
      return highWater;
    },
    compactionSeqHighWater: async () => highWater,
    raiseCompactionSeqHighWater: async (_sessionId, seq) => {
      if (failWrites) throw new Error("disk on fire");
      highWater = Math.max(highWater, seq);
    },
    appendCompactionRecord: async (_sessionId, record) => {
      if (failWrites) throw new Error("disk on fire");
      rows.set(record.id, record);
      if (!order.includes(record.id)) order.push(record.id);
    },
    listCompactionRecords: async () => order.map((id) => rows.get(id)!),
    discardCompactionRecords: async (_sessionId, ids) => {
      if (failWrites) throw new Error("disk on fire");
      for (const id of ids) {
        rows.delete(id);
        const at = order.indexOf(id);
        if (at !== -1) order.splice(at, 1);
      }
    },
  };
  return store;
}

const record = (id: string, createdAt: number, extra: Partial<CompactionRecord> = {}): CompactionRecord => ({
  id,
  createdAt,
  ok: true,
  ...extra,
});

/** The history a checkpoint restores: what the cutoff is measured against. */
const restored = (latest: number): HistoryItem[] => [
  { id: "kept-1", createdAt: 1, message: { role: "user", content: "kept" } },
  { id: "kept-2", createdAt: latest, message: { role: "assistant", content: [{ type: "text", text: "kept" }] } },
];

describe("CompactionRecordLog (GitHub #36)", () => {
  it("loads what storage kept, so the very first handshake already knows the session's compactions", async () => {
    const store = fakeStore([record("a", 1), record("b", 2)]);
    const log = new CompactionRecordLog(store, "s1");

    await log.load();

    expect(log.list().map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("a read failure boots with no remembered rows instead of failing the session", async () => {
    const store: CompactionRecordStore = {
      appendCompactionRecord: async () => undefined,
      listCompactionRecords: async () => {
        throw new Error("database locked");
      },
      discardCompactionRecords: async () => undefined,
      compactionSeqHighWater: async () => 0,
      raiseCompactionSeqHighWater: async () => undefined,
    };
    const errors: unknown[] = [];
    const log = new CompactionRecordLog(store, "s1", (error) => errors.push(error));

    await log.load();

    expect(log.list()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("records synchronously into the cache (the handshake is synchronous) and writes in order", async () => {
    const store = fakeStore();
    const log = new CompactionRecordLog(store, "s1");

    log.record(record("a", 1));
    log.record(record("b", 2));

    // Visible immediately: a ui_ready arriving before the write settles still
    // ships the row.
    expect(log.list().map((entry) => entry.id)).toEqual(["a", "b"]);
    await log.flush();
    expect([...store.rows.keys()]).toEqual(["a", "b"]);
  });

  it("keeps the cache bounded to the same count the store does", async () => {
    const store = fakeStore();
    const log = new CompactionRecordLog(store, "s1");

    for (let i = 0; i < COMPACTION_RECORD_MAX_PER_SESSION + 3; i += 1) {
      log.record(record(`r-${i}`, i));
    }
    await log.flush();

    expect(log.list()).toHaveLength(COMPACTION_RECORD_MAX_PER_SESSION);
    expect(log.list()[0]?.id).toBe("r-3");
  });

  it("hands out a monotonic sequence and reports the boundary the next record would exceed", async () => {
    const log = new CompactionRecordLog(fakeStore(), "s1");
    expect(log.sequence()).toBe(0);

    log.record(record("a", 10));
    expect(log.list()[0]?.seq).toBe(1);
    expect(log.sequence()).toBe(1);

    log.record(record("b", 20));
    expect(log.list().map((entry) => entry.seq)).toEqual([1, 2]);
    expect(log.sequence()).toBe(2);
    await log.flush();
  });

  it("continues the sequence after a restart instead of restarting at 1", async () => {
    // The counter is durable: a reopened session must not hand out a seq a
    // stored record already holds, or a rewind boundary would misjudge both.
    const store = fakeStore([{ ...record("stored", 5), seq: 7 }]);
    const log = new CompactionRecordLog(store, "s1");

    await log.load();
    expect(log.sequence()).toBe(7);

    log.record(record("fresh", 30));
    expect(log.list().at(-1)?.seq).toBe(8);
  });

  it("numbers records that predate the field by their stored order on load", async () => {
    const store = fakeStore([record("old-1", 1), record("old-2", 2)]);
    const log = new CompactionRecordLog(store, "s1");

    await log.load();

    expect(log.list().map((entry) => entry.seq)).toEqual([1, 2]);
    expect(log.sequence()).toBe(2);
  });

  it("a sequence boundary keeps a between-turns failed row and drops only what was recorded after it", async () => {
    const store = fakeStore([record("failed-before-turn", 400, { ok: false }), record("after", 500, { ok: false })]);
    const log = new CompactionRecordLog(store, "s1");
    await log.load();

    // Boundary 1 = the sequence at the checkpoint's turn start: the first row
    // existed by then (it happened between turns), the second did not.
    log.truncate(restored(100), 1);
    await log.flush();

    expect(log.list().map((entry) => entry.id)).toEqual(["failed-before-turn"]);
    expect([...store.rows.keys()]).toEqual(["failed-before-turn"]);
  });

  it("truncate drops the records of the discarded conversation from the cache at once, and from storage behind the queue", async () => {
    const store = fakeStore([record("kept", 100), record("discarded", 300)]);
    const log = new CompactionRecordLog(store, "s1");
    await log.load();

    log.truncate(restored(200));

    // The very next (synchronous) handshake already excludes the discarded row
    // — a reconnect must not ship a summary of the rewound-away conversation.
    expect(log.list().map((entry) => entry.id)).toEqual(["kept"]);
    await log.flush();
    // ...and a later REOPEN agrees, because storage dropped it too.
    expect([...store.rows.keys()]).toEqual(["kept"]);
  });

  it("truncate measures the checkpoint's HISTORY, not a clock: a compaction earlier in the same turn (before a lazily created checkpoint) is discarded", async () => {
    // The checkpoint was created at t=1000 (lazily, at the turn's first
    // write-effect tool) but its snapshot is the history from BEFORE the turn
    // (newest item at t=200). The auto compaction ran at t=400, INSIDE that
    // turn: newer than the snapshot, older than the checkpoint row. A
    // timestamp cutoff would keep it and resurrect the pre-turn summary.
    const store = fakeStore([record("pre-turn-compaction", 400, { summary: "summary of the pre-turn conversation" })]);
    const log = new CompactionRecordLog(store, "s1");
    await log.load();

    log.truncate(restored(200));
    await log.flush();

    expect(log.list()).toEqual([]);
    expect([...store.rows.keys()]).toEqual([]);
  });

  it("truncate keeps a compaction whose own summary survived the rewind, whatever its timestamp", async () => {
    // Rewind to a checkpoint taken AFTER that compaction: its summary item is
    // part of the restored history, so the row still describes it.
    const store = fakeStore([record("survived", 900, { summaryItemId: "summary-1" })]);
    const log = new CompactionRecordLog(store, "s1");
    await log.load();

    log.truncate([
      { id: "summary-1", createdAt: 500, message: { role: "user", content: "Session continued. Summary…" } },
      { id: "later", createdAt: 950, message: { role: "user", content: "kept" } },
    ]);
    await log.flush();

    expect(log.list().map((entry) => entry.id)).toEqual(["survived"]);
    expect([...store.rows.keys()]).toEqual(["survived"]);
  });

  it("a failed write is reported and swallowed — a compaction row must never fail the turn that made it", async () => {
    const errors: unknown[] = [];
    const log = new CompactionRecordLog(fakeStore([], true), "s1", (error) => errors.push(error));

    log.record(record("a", 1));

    await expect(log.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    // The row stays readable in this process even though the disk refused it.
    expect(log.list().map((entry) => entry.id)).toEqual(["a"]);
  });

  it("snapshots the record at record() time, so a later mutation cannot rewrite what was stored", async () => {
    const store = fakeStore();
    const log = new CompactionRecordLog(store, "s1");
    const live: CompactionRecord = { id: "a", createdAt: 1, ok: true, summary: "as recorded" };

    log.record(live);
    live.summary = "mutated afterwards";
    await log.flush();

    expect(store.rows.get("a")?.summary).toBe("as recorded");
    expect(log.list()[0]?.summary).toBe("as recorded");
  });
});

describe("CompactionRecordLog — the sequence high-water mark (GitHub #36 review 5)", () => {
  it("never reuses a number after a rewind deleted the records that held it", async () => {
    // A number already covered by a live checkpoint's boundary means "recorded
    // BEFORE that snapshot". Handing it out again would make the next compaction
    // look older than it is, so a rewind to that checkpoint would KEEP it — and
    // resurrect a summary of the conversation the user discarded.
    const store = fakeStore([record("a", 10), record("b", 20)]);
    const first = new CompactionRecordLog(store, "s1");
    await first.load();
    expect(first.sequence()).toBe(2);

    // Rewind to a checkpoint whose boundary is 0: every record goes, the mark stays.
    first.truncate(restored(0), 0);
    await first.flush();
    expect(store.rows.size).toBe(0);

    // Reopen (a fresh log over the same store) and record again.
    const reopened = new CompactionRecordLog(store, "s1");
    await reopened.load();
    expect(reopened.sequence()).toBe(2);
    reopened.record(record("c", 30));
    expect(reopened.list()[0]?.seq).toBe(3);

    // A checkpoint taken earlier (boundary 2) must still discard it.
    reopened.truncate(restored(0), 2);
    await reopened.flush();
    expect(reopened.list()).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it("persists the mark through a REAL database, across record deletion and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-compaction-seq-"));
    try {
      const dbPath = join(dir, "anycode.sqlite");
      const adapter = new SqlitePersistenceAdapter(dbPath);
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });

      const first = new CompactionRecordLog(adapter, "s1");
      await first.load();
      first.record(record("one", 10));
      first.record(record("two", 20));
      await first.flush();
      expect(await adapter.compactionSeqHighWater("s1")).toBe(2);

      // The rewind deletes BOTH rows — and must leave the mark where it was.
      first.truncate(restored(0), 0);
      await first.flush();
      expect(await adapter.listCompactionRecords("s1")).toEqual([]);
      expect(await adapter.compactionSeqHighWater("s1")).toBe(2);
      await adapter.close();

      // REOPEN: a fresh process reads the same durable state.
      const reopenedAdapter = new SqlitePersistenceAdapter(dbPath);
      const reopened = new CompactionRecordLog(reopenedAdapter, "s1");
      await reopened.load();
      expect(reopened.sequence()).toBe(2);
      reopened.record(record("three", 30));
      await reopened.flush();
      expect(reopened.list()[0]?.seq).toBe(3);
      expect(await reopenedAdapter.compactionSeqHighWater("s1")).toBe(3);

      // A checkpoint that exists from BEFORE it (boundary 2) drops it.
      reopened.truncate(restored(0), 2);
      await reopened.flush();
      expect(await reopenedAdapter.listCompactionRecords("s1")).toEqual([]);
      await reopenedAdapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the mark only moves forward — a stale or replayed write cannot lower it", async () => {
    const store = fakeStore();
    const log = new CompactionRecordLog(store, "s1");

    log.record(record("a", 10));
    log.record(record("b", 20));
    await log.flush();
    expect(store.highWater).toBe(2);
    await store.raiseCompactionSeqHighWater("s1", 1);
    expect(store.highWater).toBe(2);
  });
});

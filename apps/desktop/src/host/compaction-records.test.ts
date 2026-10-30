import { describe, expect, it } from "vitest";
import { COMPACTION_RECORD_MAX_PER_SESSION, type CompactionRecord } from "@anycode/core";
import { CompactionRecordLog, type CompactionRecordStore } from "./compaction-records.js";

/** In-memory stand-in for the SQLite store's two methods. */
function fakeStore(initial: CompactionRecord[] = [], failWrites = false) {
  const rows = new Map(initial.map((record) => [record.id, record]));
  const order: string[] = initial.map((record) => record.id);
  const store: CompactionRecordStore & { rows: Map<string, CompactionRecord> } = {
    rows,
    appendCompactionRecord: async (_sessionId, record) => {
      if (failWrites) throw new Error("disk on fire");
      rows.set(record.id, record);
      if (!order.includes(record.id)) order.push(record.id);
    },
    listCompactionRecords: async () => order.map((id) => rows.get(id)!),
    truncateCompactionRecords: async (_sessionId, checkpointAt) => {
      if (failWrites) throw new Error("disk on fire");
      for (const [id, entry] of [...rows]) {
        if (entry.createdAt > checkpointAt) {
          rows.delete(id);
          order.splice(order.indexOf(id), 1);
        }
      }
    },
  };
  return store;
}

const record = (id: string, createdAt: number): CompactionRecord => ({ id, createdAt, ok: true });

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
      truncateCompactionRecords: async () => undefined,
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

  it("truncate drops everything AFTER the cutoff from the cache at once, and from storage behind the queue", async () => {
    const store = fakeStore([record("kept", 100), record("discarded", 300)]);
    const log = new CompactionRecordLog(store, "s1");
    await log.load();

    log.truncate(200);

    // The very next (synchronous) handshake already excludes the discarded row
    // — a reconnect must not ship a summary of the rewound-away conversation.
    expect(log.list().map((entry) => entry.id)).toEqual(["kept"]);
    await log.flush();
    // ...and a later REOPEN agrees, because storage dropped it too.
    expect([...store.rows.keys()]).toEqual(["kept"]);
  });

  it("truncate keeps a record stamped at the cutoff itself (same-millisecond is not proof it was after the snapshot)", async () => {
    const store = fakeStore([record("boundary", 200), record("after", 201)]);
    const log = new CompactionRecordLog(store, "s1");
    await log.load();

    log.truncate(200);
    await log.flush();

    expect(log.list().map((entry) => entry.id)).toEqual(["boundary"]);
    expect([...store.rows.keys()]).toEqual(["boundary"]);
  });

  it("a failed truncate write is reported and swallowed like any other record write", async () => {
    const errors: unknown[] = [];
    const log = new CompactionRecordLog(fakeStore([record("a", 300)], true), "s1", (error) => errors.push(error));

    log.truncate(200);

    await expect(log.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    // The cache still honours the cutoff: the current process never shows it.
    expect(log.list()).toEqual([]);
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

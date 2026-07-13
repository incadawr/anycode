import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { SqliteCodexShadowLog } from "./shadow-log.js";

describe("SqliteCodexShadowLog", () => {
  it("round-trips a recorded item through the persistence adapter, stripping itemId from the projection shape", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    const log = new SqliteCodexShadowLog(persistence);

    log.record("thread-1", "exec-1", { turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo hi", cwd: "/repo", exitCode: 0, outputHead: "hi\n" });
    // record() is fire-and-forget: the underlying write is a real (fast,
    // in-memory) async call, so it must be flushed before list() reads it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const items = await log.list("thread-1");
    expect(items).toEqual([{ turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo hi", cwd: "/repo", exitCode: 0, outputHead: "hi\n" }]);
    expect(items[0]).not.toHaveProperty("itemId");
  });

  it("list() returns an empty array for a thread with no recorded items", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    const log = new SqliteCodexShadowLog(persistence);
    expect(await log.list("unknown-thread")).toEqual([]);
  });

  it("record() swallows a persistence failure rather than throwing into the live turn", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    persistence.recordCodexThreadItem = vi.fn().mockRejectedValue(new Error("disk full"));
    const log = new SqliteCodexShadowLog(persistence);

    // Must not throw synchronously — record() is fire-and-forget by contract.
    expect(() => log.record("thread-1", "exec-1", { turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo hi" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("shadow log write failed"));
    errorSpy.mockRestore();
  });
});

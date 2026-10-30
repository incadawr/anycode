import { describe, expect, it } from "vitest";
import { compactionRecordsDiscardedByRewind, type CompactionRecord } from "./compaction.js";
import type { HistoryItem } from "./history.js";

const record = (id: string, createdAt: number, extra: Partial<CompactionRecord> = {}): CompactionRecord => ({
  id,
  createdAt,
  ok: true,
  ...extra,
});

const item = (id: string, createdAt: number): HistoryItem => ({
  id,
  createdAt,
  message: { role: "user", content: id },
});

/**
 * GitHub #36 review 3: the rewind cutoff is the checkpoint's CONVERSATION
 * STATE, not its creation time — an automatic checkpoint is created lazily at a
 * turn's first write-effect tool while its snapshot holds the history from
 * BEFORE that turn, so a compaction earlier in the same turn is newer than the
 * snapshot yet older than the checkpoint row.
 */
describe("compactionRecordsDiscardedByRewind", () => {
  it("discards a compaction that happened earlier in the same turn, before a lazily created checkpoint", () => {
    // Snapshot: history from before the turn (newest item t=200). Checkpoint
    // row created at t=1000. Compaction ran at t=400, inside the turn.
    const records = [record("pre-turn", 400, { summary: "pre-turn summary" })];

    expect(compactionRecordsDiscardedByRewind(records, [item("a", 100), item("b", 200)])).toEqual(["pre-turn"]);
  });

  it("keeps anything older than the restored state — a compaction that predates the checkpoint survives it", () => {
    const records = [record("old", 50)];

    expect(compactionRecordsDiscardedByRewind(records, [item("a", 100), item("b", 200)])).toEqual([]);
  });

  it("keeps a compaction whose own summary item the rewind restored, whatever its timestamp", () => {
    // The checkpoint was taken AFTER this compaction, so its summary is part
    // of the restored conversation: the row still describes what is on screen.
    const records = [record("survived", 900, { summaryItemId: "summary-1" })];

    expect(
      compactionRecordsDiscardedByRewind(records, [item("summary-1", 500), item("after", 950)]),
    ).toEqual([]);
  });

  it("discards everything when the rewind restores an EMPTY conversation", () => {
    const records = [record("a", 100), record("b", 200, { ok: false, error: "skipped" })];

    expect(compactionRecordsDiscardedByRewind(records, [])).toEqual(["a", "b"]);
  });

  it("judges a failed attempt by time only — it has no summary item to recognize", () => {
    const records = [
      record("failed-old", 50, { ok: false, error: "model unreachable" }),
      record("failed-new", 400, { ok: false, error: "model unreachable" }),
    ];

    expect(compactionRecordsDiscardedByRewind(records, [item("a", 200)])).toEqual(["failed-new"]);
  });

  it("a record stamped exactly at the newest restored item counts as discarded", () => {
    expect(compactionRecordsDiscardedByRewind([record("boundary", 200)], [item("a", 200)])).toEqual(["boundary"]);
  });
});

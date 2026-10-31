/**
 * Durable presentation record of ONE compaction (GitHub #36).
 *
 * A compaction is the only operation that destroys transcript context, and the
 * row that reports it is the only place a user can see what survived. That row
 * cannot live in `history_items`: a compaction REPLACES the history, so the
 * previous summary item is exactly what the next compaction drops, and a
 * refused/failed compaction leaves no item at all. The row therefore keeps its
 * own bounded table of records, written by the host at `compaction_end` and
 * read back on resume so a reopened session shows every compaction it went
 * through — with its own summary, or with the reason it did not happen.
 *
 * Presentation-only: nothing here is ever sent to a model, and no field ever
 * carries a raw error object — `error` is the already-redacted wire string.
 */
export interface CompactionRecord {
  /** Stable id; also stamped onto the live `compaction_end` as `recordId`, so a replayed event patches the row hydration restored instead of adding a twin. */
  id: string;
  /** Epoch ms the compaction ended — the ordering anchor against history items. */
  createdAt: number;
  /**
   * Monotonic per-session sequence, assigned by the store when the outcome is
   * recorded (1, 2, 3… for the life of the session, continuing across a
   * restart). This — not a clock — is what a rewind compares against: a
   * checkpoint captures the sequence CURRENT AT ITS TURN START, so "recorded
   * before that snapshot" is a question with an exact answer even when the
   * history has not moved (a failed or skipped compaction leaves it untouched)
   * and even when two events share a millisecond.
   *
   * Absent only on records written before this field existed; the store
   * normalizes those on load by their stored order.
   */
  seq?: number;
  /** Whether the swap actually happened. A failed record carries `error`, never `summary`. */
  ok: boolean;
  /** Absent when the tab that wrote the record never learned who asked (reattached mid-compaction). */
  trigger?: "auto" | "manual";
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  /** Redacted reason for a not-applied compaction. */
  error?: string;
  /**
   * True when the outcome was a structural NO-OP (nothing to compact) rather
   * than an attempt that failed. Kept on the record so a reopened session still
   * reads the row as a plain statement instead of a refusal (UI audit v0.0.49
   * §C3). Absent on pre-existing records, which read as failures.
   */
  skipped?: true;
  /** The text installed as the new history head — what the model actually sees. */
  summary?: string;
  /** Id of the `compact_summary` history item that held `summary` (until a later compaction dropped it). */
  summaryItemId?: string;
  /**
   * The instruction that was ACTUALLY sent to the summarizing model, recorded
   * so a reopened row never presents today's instruction as the one that
   * produced this summary. Absent for a structural skip (no model call) and
   * for any engine that compacts natively.
   */
  prompt?: string;
  /** Model id of the summarizing call, when known — failures included. */
  model?: string;
}

/**
 * Hard bound on records kept per session — the agreed retention rule.
 *
 * A compaction is rare (tens over the life of a long session), so 64 is
 * generous; the bound exists so a pathological loop cannot grow the table
 * without limit. Beyond it the OLDEST records roll off, and that is honest
 * degradation rather than a bet:
 *  - a successful compaction whose freshly-installed summary item is still in
 *    the history keeps rendering after its record is gone (the projection
 *    falls back to a `summaryOrigin: "history"` row carrying the same text, and
 *    says the instruction it shows is the CURRENT one rather than the used one);
 *  - a compaction whose summary a later one folded away — or one that never
 *    happened — is genuinely unrecoverable once dropped, and simply stops
 *    appearing. Nothing is invented in its place.
 * Only ids are ever rewritten by retention, never text: a surviving row keeps
 * its own summary, reason, prompt and model verbatim.
 */
export const COMPACTION_RECORD_MAX_PER_SESSION = 64;

/**
 * Per-field character bound. A summary is bounded in practice by the model's
 * own output budget; this cap only guards against a pathological blob, and is
 * far above any real summary (~50k tokens).
 */
export const COMPACTION_RECORD_FIELD_MAX_CHARS = 200_000;

/** Clamps one record's text fields to the storage bound; leaves small values untouched. */
export function boundCompactionRecord(record: CompactionRecord): CompactionRecord {
  const clamp = (value: string | undefined): string | undefined =>
    value === undefined || value.length <= COMPACTION_RECORD_FIELD_MAX_CHARS
      ? value
      : value.slice(0, COMPACTION_RECORD_FIELD_MAX_CHARS);
  return {
    ...record,
    ...(record.error !== undefined ? { error: clamp(record.error) } : {}),
    ...(record.summary !== undefined ? { summary: clamp(record.summary) } : {}),
    ...(record.prompt !== undefined ? { prompt: clamp(record.prompt) } : {}),
  };
}

/**
 * Which compaction records a conversation REWIND must discard (GitHub #36).
 *
 * The boundary is a SEQUENCE, not a clock: `boundary` is the record sequence
 * that was current when the checkpoint took its history snapshot, so a record
 * with `seq <= boundary` existed at that moment and survives, and everything
 * above it was created afterwards and belongs to the conversation being thrown
 * away. That is the only test that answers the question exactly:
 *
 *  - a clock cannot: an automatic checkpoint is created LAZILY — at a turn's
 *    first write-effect tool — while its snapshot is the history from BEFORE
 *    that turn, so a compaction earlier in the same turn is newer than the
 *    snapshot yet older than the checkpoint row;
 *  - the newest restored item's timestamp cannot either, in the other
 *    direction: a FAILED or skipped compaction changes no history at all, so
 *    one that happened between turns is newer than every item the next turn's
 *    checkpoint restores while still predating that checkpoint. Judging by
 *    timestamps deleted a perfectly valid row, permanently (cache AND storage).
 *
 * `boundary` is absent for a checkpoint written before this field existed (and
 * for the CLI, which keeps no compaction records). Only then does the older
 * history-based heuristic apply, and its rule is spelled out below.
 *
 * Returns the ids to discard (bounded by the caller's retention cap).
 */
export function compactionRecordsDiscardedByRewind(
  records: readonly CompactionRecord[],
  restoredHistory: readonly { id: string; createdAt: number }[],
  boundary?: number,
): string[] {
  if (boundary !== undefined) {
    return records.filter((record) => (record.seq ?? 0) > boundary).map((record) => record.id);
  }

  // Legacy checkpoint (no sequence recorded): fall back to the history itself.
  //  - a record whose summary item is still in that history SURVIVED the rewind
  //    (its text is literally in the restored state) and is kept, whatever its
  //    timestamp;
  //  - otherwise a record is discarded when it is not older than every restored
  //    item. This mis-drops a between-turns failed compaction — the reason the
  //    sequence exists — but it is strictly better than resurrecting a summary,
  //    and it only applies to checkpoints predating the sequence.
  let cutoff = 0;
  const restoredIds = new Set<string>();
  for (const item of restoredHistory) {
    restoredIds.add(item.id);
    if (item.createdAt > cutoff) cutoff = item.createdAt;
  }
  return records
    .filter((record) => {
      if (record.summaryItemId !== undefined && restoredIds.has(record.summaryItemId)) {
        return false;
      }
      return record.createdAt >= cutoff && record.createdAt > 0;
    })
    .map((record) => record.id);
}

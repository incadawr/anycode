/**
 * Durable compaction presentation records for one session (GitHub #36).
 *
 * Why this exists at all: a compaction row has to survive a REOPEN, and the
 * history cannot hold it. A successful compaction replaces the whole history
 * with `[summary, ...tail]`, so the summary item that textually embodies the
 * event is precisely what the NEXT compaction deletes; a refused or failed
 * compaction changes no history at all. Keeping the row only in renderer
 * memory (the pre-#36 posture) meant a session that compacted twice showed one
 * row after a restart, and a failed compaction disappeared entirely.
 *
 * So the HOST records what the row needs at `compaction_end`, in its own
 * bounded table (`COMPACTION_RECORD_MAX_PER_SESSION`), and ships the records
 * back with `session_history`/`presentation_snapshot`.
 *
 * Two properties carried over from the codex agent-card log (same shape, same
 * reason):
 * - writes are SERIALIZED and fail-soft: a compaction row is presentation, and
 *   a storage hiccup must never fail the turn that produced it;
 * - `list()` is synchronous and reads an in-memory cache, because the
 *   handshake that needs it (`buildSessionHistory`) is synchronous. `load()`
 *   fills that cache once at boot; `flush()` lets shutdown drain the tail.
 */

import type { CompactionRecord, HistoryItem, SqlitePersistenceAdapter } from "@anycode/core";
import { COMPACTION_RECORD_MAX_PER_SESSION, compactionRecordsDiscardedByRewind } from "@anycode/core";

/** What Session needs: a live cache for the handshake, fire-and-forget writes for events. */
export interface CompactionRecordSeam {
  /** Records one outcome; never throws, never blocks the caller. */
  record(record: CompactionRecord): void;
  /**
   * The sequence the NEXT record will get, minus one — i.e. "how many outcomes
   * have been recorded so far". Sampled at a turn's start and stored on that
   * turn's checkpoint as its rewind boundary (GitHub #36 review 4).
   */
  sequence(): number;
  /**
   * Drops the records a conversation rewind discarded (GitHub #36). `boundary`
   * is the sequence the checkpoint captured at its turn start: everything above
   * it was recorded afterwards, i.e. inside the part of the conversation the
   * rewind throws away. Absent (a checkpoint written before the boundary
   * existed) falls back to judging by `restoredHistory`, see
   * `compactionRecordsDiscardedByRewind`.
   *
   * The live cache is filtered SYNCHRONOUSLY (the post-rewind handshake is sent
   * in the same breath and must not ship a discarded row); storage is dropped
   * behind the same serialized queue, so a later reopen agrees.
   */
  truncate(restoredHistory: readonly HistoryItem[], boundary?: number): void;
  /** The kept records, oldest first — the live cache, safe to read synchronously. */
  list(): readonly CompactionRecord[];
  /** Resolves once every queued write has settled (shutdown ordering). */
  flush(): Promise<void>;
}

/** The store methods this module uses; `SqlitePersistenceAdapter` satisfies it. */
export interface CompactionRecordStore {
  appendCompactionRecord(sessionId: string, record: CompactionRecord): Promise<void>;
  listCompactionRecords(sessionId: string): Promise<CompactionRecord[]>;
  discardCompactionRecords(sessionId: string, ids: readonly string[]): Promise<void>;
  /**
   * The highest sequence this session ever handed out, kept apart from the
   * records themselves (GitHub #36 review 5) — see `load()` for why.
   */
  compactionSeqHighWater(sessionId: string): Promise<number>;
  raiseCompactionSeqHighWater(sessionId: string, seq: number): Promise<void>;
}

export class CompactionRecordLog implements CompactionRecordSeam {
  private cache: CompactionRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  /** Next sequence to hand out; seeded from storage on load so it survives a restart. */
  private nextSeq = 1;

  constructor(
    private readonly store: CompactionRecordStore,
    private readonly sessionId: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.error("[host] compaction record write failed", error),
  ) {}

  /**
   * Fills the cache from storage. A read failure is fail-soft: the session
   * boots with no remembered rows rather than refusing to open.
   */
  async load(): Promise<void> {
    try {
      const stored = await this.store.listCompactionRecords(this.sessionId);
      // Records written before the sequence existed carry none. Number them in
      // stored order (oldest first), never below the previous record's value, so
      // the boundary rule has a strictly increasing total order to work with —
      // and a stored seq is never renumbered. A session that has only legacy
      // records therefore keeps its oldest rows across any boundary, which is
      // the harmless direction (a visible row beats a resurrected summary).
      let seq = 0;
      this.cache = stored
        .map((record) => {
          seq = Math.max(seq + 1, record.seq ?? 0);
          return { ...record, seq };
        })
        .slice(-COMPACTION_RECORD_MAX_PER_SESSION);
      // The counter is NOT derived from the survivors alone (GitHub #36 review
      // 5): a rewind deletes records, and a number that a still-live checkpoint
      // already covers as "before my snapshot" must never be handed out again —
      // rewinding to that checkpoint would then keep the newer row and resurrect
      // a discarded summary. The durable high-water mark can only move forward.
      const highWater = await this.store.compactionSeqHighWater(this.sessionId);
      const highest = this.cache.at(-1)?.seq ?? 0;
      this.nextSeq = Math.max(highWater, highest) + 1;
      // Legacy rows numbered above the stored mark (a database written before
      // the mark existed) must lift it, or deleting them would restart the
      // counter below numbers a live checkpoint already covers.
      if (highest > highWater) {
        this.writes = this.writes
          .then(() => this.store.raiseCompactionSeqHighWater(this.sessionId, highest))
          .catch((error: unknown) => {
            this.onError(error);
          });
      }
    } catch (error) {
      this.onError(error);
      this.cache = [];
      this.nextSeq = 1;
    }
  }

  sequence(): number {
    return this.nextSeq - 1;
  }

  record(record: CompactionRecord): void {
    // Snapshot NOW: the caller's object must not be readable/writable by a
    // later mutation while the write is queued. The sequence is assigned HERE
    // (the store owns the counter), never by the caller.
    const snapshot = structuredClone({ ...record, seq: record.seq ?? this.nextSeq });
    this.nextSeq = Math.max(this.nextSeq + 1, (snapshot.seq ?? 0) + 1);
    this.cache = [...this.cache, snapshot].slice(-COMPACTION_RECORD_MAX_PER_SESSION);
    this.writes = this.writes
      // The mark is raised BEFORE the row is written: a crash between the two
      // skips a number (harmless — nothing is kept that a boundary would
      // misread), while the reverse order could reuse one.
      .then(() => this.store.raiseCompactionSeqHighWater(this.sessionId, snapshot.seq ?? 0))
      .then(() => this.store.appendCompactionRecord(this.sessionId, snapshot))
      .catch((error: unknown) => {
        this.onError(error);
      });
  }

  /**
   * Rewind cutoff: the cache is filtered SYNCHRONOUSLY so the very next
   * handshake already excludes the discarded rows, and storage drops the same
   * ids behind the serialized queue so a later reopen agrees. Deliberately does
   * NOT touch the sequence high-water mark — deleted rows free no numbers.
   */
  truncate(restoredHistory: readonly HistoryItem[], boundary?: number): void {
    const discarded = new Set(compactionRecordsDiscardedByRewind(this.cache, restoredHistory, boundary));
    if (discarded.size === 0) return;
    this.cache = this.cache.filter((record) => !discarded.has(record.id));
    const ids = [...discarded];
    this.writes = this.writes
      .then(() => this.store.discardCompactionRecords(this.sessionId, ids))
      .catch((error: unknown) => {
        this.onError(error);
      });
  }

  list(): readonly CompactionRecord[] {
    return this.cache;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}

/** Builds the live seam for a session whose row already exists. */
export async function createCompactionRecordLog(
  adapter: () => SqlitePersistenceAdapter | null,
  sessionId: string,
  onError?: (error: unknown) => void,
): Promise<CompactionRecordSeam | undefined> {
  const store = adapter();
  if (store === null) return undefined;
  const log = new CompactionRecordLog(store, sessionId, onError);
  await log.load();
  return log;
}

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

import type { CompactionRecord, SqlitePersistenceAdapter } from "@anycode/core";
import { COMPACTION_RECORD_MAX_PER_SESSION } from "@anycode/core";

/** What Session needs: a live cache for the handshake, fire-and-forget writes for events. */
export interface CompactionRecordSeam {
  /** Records one outcome; never throws, never blocks the caller. */
  record(record: CompactionRecord): void;
  /** The kept records, oldest first — the live cache, safe to read synchronously. */
  list(): readonly CompactionRecord[];
  /** Resolves once every queued write has settled (shutdown ordering). */
  flush(): Promise<void>;
}

/** The store methods this module uses; `SqlitePersistenceAdapter` satisfies it. */
export interface CompactionRecordStore {
  appendCompactionRecord(sessionId: string, record: CompactionRecord): Promise<void>;
  listCompactionRecords(sessionId: string): Promise<CompactionRecord[]>;
}

export class CompactionRecordLog implements CompactionRecordSeam {
  private cache: CompactionRecord[] = [];
  private writes: Promise<void> = Promise.resolve();

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
      this.cache = (await this.store.listCompactionRecords(this.sessionId)).slice(-COMPACTION_RECORD_MAX_PER_SESSION);
    } catch (error) {
      this.onError(error);
      this.cache = [];
    }
  }

  record(record: CompactionRecord): void {
    // Snapshot NOW: the caller's object must not be readable/writable by a
    // later mutation while the write is queued.
    const snapshot = structuredClone(record);
    this.cache = [...this.cache, snapshot].slice(-COMPACTION_RECORD_MAX_PER_SESSION);
    this.writes = this.writes
      .then(() => this.store.appendCompactionRecord(this.sessionId, snapshot))
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

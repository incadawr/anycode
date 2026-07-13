/**
 * Host-owned bridge between the live Codex `item/*` stream and the additive
 * `codex_thread_items` SQLite table (cut §2(e), TASK.42). `record()` is
 * fire-and-forget — mirrors `WriteBehindHistorySink`'s posture: a shadow-log
 * write must never block or fail a live turn, so a failure is logged and
 * swallowed, never thrown into `runTurn()`.
 */

import type { SqlitePersistenceAdapter } from "@anycode/core";
import type { ShadowCommandItem } from "./history-projection.js";

export interface CodexShadowLogPort {
  /** Fire-and-forget: called synchronously from the live notification stream, never awaited by the caller. */
  record(threadId: string, itemId: string, item: ShadowCommandItem): void;
  /** Full log for one thread, ordered by (turnOrdinal, positionInTurn) — the resume-projection merge input. */
  list(threadId: string): Promise<ShadowCommandItem[]>;
}

export class SqliteCodexShadowLog implements CodexShadowLogPort {
  constructor(private readonly persistence: SqlitePersistenceAdapter) {}

  record(threadId: string, itemId: string, item: ShadowCommandItem): void {
    void this.persistence.recordCodexThreadItem(threadId, { ...item, itemId }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[codex] shadow log write failed for thread ${threadId} item ${itemId}: ${message}`);
    });
  }

  async list(threadId: string): Promise<ShadowCommandItem[]> {
    const rows = await this.persistence.listCodexThreadItems(threadId);
    // itemId is a DB-internal dedup key (primary key part); the pure
    // projection's ShadowCommandItem type never needed it (cut §3.6 — a
    // shadow item's HistoryItem id is derived from (turnOrdinal, positionInTurn)).
    return rows.map(({ itemId: _itemId, ...rest }) => rest);
  }
}

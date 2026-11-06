import { mergeRuntimeHistory, type HistoryItem, type RuntimeSessionSnapshot, type SqlitePersistenceAdapter } from "@anycode/core";

/** Session-owned canonical history; native/model snapshots always belong to one current segment. */
export class RuntimeSessionHistory {
  constructor(readonly store: SqlitePersistenceAdapter, readonly sessionId: string) {}
  state(): RuntimeSessionSnapshot { return this.store.ensureRuntimeSession(this.sessionId); }
  snapshot(live: readonly HistoryItem[]): RuntimeSessionSnapshot {
    const state = this.state();
    return { ...state, items: mergeRuntimeHistory(state.items,state.activeSegmentId,live,state.handoff) };
  }
}

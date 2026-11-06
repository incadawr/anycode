import { type HistoryItem, type RuntimeSessionSnapshot, type SqlitePersistenceAdapter } from "@anycode/core";
import type { SessionEngine, RunTurnOptions } from "./engines/session-engine.js";

/** Session-owned canonical history; every checked native read belongs to one current segment. */
export class RuntimeSessionHistory {
  constructor(readonly store: SqlitePersistenceAdapter, readonly sessionId: string) {}
  state(): RuntimeSessionSnapshot { return this.store.ensureRuntimeSession(this.sessionId); }
  snapshot(live: readonly HistoryItem[]): RuntimeSessionSnapshot {
    const state = this.state();
    this.store.reconcileRuntimeInputs(this.sessionId,state.activeSegmentId,live);
    this.store.mergeRuntimeTranscript(this.sessionId,state.activeSegmentId,live);
    return this.state();
  }
  async readTranscript(engine: SessionEngine): Promise<readonly HistoryItem[]> {
    const state = this.state();
    const active = state.segments.find(segment => segment.id === state.activeSegmentId)!;
    // A fresh native allocation has no resumable artifact to read until input
    // is dispatched. The journal proves whether a checked reconciliation is needed.
    if (engine.id !== "core" && active.nativeState === "fresh" && !this.store.runtimeInputRecoveryNeeded(this.sessionId,active.id)) return engine.historyItems();
    return engine.readTranscript?.() ?? engine.historyItems();
  }
  async hydrate(engine: SessionEngine): Promise<RuntimeSessionSnapshot> {
    try { return this.snapshot(await this.readTranscript(engine)); }
    catch (error) {
      const state = this.state();
      this.store.reconcileRuntimeInputs(this.sessionId,state.activeSegmentId,[]);
      throw error;
    }
  }
  prepare(turnId: string, original: string, input: string, genuineUser: boolean): { text: string; hooks: Pick<RunTurnOptions,"onInputDispatched" | "onInputAccepted"> } {
    const state = this.state();
    const text = this.store.prepareRuntimeInput(this.sessionId,turnId,original,input,genuineUser);
    return { text, hooks: {
      onInputDispatched: () => this.store.transitionRuntimeInput(this.sessionId,state.activeSegmentId,turnId,"dispatching"),
      onInputAccepted: nativeId => this.store.transitionRuntimeInput(this.sessionId,state.activeSegmentId,turnId,"accepted",nativeId),
    } };
  }
  assertSettled(): void {
    const state = this.state();
    if (this.store.runtimeInputRecoveryNeeded(this.sessionId,state.activeSegmentId)) throw new Error("Conversation import acceptance is uncertain. Recovery is required.");
  }
}

/** Disabling new switches must never strand an already committed conversation. */
export function createRuntimeSessionHistory(store: SqlitePersistenceAdapter, sessionId: string, enabled: boolean, child = false): RuntimeSessionHistory | undefined {
  if (child || (!enabled && (store.loadRuntimeSession(sessionId)?.revision ?? 0) === 0)) return undefined;
  return new RuntimeSessionHistory(store,sessionId);
}

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
  async hydrate(engine: SessionEngine): Promise<RuntimeSessionSnapshot> {
    return this.snapshot(await (engine.readTranscript?.() ?? Promise.resolve(engine.historyItems())));
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
    if (state.handoff?.state === "uncertain" || state.handoff?.state === "dispatching") throw new Error("Conversation import acceptance is uncertain. Recovery is required.");
  }
}

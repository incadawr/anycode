import { type HistoryItem, type RuntimeSettings, type RuntimeSessionSnapshot, type SqlitePersistenceAdapter } from "@anycode/core";
import type { SessionEngine, RunTurnOptions } from "./engines/session-engine.js";
import { capImportPrompt } from "./engine-switch.js";

/** Session-owned canonical history; every checked native read belongs to one current segment. */
export class RuntimeSessionHistory {
  constructor(readonly store: SqlitePersistenceAdapter, readonly sessionId: string) {}
  state(): RuntimeSessionSnapshot { return this.store.ensureRuntimeSession(this.sessionId); }
  settings(selected: RuntimeSettings, applied: RuntimeSettings): void {
    const state = this.state();
    this.store.updateRuntimeSettings(this.sessionId,state.activeSegmentId,selected,applied);
  }
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
    try {
      this.snapshot(await this.readTranscript(engine));
      const state = this.state();
      for (const input of this.store.runtimeInputRecoveries(this.sessionId,state.activeSegmentId)) {
        if (input.state !== "pending" && await engine.verifyInputAbsent?.(input.input)) this.store.resetRuntimeInput(this.sessionId,state.activeSegmentId,input.turnId);
      }
      return this.state();
    }
    catch (error) {
      const state = this.state();
      this.store.reconcileRuntimeInputs(this.sessionId,state.activeSegmentId,[]);
      throw error;
    }
  }
  prepare(turnId: string, original: string, input: string, genuineUser: boolean, budgetBytes?: number): { text: string; hooks: Pick<RunTurnOptions,"onInputDispatched" | "onInputAccepted" | "onInputNotSent"> } {
    const state = this.state();
    const payload = genuineUser && state.handoff?.state === "pending" && budgetBytes !== undefined
      ? capImportPrompt(state.handoff.payload,budgetBytes - Buffer.byteLength(input,"utf8") - 32) : undefined;
    const text = this.store.prepareRuntimeInput(this.sessionId,turnId,original,input,genuineUser,payload);
    return { text, hooks: {
      onInputDispatched: () => this.store.transitionRuntimeInput(this.sessionId,state.activeSegmentId,turnId,"dispatching"),
      onInputAccepted: nativeId => this.store.transitionRuntimeInput(this.sessionId,state.activeSegmentId,turnId,"accepted",nativeId),
      onInputNotSent: () => this.store.resetRuntimeInput(this.sessionId,state.activeSegmentId,turnId),
    } };
  }
  recoveries() { const state = this.state(); return this.store.runtimeInputRecoveries(this.sessionId,state.activeSegmentId); }
  discard(turnId: string): void { const state = this.state(); this.store.resetRuntimeInput(this.sessionId,state.activeSegmentId,turnId,true); }
  requiresRecovery(): boolean { const handoff = this.state().handoff; return handoff?.state === "dispatching" || handoff?.state === "uncertain"; }
  assertSettled(): void {
    if (this.requiresRecovery()) throw new Error("Conversation import acceptance is uncertain. Recovery is required.");
  }
}

/** Disabling new switches must never strand an already committed conversation. */
export function createRuntimeSessionHistory(store: SqlitePersistenceAdapter, sessionId: string, enabled: boolean, child = false): RuntimeSessionHistory | undefined {
  if (child || (!enabled && (store.loadRuntimeSession(sessionId)?.revision ?? 0) === 0)) return undefined;
  return new RuntimeSessionHistory(store,sessionId);
}

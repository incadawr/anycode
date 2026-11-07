import { useEffect } from "react";
import type { ClaudeDoctorReport } from "../../shared/claude-doctor.js";
import type { EngineModelChoice } from "../../shared/protocol.js";
import { CLAUDE_DRAFT_MODELS } from "./claude-draft-models.js";
import { useTabsStore } from "./tabs-store.js";

type Snapshot = { report: ClaudeDoctorReport };
/** Subscribe first; a pushed account verdict supersedes any pending invoke. */
export function startClaudeCatalogRefresh(bridge: {
  recheck(): Promise<Snapshot>;
  onSnapshotChanged(callback: (snapshot: Snapshot) => void): () => void;
}, setModels: (models: readonly EngineModelChoice[]) => void, current: readonly EngineModelChoice[] = [], confirmedAt = 0): () => void {
  let active = true, pushed = false;
  if (!current.length) setModels(CLAUDE_DRAFT_MODELS);
  const apply = ({ report }: Snapshot) => {
    if (active) setModels(report.status === "ready" && report.models?.length ? report.models : CLAUDE_DRAFT_MODELS);
  };
  const unsubscribe = bridge.onSnapshotChanged(snapshot => { pushed = true; apply(snapshot); });
  if (Date.now() - confirmedAt >= 60_000) void bridge.recheck().then(snapshot => { if (!pushed) apply(snapshot); }, () => { if (!pushed) apply({ report: { status: "error" } }); });
  return () => { active = false; unsubscribe(); };
}
export function useClaudeDraftModels(enabled: boolean) {
  const models = useTabsStore(state => state.claudeModels);
  useEffect(() => {
    if (!enabled || !window.anycode.claude?.onSnapshotChanged) return;
    const state = useTabsStore.getState();
    return startClaudeCatalogRefresh(window.anycode.claude, value => useTabsStore.getState().setClaudeModels(value), state.claudeModels, state.claudeCatalogConfirmedAt);
  }, [enabled]);
  return models.length ? models : CLAUDE_DRAFT_MODELS;
}

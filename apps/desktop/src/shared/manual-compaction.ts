import type { EngineId } from "./engines.js";

export function manualCompactionUnavailableReason(engineId: EngineId, childSurface: boolean): string {
  if (childSurface) return "Manual compaction is not available in child sessions.";
  if (engineId === "codex") return "Manual compaction is unavailable for this Codex app-server. Update Codex and start a new session.";
  return "Manual compaction is not available in this session.";
}

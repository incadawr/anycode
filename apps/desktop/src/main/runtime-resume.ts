import type { SessionMeta } from "@anycode/core";
import type { EngineId } from "../shared/engines.js";

/** Durable identity is chosen before readiness checks and before any fork. */
export function runtimeResumeIdentity(row: Pick<SessionMeta,"engineId" | "model" | "mode">) {
  const engine = row.engineId ?? "core";
  if (engine !== "core" && engine !== "codex" && engine !== "claude") throw new Error("Unsupported session engine");
  return {engine:engine as EngineId,engineModel:row.model,enginePreset:row.mode,modelOverride:engine === "core" ? row.model : undefined};
}

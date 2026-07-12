/**
 * Value-free engine identity shared by main, host, and future renderer wiring.
 * This is deliberately not a dynamic plugin manifest: only reviewed engines
 * compiled into the desktop application can appear here.
 */

export const ENGINE_IDS = ["core", "codex"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export function isEngineId(value: string | undefined): value is EngineId {
  return value !== undefined && (ENGINE_IDS as readonly string[]).includes(value);
}

export const ENV_ENGINE = "ANYCODE_ENGINE";

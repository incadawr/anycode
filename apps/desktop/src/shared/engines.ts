/**
 * Value-free engine identity shared by main, host, and future renderer wiring.
 * This is deliberately not a dynamic plugin manifest: only reviewed engines
 * compiled into the desktop application can appear here.
 */

export const ENGINE_IDS = ["core", "codex", "claude"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export function isEngineId(value: string | undefined): value is EngineId {
  return value !== undefined && (ENGINE_IDS as readonly string[]).includes(value);
}

export const ENV_ENGINE = "ANYCODE_ENGINE";
/** Absolute main-validated Codex CLI path passed only to the host process. */
export const ENV_CODEX_BIN = "ANYCODE_CODEX_BIN";
/** Absolute main-validated Claude Code CLI path (SLICE-CC A1) — mirrors ENV_CODEX_BIN; wired to the host process starting CC-C. */
export const ENV_CLAUDE_BIN = "ANYCODE_CLAUDE_BIN";
/** Main-owned utility-process generation; never trusted from renderer input. */
export const ENV_HOST_GENERATION = "ANYCODE_HOST_GENERATION";

export const ENGINE_PROCESS_REGISTRATION_TYPE = "anycode:engine-process";

/** Exact process ownership facts reported from a host to main. */
export interface EngineProcessRegistration {
  hostPid: number;
  generation: number;
  enginePid: number;
  pgid: number;
}

export type EngineProcessRegistrationMessage =
  & { type: typeof ENGINE_PROCESS_REGISTRATION_TYPE }
  & EngineProcessRegistration;

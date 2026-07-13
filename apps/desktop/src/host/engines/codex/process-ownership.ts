/** Host-side, typed bridge for the future Codex bootstrap to report ownership. */

import {
  ENGINE_PROCESS_REGISTRATION_TYPE,
  ENV_HOST_GENERATION,
  type EngineProcessRegistrationMessage,
} from "../../../shared/engines.js";

export interface HostProcessOwnership {
  hostPid: number;
  generation: number;
  report(message: EngineProcessRegistrationMessage): void;
}

export function readHostProcessOwnership(
  env: NodeJS.ProcessEnv,
  hostPid: number,
  report: (message: EngineProcessRegistrationMessage) => void,
): HostProcessOwnership | null {
  const raw = env[ENV_HOST_GENERATION];
  const generation = raw === undefined ? NaN : Number(raw);
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0 || !Number.isSafeInteger(generation) || generation <= 0) {
    return null;
  }
  return { hostPid, generation, report };
}

/** Exposed only to make the message shape explicit at the host/main boundary. */
export { ENGINE_PROCESS_REGISTRATION_TYPE };

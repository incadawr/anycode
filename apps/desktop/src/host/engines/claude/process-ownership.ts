/**
 * Host-side, typed bridge for the Claude engine bootstrap to report ownership.
 *
 * Duplicated on purpose from host/engines/codex/process-ownership.ts (cut
 * §1.3: "дословный дубликат... межкаталожный импорт codex→claude создал бы
 * связность, которой шов избегает"). Both engine directories import ONLY the
 * shared, value-only `shared/engines.ts` — never each other.
 */

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

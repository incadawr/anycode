/**
 * Static registry for reviewed, compile-time engines. This is intentionally
 * not a dynamic plugin loader: later engine bootstraps are still linked into
 * the host binary and can be audited with the rest of its process authority.
 */

import type { SessionEngine } from "./session-engine.js";
import { ENV_ENGINE, isEngineId, type EngineId } from "../../shared/engines.js";

export type { EngineId } from "../../shared/engines.js";

export interface EngineAvailability {
  available: boolean;
  reason?: string;
}

/** Engine-specific bootstrap data is supplied only by the host composition root. */
export interface EngineProbeContext {}

export interface EngineBootContext {
  /** E1 only wires the existing CoreEngine; E2 replaces this with dedicated bootstraps. */
  coreEngine?: SessionEngine;
}

export interface BootedEngine {
  engine: SessionEngine;
}

export interface EnginePlugin {
  readonly id: EngineId;
  probe(ctx: EngineProbeContext): Promise<EngineAvailability>;
  boot(ctx: EngineBootContext): Promise<BootedEngine>;
}

const corePlugin: EnginePlugin = {
  id: "core",
  async probe(): Promise<EngineAvailability> {
    return { available: true };
  },
  async boot(ctx: EngineBootContext): Promise<BootedEngine> {
    if (ctx.coreEngine?.id !== "core") {
      throw new Error("Core engine bootstrap was not provided");
    }
    return { engine: ctx.coreEngine };
  },
};

/** Placeholder registration keeps selection validation explicit before E3 ships. */
const codexPlugin: EnginePlugin = {
  id: "codex",
  async probe(): Promise<EngineAvailability> {
    return { available: false, reason: "Codex engine is not installed in this build" };
  },
  async boot(): Promise<BootedEngine> {
    throw new Error("Codex engine is not installed in this build");
  },
};

export const ENGINE_REGISTRY: ReadonlyMap<EngineId, EnginePlugin> = new Map([
  [corePlugin.id, corePlugin],
  [codexPlugin.id, codexPlugin],
]);

export function getEnginePlugin(id: string): EnginePlugin | undefined {
  return ENGINE_REGISTRY.get(id as EngineId);
}

/** Host-side selection is fail-closed before any provider-dependent boot work. */
export function selectEnginePlugin(env: NodeJS.ProcessEnv): EnginePlugin {
  const requested = env[ENV_ENGINE];
  if (requested === undefined || requested === "") {
    return corePlugin;
  }
  if (!isEngineId(requested)) {
    throw new Error(`Unknown session engine: ${requested}`);
  }
  return ENGINE_REGISTRY.get(requested)!;
}

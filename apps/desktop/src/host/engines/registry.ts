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
  /** Core composition retains the existing AgentLoop-owned engine. */
  coreEngine?: SessionEngine;
  /** Codex composition supplies an already-connected native lifecycle owner. */
  codexEngine?: SessionEngine;
  /** Claude composition supplies an already-connected native lifecycle owner (wired starting CC-C; unused until then). */
  claudeEngine?: SessionEngine;
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

/**
 * Statically linked first-party adapter. Process construction stays in the host
 * composition root, after its bootstrap scope exists, so a failed native start
 * has an owned cleanup path.
 */
const codexPlugin: EnginePlugin = {
  id: "codex",
  async probe(): Promise<EngineAvailability> {
    return { available: true };
  },
  async boot(ctx: EngineBootContext): Promise<BootedEngine> {
    if (ctx.codexEngine?.id !== "codex") {
      throw new Error("Codex engine bootstrap was not provided");
    }
    return { engine: ctx.codexEngine };
  },
};

/**
 * Statically linked first-party adapter (SLICE-CC A1, cut §1.2). CC-A only
 * registers identity — `boot()` throwing unconditionally is correct and
 * intentional here: `host/index.ts`'s boot switch has no `claude` branch
 * until CC-C wires `bootClaude`, and `main/tabs.ts`'s `canSpawn("claude")`
 * refuses every spawn attempt unconditionally before this plugin's `boot()`
 * could ever be reached in practice.
 */
const claudePlugin: EnginePlugin = {
  id: "claude",
  async probe(): Promise<EngineAvailability> {
    return { available: true };
  },
  async boot(ctx: EngineBootContext): Promise<BootedEngine> {
    if (ctx.claudeEngine?.id !== "claude") {
      throw new Error("Claude engine bootstrap was not provided");
    }
    return { engine: ctx.claudeEngine };
  },
};

export const ENGINE_REGISTRY: ReadonlyMap<EngineId, EnginePlugin> = new Map([
  [corePlugin.id, corePlugin],
  [codexPlugin.id, codexPlugin],
  [claudePlugin.id, claudePlugin],
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

import { engineSwitchRequestSchema } from "../shared/protocol.js";
import type { SessionOptions, SwitchRuntime } from "./session.js";
import type { CoreEngineOptions } from "./engines/core-engine.js";
import type { CodexLaunchOptions, ClaudeLaunchOptions } from "./engine-launch-options.js";
import { prepareSwitchRuntime, type SwitchRuntimeConfig } from "./engine-switch-runtime.js";
import { createCoreRuntimeServices, type CoreRuntimeServicesDependencies } from "./core-runtime-services.js";

export interface SwitchEngineRequestContext {
  workspace: string;
  sessionId: string;
  model: string;
}

/** Resolvers are trusted host code, scoped to this session's connection/profile and posture. */
export interface SwitchEngineFactoryContext {
  engineSwitchEnabled?: boolean;
  workspace: string;
  sessionId: string;
  resolveCore(request: SwitchEngineRequestContext): Promise<{ model: string; options: CoreEngineOptions; services?: Omit<CoreRuntimeServicesDependencies,"config">; cleanup?: () => void | Promise<void>; configure?: (runtime: SwitchRuntime) => void } | undefined>;
  resolveCodex(request: SwitchEngineRequestContext): Promise<{ options: CodexLaunchOptions; cleanup?: () => void | Promise<void>; configure?: (runtime: SwitchRuntime) => void } | undefined>;
  resolveClaude(request: SwitchEngineRequestContext): Promise<{ options: ClaudeLaunchOptions; cleanup?: () => void | Promise<void>; configure?: (runtime: SwitchRuntime) => void } | undefined>;
}

export function createSwitchEngineFactory(ctx: SwitchEngineFactoryContext): SessionOptions["switchEngineFactory"] {
  if (ctx.engineSwitchEnabled !== true) return undefined;
  return async (engine, model) => {
    const parsed = engineSwitchRequestSchema.safeParse({ type: "engine_switch_request", requestId: "host", engine, model });
    if (!parsed.success) throw new Error("Invalid engine switch selection");
    const request = { workspace: ctx.workspace, sessionId: ctx.sessionId, model: parsed.data.model };
    let config: SwitchRuntimeConfig;
    switch (engine) {
      case "core": {
        const resolved = await ctx.resolveCore(request);
        if (!resolved || resolved.model !== request.model) throw new Error(`Requested model ${request.model} is unavailable for core`);
        const services = resolved.services ? await createCoreRuntimeServices({...resolved.services,config:resolved.options.config}) : undefined;
        config = { engine, options: resolved.options, cleanup: resolved.cleanup, configure: runtime => {
          resolved.configure?.(runtime);
          if (services) {
            runtime.callbacks = {...runtime.callbacks,...services.callbacks};
            runtime.presentation = {...runtime.presentation,...services.presentation};
          }
        } };
        break;
      }
      case "codex": {
        const resolved = await ctx.resolveCodex(request);
        if (!resolved) throw new Error("Codex launch configuration is unavailable");
        config = { engine, model: request.model, ...resolved };
        break;
      }
      case "claude": {
        const resolved = await ctx.resolveClaude(request);
        if (!resolved) throw new Error("Claude launch configuration is unavailable");
        config = { engine, model: request.model, ...resolved };
        break;
      }
    }
    const runtime = await prepareSwitchRuntime(config);
    if (engine === "core") runtime.identity = { model: request.model, mode: runtime.engine.mode() };
    return runtime;
  };
}

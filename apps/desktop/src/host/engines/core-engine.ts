/** Built-in engine adapter. Every method delegates to the retained core object. */

import type { AgentLoop, AgentLoopConfig } from "@anycode/core";
import type {
  EngineCapabilities,
  ModelSwitchResult,
  RunTurnOptions,
  SessionEngine,
} from "./session-engine.js";
import { CORE_ENGINE_CAPABILITIES } from "./session-engine.js";
import type { ReasoningEffort } from "@anycode/core";

export interface CoreEngineOptions {
  loop: AgentLoop;
  config: AgentLoopConfig;
  switchModelImpl?: (id: string, effort: ReasoningEffort) => ModelSwitchResult;
  capabilities?: EngineCapabilities;
}

/**
 * Keeps the existing AgentLoop and config object by reference. It must never
 * cache or copy core state: Session's old between-turn mutations were visible
 * to the loop through precisely this shared config object.
 */
export class CoreEngine implements SessionEngine {
  readonly id = "core" as const;
  readonly capabilities: EngineCapabilities;
  readonly switchModel: SessionEngine["switchModel"];

  constructor(private readonly options: CoreEngineOptions) {
    this.capabilities = options.capabilities ?? CORE_ENGINE_CAPABILITIES;
    this.switchModel = options.switchModelImpl;
  }

  mode() {
    return this.options.config.mode;
  }

  setMode(mode: AgentLoopConfig["mode"]): void {
    this.options.config.mode = mode;
  }

  reasoningEffort() {
    return this.options.config.reasoningEffort;
  }

  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    this.options.config.reasoningEffort = effort;
  }

  runTurn(input: string, options: RunTurnOptions) {
    return this.options.loop.runTurn(input, options);
  }

  continueTurn(options: RunTurnOptions) {
    return this.options.loop.continueTurn(options);
  }

  historyItems() {
    return this.options.loop.history.items;
  }

  replaceHistory(items: Parameters<NonNullable<SessionEngine["replaceHistory"]>>[0]): void {
    this.options.loop.history.replaceAll(items);
  }

  contextBreakdown() {
    return this.options.loop.contextBreakdown();
  }

  async dispose(_reason: "session-close" | "host-shutdown"): Promise<void> {
    // Core child lifecycles remain owned by the existing host managers.
  }
}

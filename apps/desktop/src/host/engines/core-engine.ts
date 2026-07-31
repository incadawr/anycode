/** Built-in engine adapter. Every method delegates to the retained core object. */

import type { AgentEvent, AgentLoop, AgentLoopConfig } from "@anycode/core";
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
  /**
   * Awaited before every new user turn is handed to the loop (subagent-model
   * design: a profile authored into `.anycode/agents/` during a live session
   * must become callable without a restart, and re-scanning is host-only
   * wiring the core loop knows nothing about). Fail-soft by contract: a
   * throwing hook must never block the turn it was meant to precede, so the
   * failure is logged and swallowed here rather than propagated.
   */
  onBeforeTurn?: () => Promise<void>;
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

  async *runTurn(input: string, options: RunTurnOptions): AsyncGenerator<AgentEvent> {
    // onBeforeTurn runs on every NEW user turn only (never continueTurn — a
    // rehost's terminal-control continuation is not "the start of a turn").
    // Awaited before the loop sees the input so a just-rescanned profile is
    // already live by the time this turn's Agent tool calls could reach it.
    if (this.options.onBeforeTurn) {
      try {
        await this.options.onBeforeTurn();
      } catch (error) {
        console.warn(
          `[core-engine] onBeforeTurn failed, continuing the turn unchanged: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    yield* this.options.loop.runTurn(input, options);
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

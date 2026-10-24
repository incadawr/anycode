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
  /**
   * TASK.162 (§0b adjudication): notifies the host that the USER selected a
   * reasoning tier, so the host can keep its own `selectedEffort` cell current
   * for anything that must re-resolve against the selected tier later — the
   * child-model settings resolver at subagent spawn, above all.
   *
   * At THIS seam `undefined` unambiguously means the user selected "off":
   * Session maps off -> undefined before calling `setReasoningEffort`, and a
   * tier merely suppressed by the current model's capabilities never travels
   * through this method (the model switch re-resolves that separately, from
   * the preserved tier). That is precisely why the cell it feeds stays a
   * faithful SELECTED tier rather than model-effective state.
   *
   * Additive-optional: no subscriber => behavior byte-identical.
   */
  onReasoningEffortSet?: (effort: ReasoningEffort | undefined) => void;
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

  /**
   * Routes through the loop (TASK.37), not a bare config write: the loop
   * mutates the same shared config object AND the in-flight turn's dispatch
   * context, so a mid-turn change reaches the next permission check. Between
   * turns this is behavior-identical to the old `config.mode = mode`.
   */
  setMode(mode: AgentLoopConfig["mode"]): void {
    this.options.loop.setMode(mode);
  }

  reasoningEffort() {
    return this.options.config.reasoningEffort;
  }

  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    this.options.config.reasoningEffort = effort;
    this.options.onReasoningEffortSet?.(effort);
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
    try {
      yield* this.options.loop.runTurn(input, options);
    } finally {
      this.failUndeliveredSteers();
    }
  }

  continueTurn(options: RunTurnOptions) {
    // TASK.117: continueTurn's AgentLoop path appends no user frame, but the
    // resumed steps' assistant/tool items still get {turnId, step} stamps —
    // options pass through verbatim, exactly like runTurn above.
    return this.wrapSteerLifecycle(this.options.loop.continueTurn(options));
  }

  /**
   * TASK.123 (Taskana 4110): pending steer waiters — one entry per in-flight
   * `steer()` call, resolved with the step ordinal the loop delivered the
   * frame after, or rejected when the frame never landed. Drained by
   * `failUndeliveredSteers` from the engine's own turn generators' `finally`
   * (a turn that ends before the flush kills its undelivered steers).
   */
  private readonly pendingSteerWaiters = new Set<(step: number) => void>();

  /** Wraps a loop generator so undelivered steers fail when the turn ends. */
  private wrapSteerLifecycle(events: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    const self = this;
    return (async function* () {
      try {
        yield* events;
      } finally {
        self.failUndeliveredSteers();
      }
    })();
  }

  /** Rejects every waiter still registered at turn end (slot died with the turn). */
  private failUndeliveredSteers(): void {
    for (const waiter of this.pendingSteerWaiters) {
      this.pendingSteerWaiters.delete(waiter);
      waiter(-1);
    }
  }

  steeringStatus(): { supported: boolean; ready: boolean } {
    return { supported: true, ready: this.options.loop.hasActiveTurn() };
  }

  /**
   * TASK.123 (Taskana 4110): force-delivers `input` into the RUNNING turn via
   * the loop's deferred-injection slot. Resolves only once the loop has
   * actually flushed the frame at the legal seam — `{ turnId: "core:step:N" }`
   * names the step whose results the frame follows (self-describing, never
   * collides with host UUIDs; the engine does not own the host turnId).
   * Rejects with "No active core turn" when called idle, and with "core turn
   * ended before injection" / "superseded by a newer steer" when the frame
   * never landed.
   */
  async steer(input: string): Promise<{ turnId: string }> {
    return new Promise<{ turnId: string }>((resolve, reject) => {
      let settled = false;
      const registered = (step: number): void => {
        if (settled) return;
        settled = true;
        this.pendingSteerWaiters.delete(registered);
        if (step === -1) {
          // The slot never delivered THIS frame — either a newer steer
          // overwrote it (the loop's last-value-wins callback) or the turn
          // ended first (failUndeliveredSteers). The engine treats both as
          // "never landed"; the message keeps the brief's wording.
          reject(new Error("core turn ended before injection"));
          return;
        }
        resolve({ turnId: `core:step:${step}` });
      };
      this.pendingSteerWaiters.add(registered);
      const queued = this.options.loop.queueInjection(input, registered);
      if (!queued) {
        this.pendingSteerWaiters.delete(registered);
        settled = true;
        reject(new Error("No active core turn"));
      }
    });
  }

  compactNow(options: { signal: AbortSignal }) {
    return this.options.loop.compactNow(options);
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

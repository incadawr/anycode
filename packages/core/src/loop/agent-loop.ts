/**
 * Hand-written agent loop (no SDK multi-step magic). runTurn drives a for(;;):
 *   - UserPromptSubmit hooks run at entry, before the user message is written;
 *     any additionalContext is appended inside a <hook-context> tag (§2.10).
 *   - at the start of each iteration the ContextManager runs microcompact then
 *     (if over budget) transactional LLM auto-compaction (§2.6); the turn signal
 *     is linked so a Stop during compaction is a clean cancel (history untouched).
 *   - each iteration performs exactly ONE ModelPort.streamText step (the port
 *     pins stopWhen: stepCountIs(1)); stream events are re-emitted as they arrive.
 *   - after finish: provider usage is recorded (noteUsage) and a context_usage
 *     event is emitted (§2.5).
 *   - proposed tool calls are appended as the assistant message (invalid calls
 *     sanitized to input:{}), then dispatched: invalid calls (§2.9) get a
 *     synthesized invalid_input outcome, valid calls run through runToolBatches
 *     (§2.7, parallel read-only batches). Every outcome is written to history in
 *     PROPOSAL order, one tool-role message per call.
 *   - Stop hooks run before every loop_end (fail-open, never block completion).
 *
 * THE INVARIANT (§2.10, closes the latent MVP defect R3): every exit path after
 * an assistant message carrying tool_calls writes an outcome (real or a
 * synthesized cancelled) for EVERY call before loop_end. runToolBatches returns
 * one outcome per call (cancelled included), all are appended before any exit,
 * and emitLoopEnd is a final net that closes any straggler so
 * history.unansweredToolCallIds() is [] at every loop_end.
 *
 * History speaks the own envelope (ConversationHistory / ChatMessage, §2.1-2.2);
 * the system prompt travels per-call as ModelRequest.system.
 */

import type {
  AgentEvent,
  FinishReason,
  LoopEndReason,
  ProposedToolCall,
  TokenUsage,
} from "../types/events.js";
import type { AssistantPart, ChatMessage } from "../types/history.js";
import type { ImageAttachment } from "../types/images.js";
import type { ToolCallOutcome } from "../types/tools.js";
import type { HookRunner } from "../types/hooks.js";
import type { PermissionBroker, PermissionEngine, PermissionMode } from "../types/permissions.js";
import type { CorePorts, ModelPort } from "../ports/index.js";
import type { SubagentPort } from "../ports/subagent.js";
import type { SkillPort } from "../ports/skills.js";
import type { WorkflowPort } from "../ports/workflow.js";
import type { BackgroundTaskPort } from "../ports/tasks.js";
import type { LspPort } from "../ports/lsp.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { WorktreeControlPort } from "../ports/worktrees.js";
import type { CheckpointCapturer, CheckpointCaptureResult } from "../ports/checkpoints.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ConversationHistory } from "../context/history.js";
import { ContextManager } from "../context/manager.js";
import {
  compactThresholdTokens,
  effectiveWindowTokens,
  resolveContextBudgetConfig,
  type ContextBudgetConfig,
} from "../context/budget.js";
import { HeuristicTokenizer, type Tokenizer } from "../context/tokenizer.js";
import { DEFAULT_MAX_TURNS, DEFAULT_TOOL_CONCURRENCY, type ReasoningEffort } from "../types/config.js";
import type { DispatchContext } from "../dispatch/dispatcher.js";
import { runToolBatches, type ToolSchedulerConfig } from "../dispatch/scheduler.js";
import { toToolDeclarations } from "../tools/to-model-tools.js";
import {
  estimateToolDeclarationTokens,
  splitToolDeclarationsByMcpPrefix,
} from "../context/tokens.js";
import { classifyProviderFailure, isModelOutputEvent } from "../provider/failure.js";

function appendSystemContext(systemPrompt: string | undefined, systemContext: string | undefined): string | undefined {
  if (systemContext === undefined || systemContext.length === 0) return systemPrompt;
  if (systemPrompt === undefined || systemPrompt.length === 0) return systemContext;
  return `${systemPrompt}\n\n${systemContext}`;
}

/**
 * Terminal-retry metadata for an `{type:"error"}` event (TASK.33 W7b). Called
 * at yield time for every error event this turn — terminality is not knowable
 * yet (a `finish` may still arrive and forgive it), so every passing error
 * event gets the CURRENT per-turn counters, not just the last one.
 */
function buildRetryMetadata(
  error: unknown,
  attemptsMade: number,
  maxAttempts: number | undefined,
  hadModelOutput: boolean,
): { attemptsMade: number; maxAttempts?: number; retryable: boolean; hadModelOutput: boolean; code: string } {
  const classification = classifyProviderFailure(error);
  return {
    attemptsMade,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    retryable: classification.retryable,
    hadModelOutput,
    code: classification.code,
  };
}

export interface AgentLoopConfig {
  modelPort: ModelPort;
  registry: ToolRegistry;
  hooks: HookRunner;
  permissionEngine: PermissionEngine;
  permissionBroker: PermissionBroker;
  mode: PermissionMode;
  ports: CorePorts;
  cwd: string;
  /** Turn budget for one runTurn call; DEFAULT_MAX_TURNS when omitted. */
  maxTurns?: number;
  /** Passed out-of-band as ModelRequest.system on every step; never enters history. */
  systemPrompt?: string;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Injected for session resume (design §2.10); a fresh empty history when omitted. */
  history?: ConversationHistory;
  /**
   * Token estimator shared by the history and the context manager. When omitted
   * a HeuristicTokenizer is used; the wiring layer (cli/main.ts) injects the
   * higher-fidelity createDefaultTokenizer result and MUST hand the same
   * instance to any pre-built `history` so per-item estimates stay consistent.
   */
  tokenizer?: Tokenizer;
  /** Overrides over the default context budget (design §2.5). */
  context?: Partial<ContextBudgetConfig>;
  /** Parallel cap for read-only tool batches; DEFAULT_TOOL_CONCURRENCY when omitted. */
  toolConcurrency?: number;
  /**
   * In-process subagent entry (design §3.1). Placed into the DispatchContext so
   * the Agent tool can spawn child loops; the emitted subagent_* events flow
   * back out through runToolBatches and are re-yielded by this loop unchanged.
   * Attached via withSubagents(config) before `new AgentLoop`; omitted for a
   * child loop (non-recursion lock). Type-only reference — the loop never
   * imports the runner (subagents/ -> loop/, no back-edge).
   */
  subagents?: SubagentPort;
  /**
   * Discovered-skills entry (design §2.2/§3.3). Placed into the DispatchContext
   * so the Skill tool can load a body lazily. Attached by the CLI/host wiring;
   * omitted for a child loop (children do not inherit skills in v1). Absence is
   * the Skill tool's fail-closed "unavailable" lock.
   */
  skills?: SkillPort;
  /**
   * Declarative-workflow entry (design §2.1/§2.10). Placed into the
   * DispatchContext so the Workflow tool can start a run; the emitted workflow_*
   * events flow back out through runToolBatches and are re-yielded by this loop
   * unchanged. Attached via withWorkflows(config) AFTER withSubagents (the
   * engine runs steps through the parent's SubagentPort); omitted for a child
   * loop (non-recursion lock). Type-only reference — the loop never imports the
   * engine (workflow/ -> loop/, no back-edge).
   */
  workflows?: WorkflowPort;
  /**

   * Placed into the DispatchContext so background-capable Bash / BashOutput /
   * BashKill can reach the session's tasks. Attached by the CLI wiring only

   * (buildChildConfig does not copy it), so children fail closed. Type-only
   * reference — the loop never constructs the manager.
   */
  tasks?: BackgroundTaskPort;
  /**

   * the DispatchContext so the diagnostics-wrapped Edit/Write can query the
   * session's language servers after a successful write. Attached by the CLI

   * does not copy it, so children fail soft. Type-only reference — the loop never
   * constructs the manager.
   */
  lsp?: LspPort;
  /**
   * Live image-capability verdict for the current session model (design

   * image-wrapped Read attaches a picture only when the current model is marked
   * image-capable. Attached by the CLI wiring only (never desktop today);
   * buildChildConfig does not copy it, so a child's Read never attaches an image.
   * Type-only reference — the loop never constructs the closure.
   */
  media?: MediaCapabilityPort;
  /**
   * Parent-host worktree relocation port. Deliberately omitted by child-loop
   * config builders, so only the owning session can relocate itself.
   */
  worktrees?: WorktreeControlPort;
  /**
   * Target mode an approved ExitPlanMode advances to (design slice-4.3-cut.md
   * §2.3). Set => the loop builds a PlanModeControl each turn and threads it
   * through the DispatchContext; unset (desktop today, every child via
   * buildChildConfig) => ToolContext.planMode is absent and the tool fails
   * closed. "plan"/"yolo" are excluded by the type: the transition can neither
   * loop back onto itself nor escalate into the broker-less yolo mode.
   */
  planExitMode?: Exclude<PermissionMode, "plan" | "yolo">;
  /** Notifies the client of a mode change made by the exit arc (CLI: touchSession; desktop consume later). */
  onModeChange?: (mode: PermissionMode) => void;
  /**
   * Lazy per-turn workspace checkpoint (design slice-4.7-cut.md §2.4): built ONLY
   * when the wiring supplied a capturer; absence keeps the turn byte-identical.
   * The loop threads a promise-memoized TurnCheckpointControl through the
   * DispatchContext so the FIRST write-effect tool of the turn (post-permission)
   * captures exactly one checkpoint. Children do NOT inherit it (buildChildConfig
   * is an explicit object): a child's writes are already covered by a checkpoint

   */
  checkpoints?: CheckpointCapturer;
  /**
   * Fire-and-forget observer of every event yielded by runTurn/compactNow
   * (slice 6.6 telemetry seam). Called synchronously immediately before each
   * yield; exceptions are swallowed (an observer can never break a turn); MUST
   * NOT block. Attached by the CLI/host wiring only; buildChildConfig does not
   * copy it, so a child loop never reports directly — child activity reaches
   * the tap as the parent's subagent_* events. Absent => the generators
   * delegate straight through (byte-identical behaviour).
   */
  eventTap?: (event: AgentEvent) => void;
  /**
   * Accounting-only section boundaries of `systemPrompt` (design
   * slice-P7.17-cut.md §2.1, ctx-breakdown). NEVER used to build the prompt
   * itself — `systemPrompt` remains the single string passed to the model
   * unchanged; this is purely metadata for contextBreakdown() to split the
   * base into named categories by subtracting each component's token count
   * from the full systemPrompt estimate. Absent => contextBreakdown()
   * collapses the whole systemPrompt into one "System prompt" category
   * (backward-compatible).
   */
  systemPromptComponents?: ReadonlyArray<{
    kind: "memory" | "skills" | "workflows" | "profiles" | "repoMap";
    text: string;
  }>;
}

/** Live token-budget snapshot for /context (slice 6.4). Pure read — no event, no history touch. */
export interface ContextInfo {
  estimatedTokens: number;
  source: "provider" | "estimate";
  contextWindowTokens: number;
  outputReserveTokens: number;
  /** The context_usage denominator: effectiveWindowTokens(budget). */
  effectiveWindowTokens: number;
  compactThresholdTokens: number;
  /** True when the auto-compact circuit breaker has tripped (manual /compact still works). */
  breakerTripped: boolean;
}

/**
 * Per-category token breakdown for the ctx-meter hover popover (design
 * slice-P7.17-cut.md §2.1, P7.17/F12 W1-FIX P2). Pure read, mirrors
 * ContextInfo's contract (no event, no history/model touch, safe mid-turn).
 * `totalEstimatedTokens` is PROVIDER-ANCHORED — the exact same number
 * ContextInfo.estimatedTokens reports (the ctx-ring/headline total). Each
 * leaf below is a raw local-tokenizer estimate that is then proportionally
 * rescaled so the six leaves sum to that anchor exactly: per-category
 * tokenization is not additive (Σ estimate(part) ≠ estimate(concat)), so the
 * breakdown is a DECOMPOSITION of the anchored total, never an independent
 * sum that could drift above/below it.
 */
export interface ContextBreakdown {
  /** Proportional share of history.totalTokenEstimate() — the conversation messages sent to the model. */
  messagesTokens: number;
  /** Proportional share of builtin (non-mcp__) tool declarations currently in the registry. */
  systemToolsTokens: number;
  /** Proportional share of tool declarations bridged from MCP servers (mcp__ name prefix). */
  mcpToolsTokens: number;
  /** Proportional share of systemPromptComponents entries with kind "skills"; 0 when components are absent. */
  skillsTokens: number;
  /**
   * Proportional share of the system-prompt base. With systemPromptComponents
   * configured, the pre-scale raw value is max(0, tok(config.systemPrompt) −
   * Σ tok(all component texts)) — a subtraction, not a separate base string,
   * so prompt-concatenation drift never desyncs the categories; clamped to 0
   * so it can never go negative. Without systemPromptComponents: the WHOLE
   * systemPrompt (backward-compatible collapse — every section falls into
   * this one category).
   */
  systemPromptTokens: number;
  /** Proportional share of systemPromptComponents entries with kind "memory" | "workflows" | "profiles" | "repoMap". */
  metaTokens: number;
  /**
   * Provider-anchored total — identical to contextInfo().estimatedTokens.
   * Invariant: messagesTokens + systemToolsTokens + mcpToolsTokens +
   * skillsTokens + systemPromptTokens + metaTokens === totalEstimatedTokens
   * (exact, via an integer-rounding remainder folded into messagesTokens;
   * see contextBreakdown() for the one degenerate clamp-to-0 exception).
   */
  totalEstimatedTokens: number;
}

export class AgentLoop {
  /**
   * Conversation history in the own envelope (design §2.1). User/assistant/
   * tool messages only; the system prompt travels per-call as
   * ModelRequest.system.
   */
  readonly history: ConversationHistory;

  /** Compaction + token-budget manager, bound to this loop's history (design §2.6). */
  private readonly context: ContextManager;
  /** Budget denominator reported in context_usage: the effective input window. Recomputed by setContextWindow (slice 6.4). */
  private budgetTokens: number;
  private readonly schedulerConfig: ToolSchedulerConfig;
  /** Same instance handed to history/context; reused by contextBreakdown() (design slice-P7.17-cut.md §2.1). */
  private readonly tokenizer: Tokenizer;

  constructor(private readonly config: AgentLoopConfig) {
    const tokenizer = config.tokenizer ?? new HeuristicTokenizer();
    this.tokenizer = tokenizer;
    this.history = config.history ?? new ConversationHistory({ tokenizer });
    const budget = resolveContextBudgetConfig(config.context);
    this.budgetTokens = effectiveWindowTokens(budget);
    this.context = new ContextManager({
      history: this.history,
      tokenizer,
      modelPort: config.modelPort,
      config: budget,
    });
    this.schedulerConfig = {
      maxConcurrency: config.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
    };
  }

  async *runTurn(
    userInput: string,
    options?: {
      signal?: AbortSignal;
      mode?: PermissionMode;
      attachments?: ImageAttachment[];
      /** Ephemeral context added to this turn's system prompt, never history. */
      systemContext?: string;
    },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const tap = this.config.eventTap;
    if (tap === undefined) {
      yield* this.runTurnInner(userInput, options);
      return;
    }
    for await (const event of this.runTurnInner(userInput, options)) {
      try {
        tap(event);
      } catch {
        // An observer must never break the loop (slice 6.6 eventTap contract).
      }
      yield event;
    }
  }

  /**
   * Resume an already-balanced conversation after a host relocation. Unlike
   * runTurn, this does not run UserPromptSubmit hooks and does not append a
   * synthetic user message; the first model request sees the persisted history
   * exactly as the prior host segment left it.
   */
  async *continueTurn(
    options?: { signal?: AbortSignal; mode?: PermissionMode },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const tap = this.config.eventTap;
    if (tap === undefined) {
      yield* this.runTurnInner(undefined, options);
      return;
    }
    for await (const event of this.runTurnInner(undefined, options)) {
      try {
        tap(event);
      } catch {
        // An observer must never break the resumed loop segment.
      }
      yield event;
    }
  }

  private async *runTurnInner(
    userInput: string | undefined,
    options?: {
      signal?: AbortSignal;
      mode?: PermissionMode;
      attachments?: ImageAttachment[];
      systemContext?: string;
    },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const signal = options?.signal;
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;

    // single sanctioned mid-turn transition is a broker-approved ExitPlanMode
    // advancing plan -> planExitMode (design slice-4.3-cut.md §2.3), applied via
    // the PlanModeControl mutation below rather than by re-reading config.
    const mode = options?.mode ?? this.config.mode;

    // Pre-aborted: end immediately, before hooks or any model call.
    if (signal?.aborted) {
      yield* this.emitLoopEnd("cancelled", 0, signal);
      return;
    }

    // UserPromptSubmit hooks (design §2.10) run BEFORE the user message is
    // written; their additionalContext is appended inside a structural tag.
    // runUserPromptSubmit is fail-open for hook failures and only throws on an
    // external abort — treat that as a clean cancel.
    // Pre-turn history snapshot for lazy checkpointing, before a normal turn's
    // user frame is appended. A continuation has no new frame, so this is also
    // exactly the persisted pre-resume history.
    const preTurnItems = this.config.checkpoints !== undefined ? [...this.history.items] : [];

    if (userInput !== undefined) {
      let promptText = userInput;
      try {
        const submitted = await this.config.hooks.runUserPromptSubmit(
          { prompt: userInput },
          { signal },
        );
        if (submitted.additionalContext) {
          promptText = `${userInput}\n<hook-context>\n${submitted.additionalContext}\n</hook-context>`;
        }
      } catch {
        yield* this.emitLoopEnd("cancelled", 0, signal);
        return;
      }

      this.history.append({
        role: "user",
        content: promptText,
        ...(options?.attachments?.length ? { images: options.attachments } : {}),
      });
    }

    const dispatchCtx: DispatchContext = {
      registry: this.config.registry,
      hooks: this.config.hooks,
      permissionEngine: this.config.permissionEngine,
      permissionBroker: this.config.permissionBroker,
      mode,
      ports: this.config.ports,
      cwd: this.config.cwd,
      subagents: this.config.subagents,
      skills: this.config.skills,
      workflows: this.config.workflows,
      tasks: this.config.tasks,
      lsp: this.config.lsp,
      media: this.config.media,
      worktrees: this.config.worktrees,
    };

    // Plan-mode exit arc (design slice-4.3-cut.md §2.3): built ONLY when the
    // wiring opted in via planExitMode. exitPlan is the one sanctioned mid-turn
    // mode mutation — it advances dispatchCtx.mode (so later tool calls THIS turn
    // gate under the target) and config.mode (so later turns and lazily-spawned
    // children inherit it), then notifies the client. When planExitMode is unset
    // this block does not run, so dispatchCtx.planMode stays absent and the turn
    // is byte-identical to a pre-4.3 turn.
    if (this.config.planExitMode !== undefined) {
      dispatchCtx.planMode = {
        currentMode: () => dispatchCtx.mode,
        exitPlan: () => {
          if (dispatchCtx.mode !== "plan") {
            return null;
          }
          const target = this.config.planExitMode!;
          dispatchCtx.mode = target;
          this.config.mode = target;
          this.config.onModeChange?.(target);
          return target;
        },
      };
    }

    // Auto-checkpoint arc (design slice-4.7-cut.md §2.4): built ONLY when the

    // batch (Agent is concurrentSafe, so two Agent calls of one step run at once)
    // awaits ONE in-flight capture rather than spawning a second. `announced`
    // makes only the first ensure() this turn carry the result to the emitter;
    // any later write-effect tool of the same turn gets null. When checkpoints is
    // unset this block does not run, dispatchCtx.checkpoint stays absent, and the
    // turn is byte-identical to a pre-4.7 turn.
    if (this.config.checkpoints !== undefined) {
      const capturer = this.config.checkpoints;
      let pending: Promise<CheckpointCaptureResult> | null = null;
      let announced = false;
      dispatchCtx.checkpoint = {
        ensure: async () => {
          pending ??= capturer.capture({ userInput: userInput ?? "", historySnapshot: preTurnItems });
          const result = await pending;
          if (announced) return null;
          announced = true;
          return result;
        },
      };
    }

    let turn = 0;
    for (;;) {
      if (signal?.aborted) {
        yield* this.emitLoopEnd("cancelled", turn, signal);
        return;
      }

      turn += 1;
      yield { type: "turn_start", turn };

      if (turn > maxTurns) {
        yield* this.emitLoopEnd("max_turns", turn - 1, signal);
        return;
      }

      // Compaction at iteration start (design §2.6): microcompact first, then
      // token-pressure LLM auto-compaction. The turn signal is linked so Stop
      // during compaction cancels cleanly and leaves the history untouched.
      const micro = this.context.maybeMicrocompact();
      if (micro) {
        yield {
          type: "microcompact",
          clearedToolResults: micro.clearedToolResults,
          savedTokens: micro.savedTokens,
        };
      }
      if (this.context.shouldAutoCompact()) {
        yield* this.runCompactionCycle("auto", signal);
      }
      if (signal?.aborted) {
        yield* this.emitLoopEnd("cancelled", turn, signal);
        return;
      }

      const textParts: string[] = [];
      const toolCalls: ProposedToolCall[] = [];
      let finishReason: FinishReason = "unknown";
      let usage: TokenUsage = {};
      let streamErrored = false;
      let sawFinish = false;
      // Terminal-retry metadata counters (TASK.33 W7b): attemptsMade counts
      // stream_retry events seen THIS TURN — unlike the accumulators above it is
      // NOT reset on stream_retry (a retry increments it, it does not erase it).
      let attemptsMade = 0;
      let maxAttempts: number | undefined;
      let hadModelOutput = false;

      try {
        const stream = this.config.modelPort.streamText({
          system: appendSystemContext(this.config.systemPrompt, options?.systemContext),
          messages: this.history.toMessages(),
          tools: toToolDeclarations(this.config.registry),
          maxOutputTokens: this.config.maxOutputTokens,
          reasoningEffort: this.config.reasoningEffort,
          abortSignal: signal,
        });
        for await (const event of stream) {
          yield event.type === "error"
            ? { ...event, retry: buildRetryMetadata(event.error, attemptsMade, maxAttempts, hadModelOutput) }
            : event;
          if (isModelOutputEvent(event)) {
            hadModelOutput = true;
          }
          switch (event.type) {
            case "text_delta":
              textParts.push(event.text);
              break;
            case "tool_call":
              toolCalls.push(event.toolCall);
              break;
            case "finish":
              finishReason = event.finishReason;
              usage = event.usage;
              sawFinish = event.finishReason !== "error";
              break;
            case "error":
              streamErrored = true;
              break;
            case "stream_retry":
              attemptsMade += 1;
              maxAttempts = event.maxAttempts;
              // hadModelOutput is already false here by construction: the port's
              // own retry gate (isModelOutputEvent, provider/failure.ts) never
              // emits stream_retry once model output has reached the consumer.
              hadModelOutput = false;

              // whole step is replayed from scratch, so every accumulator built up
              // from the aborted attempt's partial events must be discarded — the
              // eventual assistant message must reflect only the winning attempt.
              // For a pre-first-event retry every one of these is already a no-op.
              // Known cosmetic gap (out of scope for 2.3): any partial text already
              // rendered by the UI before the stall stays on screen; only the
              // written history is guaranteed clean.
              textParts.length = 0;
              toolCalls.length = 0;
              finishReason = "unknown";
              usage = {};
              streamErrored = false;
              sawFinish = false;
              break;
            default:
              break;
          }
        }
      } catch (error) {
        // The stream iterator threw. An abort is a clean cancellation; anything
        // else is an unrecoverable stream error — surfaced as an {type:"error"}
        // event (transcript block / CLI line / host log) before loop_end so the
        // real provider failure is diagnosable (TASK.2 DoD-c), never swallowed.
        if (signal?.aborted) {
          yield* this.emitLoopEnd("cancelled", turn, signal);
        } else {
          yield { type: "error", error, retry: buildRetryMetadata(error, attemptsMade, maxAttempts, hadModelOutput) };
          // The consumer may abort while paused on the yielded error event
          // (before this generator resumes) — re-check so a synchronous
          // abort there still ends the loop as "cancelled", not "error".
          if (signal?.aborted) {
            yield* this.emitLoopEnd("cancelled", turn, signal);
          } else {
            yield* this.emitLoopEnd("error", turn, signal);
          }
        }
        return;
      }

      if (signal?.aborted) {
        yield* this.emitLoopEnd("cancelled", turn, signal);
        return;
      }

      // Fail-closed at the RIGHT granularity (TASK.2): a mid-stream error event
      // is fatal only when the step's finish never arrived (usage/stop_reason
      // lost — the assistant frame is not trustworthy). When finish WAS received
      // the frame is complete; the error (already re-yielded above as a visible
      // event) is a provider artifact — the turn continues instead of dying.
      // A synthetic SDK finish with finishReason "error" does not count as a real finish.
      if (streamErrored && !sawFinish) {
        yield* this.emitLoopEnd("error", turn, signal);
        return;
      }

      // Record provider usage against the pre-assistant history so its input
      // count anchors the delta correctly (design §2.5), then append the
      // assistant message and report context_usage.
      this.context.noteUsage(usage);
      this.history.append({
        role: "assistant",
        content: buildAssistantParts(textParts.join(""), toolCalls),
      });
      const usageEstimate = this.context.estimate();
      yield {
        type: "context_usage",
        estimatedTokens: usageEstimate.tokens,
        budgetTokens: this.budgetTokens,
        source: usageEstimate.source,
      };

      // Sentinel: a step with no proposed tool calls ends the loop.
      if (toolCalls.length === 0) {
        yield { type: "turn_end", turn, finishReason };
        yield* this.emitLoopEnd("completed", turn, signal);
        return;
      }

      // Dispatch. Invalid calls (§2.9) never reach the scheduler: they get a
      // synthesized invalid_input outcome. Valid calls flow through
      // runToolBatches, which returns exactly one outcome per call (cancelled
      // included) in proposal order. Every outcome is appended before any exit.
      const outcomeById = new Map<string, ToolCallOutcome>();

      for (const call of toolCalls) {
        if (!call.invalid) {
          continue;
        }
        const outcome = synthesizeInvalidOutcome(call);
        outcomeById.set(call.id, outcome);
        yield { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, input: {} };
        yield { type: "tool_result", outcome };
      }

      const validCalls = toolCalls.filter((call) => !call.invalid);
      if (validCalls.length > 0) {
        const batches = runToolBatches(dispatchCtx, validCalls, this.schedulerConfig, signal);
        let next = await batches.next();
        while (!next.done) {
          yield next.value;
          next = await batches.next();
        }
        for (const outcome of next.value) {
          outcomeById.set(outcome.toolCallId, outcome);
        }
      }

      // Append every result in PROPOSAL order (invariant: full pairing).
      for (const call of toolCalls) {
        const outcome = outcomeById.get(call.id);
        if (outcome) {
          this.history.append(buildToolResultMessage(call, outcome));
        }
      }

      const transition = toolCalls
        .map((call) => outcomeById.get(call.id))
        .find(
          (outcome) =>
            outcome?.status === "success" &&
            outcome.result?.ok === true &&
            outcome.result.control?.type === "workspace_transition",
        )?.result?.control?.transition;

      if (transition !== undefined) {
        yield { type: "turn_end", turn, finishReason };
        yield { type: "workspace_transition", transition };
        yield* this.emitLoopEnd("workspace_transition", turn, signal);
        return;
      }

      // Cancellation mid-dispatch: history is now balanced (all outcomes written),
      // so this exit satisfies the no-dangling-tool_call invariant.
      if (signal?.aborted) {
        yield* this.emitLoopEnd("cancelled", turn, signal);
        return;
      }

      yield { type: "turn_end", turn, finishReason };
    }
  }

  /**

   * the SAME compaction machinery as the auto path (context.runCompaction; the
   * ContextManager itself is unchanged) but bypasses shouldAutoCompact
   * entirely — it does not consult the threshold or the auto-compact circuit
   * breaker, so a manual compaction still reaches the model even right after
   * the breaker has tripped. A successful manual compaction resets the
   * breaker's failure counter (runCompaction's own success path), so it also
   * "heals" auto-compaction for the rest of the session.
   */
  async *compactNow(opts?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent, void, unknown> {
    const tap = this.config.eventTap;
    if (tap === undefined) {
      yield* this.compactNowInner(opts);
      return;
    }
    for await (const event of this.compactNowInner(opts)) {
      try {
        tap(event);
      } catch {
        // An observer must never break the loop (slice 6.6 eventTap contract).
      }
      yield event;
    }
  }

  private async *compactNowInner(opts?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent, void, unknown> {
    yield* this.runCompactionCycle("manual", opts?.signal);
  }

  contextInfo(): ContextInfo {
    const estimate = this.context.estimate();
    const budget = this.context.getBudgetConfig();
    return {
      estimatedTokens: estimate.tokens,
      source: estimate.source,
      contextWindowTokens: budget.contextWindowTokens,
      outputReserveTokens: budget.outputReserveTokens,
      effectiveWindowTokens: this.budgetTokens,
      compactThresholdTokens: compactThresholdTokens(budget),
      breakerTripped: this.context.breakerTripped(),
    };
  }

  /**
   * Per-category token breakdown for the ctx-meter hover popover (design
   * slice-P7.17-cut.md §2.1). Pure read: never touches history, the model, or
   * config.systemPromptComponents' base semantics (§2.1) — the tool registry
   * and system prompt are read live, so a late-connected MCP server or a
   * mid-turn call are both reflected/safe.
   */
  contextBreakdown(): ContextBreakdown {
    const rawMessagesTokens = this.history.totalTokenEstimate();

    const decls = toToolDeclarations(this.config.registry);
    const { systemTools, mcpTools } = splitToolDeclarationsByMcpPrefix(decls);
    const rawSystemToolsTokens = estimateToolDeclarationTokens(systemTools, this.tokenizer);
    const rawMcpToolsTokens = estimateToolDeclarationTokens(mcpTools, this.tokenizer);

    const fullPromptTokens = this.tokenizer.count(this.config.systemPrompt ?? "");
    const components = this.config.systemPromptComponents;
    let rawSkillsTokens = 0;
    let rawMetaTokens = 0;
    let rawSystemPromptTokens = fullPromptTokens;
    if (components !== undefined) {
      let componentsTotal = 0;
      for (const component of components) {
        const tokens = this.tokenizer.count(component.text);
        componentsTotal += tokens;
        if (component.kind === "skills") {
          rawSkillsTokens += tokens;
        } else {
          rawMetaTokens += tokens;
        }
      }
      // Subtraction, not a separate base string (design §2.1): the base is
      // whatever full systemPrompt tokens remain once every known component
      // is accounted for, clamped so concatenation drift never goes negative.
      rawSystemPromptTokens = Math.max(0, fullPromptTokens - componentsTotal);
    }

    const rawTotal =
      rawMessagesTokens + rawSystemToolsTokens + rawMcpToolsTokens + rawSkillsTokens + rawSystemPromptTokens + rawMetaTokens;

    // Provider-anchored total: the SAME field ContextInfo.estimatedTokens
    // reports (the number that drives the ctx-ring/headline), not an
    // independent re-sum of the categories below.
    const anchor = this.context.estimate().tokens;

    if (rawTotal === 0) {
      // No div-by-0 on an empty prompt with zero components (and empty
      // history/tools): every category collapses to 0 while the total still
      // tracks the anchor.
      return {
        messagesTokens: 0,
        systemToolsTokens: 0,
        mcpToolsTokens: 0,
        skillsTokens: 0,
        systemPromptTokens: 0,
        metaTokens: 0,
        totalEstimatedTokens: anchor,
      };
    }

    // Per-category tokenization is NOT additive (Σ estimate(part) ≠
    // estimate(concat)), so the six independently-estimated raw categories
    // are proportionally rescaled to sum to `anchor` — the breakdown is a
    // DECOMPOSITION of the provider-anchored total, never an independent sum
    // that can drift above/below it (P7.17/F12 W1-FIX P2).
    const scale = anchor / rawTotal;
    const systemToolsTokens = Math.round(rawSystemToolsTokens * scale);
    const mcpToolsTokens = Math.round(rawMcpToolsTokens * scale);
    const skillsTokens = Math.round(rawSkillsTokens * scale);
    const systemPromptTokens = Math.round(rawSystemPromptTokens * scale);
    const metaTokens = Math.round(rawMetaTokens * scale);
    const roundedMessagesTokens = Math.round(rawMessagesTokens * scale);

    // Rounding to integers can leave an off-by-a-few remainder; it is folded
    // into the largest bucket (messages) so Σ leaves === anchor exactly,
    // keeping the popover in lockstep with the ctx-ring. In the degenerate
    // case where that would drive messages negative, clamp to 0 instead (the
    // leaves then legitimately fall a little short of anchor).
    const roundedSum =
      roundedMessagesTokens + systemToolsTokens + mcpToolsTokens + skillsTokens + systemPromptTokens + metaTokens;
    const messagesTokens = Math.max(0, roundedMessagesTokens + (anchor - roundedSum));

    return {
      messagesTokens,
      systemToolsTokens,
      mcpToolsTokens,
      skillsTokens,
      systemPromptTokens,
      metaTokens,
      totalEstimatedTokens: anchor,
    };
  }

  /**
   * Mid-session context-window re-resolution (slice 6.4: the /model switch).
   * Applies the new window over the CURRENT budget config between turns; the
   * manager's compaction threshold and the context_usage denominator follow on
   * the next turn. Estimate anchor and breaker state are preserved (A1).
   */
  setContextWindow(tokens: number): void {
    const next = { ...this.context.getBudgetConfig(), contextWindowTokens: tokens };
    this.context.setBudgetConfig(next);
    this.budgetTokens = effectiveWindowTokens(next);
  }

  /**
   * Shared compaction_start/runCompaction/compaction_end + durationMs
   * bookkeeping for BOTH the auto (runTurn) and manual (compactNow) triggers —
   * the only difference between them is this `trigger` label and whether
   * shouldAutoCompact gated the call before it got here.
   */
  private async *runCompactionCycle(
    trigger: "auto" | "manual",
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    yield { type: "compaction_start", trigger };
    const startedAt = Date.now();
    const result = await this.context.runCompaction({ signal });
    if (result.ok) {
      yield {
        type: "compaction_end",
        ok: true,
        preTokens: result.preTokens,
        postTokens: result.postTokens,
        durationMs: Date.now() - startedAt,
      };
    } else {
      yield {
        type: "compaction_end",
        ok: false,
        preTokens: result.preTokens,
        durationMs: Date.now() - startedAt,
        error: result.error,
      };
    }
  }

  /**
   * Emits loop_end after running Stop hooks (fail-open) and, as a final net for
   * the §2.10 invariant, closing any assistant tool_call that reached here
   * unanswered with a synthesized cancelled tool_result. In correct control flow
   * there are never any stragglers (the dispatch path writes every outcome), so
   * this loop is a no-op on all well-behaved paths; it exists so a persisted
   * history can never carry a dangling tool_use that would 400 a resumed turn.
   */
  private async *emitLoopEnd(
    reason: LoopEndReason,
    turns: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const dangling = this.history.unansweredToolCallIds();
    if (dangling.length > 0) {
      const names = this.toolCallNames();
      for (const toolCallId of dangling) {
        const toolName = names.get(toolCallId) ?? "unknown";
        const outcome: ToolCallOutcome = {
          toolCallId,
          toolName,
          status: "cancelled",
          modelText: `Tool ${toolName} was cancelled before it produced a result.`,
          durationMs: 0,
        };
        yield { type: "tool_result", outcome };
        this.history.append({
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId,
              toolName,
              text: outcome.modelText,
              status: "cancelled",
            },
          ],
        });
      }
    }

    // Stop hooks (design §2.10): fail-open, must never block completion. A hook
    // failure is swallowed by runObservers; an aborted turn signal makes it
    // throw before running any hook — caught here so cancel still reaches loop_end.
    try {
      await this.config.hooks.runObservers(
        "Stop",
        { reason, turns },
        signal ? { signal } : undefined,
      );
    } catch {
      // fail-open (design §2.11).
    }

    yield { type: "loop_end", reason, turns };
  }

  /** Map of toolCallId -> toolName from every assistant tool_call in history. */
  private toolCallNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const item of this.history.items) {
      if (item.message.role === "assistant") {
        for (const part of item.message.content) {
          if (part.type === "tool_call") {
            names.set(part.toolCallId, part.toolName);
          }
        }
      }
    }
    return names;
  }
}

/**
 * Assembles the assistant message parts: text (when present) followed by the
 * tool calls. Invalid calls (§2.9) are written with input sanitized to {} — a
 * valid JSON object — so a strict endpoint never receives malformed arguments on
 * the next step.
 */
function buildAssistantParts(text: string, toolCalls: ProposedToolCall[]): AssistantPart[] {
  const parts: AssistantPart[] = [];
  if (text.length > 0 || toolCalls.length === 0) {
    parts.push({ type: "text", text });
  }
  for (const call of toolCalls) {
    parts.push({
      type: "tool_call",
      toolCallId: call.id,
      toolName: call.name,
      input: call.invalid ? {} : call.input,
    });
  }
  return parts;
}

/**
 * Synthesizes the invalid_input outcome for a tool call whose arguments failed
 * to parse at the SDK level (design §2.9). The model gets a chance to retry with
 * valid arguments; the history stays valid (paired with the sanitized tool_call).
 */
function synthesizeInvalidOutcome(call: ProposedToolCall): ToolCallOutcome {
  const reason = call.invalid?.reason ?? "unparseable arguments";
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: "invalid_input",
    modelText: `Tool ${call.name} arguments were malformed JSON; retry with valid arguments. (${reason})`,
    durationMs: 0,
  };
}

/** Wraps a dispatch outcome as a tool-role message so the model sees the result on the next step. */
function buildToolResultMessage(call: ProposedToolCall, outcome: ToolCallOutcome): ChatMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        text: outcome.modelText,
        status: outcome.status,
        ...(outcome.result?.images?.length ? { images: outcome.result.images } : {}),
      },
    ],
  };
}

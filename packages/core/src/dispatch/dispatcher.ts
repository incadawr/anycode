/**
 * Tool-call dispatch pipeline. Order is fixed:
 *   1. registry lookup            (unknown tool -> "error" outcome)
 *   2. zod validation             (safeParse; failure -> "invalid_input" outcome
 *                                  with the zod issues rendered for the model)
 *   3. PreToolUse hooks           (deny -> "denied"; updatedInput -> re-validate)
 *   4. permission gate            (engine.check; "ask" -> broker; deny -> "denied";
 *                                  fail-closed via DenyPermissionBroker)
 *   5. timeout + linked abort     (fresh AbortController linked to parentSignal;
 *                                  generic tools race the timeout; terminal
 *                                  controls abort then await commit settlement)
 *   6. handler(input, ctx)        (ports-only side effects)
 * Invariant: never throws — every failure path becomes a ToolCallOutcome so the
 * loop always appends a tool result message for the model.
 */

import type { ZodError } from "zod";
import type { HookRunner, PostToolUseHookInput } from "../types/hooks.js";
import type {
  PermissionBroker,
  PermissionEngine,
  PermissionMode,
  PermissionRequest,
  PlanModeControl,
} from "../types/permissions.js";
import type { ProposedToolCall } from "../types/events.js";
import type {
  AnyToolDefinition,
  ToolCallOutcome,
  ToolCallStatus,
  ToolContext,
  ToolEmittedEvent,
  ToolMetadata,
  ToolResult,
} from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type { SubagentPort } from "../ports/subagent.js";
import type { SkillPort } from "../ports/skills.js";
import type { WorkflowPort } from "../ports/workflow.js";
import type { BackgroundTaskPort } from "../ports/tasks.js";
import type { LspPort } from "../ports/lsp.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { WorktreeControlPort } from "../ports/worktrees.js";
import type { TurnCheckpointControl } from "../ports/checkpoints.js";
import type { ToolRegistry } from "../tools/registry.js";
import { DEFAULT_TOOL_RESULT_BUDGET, DISPATCH_TIMEOUT_GRACE_MS } from "../types/config.js";
import { linkAbortSignal, raceWithTimeout } from "../util/abort.js";
import { applyResultBudget, type ResultPreviewDirection } from "../util/result-budget.js";

export interface DispatchContext {
  registry: ToolRegistry;
  hooks: HookRunner;
  permissionEngine: PermissionEngine;
  permissionBroker: PermissionBroker;
  mode: PermissionMode;
  ports: CorePorts;
  cwd: string;
  /**
   * In-process subagent entry (design §3.1/§3.2), threaded into every
   * ToolContext. Optional: absent => the Agent tool fails closed as
   * "unavailable" (the child's own DispatchContext leaves it unset, which is
   * the second non-recursion lock).
   */
  subagents?: SubagentPort;
  /**
   * Discovered-skills entry (design §2.2), threaded into every ToolContext.
   * Optional: absent => the Skill tool fails closed as "unavailable" (a child
   * loop's DispatchContext leaves it unset, so children cannot load skills).
   */
  skills?: SkillPort;
  /**
   * Declarative-workflow entry (design §2.1/§2.2), threaded into every
   * ToolContext. Optional: absent => the Workflow tool fails closed as
   * "unavailable" (a child loop's DispatchContext leaves it unset, the third
   * non-recursion lock — a step's child can never launch a workflow).
   */
  workflows?: WorkflowPort;
  /**

   * threaded into every ToolContext. Optional: absent => background-capable
   * Bash / BashOutput / BashKill fail closed as "unavailable" (a child loop's
   * DispatchContext leaves it unset, so children never reach the registry). The
   * dispatch pipeline is unchanged — the port only rides along on the context.
   */
  tasks?: BackgroundTaskPort;
  /**

   * into every ToolContext. Optional: absent => the diagnostics-wrapped
   * Edit/Write return the inner result untouched (a child loop's DispatchContext
   * leaves it unset, so a child's edits are never diagnosed). The dispatch
   * pipeline is unchanged — the port only rides along on the context.
   */
  lsp?: LspPort;
  /**
   * Live image-capability verdict for the current session model (design

   * => the image-wrapped Read returns an explicit "not image-capable" error
   * instead of attaching (a child loop's DispatchContext leaves it unset, so a
   * child's Read never attaches an image). The dispatch pipeline is unchanged —
   * the port only rides along on the context.
   */
  media?: MediaCapabilityPort;
  /**
   * Sanctioned plan-mode exit (design slice-4.3-cut.md §2.4), threaded into
   * every ToolContext. Optional: absent => the ExitPlanMode tool fails closed
   * as "unavailable" (a child loop's DispatchContext leaves it unset, so a child
   * can never escalate the parent's mode).
   */
  planMode?: PlanModeControl;
  /** Host-owned terminal workspace relocation; absent in child/headless loops. */
  worktrees?: WorktreeControlPort;
  /**
   * Lazy per-turn workspace checkpoint control (design slice-4.7-cut.md §2.4).
   * Optional: absent => the auto-checkpoint arc sleeps (a child loop's
   * DispatchContext leaves it unset, so a child never captures — the parent
   * already checkpointed before spawning the Agent/Workflow tool). ensure() is
   * called before the FIRST write-effect tool of the turn (post-permission).
   */
  checkpoint?: TurnCheckpointControl;
}

/** deny > ask > allow: higher rank is the more restrictive decision. */
const DECISION_RANK: Record<"allow" | "ask" | "deny", number> = { allow: 1, ask: 2, deny: 3 };

/**
 * Write-effect classifier for the auto-checkpoint arc (design slice-4.7-cut.md

 * (Write/Edit/Bash, every bridged mcp__* — frozen readOnly:false) OR its side
 * effects reach a spawned process (Agent/Workflow — readOnly:true but their
 * children may write, so the checkpoint is taken conservatively BEFORE the
 * spawn). Read/Glob/Grep/WebFetch/TodoWrite/Skill/ExitPlanMode are excluded.
 * No name lists: a new write-tool is covered automatically by its metadata.
 */
export function checkpointRequired(metadata: ToolMetadata): boolean {
  return !metadata.readOnly || metadata.sideEffectScope === "process";
}

export async function executeToolCall(
  ctx: DispatchContext,
  call: ProposedToolCall,
  parentSignal?: AbortSignal,
  emit?: (event: ToolEmittedEvent) => void,
): Promise<ToolCallOutcome> {
  const startedAt = Date.now();
  const toolCallId = call.id;
  const toolName = call.name;
  // Best-known input at exit: the validated/rewritten value once it exists,
  // otherwise the raw proposed input. Handed to PostToolUse observers.
  let effectiveInput: unknown = call.input;

  const outcome = (
    status: ToolCallStatus,
    modelText: string,
    result?: ToolResult,
  ): ToolCallOutcome => ({
    toolCallId,
    toolName,
    status,
    modelText,
    durationMs: Date.now() - startedAt,
    ...(result !== undefined ? { result } : {}),
  });

  // Runs the full pipeline to exactly one outcome. Never throws.
  const pipeline = async (): Promise<ToolCallOutcome> => {
    try {
      // Bail out early if the turn was already cancelled before this call began.
      if (parentSignal?.aborted) {
        return outcome("cancelled", `Tool ${toolName} was cancelled before it started.`);
      }

      // 1. registry lookup
      const tool = ctx.registry.get(toolName);
      if (!tool) {
        return outcome("error", `Unknown tool: ${toolName}.`);
      }

      // 2. zod validation
      const parsed = tool.inputSchema.safeParse(call.input);
      if (!parsed.success) {
        return outcome("invalid_input", formatValidationError(toolName, parsed.error));
      }
      let input: unknown = parsed.data;
      effectiveInput = input;

      // 3. PreToolUse hooks
      const hookResult = await ctx.hooks.runPreToolUse(
        { toolCallId, toolName, input },
        { signal: parentSignal },
      );
      if (hookResult.permissionDecision === "deny") {
        return outcome(
          "denied",
          budgetExternalText(hookResult.reason ?? `Blocked by a PreToolUse hook: ${toolName}.`),
        );
      }
      if (hookResult.updatedInput !== undefined) {
        const revalidated = tool.inputSchema.safeParse(hookResult.updatedInput);
        if (!revalidated.success) {
          return outcome("invalid_input", formatValidationError(toolName, revalidated.error));
        }
        input = revalidated.data;
        effectiveInput = input;
      }

      // Resolve input-sensitive safety metadata only after zod validation and
      // hook rewriting. Resolver failures are caught by the defensive net.
      let metadata = tool.resolveMetadata?.(input) ?? tool.metadata;

      // 4. permission gate: engine ruling merged with any hook decision (deny > ask > allow).
      const request: PermissionRequest = {
        toolName,
        input,
        metadata,
        mode: ctx.mode,
        toolCallId,
      };
      const ruling = ctx.permissionEngine.check(request);
      let decision = ruling.decision;
      let denyReason = ruling.reason;
      const hookDecision = hookResult.permissionDecision;
      if (hookDecision && DECISION_RANK[hookDecision] > DECISION_RANK[decision]) {
        decision = hookDecision;
        denyReason = hookResult.reason ?? denyReason;
      }

      if (decision === "deny") {
        return outcome("denied", budgetExternalText(denyReason ?? `Permission denied for ${toolName}.`));
      }
      if (decision === "ask") {

        const broker = await ctx.permissionBroker.requestPermission(request, {
          signal: parentSignal,
        });
        if (broker.behavior === "deny") {
          return outcome(
            "denied",
            budgetExternalText(broker.reason || `Permission denied for ${toolName}.`),
          );
        }
        if (broker.updatedInput !== undefined) {
          const revalidated = tool.inputSchema.safeParse(broker.updatedInput);
          if (!revalidated.success) {
            return outcome("invalid_input", formatValidationError(toolName, revalidated.error));
          }
          input = revalidated.data;
          effectiveInput = input;
          metadata = tool.resolveMetadata?.(input) ?? tool.metadata;
        }
      }


      // BEFORE the first write-effect tool and AFTER permission (a denied/invalid

      // wrapped in the handler's raceWithTimeout: each git spawn carries its own

      // notice rides the same emit channel as subagent_*/workflow_* progress.
      if (ctx.checkpoint !== undefined && checkpointRequired(metadata)) {
        const notice = await ctx.checkpoint.ensure();
        if (notice !== null && notice.kind === "created") {
          emit?.({ type: "checkpoint_created", id: notice.id, label: notice.label });
        } else if (notice !== null && notice.kind === "failed") {
          emit?.({ type: "checkpoint_failed", reason: notice.reason });
        }
      }

      // 5. timeout + linked abort. B(2): the dispatcher races the handler against
      // timeoutMs + DISPATCH_TIMEOUT_GRACE_MS so a handler with its own inner
      // deadline (Bash's ExecutionPort) wins first and brings captured output;
      // the reported message still cites the original timeoutMs (design §2.10).
      const controller = new AbortController();
      const dispose = parentSignal ? linkAbortSignal(parentSignal, controller) : () => {};
      const timeoutMs = resolveTimeoutMs(metadata, input);
      const handlerCtx: ToolContext = {
        toolCallId,
        abortSignal: controller.signal,
        cwd: ctx.cwd,
        ports: ctx.ports,
        subagents: ctx.subagents,
        skills: ctx.skills,
        workflows: ctx.workflows,
        tasks: ctx.tasks,
        lsp: ctx.lsp,
        media: ctx.media,
        planMode: ctx.planMode,
        worktrees: ctx.worktrees,
        emit,
      };

      let terminalTimedOut = false;
      try {
        // 6. handler
        const handlerPromise = tool.handler(input, handlerCtx);
        let result: ToolResult;
        if (metadata.terminalControl === true) {
          // A workspace transition has a durable commit boundary. Once its
          // handler starts, timeout/cancel may request abort, but the dispatcher
          // must not publish a losing outcome while the commit can still win.
          // Keep waiting for settlement; a successful commit is authoritative.
          const timer = setTimeout(() => {
            terminalTimedOut = true;
            controller.abort("timeout");
          }, timeoutMs + DISPATCH_TIMEOUT_GRACE_MS);
          try {
            result = await handlerPromise;
          } finally {
            clearTimeout(timer);
          }
        } else {
          const race = await raceWithTimeout(
            handlerPromise,
            timeoutMs + DISPATCH_TIMEOUT_GRACE_MS,
            controller,
          );
          if (race.timedOut) {
            return outcome("timed_out", `Tool ${toolName} timed out after ${timeoutMs}ms.`);
          }
          result = race.value as ToolResult;
        }

        if (metadata.terminalControl === true) {
          if (result.ok) {
            return outcome("success", formatModelText(tool, metadata, result), result);
          }
          if (parentSignal?.aborted) {
            return outcome("cancelled", `Tool ${toolName} was cancelled.`, result);
          }
          if (terminalTimedOut) {
            return outcome("timed_out", `Tool ${toolName} timed out after ${timeoutMs}ms.`, result);
          }
        }
        // B(2): the handler's own failure classification wins deterministically, so
        // a Bash timeout/cancel keeps its captured stdout/stderr on the outcome.
        const status: ToolCallStatus = result.ok ? "success" : (result.errorKind ?? "error");
        return outcome(status, formatModelText(tool, metadata, result), result);
      } catch (error) {
        if (parentSignal?.aborted) {
          return outcome("cancelled", `Tool ${toolName} was cancelled.`);
        }
        if (metadata.terminalControl === true && terminalTimedOut) {
          return outcome("timed_out", `Tool ${toolName} timed out after ${timeoutMs}ms.`);
        }
        if (controller.signal.aborted) return outcome("cancelled", `Tool ${toolName} was cancelled.`);
        return outcome("error", budgetExternalText(`Tool ${toolName} threw: ${errorMessage(error)}`));
      } finally {
        dispose();
      }
    } catch (error) {
      // Defensive net: the pipeline (hooks/engine/broker) must never bubble a throw
      // out of the dispatcher, or the loop would hang on an unanswered tool call.
      if (parentSignal?.aborted) {
        return outcome("cancelled", `Tool ${toolName} was cancelled.`);
      }
      return outcome(
        "error",
        budgetExternalText(`Tool ${toolName} dispatch failed: ${errorMessage(error)}`),
      );
    }
  };

  const finalOutcome = await pipeline();
  await runPostToolUseObservers(
    ctx,
    { toolCallId, toolName, input: effectiveInput, outcome: finalOutcome },
    parentSignal,
  );
  return finalOutcome;
}

/**
 * Fires PostToolUse (success) or PostToolUseFailure (any other status) observers
 * after every outcome. Fail-open: the observer layer must never affect the tool
 * result, so any throw (including an already-aborted turn signal propagated by
 * the runner) is swallowed (design §2.10, §2.11).
 */
async function runPostToolUseObservers(
  ctx: DispatchContext,
  hookInput: PostToolUseHookInput,
  parentSignal?: AbortSignal,
): Promise<void> {
  const event = hookInput.outcome.status === "success" ? "PostToolUse" : "PostToolUseFailure";
  try {
    await ctx.hooks.runObservers(event, hookInput, { signal: parentSignal });
  } catch {
    // fail-open (design §2.11).
  }
}

/**
 * Effective per-call timeout: metadata.timeoutMs is the default. A tool that
 * declares metadata.maxTimeoutMs opts into a per-call override read from the
 * input's `timeout` field (the Bash tool), capped at maxTimeoutMs.
 */
function resolveTimeoutMs(metadata: ToolMetadata, input: unknown): number {
  let timeoutMs = metadata.timeoutMs;
  if (
    metadata.maxTimeoutMs !== undefined &&
    isRecord(input) &&
    typeof input.timeout === "number" &&
    Number.isFinite(input.timeout) &&
    input.timeout > 0
  ) {
    timeoutMs = Math.min(input.timeout, metadata.maxTimeoutMs);
  }
  return timeoutMs;
}

/**
 * Renders the result for the model and budgets it. The budget is applied HERE,
 * after every rendering branch — a tool's own formatResultForModel and the
 * error text are subject to it exactly like the default JSON rendering, because
 * an unbounded string is unbounded whoever produced it (TASK.93).
 */
function formatModelText(
  tool: AnyToolDefinition,
  metadata: ToolMetadata,
  result: ToolResult,
): string {
  const budget = resolveResultBudget(metadata);
  return applyResultBudget(
    renderModelText(tool, metadata, result),
    budget.maxModelBytes,
    budget.previewDirection,
  );
}

/**
 * Budgets text the dispatcher only half-authored. A hook's or broker's denial
 * reason and a handler's own Error message are third-party strings under no
 * size contract, so they get the DEFAULT budget rather than the tool's — the
 * tool's budget describes its result, not its failure to produce one.
 */
function budgetExternalText(text: string): string {
  return applyResultBudget(text, DEFAULT_TOOL_RESULT_BUDGET.maxModelBytes);
}

function renderModelText(
  tool: AnyToolDefinition,
  metadata: ToolMetadata,
  result: ToolResult,
): string {
  if (tool.formatResultForModel) {
    try {
      return tool.formatResultForModel(result);
    } catch {
      // fall through to the default renderer on formatter failure.
    }
  }
  if (!result.ok) {
    return result.error ?? `Tool ${metadata.name} returned an error.`;
  }
  return result.output === undefined ? "" : stringifyOutput(result.output);
}

/**
 * Effective model-visible cap: the tool's declared budget, or the default when
 * it declares none.
 *
 * Deliberately NOT min()'d with metadata.maxOutputBytes, which ZCode's
 * equivalent does. There, both numbers are declared together per tool; here
 * maxOutputBytes predates this layer as a handler-side buffer cap, and min()
 * only ever bites in one case — a handler that fills its buffer exactly and a
 * formatter that then frames it (the Skill body plus its own truncation
 * marker). Clamping there would evict the framing to no purpose: the payload is
 * already within the inline cap by construction, so min() protects nothing.
 */
function resolveResultBudget(metadata: ToolMetadata): {
  maxModelBytes: number;
  previewDirection: ResultPreviewDirection;
} {
  const declared = metadata.resultBudget ?? DEFAULT_TOOL_RESULT_BUDGET;
  return {
    maxModelBytes: declared.maxModelBytes,
    previewDirection: declared.previewDirection ?? "head",
  };
}

function formatValidationError(toolName: string, error: ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  return `Invalid input for ${toolName}: ${issues || "schema validation failed"}`;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

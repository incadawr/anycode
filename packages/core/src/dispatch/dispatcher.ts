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
  ToolResultBudget,
} from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type { SubagentPort } from "../ports/subagent.js";
import type { SkillPort } from "../ports/skills.js";
import type { WorkflowPort } from "../ports/workflow.js";
import type { BackgroundTaskPort } from "../ports/tasks.js";
import type { LspPort } from "../ports/lsp.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { WorktreeControlPort } from "../ports/worktrees.js";
import type { PreviewPort } from "../ports/preview.js";
import type { TurnCheckpointControl } from "../ports/checkpoints.js";
import type { ArtifactContext } from "../ports/artifacts.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  ARTIFACT_PREVIEW_BYTES,
  DEFAULT_TOOL_RESULT_BUDGET,
  DISPATCH_TIMEOUT_GRACE_MS,
} from "../types/config.js";
import { linkAbortSignal, raceWithTimeout } from "../util/abort.js";
import {
  applyResultBudget,
  previewFirstChars,
  type ResultPreviewDirection,
} from "../util/result-budget.js";

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
   * Host-owned browser-preview control plane, threaded into every
   * ToolContext. Optional: absent => BrowserOpen/BrowserRead/BrowserScreenshot
   * fail closed as "unavailable" (a child loop's DispatchContext leaves it
   * unset, so a child never reaches a preview window). The dispatch pipeline
   * is unchanged — the port only rides along on the context.
   */
  preview?: PreviewPort;
  /**
   * Lazy per-turn workspace checkpoint control (design slice-4.7-cut.md §2.4).
   * Optional: absent => the auto-checkpoint arc sleeps (a child loop's
   * DispatchContext leaves it unset, so a child never captures — the parent
   * already checkpointed before spawning the Agent/Workflow tool). ensure() is
   * called before the FIRST write-effect tool of the turn (post-permission).
   */
  checkpoint?: TurnCheckpointControl;
  /**
   * Artifact store + owning session for oversized tool results (TASK.94).
   * Optional: absent => a tool declaring `strategy: "artifact"` is budgeted by
   * plain truncation, byte-identical to TASK.93. Child loops DO inherit it
   * (buildChildConfig copies it), so a subagent's oversized Bash output is
   * recoverable too; a child writes under the parent's session directory,
   * which is correct because tool-call ids are globally unique.
   */
  artifacts?: ArtifactContext;
}

/**
 * Envelope markers for a spilled result. ZCode keys its
 * `isPersistedOutputContent` off the same pair so hook context can be appended
 * to an envelope without corrupting it; we have no such consumer yet, but the
 * markers are what makes one possible later, and a self-describing envelope is
 * cheap.
 */
export const PERSISTED_OUTPUT_OPEN_TAG = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSE_TAG = "</persisted-output>";

/** True when `text` is a persisted-output envelope rather than a tool's own result text. */
export function isPersistedOutputContent(text: string): boolean {
  return text.startsWith(PERSISTED_OUTPUT_OPEN_TAG) && text.trimEnd().endsWith(PERSISTED_OUTPUT_CLOSE_TAG);
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
        preview: ctx.preview,
        artifacts: ctx.artifacts,
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
            return outcome(
              "success",
              await formatModelText(ctx, tool, metadata, result, toolCallId),
              result,
            );
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
        return outcome(
          status,
          await formatModelText(ctx, tool, metadata, result, toolCallId),
          result,
        );
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
 *
 * Async since TASK.94: an over-budget result from a tool that opted into
 * `strategy: "artifact"` is written to disk before it is rendered. The spill is
 * the ONLY awaiting branch; every other path resolves without touching I/O, and
 * ToolCallOutcome is unchanged.
 */
async function formatModelText(
  ctx: DispatchContext,
  tool: AnyToolDefinition,
  metadata: ToolMetadata,
  result: ToolResult,
  toolCallId: string,
): Promise<string> {
  const budget = resolveResultBudget(metadata);
  const rendered = renderModelText(tool, metadata, result);

  if (
    budget.strategy === "artifact" &&
    ctx.artifacts !== undefined &&
    Buffer.byteLength(rendered, "utf8") > budget.maxModelBytes
  ) {
    const envelope = await spillToArtifact(
      ctx.artifacts,
      tool,
      metadata,
      result,
      rendered,
      budget.previewDirection,
      toolCallId,
    );
    // The envelope is small by construction (path + a 2 KB preview), so this
    // pass is a guard against a formatPersistedModelContent that misbehaves,
    // not the mechanism.
    if (envelope !== null) {
      return applyResultBudget(envelope, budget.maxModelBytes, "head");
    }
  }

  return applyResultBudget(rendered, budget.maxModelBytes, budget.previewDirection);
}

/**
 * Persists the full rendered text and returns the envelope that replaces it, or
 * null when the store refused (unsafe id, over the per-write cap, I/O failure).
 *
 * A null return means the caller truncates — exactly the TASK.93 outcome, and
 * exactly what the model would have received had the tool never opted in. There
 * is deliberately no error branch and no diagnostic in the model text: the
 * envelope must never claim a path that does not exist, and a failed spill is
 * not something the model can act on. (The dispatcher holds no telemetry port,
 * so the failure is silent by construction rather than by choice.)
 */
async function spillToArtifact(
  artifacts: ArtifactContext,
  tool: AnyToolDefinition,
  metadata: ToolMetadata,
  result: ToolResult,
  rendered: string,
  previewDirection: ResultPreviewDirection,
  toolCallId: string,
): Promise<string | null> {
  let written: { path: string; bytes: number };
  try {
    written = await artifacts.store.writeToolResultArtifact({
      sessionId: artifacts.sessionId,
      toolCallId,
      toolName: metadata.name,
      content: rendered,
      contentType: "text/plain",
      retention: metadata.resultBudget?.artifact?.retention ?? "session",
    });
  } catch {
    return null;
  }

  const preview = previewFirstChars(rendered, ARTIFACT_PREVIEW_BYTES, previewDirection);
  if (tool.formatPersistedModelContent) {
    try {
      return tool.formatPersistedModelContent({
        result,
        path: written.path,
        originalBytes: written.bytes,
        preview,
        previewDirection,
      });
    } catch {
      // fall through to the generic envelope on formatter failure, mirroring
      // renderModelText's treatment of formatResultForModel.
    }
  }
  return formatPersistedOutput({
    path: written.path,
    originalBytes: written.bytes,
    preview,
    previewDirection,
  });
}

/**
 * The generic persisted-output envelope. It has to carry three things or the
 * spill is worse than a truncation: WHERE the data is, HOW MUCH of it there is,
 * and HOW to get at it. The last one is not decoration — a path alone leaves
 * the model to guess at whole-file reads of a multi-megabyte log, so the
 * envelope names Read's offset/limit and Grep explicitly.
 */
export function formatPersistedOutput(args: {
  path: string;
  originalBytes: number;
  preview: string;
  previewDirection: ResultPreviewDirection;
}): string {
  const end = args.previewDirection === "tail" ? "last" : "first";
  return [
    PERSISTED_OUTPUT_OPEN_TAG,
    `Output too large (${args.originalBytes} bytes). Full output saved to: ${args.path}`,
    "Read it with the Read tool (use offset/limit for large files) or search it with Grep.",
    "",
    `Preview (${end} ${ARTIFACT_PREVIEW_BYTES} bytes):`,
    args.preview,
    "...",
    PERSISTED_OUTPUT_CLOSE_TAG,
  ].join("\n");
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
  strategy: "truncate" | "artifact";
} {
  const declared: ToolResultBudget = metadata.resultBudget ?? DEFAULT_TOOL_RESULT_BUDGET;
  return {
    maxModelBytes: declared.maxModelBytes,
    previewDirection: declared.previewDirection ?? "head",
    // "truncate" is the default for the same reason the whole budget has one:
    // a tool that declared nothing must land on the pre-TASK.94 behaviour, not
    // on the newest one (TASK.94 DoD-3).
    strategy: declared.strategy ?? "truncate",
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

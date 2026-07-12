/**
 * Tool contract. Tools are authored with Zod input schemas (single source of
 * truth), execute exclusively through ports (never touch fs/child_process
 * directly), and are only *proposed* by the model — execution goes through the
 * dispatch pipeline (validate -> hooks -> permission gate -> timeout/abort).
 */

import type { z } from "zod";
import type { CorePorts } from "../ports/index.js";
import type { SubagentPort } from "../ports/subagent.js";
import type { SkillPort } from "../ports/skills.js";
import type { WorkflowPort } from "../ports/workflow.js";
import type { BackgroundTaskPort } from "../ports/tasks.js";
import type { LspPort } from "../ports/lsp.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { ImageAttachment } from "./images.js";
import type { PlanModeControl } from "./permissions.js";
import type { AgentEvent } from "./events.js";

export type RiskLevel = "low" | "medium" | "high";

export type SideEffectScope = "none" | "filesystem" | "process" | "network";

export interface ToolMetadata {
  name: string;
  /** Model-facing description. Original minimal text; never copied from other products. */
  description: string;
  readOnly: boolean;
  destructive: boolean;
  concurrentSafe: boolean;
  riskLevel: RiskLevel;
  sideEffectScope: SideEffectScope;
  /** Baseline approval requirement; the permission engine combines it with the session mode. */
  needsApproval: boolean;
  /** Default handler timeout, enforced by the dispatcher with an AbortController race. */
  timeoutMs: number;
  /** Upper bound for a per-call timeout override (e.g. the Bash `timeout` input field). */
  maxTimeoutMs?: number;
  /** Cap on model-visible result size; larger payloads are truncated by the formatter. */
  maxOutputBytes?: number;
}

/**
 * Events a long-running tool handler may push through ctx.emit to interleave
 * coarse progress into the parent's event stream (design §3.2). Slice 3.1 added
 * the subagent_* variants; slice 3.4 widens the seam with the workflow_*
 * variants (design §2.2); slice 4.7 adds the checkpoint_* variants (design
 * §2.3), emitted by the dispatcher's auto-checkpoint seam. The union grows as
 * more long-running tools adopt it.
 */
export type ToolEmittedEvent = Extract<
  AgentEvent,
  { type: `subagent_${string}` | `workflow_${string}` | `checkpoint_${string}` }
>;

export interface ToolContext {
  toolCallId: string;
  /** Linked signal: parent turn abort or dispatcher timeout aborts the handler. */
  abortSignal: AbortSignal;
  cwd: string;
  ports: CorePorts;
  /**
   * Entry into an in-process child AgentLoop (design §3.1). Optional by design:
   * its absence is the fail-closed non-recursion lock — the Agent tool returns
   * an "unavailable" error-outcome rather than spawning.
   */
  subagents?: SubagentPort;
  /**
   * Discovered-skills entry (design §2.2/§3.3). Optional by design: its absence
   * is the fail-closed lock — the Skill tool returns a "skills unavailable"
   * error-outcome rather than loading a body. A child subagent receives no port
   * (buildChildConfig does not copy it), so children cannot load skills in v1.
   */
  skills?: SkillPort;
  /**
   * Declarative-workflow entry (design §2.1/§2.2). Optional by design: its
   * absence is the fail-closed lock — the Workflow tool returns a "workflows
   * unavailable" error-outcome rather than starting a run. A child subagent
   * receives no port (buildChildConfig does not copy it), so a step's child can
   * never launch a workflow.
   */
  workflows?: WorkflowPort;
  /**

   * Optional by design: its absence is the fail-closed lock — background-capable
   * Bash / BashOutput / BashKill return an "unavailable" error-outcome rather
   * than spawning or peeking a task. A child subagent receives no port
   * (buildChildConfig does not copy it), so a child can never open a background
   * task even if a `run_in_background` input slipped through.
   */
  tasks?: BackgroundTaskPort;
  /**

   * design: its absence is the fail-soft lock — the diagnostics-wrapped
   * Edit/Write return the inner result untouched, byte-identical to today. A
   * child subagent receives no port (buildChildConfig does not copy it), so a
   * child's edits are never diagnosed.
   */
  lsp?: LspPort;
  /**
   * Live image-capability verdict for the current session model (design

   * lock — the image-wrapped Read returns an explicit "not image-capable" error
   * instead of attaching. A child subagent receives no port (buildChildConfig
   * does not copy it), so a child's Read never attaches an image.
   */
  media?: MediaCapabilityPort;
  /**
   * Interleaves coarse tool-progress events into the parent's stream (design
   * §3.2). Wired by the scheduler; absent when a handler runs outside the
   * batch runner. Long tools emit; short tools ignore it.
   */
  emit?: (event: ToolEmittedEvent) => void;
  /**
   * Sanctioned plan-mode exit (design slice-4.3-cut.md §2.4). Optional by
   * design: its absence is the fail-closed lock — the ExitPlanMode tool returns
   * an "unavailable" error-outcome rather than switching any mode. Built by the
   * loop only when the wiring set AgentLoopConfig.planExitMode; a child subagent
   * receives no control (buildChildConfig copies neither the config field nor
   * this port), so a child can never escalate the parent's mode.
   */
  planMode?: PlanModeControl;
}

/** Handler-level result. Dispatcher-level failures (denied/timeout/...) live on ToolCallOutcome. */
export interface ToolResult<Out = unknown> {
  ok: boolean;
  output?: Out;
  /** Model-visible error text when ok === false. */
  error?: string;
  /** Set only alongside ok:true; rides ToolCallOutcome.result into the loop's tool message. */
  images?: ImageAttachment[];
  /**
   * Failure classification set by the handler when it lost a race it can name
   * (e.g. Bash maps ExecStatus timed_out/cancelled). The dispatcher maps the
   * outcome status as `ok ? "success" : (errorKind ?? "error")` (design §2.10, B2).
   * "invalid_input" lets a handler classify a bad argument it can only validate
   * itself — e.g. the Agent tool's agent_type checked against the persona
   * registry (design §3.4), which is deliberately not a zod-enum.
   */
  errorKind?: "timed_out" | "cancelled" | "invalid_input";
}

/**
 * Provider-agnostic tool declaration handed to ModelPort (design §2.2):
 * the ready-made JSON Schema comes from z.toJSONSchema on the zod input schema.
 */
export interface ToolDeclaration {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

export type ToolCallStatus =
  | "success"
  | "error"
  | "invalid_input"
  | "denied"
  | "timed_out"
  | "cancelled";

/** Final outcome of one dispatched tool call; always produced, never thrown. */
export interface ToolCallOutcome {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  /** Present when the handler actually ran. */
  result?: ToolResult;
  /** Text fed back to the model as the tool result content. */
  modelText: string;
  durationMs: number;
}

export interface ToolDefinition<In = unknown, Out = unknown> {
  metadata: ToolMetadata;
  /** Zod schema; converted to JSON Schema and wrapped with the SDK's jsonSchema() for the model. */
  inputSchema: z.ZodType<In>;
  /**
   * Raw JSON Schema for the tool input, used verbatim in ToolDeclaration when
   * present (MCP tools arrive as JSON Schema, not zod). The zod inputSchema
   * slot still runs in the dispatch pipeline (a permissive passthrough for MCP
   * tools — real validation happens server-side).
   */
  rawInputJsonSchema?: Record<string, unknown>;
  handler(input: In, ctx: ToolContext): Promise<ToolResult<Out>>;
  /** Renders the result payload into model-visible text. Default: JSON serialization with size cap. */
  formatResultForModel?(result: ToolResult<Out>): string;
}

/** Existential wrapper for heterogeneous registry storage. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * Tool contract. Tools are authored with Zod input schemas (single source of
 * truth), execute exclusively through ports (never touch fs/child_process
 * directly), and are only *proposed* by the model — execution goes through the
 * dispatch pipeline (validate -> hooks -> permission gate -> timeout/abort).
 */

import type { z } from "zod";
import type { CorePorts } from "../ports/index.js";
import type { SubagentPort } from "../ports/subagent.js";
import type { SessionSubagentPort } from "../ports/session-subagent.js";
import type { SkillPort } from "../ports/skills.js";
import type { WorkflowPort } from "../ports/workflow.js";
import type { BackgroundTaskPort } from "../ports/tasks.js";
import type { LspPort } from "../ports/lsp.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { ImageAttachment } from "./images.js";
import type { PlanModeControl } from "./permissions.js";
import type { AgentEvent } from "./events.js";
import type { WorkspaceTransition, WorktreeControlPort } from "../ports/worktrees.js";
import type { PreviewPort } from "../ports/preview.js";
import type { ArtifactContext, ArtifactRetention } from "../ports/artifacts.js";
import type { ResultPreviewDirection } from "../util/result-budget.js";
import type { ToolResultPresentation } from "./subagent-card.js";

export type RiskLevel = "low" | "medium" | "high";

export type SideEffectScope = "none" | "filesystem" | "process" | "network";

export interface ToolMetadata {
  name: string;
  /** Model-facing description. Original minimal text; never copied from other products. */
  description: string;
  readOnly: boolean;
  destructive: boolean;
  concurrentSafe: boolean;
  /** Successful handler result terminates this loop segment (always solo). */
  terminalControl?: boolean;
  riskLevel: RiskLevel;
  sideEffectScope: SideEffectScope;
  /** Baseline approval requirement; the permission engine combines it with the session mode. */
  needsApproval: boolean;
  /** Default handler timeout, enforced by the dispatcher with an AbortController race. */
  timeoutMs: number;
  /** Upper bound for a per-call timeout override (e.g. the Bash `timeout` input field). */
  maxTimeoutMs?: number;
  /**
   * Inline cap: how much the handler itself may buffer and return (the Bash
   * ExecutionPort request, the WebFetch body cap). It is NOT the model-visible
   * cap — that is `resultBudget`, which the dispatcher enforces. The two are
   * separate numbers on purpose: Bash may keep megabytes for the host while the
   * model only ever sees the budgeted tail.
   */
  maxOutputBytes?: number;
  /**
   * Model-visible result budget (TASK.93). Omitting it does NOT mean "no
   * limit" — the dispatcher falls back to DEFAULT_TOOL_RESULT_BUDGET, so a new
   * tool is bounded before anyone remembers to declare anything.
   */
  resultBudget?: ToolResultBudget;
}

/** Per-tool cap on the text a result contributes to the model's context. */
export interface ToolResultBudget {
  /** Hard cap in UTF-8 bytes, inclusive of the truncation notice. */
  maxModelBytes: number;
  /** Which end of an oversized payload survives. Default "head". */
  previewDirection?: ResultPreviewDirection;
  /**
   * What happens to the bytes that do not fit (TASK.94). "truncate" (the
   * default, and what every tool got before this field existed) destroys them.
   * "artifact" writes the full rendered text to the artifact store and hands
   * the model an envelope with the path plus a preview, so the remainder is
   * recoverable with Read/Grep instead of by re-running the tool.
   *
   * Opting in is not a promise: with no ArtifactStorePort in the dispatch
   * context, or on any store failure, the result falls back to "truncate".
   */
  strategy?: "truncate" | "artifact";
  /**
   * Retention class for the spilled artifact. Semantically required when
   * strategy === "artifact"; ignored otherwise.
   */
  artifact?: { retention: ArtifactRetention };
}

/**
 * What a tool sees when its oversized result was spilled to an artifact and it
 * gets to author the envelope itself (`formatPersistedModelContent`).
 */
export interface PersistedRenderContext<Out = unknown> {
  /** The handler result, so the formatter can speak about exit codes and status. */
  result: ToolResult<Out>;
  /** Absolute path of the written artifact — the whole point of the envelope. */
  path: string;
  /** Size of the persisted text in UTF-8 bytes. */
  originalBytes: number;
  /**
   * Preview already cut to ARTIFACT_PREVIEW_BYTES on a line boundary, taken
   * from the end the tool's previewDirection asked for. The formatter embeds
   * it; it must not re-cut it.
   */
  preview: string;
  /** Which end `preview` was taken from, so the envelope can say so honestly. */
  previewDirection: ResultPreviewDirection;
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
   * Session-tier subagent entry (TASK.102 CUT-S2 §2.2/§0.2): spawns a full
   * child SESSION in its own process, distinct from the in-process `subagents`
   * port above. Optional by design and NEVER copied by buildChildConfig — its
   * physical absence is non-recursion lock #2 of 3 (the schema-level
   * restricted `Agent` declaration is lock #1; main's `childOf` spawn refusal
   * is lock #3, CUT-S2 §0.2). The Agent tool's `tier:"session"` branch reads
   * this; `tier:"inline"` (default) always uses `subagents` instead.
   */
  sessionSubagents?: SessionSubagentPort;
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
  /**
   * Host-owned workspace relocation seam. It is deliberately optional: only
   * the parent desktop host registers the paired worktree tools and supplies
   * this port; child loops and other clients fail closed.
   */
  worktrees?: WorktreeControlPort;
  /**
   * Host-owned browser-preview control plane (night-track wave-1 cut §2.1).
   * Optional by design: its absence is the fail-closed lock — BrowserOpen/
   * BrowserRead/BrowserScreenshot return an "unavailable" error-outcome
   * rather than reaching a preview window. Only the desktop host registers
   * the Browser* tools and supplies this port; a child subagent receives no
   * port (buildChildConfig does not copy it), so a child's Browser* calls
   * always fail closed — avoids window-focus/consent races between parallel
   * children (wave1-cut.md §1(f)).
   */
  preview?: PreviewPort;
  /**
   * Artifact store plus the session to write under (TASK.94). Present here for
   * symmetry with DispatchContext and for future handler-side use; the SPILL
   * itself is performed by the dispatcher, not by handlers — a handler that
   * wrote artifacts on its own would bypass the budget layer that decides
   * whether a spill is warranted at all. Optional by design: its absence makes
   * `strategy: "artifact"` degrade to truncation.
   */
  artifacts?: ArtifactContext;
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
   * registry (design §3.4), which is deliberately not a zod-enum. "max_turns"
   * lets the Agent tool surface a subagent that hit its turn budget as an
   * honest incomplete outcome rather than masquerading as success (TASK.44).
   */
  errorKind?: "timed_out" | "cancelled" | "max_turns" | "invalid_input";
  /**
   * Successful terminal control result. The scheduler stops before every
   * later proposal and AgentLoop ends the current host segment after pairing
   * all proposed calls in history.
   */
  control?: { type: "workspace_transition"; transition: WorkspaceTransition };
  /**
   * Renderer-facing card presentation (TASK.102 slice S1, CUT-S1 §2.3).
   * NEVER model-visible: formatResultForModel/stringifyOutput never see this
   * field — it rides ToolCallOutcome.result straight into the ToolResultPart
   * via buildToolResultMessage (loop/agent-loop.ts), for persistence/hydration
   * only.
   */
  presentation?: ToolResultPresentation;
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
  | "max_turns"
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
  /**
   * Resolve input-sensitive safety metadata after zod + hook rewriting. The
   * dispatcher uses this result for permission, checkpoint and timeout gates.
   * It must be pure and must not weaken the declared concurrency contract.
   */
  resolveMetadata?(input: In): ToolMetadata;
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
  /**
   * Renders the envelope shown to the model when this tool's oversized result
   * was spilled to an artifact (TASK.94 §2). Optional: without it the
   * dispatcher emits a generic `<persisted-output>` envelope. A tool overrides
   * it when the generic one would be actively unhelpful — Bash's persisted text
   * is a JSON BashOutput, and a raw JSON stump tells the model nothing about
   * the exit code it actually cares about.
   *
   * The result is still passed through the tool's result budget afterwards, so
   * a formatter cannot use this hook to escape its cap.
   */
  formatPersistedModelContent?(ctx: PersistedRenderContext<Out>): string;
}

/** Existential wrapper for heterogeneous registry storage. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

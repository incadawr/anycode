/**
 * WorkflowPort (Phase 3 slice 3.4, design §2.1): the entry point into a
 * declarative DAG run built ON TOP of the existing SubagentPort. Exposed as a
 * PORT so the Workflow tool — which lives in tools/, a layer BELOW loop/ and the
 * engine — can start a run WITHOUT importing the engine or AgentLoop (that would

 * this over child loops driven through the SubagentPort; the tool only ever sees
 * this interface. Absence of the port in a ToolContext is the fail-closed
 * non-recursion lock (a child subagent receives no port — buildChildConfig does
 * not copy it — and carries no Workflow declaration).
 */

import type { TokenUsage } from "../types/events.js";

/** One step of a declarative workflow DAG (validated at discovery). */
export interface WorkflowStepDefinition {
  /** ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$; unique within the workflow. */
  id: string;
  /** Built-in persona or md-profile name; existence is checked at RUN start (fail-fast), not at discovery. */
  agentType: string;
  /** User content. Placeholders: ${input} and ${steps.<id>} where <id> ∈ dependsOn (validated statically). */
  promptTemplate: string;
  /** Step ids this step waits for; results become template variables. Absent = source step. */
  dependsOn?: readonly string[];
  /** Optional per-step turn budget; the runner caps it at SUBAGENT_MAX_TURNS_CEILING. */
  maxTurns?: number;
}

export interface WorkflowDefinition {
  /** NAME_RE; fallback = file stem. */
  name: string;
  /** Required (nothing to advertise without it). */
  description: string;
  /** 1..MAX_WORKFLOW_STEPS, acyclic. */
  steps: readonly WorkflowStepDefinition[];
  /** Optional output template (${input}/${steps.<id>} over ALL steps); default = sink steps' finalText joined. */
  outputTemplate?: string;
  /** "project" | "user" (data, widened by plugins later). */
  source: string;
  /** Absolute definition path. */
  path: string;
}

/** Advertised metadata for list()/prompt-section (mirror of SkillMeta). */
export interface WorkflowMeta {
  name: string;
  description: string;
  stepCount: number;
  source: string;
}

/**
 * The run's step graph, as carried on `workflow_start` (TASK.191 slice S3):
 * just enough of `WorkflowStepDefinition` for the desktop card to hold and
 * lay out all N steps before the first one launches — `promptTemplate` and
 * `maxTurns` are engine-internal and never rendered, so they stay off the
 * wire.
 */
export interface WorkflowStepGraphNode {
  id: string;
  agentType: string;
  dependsOn?: readonly string[];
}

export interface WorkflowStepOutcome {
  stepId: string;
  agentType: string;
  /** "skipped" = dependency failed / run aborted before launch. */
  status: "completed" | "max_turns" | "cancelled" | "error" | "skipped";
  /** Capped by the runner (SUBAGENT_OUTPUT_MAX_BYTES). */
  finalText: string;
  truncated: boolean;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

export interface WorkflowRunOutcome {
  status: "completed" | "failed" | "cancelled";
  /** Rendered output (outputTemplate or sink join), capped at WORKFLOW_OUTPUT_MAX_BYTES. */
  output: string;
  truncated: boolean;
  /** One entry per definition step, in DEFINITION order (deterministic shape). */
  steps: WorkflowStepOutcome[];
  durationMs: number;
}

/** Coarse progress events bridged into the parent stream as workflow_* AgentEvents (design §2.3/§3.4). */
export type WorkflowProgress =
  // `steps` (TASK.191 slice S3) is the run's full step graph, so a client can
  // hold and order all N steps before the first `step_start` arrives instead
  // of discovering them one at a time in event-ARRIVAL order.
  | { kind: "start"; workflow: string; totalSteps: number; steps: readonly WorkflowStepGraphNode[] }
  | { kind: "step_start"; stepId: string; agentType: string }
  // The step's REAL (post-semaphore) start (TASK.191 slice S3), distinct from
  // `step_start` above: that one fires the instant a step's deps are
  // satisfied, BEFORE the engine ever calls `subagents.run` — so a step can
  // sit ready-but-unlaunched behind the runner's shared MAX_CONCURRENT_SUBAGENTS
  // semaphore for real wall-clock time, and `step_start` alone cannot tell
  // "queued" apart from "running" (a client-side guess from dependsOn was
  // tried and disproven — engine.ts emits step_start before ever touching the
  // semaphore). This variant rides the child's own SubagentProgress "start"
  // (already the point the engine arms the per-step timeout, for the same
  // post-semaphore reason).
  | { kind: "step_running"; stepId: string }
  // `usage` (TASK.191 slice S2) is the STEP's cumulative token spend since its
  // own start, forwarded from the child's SubagentProgress unchanged. Cumulative
  // and REPLACED by the receiver, never added — a lost or repeated progress
  // event must not shift the number. Optional because a tier that reports no
  // spend (session-tier / engine children) must read as "not reported", which
  // is a different fact from zero.
  | {
      kind: "step_progress";
      stepId: string;
      turns: number;
      toolCalls: number;
      lastTool?: string;
      usage?: TokenUsage;
    }
  // Per-step tool activity (TASK.191 slice S1): the step's child emitted one
  // bounded one-liner for its own tool call, forwarded verbatim with the step
  // stamped on it. `toolName`/`summary` arrive already capped and sanitized by
  // the producing SubagentPort (never raw child input) — this variant adds
  // `stepId` and nothing else, because the run-level feed is ONE lane shared by
  // every concurrent step and each row must say which lane it came from.
  | { kind: "step_activity"; stepId: string; toolName: string; summary: string }
  | {
      kind: "step_end";
      stepId: string;
      status: WorkflowStepOutcome["status"];
      turns: number;
      durationMs: number;
      /** The step's FINAL spend, read off the child's own SubagentOutcome. */
      usage?: TokenUsage;
    }
  | {
      kind: "end";
      status: WorkflowRunOutcome["status"];
      completedSteps: number;
      totalSteps: number;
      durationMs: number;
    };

export interface WorkflowRunOptions {
  /** Linked to the Workflow tool call's abort so parent-stop cascades into every step. */
  signal?: AbortSignal;
  onProgress?: (progress: WorkflowProgress) => void;
}

export interface WorkflowPort {
  /** Boot-time discovery snapshot (static for the session, mirrors skills/MCP rulings). */
  list(): WorkflowMeta[];
  /** Unknown name / structural failure => failed outcome, NEVER a throw (mirror of SubagentPort.run). */
  run(req: { name: string; input?: string }, opts: WorkflowRunOptions): Promise<WorkflowRunOutcome>;
}

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
  /** Optional per-step turn budget; the runner caps it at DEFAULT_SUBAGENT_MAX_TURNS regardless. */
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
  | { kind: "start"; workflow: string; totalSteps: number }
  | { kind: "step_start"; stepId: string; agentType: string }
  | { kind: "step_progress"; stepId: string; turns: number; toolCalls: number; lastTool?: string }
  | { kind: "step_end"; stepId: string; status: WorkflowStepOutcome["status"]; turns: number; durationMs: number }
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

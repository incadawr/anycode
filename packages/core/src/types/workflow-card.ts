/**
 * Persisted workflow card snapshot (TASK.191 slice S5). Mirror of
 * types/subagent-card.ts's SubagentCardSnapshotV1: a versioned terminal
 * snapshot riding the paired tool_result's `presentation` field — no SQLite
 * migration, same discipline the subagent card already established.
 *
 * Pure types, no imports from tools/events: subagent-card.ts imports THIS
 * file for its `ToolResultPresentation` envelope's sibling `workflow` key,
 * and types/tools.ts imports subagent-card.ts for that same envelope, and
 * types/events.ts imports types/tools.ts (ToolCallOutcome) — so an import of
 * TokenUsage FROM types/events.ts HERE would close events.ts -> tools.ts ->
 * subagent-card.ts -> workflow-card.ts -> events.ts. This is the exact cycle
 * types/events.ts's own workflow_start doc comment already sidesteps for
 * WorkflowStepGraphNode ("Shape duplicated ... rather than imported"); the
 * usage shape below is a deliberate duplicate of TokenUsage for the same
 * reason (both are import-type-only, which TS tolerates, but this package
 * treats ports/types as a one-way arrow everywhere else).
 */

/** Duplicate of types/events.ts's TokenUsage — see the file header for why this cannot be an import. */
export interface WorkflowCardTokenUsage {
  inputTokens?: number;
  /** Input tokens served from the provider prompt cache; included in inputTokens. */
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Terminal status of a settled workflow step — same union as WorkflowStepOutcome["status"] (ports/workflow.ts). */
export type WorkflowCardStepStatus = "completed" | "max_turns" | "cancelled" | "error" | "skipped";

/** Terminal status of a settled workflow run — same union as WorkflowRunOutcome["status"] (ports/workflow.ts). */
export type WorkflowCardRunStatus = "completed" | "failed" | "cancelled";

export interface WorkflowCardActivityEntry {
  /** Which step's lane this row came from — the run-level feed is shared by every concurrent step. */
  stepId: string;
  toolName: string;
  summary: string;
}

export interface WorkflowCardStepResult {
  status: WorkflowCardStepStatus;
  turns: number;
  durationMs: number;
  /** The step's FINAL spend (workflow_step_end's own usage). Absent = the tier reported none, not zero. */
  usage?: WorkflowCardTokenUsage;
}

/**
 * One node of the run's step graph, as reported on workflow_start, with its
 * terminal result folded in once the step reaches workflow_step_end.
 * `dependsOn` is REQUIRED here for the graph to be worth persisting at all:
 * without it a reloaded card cannot tell "queued behind a dependency" from
 * "never started" — exactly the distinction TASK.191 slice S3 built the live
 * card to make, so dropping the field here would silently regress it after
 * every reload.
 */
export interface WorkflowCardStep {
  id: string;
  agentType: string;
  /** Absent = a source step (no dependencies). */
  dependsOn?: readonly string[];
  /**
   * Absent only for a step whose workflow_step_end never arrived. In
   * practice this cannot happen in a snapshot that reached `final`
   * (workflow/engine.ts emits step_end for every step, launched or
   * synthetically skipped — TASK.191 slice S3), but the type does not
   * assume the wire is honest.
   */
  result?: WorkflowCardStepResult;
}

export interface WorkflowCardSnapshotV1 {
  kind: "workflow";
  version: 1;
  /** Workflow definition name, as reported on workflow_start. */
  workflow: string;
  totalSteps: number;
  /** Definition order (workflow_start's own order), not event-arrival order. */
  steps: readonly WorkflowCardStep[];
  activity: {
    /** <= WORKFLOW_CARD_ACTIVITY_RING, oldest-first. ONE lane for the whole run, shared across every concurrent step. */
    entries: readonly WorkflowCardActivityEntry[];
    /**
     * Ring/byte-cap evictions across the WHOLE RUN. An evicted entry's
     * `stepId` is gone with it — this counter is deliberately run-scoped,
     * never per-step: attributing it back to one step after the row itself
     * was discarded would be a fabrication.
     */
    dropped: number;
  };
  /**
   * REQUIRED (mirror of SubagentCardSnapshotV1's `final`): a persisted
   * snapshot is only ever written once the Workflow tool call has settled,
   * so a durable record without a terminal status would be a contradiction.
   * Nullable `end` lives only in the internal accumulator, never here.
   */
  final: {
    status: WorkflowCardRunStatus;
    durationMs: number;
  };
}

/**
 * Workflow tool (Phase 3 slice 3.4, design §2.7): starts a declarative DAG run
 * via ctx.workflows (a WorkflowPort) and returns its outcome as a normal tool
 * result. A thin mirror of the Agent tool — ALL orchestration lives in the
 * engine behind the port; the tool lives BELOW loop/ and never imports the
 * engine or AgentLoop (§2.10).
 *

 * the run itself is side-effect-free, and every effectful child tool call passes
 * the SAME inherited permission gate (plan-mode stays honest: a step's child
 * inherits plan, so its write tools go to deny). concurrentSafe:false — one run
 * already saturates the shared subagent semaphore, so parallel runs would only
 * interleave event noise.
 *
 * The handler never throws — every path is a ToolResult. Absence of the port is
 * the fail-closed lock (mirror of Agent without a SubagentPort): a child loop's
 * DispatchContext leaves workflows unset, so a step's child can never launch a
 * workflow.
 */

import type { ToolDefinition, ToolEmittedEvent, ToolMetadata } from "../types/tools.js";
import type { WorkflowProgress } from "../ports/workflow.js";
import type { ToolResultPresentation } from "../types/subagent-card.js";
import { WORKFLOW_OUTPUT_MAX_BYTES, WORKFLOW_TOOL_TIMEOUT_MS } from "../types/config.js";
import { workflowInputSchema, type WorkflowInput, type WorkflowOutput } from "./schemas.js";
import {
  createWorkflowCardAccumulator,
  finalizeWorkflowCard,
  reduceWorkflowCardEvent,
  type WorkflowCardEvent,
} from "../workflow/card-snapshot.js";
import { buildFailureSummary, stepFailure } from "../workflow/step-failure.js";

const metadata: ToolMetadata = {
  name: "Workflow",
  description:
    "Run a named declarative workflow: a DAG of scoped subagent steps whose results feed into later steps, reporting back a single rendered result.",
  readOnly: true,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "low",
  sideEffectScope: "process",
  needsApproval: false,
  timeoutMs: WORKFLOW_TOOL_TIMEOUT_MS,
  maxTimeoutMs: WORKFLOW_TOOL_TIMEOUT_MS,
  maxOutputBytes: WORKFLOW_OUTPUT_MAX_BYTES,
};

export const workflowTool: ToolDefinition<WorkflowInput, WorkflowOutput> = {
  metadata,
  inputSchema: workflowInputSchema,
  handler: async (input, ctx) => {
    // Fail-closed lock (design §2.2/§2.7): no port => workflows are unavailable,
    // exactly like the Agent tool without a SubagentPort. A child loop leaves
    // ctx.workflows unset, so a step's child can never launch a workflow.
    if (!ctx.workflows) {
      return { ok: false, error: "Workflow: workflows are unavailable in this context." };
    }

    // Validate the name against the discovery snapshot (mirror of Agent/Skill):
    // the model supplies no paths, so there is no traversal surface. An unknown
    // name is a handler-level invalid_input carrying the available list.
    const available = ctx.workflows.list().map((meta) => meta.name);
    if (!available.includes(input.name)) {
      return {
        ok: false,
        errorKind: "invalid_input",
        error:
          available.length > 0
            ? `Unknown workflow "${input.name}". Available workflows: ${available.join(", ")}.`
            : `Unknown workflow "${input.name}". No workflows are available.`,
      };
    }

    // Run through the port. Coarse progress is bridged into the parent's stream
    // as workflow_* events via ctx.emit (design §2.3), each carrying THIS tool
    // call's id so the desktop card correlates them. The engine never throws —
    // an unknown name / structural failure is a failed outcome.
    //
    // Presentation accumulation (TASK.191 slice S5, mirror of tools/agent.ts's
    // own subagent-card accumulation): fed from the SAME mapped event ctx.emit
    // receives, not the raw WorkflowProgress, so the persisted activity entries
    // stay byte-identical to what the live renderer saw — same reasoning as the
    // subagent card. Unconditional (it runs even with no ctx.emit wired) so a
    // handler invoked outside the batch runner still produces a persisted card.
    let acc = createWorkflowCardAccumulator();
    const outcome = await ctx.workflows.run(
      { name: input.name, input: input.input },
      {
        signal: ctx.abortSignal,
        onProgress: (progress) => {
          const event = mapProgressToEvent(progress, ctx.toolCallId);
          // mapProgressToEvent's declared return type is the broader
          // ToolEmittedEvent (shared with the subagent_*/checkpoint_*
          // bridges elsewhere) — not narrowed to workflow_* here, per this
          // slice's own constraint of leaving that bridge untouched. Every
          // branch of its switch over WorkflowProgress.kind actually stamps
          // a workflow_* type, so this narrowing is safe.
          acc = reduceWorkflowCardEvent(acc, event as WorkflowCardEvent);
          ctx.emit?.(event);
        },
      },
    );

    // Terminal snapshot, or null when the run never actually started (an
    // unknown name / a pre-aborted signal fail before the engine's first
    // onProgress call — the card is never fabricated from nothing). A
    // fail-fast unknown-agentType pre-check DOES stream start/step_end/end
    // now (TASK.193, workflow/engine.ts), each error terminal carrying
    // `unlaunched: true`, so its card is produced like any other run.
    const snapshot = finalizeWorkflowCard(acc, { status: outcome.status, durationMs: outcome.durationMs });
    const presentation: { presentation?: ToolResultPresentation } =
      snapshot !== null ? { presentation: { workflow: snapshot } } : {};

    // Project the outcome onto the tool payload. A SUCCESSFUL step's finalText
    // stays dropped (what the model sees of a step that worked is the
    // definition author's call — outputTemplate / the sink join). A FAILED
    // step's reason is carried instead of discarded (TASK.193): nothing else
    // delivers it, and without it the owner debugs every failure by guessing.
    const output: WorkflowOutput = {
      status: outcome.status,
      output: outcome.output,
      truncated: outcome.truncated,
      steps: outcome.steps.map((step) => {
        const failure = stepFailure(step);
        return {
          stepId: step.stepId,
          agentType: step.agentType,
          status: step.status,
          turns: step.turns,
          toolCalls: step.toolCalls,
          durationMs: step.durationMs,
          ...(failure !== null ? { failure } : {}),
          ...(step.unlaunched === true ? { unlaunched: true as const } : {}),
        };
      }),
      durationMs: outcome.durationMs,
    };

    if (outcome.status === "completed") {
      return { ok: true, output, ...presentation };
    }
    if (outcome.status === "cancelled") {
      return {
        ok: false,
        errorKind: "cancelled",
        error: `Workflow "${input.name}" was cancelled.`,
        output,
        ...presentation,
      };
    }
    // failed: the one-line summary naming the failed + skipped steps, followed
    // by one labelled reason block per failed step, the whole string within
    // WORKFLOW_FAILURE_SUMMARY_MAX_BYTES (the rendered output — possibly
    // partial — is appended by formatResultForModel and keeps the rest of the
    // dispatcher's budget).
    return { ok: false, error: buildFailureSummary(input.name, output.steps), output, ...presentation };
  },
  formatResultForModel: (result) => {
    const output = result.output;
    const body = output?.output ?? "";
    if (!result.ok) {
      // The model sees the failure summary followed by any rendered output.
      // TASK.221: a capped precheck output carries the same truncation marker
      // the completed path appends — truncation is reported, never silent.
      const summary = result.error ?? "Workflow: the run failed.";
      const marker = output?.truncated
        ? `\n[workflow output truncated at ${WORKFLOW_OUTPUT_MAX_BYTES} bytes]`
        : "";
      return body ? `${summary}\n\n${body}${marker}` : summary;
    }
    if (!output) {
      return "";
    }
    return output.truncated
      ? `${body}\n[workflow output truncated at ${WORKFLOW_OUTPUT_MAX_BYTES} bytes]`
      : body;
  },
};

/**
 * Projects a coarse WorkflowProgress onto the matching workflow_* AgentEvent,
 * stamping the Workflow tool call's id (design §2.3). The variants map 1:1.
 */
function mapProgressToEvent(progress: WorkflowProgress, toolCallId: string): ToolEmittedEvent {
  switch (progress.kind) {
    case "start":
      return {
        type: "workflow_start",
        toolCallId,
        workflow: progress.workflow,
        totalSteps: progress.totalSteps,
        // Copied EXPLICITLY, field by field (TASK.191 slice S3): same
        // discipline as step_progress's usage bridge below — a field added to
        // WorkflowStepGraphNode and not named here type-checks green and
        // arrives nowhere.
        steps: progress.steps.map((step) => ({
          id: step.id,
          agentType: step.agentType,
          ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
        })),
      };
    case "step_start":
      return {
        type: "workflow_step_start",
        toolCallId,
        stepId: progress.stepId,
        agentType: progress.agentType,
      };
    case "step_running":
      return {
        type: "workflow_step_running",
        toolCallId,
        stepId: progress.stepId,
      };
    case "step_progress":
      return {
        type: "workflow_step_progress",
        toolCallId,
        stepId: progress.stepId,
        turns: progress.turns,
        toolCalls: progress.toolCalls,
        lastTool: progress.lastTool,
        // Copied EXPLICITLY (TASK.191 slice S2): this bridge names every field
        // it carries, so a field added to WorkflowProgress and not added here
        // type-checks green and arrives nowhere.
        ...(progress.usage !== undefined ? { usage: progress.usage } : {}),
      };
    case "step_activity":
      return {
        type: "workflow_step_activity",
        toolCallId,
        stepId: progress.stepId,
        toolName: progress.toolName,
        summary: progress.summary,
      };
    case "step_end":
      return {
        type: "workflow_step_end",
        toolCallId,
        stepId: progress.stepId,
        status: progress.status,
        turns: progress.turns,
        durationMs: progress.durationMs,
        // Copied EXPLICITLY (TASK.193): same discipline as the usage bridge
        // above — a field added to WorkflowProgress's step_end and not named
        // here type-checks green and arrives nowhere.
        ...(progress.usage !== undefined ? { usage: progress.usage } : {}),
        ...(progress.failure !== undefined ? { failure: progress.failure } : {}),
        ...(progress.unlaunched === true ? { unlaunched: true as const } : {}),
      };
    case "end":
      return {
        type: "workflow_end",
        toolCallId,
        status: progress.status,
        completedSteps: progress.completedSteps,
        totalSteps: progress.totalSteps,
        durationMs: progress.durationMs,
      };
  }
}

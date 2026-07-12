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
import { WORKFLOW_OUTPUT_MAX_BYTES, WORKFLOW_TOOL_TIMEOUT_MS } from "../types/config.js";
import { workflowInputSchema, type WorkflowInput, type WorkflowOutput } from "./schemas.js";

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
    const outcome = await ctx.workflows.run(
      { name: input.name, input: input.input },
      {
        signal: ctx.abortSignal,
        onProgress: (progress) => ctx.emit?.(mapProgressToEvent(progress, ctx.toolCallId)),
      },
    );

    // Project the outcome onto the tool payload (drop per-step finalText/truncated).
    const output: WorkflowOutput = {
      status: outcome.status,
      output: outcome.output,
      truncated: outcome.truncated,
      steps: outcome.steps.map((step) => ({
        stepId: step.stepId,
        agentType: step.agentType,
        status: step.status,
        turns: step.turns,
        toolCalls: step.toolCalls,
        durationMs: step.durationMs,
      })),
      durationMs: outcome.durationMs,
    };

    if (outcome.status === "completed") {
      return { ok: true, output };
    }
    if (outcome.status === "cancelled") {
      return {
        ok: false,
        errorKind: "cancelled",
        error: `Workflow "${input.name}" was cancelled.`,
        output,
      };
    }
    // failed: one-line summary naming the failed + skipped steps (the rendered
    // output — possibly partial — is added by formatResultForModel).
    return { ok: false, error: summarizeFailure(input.name, output), output };
  },
  formatResultForModel: (result) => {
    const output = result.output;
    const body = output?.output ?? "";
    if (!result.ok) {
      // The model sees the failure summary followed by any rendered output.
      const summary = result.error ?? "Workflow: the run failed.";
      return body ? `${summary}\n\n${body}` : summary;
    }
    if (!output) {
      return "";
    }
    return output.truncated
      ? `${body}\n[workflow output truncated at ${WORKFLOW_OUTPUT_MAX_BYTES} bytes]`
      : body;
  },
};

/** One-line failure summary: the workflow name + its failed and skipped step ids. */
function summarizeFailure(name: string, output: WorkflowOutput): string {
  const failed = output.steps
    .filter((step) => step.status !== "completed" && step.status !== "skipped")
    .map((step) => step.stepId);
  const skipped = output.steps.filter((step) => step.status === "skipped").map((step) => step.stepId);
  const parts = [`Workflow "${name}" failed.`];
  if (failed.length > 0) {
    parts.push(`Failed: ${failed.join(", ")}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * Projects a coarse WorkflowProgress onto the matching workflow_* AgentEvent,
 * stamping the Workflow tool call's id (design §2.3). The five variants map 1:1.
 */
function mapProgressToEvent(progress: WorkflowProgress, toolCallId: string): ToolEmittedEvent {
  switch (progress.kind) {
    case "start":
      return {
        type: "workflow_start",
        toolCallId,
        workflow: progress.workflow,
        totalSteps: progress.totalSteps,
      };
    case "step_start":
      return {
        type: "workflow_step_start",
        toolCallId,
        stepId: progress.stepId,
        agentType: progress.agentType,
      };
    case "step_progress":
      return {
        type: "workflow_step_progress",
        toolCallId,
        stepId: progress.stepId,
        turns: progress.turns,
        toolCalls: progress.toolCalls,
        lastTool: progress.lastTool,
      };
    case "step_end":
      return {
        type: "workflow_step_end",
        toolCallId,
        stepId: progress.stepId,
        status: progress.status,
        turns: progress.turns,
        durationMs: progress.durationMs,
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

/**
 * Agent tool (Phase 3 slice 3.1, design §3.4): spawns an in-process subagent
 * via ctx.subagents (a SubagentPort) and returns its outcome as a normal tool
 * result. The tool lives BELOW loop/ and never imports AgentLoop — the port is
 * the only seam (§3.1).
 *

 * spawn itself is side-effect-free, and every effectful child tool call passes
 * the SAME inherited permission gate, so gating the spawn too would only add
 * noise. Plan-mode stays honest: the child inherits plan, so its write tools go
 * to deny.
 *
 * Slice 3.1.2 EXPANDS this handler with the real run->outcome mapping, the
 * SubagentProgress -> ctx.emit(subagent_*) bridge and output capping. The
 * version here validates agent_type, enforces the fail-closed "unavailable"
 * lock, and keeps the run() seam clean.
 */

import type { ToolDefinition, ToolEmittedEvent, ToolMetadata } from "../types/tools.js";
import type { SubagentProgress } from "../ports/subagent.js";
import { SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS, SUBAGENT_OUTPUT_MAX_BYTES } from "../types/config.js";
import { listPersonaNames } from "../subagents/personas.js";
import {
  sanitizeAndCap,
  SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS,
} from "../subagents/summarize-tool.js";
import { agentInputSchema, type AgentInput, type AgentOutput } from "./schemas.js";

/** Persona used when the model omits agent_type. */
const DEFAULT_AGENT_TYPE = "general-purpose";

const metadata: ToolMetadata = {
  name: "Agent",
  description:
    'Delegate a task to a subagent. agent_type "explore" = read-only recon for sweeping several files when you only need the conclusion; "general-purpose" = the subtask needs write/exec tools. Independent Agent calls issued together in one response run concurrently — fan out disjoint searches. For a single known-file fact, Read/Grep it yourself; once delegated, do not redo the search.',
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "process",
  needsApproval: false,
  timeoutMs: 600_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: SUBAGENT_OUTPUT_MAX_BYTES,
};

export const agentTool: ToolDefinition<AgentInput, AgentOutput> = {
  metadata,
  inputSchema: agentInputSchema,
  handler: async (input, ctx) => {
    const agentType = input.agent_type ?? DEFAULT_AGENT_TYPE;

    // Validate the agent_type (design §2.3/§3.4): the set of runnable types is
    // delegated to the port (built-in personas + md-profiles) so slice 3.3's
    // profiles are reachable WITHOUT touching the frozen schema. A port lacking
    // listAgentTypes (older/fake) falls back to the built-in persona list.
    // Unknown type is a handler-level invalid_input carrying the available list.
    const available = ctx.subagents?.listAgentTypes?.() ?? listPersonaNames();
    if (!available.includes(agentType)) {
      return {
        ok: false,
        errorKind: "invalid_input",
        error: `Unknown agent_type "${agentType}". Available agent types: ${available.join(", ")}.`,
      };
    }

    // Non-recursion lock (design §3.1/§3.2): no port => fail closed. A child
    // loop's DispatchContext leaves subagents unset, so a child can never spawn.
    // A known-but-childless type still lands here (invalid_input for unknown,
    // unavailable for known — both fail-closed, design §2.3).
    if (!ctx.subagents) {
      return {
        ok: false,
        error: "Agent: subagents are unavailable in this context.",
      };
    }

    // Run the child loop through the port. Coarse progress is bridged into the
    // parent's stream as subagent_* events via ctx.emit (design §3.2/§3.3), each
    // carrying THIS Agent call's toolCallId so the desktop card correlates them.
    // The dispatcher turns any throw into an error-outcome, so the loop stays sound.
    const outcome = await ctx.subagents.run(
      {
        agentType,
        description: input.description,
        prompt: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
      {
        signal: ctx.abortSignal,
        onProgress: (progress) => ctx.emit?.(mapProgressToEvent(progress, ctx.toolCallId)),
      },
    );

    if (outcome.status === "error") {
      return { ok: false, error: outcome.finalText || "Agent: the subagent failed." };
    }
    // The runner already capped finalText and set truncated; forward the outcome
    // verbatim (finalText/truncated/status/counters) as the tool payload.
    return { ok: true, output: { ...outcome } };
  },
  formatResultForModel: (result) => {
    if (!result.ok) {
      return result.error ?? "Agent: the subagent failed.";
    }
    return result.output?.finalText ?? "";
  },
};

/**
 * Projects a coarse SubagentProgress onto the matching subagent_* AgentEvent,
 * stamping the Agent tool call's id (design §3.3). The three variants map 1:1;
 * the status/counter unions already align with the event shapes.
 */
function mapProgressToEvent(progress: SubagentProgress, toolCallId: string): ToolEmittedEvent {
  switch (progress.kind) {
    case "start":
      return {
        type: "subagent_start",
        toolCallId,
        agentType: progress.agentType,
        description: progress.description,
      };
    case "progress":
      return {
        type: "subagent_progress",
        toolCallId,
        turns: progress.turns,
        toolCalls: progress.toolCalls,
        lastTool: progress.lastTool,
      };
    case "tool":
      // Defense-in-depth cap at the trust boundary onto the wire (W1-FIX,
      // FIX-2): the concrete runner already sanitizes/caps toolName+summary,
      // but ANY SubagentPort could push an oversized value here — this bridge
      // is the last chokepoint before WireAgentEvent/host replay, so it
      // re-applies the SAME sanitize+cap helper the runner's summarizer uses
      // (shared function => the two trust boundaries can never disagree).
      return {
        type: "subagent_activity",
        toolCallId,
        toolName: sanitizeAndCap(progress.toolName, SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS),
        summary: sanitizeAndCap(progress.summary, SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS),
      };
    case "end":
      return {
        type: "subagent_end",
        toolCallId,
        status: progress.status,
        turns: progress.turns,
        durationMs: progress.durationMs,
      };
  }
}

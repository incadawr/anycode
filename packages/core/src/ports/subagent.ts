/**
 * SubagentPort (design phase-3 §3.1): the entry point into an in-process child
 * AgentLoop, exposed as a PORT so the Agent tool — which lives in tools/, a
 * layer BELOW loop/ — can spawn subagents WITHOUT importing AgentLoop (that

 * implements this over a child loop derived from the parent config; the tool
 * only ever sees this interface. Absence of the port in a ToolContext is the
 * fail-closed non-recursion lock (the child registry carries no Agent tool AND
 * receives no port).
 */

export interface SubagentRequest {
  /** 3.1 personas: "general-purpose" | "explore"; 3.3 widens with md-profiles. */
  agentType: string;
  /** 3-5 word label for UI/logs. */
  description: string;
  prompt: string;
  /** Requested turn budget, capped at DEFAULT_SUBAGENT_MAX_TURNS by the runner. */
  maxTurns?: number;
  /**
   * Exact model id to run the child loop on (slice 4.6, design §2.5). Resolved
   * by the host's `resolveChildModelPort` ONCE at spawn time and fixed for the
   * child's whole run; a host that offers no resolver returns a honest
   * error-outcome instead of silently falling back to the parent's model.
   */
  model?: string;
}

export interface SubagentOutcome {
  status: "completed" | "max_turns" | "cancelled" | "error";
  /** The child's final assistant text, capped at SUBAGENT_OUTPUT_MAX_BYTES. */
  finalText: string;
  truncated: boolean;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

/** Coarse progress events bridged into the parent stream as subagent_* AgentEvents (design §3.3). */
export type SubagentProgress =
  | { kind: "start"; agentType: string; description: string }
  | { kind: "progress"; turns: number; toolCalls: number; lastTool?: string }
  // Per-child-tool activity (slice P7.18/F16b): one bounded one-liner per child
  // tool call for the renderer's live feed. `summary` is a pre-capped, sanitized
  // subject (never raw child input); bridged as a subagent_activity AgentEvent.
  | { kind: "tool"; toolName: string; summary: string }
  | { kind: "end"; status: SubagentOutcome["status"]; turns: number; durationMs: number };

export interface SubagentRunOptions {
  /** Linked to the Agent tool call's abort so parent-stop cascades into the child. */
  signal?: AbortSignal;
  /** Invoked on each coarse child boundary (tool_result / turn_end) — see §3.3. */
  onProgress?: (progress: SubagentProgress) => void;
}

export interface SubagentPort {
  run(req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome>;
  /**
   * Agent-type names this port can run: built-in personas + md-profiles (slice
   * 3.3, design §2.3). Optional — absent on older/fake ports, in which case the
   * Agent tool falls back to the built-in persona list. Additive: the frozen
   * agentInputSchema is untouched (agent_type is already a plain string).
   */
  listAgentTypes?(): string[];
}

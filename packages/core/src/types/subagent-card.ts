/**
 * Persisted subagent card snapshot (TASK.102 slice S1, CUT-S1 §2.1). Chosen
 * storage shape: a versioned terminal snapshot riding the paired tool_result's
 * `presentation` field — no SQLite migration in S1 (CUT-S1 §0.1).
 *
 * Pure types, no imports from tools/events: `types/tools.ts` imports THIS
 * file for `ToolResult.presentation`, so importing back would create a cycle.
 */

/** Terminal status of a settled subagent — same union as SubagentOutcome["status"]. */
export type SubagentCardFinalStatus = "completed" | "max_turns" | "cancelled" | "error";

export interface SubagentCardActivityEntry {
  /** <= SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS (80 code points), sanitized at the tools/agent.ts bridge. */
  toolName: string;
  /** <= SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS (160 code points), sanitized at the same bridge. */
  summary: string;
}

/**
 * S1 only ever produces `{kind:"inline"}`. The `session` variant is the S2
 * contract (child-session addressing `(parentSessionId, spawnToolCallId)`,
 * S2-memo §4) — reserved here so S1's shape does not need to change under S2.
 */
export type SubagentCardTarget =
  | { kind: "inline" }
  | { kind: "session"; childSessionId: string; parentSessionId: string; spawnToolCallId: string };

export interface SubagentCardSnapshotV1 {
  kind: "subagent";
  version: 1;
  target: SubagentCardTarget;
  identity: {
    agentType: string;
    description: string;
    /** null = the child inherited the parent's model. */
    model: string | null;
    engine: "codex" | "claude" | null;
  };
  counters: { turns: number; toolCalls: number; lastTool: string | null };
  activity: {
    /** <= SUBAGENT_CARD_ACTIVITY_RING, oldest-first. */
    entries: SubagentCardActivityEntry[];
    /** Ring-cap evictions + byte-cap evictions + the source's activitySuppressed. */
    dropped: number;
  };
  /**
   * REQUIRED (CUT-S1 §0.4): a persisted snapshot is only ever written once the
   * Agent tool call has settled, so a durable record without a terminal status
   * would be a contradiction. Nullable `final` lives only in the internal
   * accumulator (SubagentCardAccumulator), never in this persisted shape.
   */
  final: {
    status: SubagentCardFinalStatus;
    durationMs: number;
    /**
     * Provider-reported model id observed on the child's port (raw wire
     * claim, not SDK-derived echo). Absent on legacy snapshots, engine
     * children, session-tier children, inherited-port children, and
     * providers exposing no raw claim. This is the provider's CLAIM,
     * not proof of serving.
     */
    responseModel?: string;
  };
  /** Reserved for S2 (the "waiting for permission" badge). S1 never writes or reads this. */
  attention?: "waiting_permission";
}

/** Envelope on a tool result. Extensible: other presentation kinds (e.g. workflow cards) add sibling keys later. */
export interface ToolResultPresentation {
  subagent?: SubagentCardSnapshotV1;
}

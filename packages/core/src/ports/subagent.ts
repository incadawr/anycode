/**
 * SubagentPort (design phase-3 §3.1): the entry point into an in-process child
 * AgentLoop, exposed as a PORT so the Agent tool — which lives in tools/, a
 * layer BELOW loop/ — can spawn subagents WITHOUT importing AgentLoop (that

 * implements this over a child loop derived from the parent config; the tool
 * only ever sees this interface. Absence of the port in a ToolContext is the
 * fail-closed non-recursion lock (the child registry carries no Agent tool AND
 * receives no port).
 */

import type { TokenUsage } from "../types/events.js";

export interface SubagentRequest {
  /** 3.1 personas: "general-purpose" | "explore"; 3.3 widens with md-profiles. */
  agentType: string;
  /** 3-5 word label for UI/logs. */
  description: string;
  prompt: string;
  /**
   * Requested turn budget; wins over the host default, capped at
   * SUBAGENT_MAX_TURNS_CEILING. Turns are what ends a long child run;
   * SUBAGENT_LOOP_DEADLINE_MS only catches a hung one (TASK.148).
   */
  maxTurns?: number;
  /**
   * Exact model id to run the child loop on (slice 4.6, design §2.5). Resolved
   * by the host's `resolveChildModelPort` ONCE at spawn time and fixed for the
   * child's whole run; a host that offers no resolver returns a honest
   * error-outcome instead of silently falling back to the parent's model.
   */
  model?: string;
}

/**
 * Everything SubagentRunnerOptions.runEngineChild needs to run ONE foreign-CLI
 * child in place of an in-process AgentLoop (md-profile `engine:` frontmatter).
 * The host owns the actual process spawn/parse; this module only describes what
 * a single one-shot run needs to start.
 */
export interface EngineChildSpec {
  engine: "codex" | "claude";
  /** Ready one-shot child prompt: the persona body + the caller's request. */
  prompt: string;
  agentType: string;
  description: string;
  /** Model for the CLI flag; absent — the engine takes its own default. */
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
  /**
   * TASK.191 slice S2: the child's own token spend over the whole run, summed
   * from the per-model-call `finish` events its loop already emits. OPTIONAL
   * on purpose — "not reported" is a distinct answer from zero: the
   * session-tier and engine children never surface a `finish` at all, and
   * three in-process paths (wrap-up rescue, ceiling verdict, compaction) call
   * the model outside the turn stream, so this is an honest LOWER BOUND on a
   * run's spend, never a ledger.
   */
  usage?: TokenUsage;
}

/**
 * Coarse progress events bridged into the parent stream as subagent_*
 * AgentEvents (design §3.3).
 *
 * TASK.171 (owner's ruling, verbatim: "модель никогда не ответит, главное
 * какие запросы мы шлем и что в них фигурирует") fixes the vocabulary for
 * "which model did the child run on" across `start` and `end` alike:
 *   - `model` is the REQUESTED id — the request override, else the persona's
 *     own `model:`, i.e. what we actually put in the request. This is the
 *     single authoritative answer, everywhere the question is asked. It is
 *     NOT read back off the constructed child port (TASK.161 tried that on
 *     `start`; reversed here) — a port's own identity is still our own
 *     construction, not independent evidence of execution. Absent means the
 *     child inherited the parent's port.
 *   - `responseModel` (on `end` only) is a SEPARATE, distinctly-named datum:
 *     the provider's own model CLAIM, read off the child's dedicated port
 *     after its last model call (the wrap-up rescue included). It answers a
 *     different question — what the provider reported, not what we asked
 *     for — and is kept specifically because it is the only instrument for
 *     the open z.ai accounting investigation (TASK.174); it is never merged
 *     into, and never overrides, `model`. Absent for engine/session-tier
 *     children, for a child that inherited the parent's shared port (a
 *     shared port's last claim is not attributable to one child), and for
 *     providers/transports that expose no raw claim at all.
 */
export type SubagentProgress =
  // `engine` is set only for an engine persona (md-profile `engine:`) — a
  // one-shot foreign CLI run (Codex or Claude Code) in place of an in-process
  // child.
  | { kind: "start"; agentType: string; description: string; model?: string; engine?: "codex" | "claude" }
  // `usage` (TASK.191 slice S2) is CUMULATIVE from the start of the run, not a
  // per-turn delta: the receiver REPLACES rather than adds, so a dropped or
  // duplicated progress event cannot corrupt the total. Same discipline as
  // `turns`/`toolCalls` above. Absent while the run has yet to complete a turn,
  // and absent for tiers that report no spend at all.
  | { kind: "progress"; turns: number; toolCalls: number; lastTool?: string; usage?: TokenUsage }
  // Per-child-tool activity (slice P7.18/F16b): one bounded one-liner per child
  // tool call for the renderer's live feed. `summary` is a pre-capped, sanitized
  // subject (never raw child input); bridged as a subagent_activity AgentEvent.
  | { kind: "tool"; toolName: string; summary: string }
  // `activitySuppressed` (slice S1 W2, CUT-S1 §0.5): count of tool-kind
  // progress events this run withheld past SUBAGENT_ACTIVITY_MAX_EVENTS.
  // Absent when the run never crossed the cap; feeds the persisted card's
  // honest dropped-activity count. `model`/`responseModel`: see the type's
  // own doc comment above — both travel on `end` (TASK.171), not only on
  // `start`, so one record is self-describing.
  | {
      kind: "end";
      status: SubagentOutcome["status"];
      turns: number;
      durationMs: number;
      activitySuppressed?: number;
      model?: string;
      responseModel?: string;
    }
  // Permission-broker gate crossing (TASK.102 CUT-S2 §2.2/§0.8): ONLY the
  // session-tier port (SessionSubagentPort) ever produces this — a child
  // SESSION has its own IpcPermissionBroker whose ask/settle can suspend the
  // whole run, which the parent's card should reflect as a "waiting for
  // permission" badge. The in-process inline runner never emits it (an inline
  // child's tool calls flow through the SAME broker as the parent, so there
  // is no separate wait to surface).
  | { kind: "attention"; waiting: boolean }
  /**
   * Stall report (TASK.148 slice 1) — see the matching `subagent_stalled`
   * AgentEvent (types/events.ts) for the full contract: reports only, never
   * kills, fires at most once per unbroken silent stretch, and
   * `waitingForApproval` is always false here since SubagentStallClock never
   * reports while paused. Produced by BOTH tiers: the inline runner drives a
   * clock directly against its own AgentLoop progress; the desktop session
   * tier drives one against the `progress`/`activity`/`attention`
   * ChildRunEvent stream it already receives (host/child-session-port.ts).
   */
  | {
      kind: "stalled";
      agentType: string;
      description: string;
      silentMs: number;
      lastActivity?: string;
      waitingForApproval: boolean;
    };

export interface SubagentRunOptions {
  /** Linked to the Agent tool call's abort so parent-stop cascades into the child. */
  signal?: AbortSignal;
  /** Invoked on each coarse child boundary (tool_result / turn_end) — see §3.3. */
  onProgress?: (progress: SubagentProgress) => void;
}

/**
 * Return shape of `SubagentPort.engineProfile` (TASK.102 CUT-S4 §2.1).
 *
 * `model` (model plumbing fix, TASK.102 follow-up) carries the profile's own
 * `model:` frontmatter (PersonaDefinition.model) through to tools/agent.ts's
 * session-tier request as a DEFAULT, never an override: an explicit
 * `Agent(model: …)` argument still wins, mirroring the precedence the
 * inline/one-shot path already established (subagents/runner.ts —
 * `req.model ?? persona.model`). Absent when the profile declares no model,
 * same as PersonaDefinition.model itself.
 */
export type EngineProfileInfo = { engine: "claude" | "codex"; systemPrompt: string; model?: string };

export interface SubagentPort {
  run(req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome>;
  /**
   * Agent-type names this port can run: built-in personas + md-profiles (slice
   * 3.3, design §2.3). Optional — absent on older/fake ports, in which case the
   * Agent tool falls back to the built-in persona list. Additive: the frozen
   * agentInputSchema is untouched (agent_type is already a plain string).
   */
  listAgentTypes?(): string[];
  /**
   * Resolves an md-profile agent type that declares `engine:` frontmatter.
   * null for built-ins and non-engine profiles. Optional: a fake/legacy port
   * without it simply has no engine profiles to offer (TASK.102 CUT-S4 §2.1 —
   * `tools/agent.ts` routes such a type to a child session BEFORE the tier
   * branch instead of the deprecated one-shot path in `subagents/runner.ts`).
   */
  engineProfile?(agentType: string): EngineProfileInfo | null;
}

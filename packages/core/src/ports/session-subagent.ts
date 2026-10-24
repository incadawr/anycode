/**
 * SessionSubagentPort (TASK.102 CUT-S2 §2.2/§0.1/§0.2): the entry point for
 * `Agent tier:"session"` — a full CHILD SESSION running in its own process,
 * as opposed to `SubagentPort` (ports/subagent.ts), which runs an in-process
 * child AgentLoop. This is a SEPARATE port, not a tier flag on SubagentPort,
 * by deliberate design (cut §0.2 rejects a one-port tier-flag): the
 * non-recursion lock (#2 of 3) works by this port's PHYSICAL ABSENCE from a
 * child session's own DispatchContext (buildChildConfig never copies it,
 * same discipline as `subagents`/`workflows`) — a tier flag on one shared
 * port could not express "this capability does not exist here" as cleanly.
 *
 * The desktop root host is the only concrete implementer (host/
 * child-session-port.ts, S2b): an RPC client over `process.parentPort` to
 * main, which owns the actual utilityProcess spawn. A host with no such
 * wiring (CLI, any child session, any host without the desktop main process)
 * simply never constructs this port, so the Agent tool's session-tier branch
 * fails closed with an "unavailable" error-outcome (tools/agent.ts, S2b).
 */

import type { SubagentOutcome, SubagentRunOptions } from "./subagent.js";
import type { ReasoningEffort } from "../types/config.js";

/**
 * One session-tier spawn request; `provider`/`model` are main-resolved
 * (host/main §2.6.4), never resolved by core itself.
 *
 * `spawnToolCallId` is the ONE field on this request core does NOT merely
 * relay — it is core's own fact (CUT-S2 §10.5): the Agent tool call's own
 * `ctx.toolCallId` (types/tools.ts), minted by the dispatcher before the
 * handler ever runs. `tools/agent.ts`'s session-tier branch stamps it onto
 * every request verbatim; the host must never substitute its own id (a
 * client-minted uuid was tried and reverted, CUT-S2 §10.5 — it broke live-Open
 * correlation, the persistence unique-index's idempotency intent, and the
 * id-shape security rationale in `shared/child-sessions.ts`, all of which
 * assume this field IS the model-visible tool_call id).
 */
export interface SessionSubagentRequest {
  agentType: string;
  description: string;
  prompt: string;
  /**
   * The parent's own Agent tool_call id (`ctx.toolCallId`) — the durable
   * spawn identity carried through the persistence pair (§2.4), the
   * relation-store key (§2.5), and the argv of the child boot (§2.6.2).
   * Model/provider-minted (not client-generated), so every host on this
   * wire validates its shape (`isValidChildId`) before putting it on any
   * further wire, rather than trusting it as already-safe (CUT-S2 §10.5).
   */
  spawnToolCallId: string;
  /** Provider connection id; defaults to the parent session's own connection. Invalid for the inline tier. */
  provider?: string;
  /**
   * EXACT provider connection id from a profile's `connection:` frontmatter (or a
   * bridge catalog entry's `connection`); main resolves it to the live connection
   * and stamps it as the child tab's pin. Never rides a resume request; a request
   * carrying both `provider` and `connectionId` is refused by the host port and
   * (defensively) by main — core never builds one.
   */
  connectionId?: string;
  /** Exact engine model id on that connection; defaults to the parent's model. */
  model?: string;
  /**
   * Reasoning tier from the profile's `effort:` (or `model_reasoning_effort`
   * alias) frontmatter; the child host resolves it against its own model's
   * tiers. Absent = the connection's default. "xhigh" is preserved verbatim
   * for engine children (claude/codex) and mapped to the existing core "max"
   * for core children.
   */
  effort?: ReasoningEffort | "xhigh";
  /**
   * Set ONLY by the engine-profile route (tools/agent.ts, TASK.102 CUT-S4
   * §2.2): the child boots this engine instead of core. Never model-visible —
   * the model picks a profile NAME; the engine is the profile's own
   * frontmatter fact.
   */
  engine?: "claude" | "codex";
  /**
   * R7 (Taskana 4704 cross-review): set ONLY by the role-route stamping in
   * tools/agent.ts when the route's resolved head entry actually stamped this
   * request's routing fields (caller passed none of model/provider). Consumed
   * ENTIRELY by the parent host's respawn bookkeeping (host/index.ts's run()
   * wrapper) to distinguish "route-stamped" from "caller-chosen" — the two
   * are indistinguishable by field comparison alone when the caller's
   * explicit model happens to equal the head entry's model. Never crosses
   * the parentPort wire; absent = the routing fields are the caller's own.
   */
  routeStamped?: boolean;
  /**
   * TASK.145 срез 1: `Agent{tier:"session", detach:true}`'s own field,
   * threaded straight through (tools/agent.ts validates it is only ever set
   * alongside `tier:"session"` before building this request). This flag is
   * consumed ENTIRELY by the parent host's own RPC client
   * (host/child-session-port.ts) — it never crosses the parentPort wire to
   * main (`ChildSpawnRequest` carries no such field): whether a run's promise
   * settles at admit vs. terminal is a fact about THIS client's own waiter,
   * not something main's spawn/accept/terminal protocol needs to know. Absent
   * = the existing sync-join behavior, byte-identical to pre-145.
   */
  detach?: boolean;
  /**
   * Follow-up to an earlier finished CORE child of the same parent session:
   * main resumes that child's own session (row + history) instead of minting
   * a new one, and `prompt` becomes its next user message. Main alone decides
   * whether the id is resumable (owned by this parent, finished, core) and
   * refuses otherwise. Absent = a fresh child, byte-identical to before.
   */
  resumeChildSessionId?: string;
  /**
   * Turn budget for the child (TASK.180): originates from a profile's
   * `maxTurns`/`turnBudget` frontmatter and applies ONLY to the creating
   * spawn — follow-up (resume) requests omit it, and no budget-reset
   * behavior exists. Validated at every boundary as a safe integer within
   * 1..SUBAGENT_MAX_TURNS_CEILING (200). Enforcement is engine-dependent:
   * a core child uses it as AgentLoopConfig.maxTurns, a claude child maps it
   * to the CLI's native --max-turns flag, and a codex child (no native turn
   * cap) merely shows one visible engine_notice warning that the budget is
   * not enforced. Absent = existing default budgets, byte-identical.
   */
  maxTurns?: number;
}

/**
 * The three ids the Agent tool's finalization (tools/agent.ts, B1) copies
 * verbatim into the persisted subagent card's `target` (design §2.1/CUT-S1).
 * Their provenance differs (CUT-S2 §10.5): `childSessionId`/`parentSessionId`
 * are relayed from what the host's accepted-relay + its own sessionId already
 * know — core never invents those two. `spawnToolCallId` is different: core
 * is its OWNER (it is `ctx.toolCallId`, stamped onto the request above), so
 * this field is a round-trip check, not a relay — the host is required to
 * return exactly the string it received on the request, and `tools/agent.ts`
 * asserts that equality rather than treating it as host-supplied truth.
 */
export interface SessionSubagentOutcome extends SubagentOutcome {
  childSessionId: string;
  parentSessionId: string;
  spawnToolCallId: string;
}

/**
 * Taskana 4153 / TASK.216 wire: the result of delivering a follow-up message
 * to the parent's OWN still-running child (`SessionSubagentPort.send`). The
 * `reason` vocabulary is presentation-only — `message` is the load-bearing
 * refusal text minted by main/host (mirroring `ChildRunEvent`'s rejected
 * `message` discipline) — but coarse enough for the Agent handler to shape
 * its error copy without string-matching in core.
 */
export type SessionSubagentSendResult = { ok: true } | { ok: false; reason: "unavailable" | "not_running" | "not_yours" | "busy" | "host_error"; message: string };

export interface SessionSubagentPort {
  run(req: SessionSubagentRequest, opts: SubagentRunOptions): Promise<SessionSubagentOutcome>;
  /**
   * Taskana 4153: deliver a follow-up message to the parent's OWN RUNNING
   * child; never spawns, never resumes. `childSessionId` comes from that
   * run's accepted report; `text` is delivered as the child's next input
   * (mode next_turn). The original sync-join `run()` call keeps waiting and
   * its terminal includes the turns the delivered message causes. OPTIONAL
   * so every host without the desktop main-process wiring (CLI, child
   * sessions) keeps compiling and naturally fails closed at the handler.
   */
  send?(req: { childSessionId: string; text: string }, opts?: { signal?: AbortSignal }): Promise<SessionSubagentSendResult>;
}

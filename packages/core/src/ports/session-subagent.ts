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
  /** Exact engine model id on that connection; defaults to the parent's model. */
  model?: string;
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

export interface SessionSubagentPort {
  run(req: SessionSubagentRequest, opts: SubagentRunOptions): Promise<SessionSubagentOutcome>;
}

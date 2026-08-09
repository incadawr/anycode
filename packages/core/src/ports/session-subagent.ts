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

/** One session-tier spawn request; `provider`/`model` are main-resolved (host/main §2.6.4), never resolved by core itself. */
export interface SessionSubagentRequest {
  agentType: string;
  description: string;
  prompt: string;
  /** Provider connection id; defaults to the parent session's own connection. Invalid for the inline tier. */
  provider?: string;
  /** Exact engine model id on that connection; defaults to the parent's model. */
  model?: string;
}

/**
 * The three ids the Agent tool's finalization (tools/agent.ts, B1) copies
 * verbatim into the persisted subagent card's `target` (design §2.1/CUT-S1)
 * — core never invents any of them, it only relays what the host's
 * accepted-relay + its own sessionId already know.
 */
export interface SessionSubagentOutcome extends SubagentOutcome {
  childSessionId: string;
  parentSessionId: string;
  spawnToolCallId: string;
}

export interface SessionSubagentPort {
  run(req: SessionSubagentRequest, opts: SubagentRunOptions): Promise<SessionSubagentOutcome>;
}

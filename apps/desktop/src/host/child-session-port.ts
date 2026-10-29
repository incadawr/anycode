import { childSessionLimitMessage } from "../shared/session-limits.js";
/**
 * Host-side RPC client for `SessionSubagentPort` (TASK.102 CUT-S2 §2.6.1):
 * the parent root host's half of the `Agent tier:"session"` wire. Turns one
 * `SessionSubagentPort.run()` call into a `ChildSpawnRequest`/`ChildRunCancel`
 * pair sent over `process.parentPort`, correlating main's `ChildRunEvent`
 * replies by `requestId`. `send`/`subscribe` are injected closures over
 * `process.parentPort.postMessage` and the shared inbound-message listener
 * registry — mirrors `createPreviewRpcClient` (host/boot.ts) and the
 * credential broker (host/index.ts:348-377): this module never touches
 * `process.parentPort` directly, so it is fully testable with fakes.
 *
 * Taskana 4153 / TASK.216 wire: the control plane now carries a THIRD op —
 * `ChildRunSend` (`send` below) — which delivers a follow-up to one
 * of the parent's OWN still-running children. It shares the requestId
 * namespace and waiter map with `run()`, but nothing else: it never spawns,
 * never cancels, and settles on the additive `{ kind: "sent" }` ack rather
 * than a run's terminal.
 *
 * Unlike the single-shot preview client, ONE `run()` call receives a WHOLE
 * lifecycle of events — exactly one `accepted` XOR `rejected`, then zero or
 * more `progress`/`activity`/`attention`, then exactly one `terminal`
 * (shared/child-sessions.ts's own doc comment) — so this client keeps a
 * `Map<requestId, waiter>` (cut §2.6.1's own words) and subscribes to the
 * shared channel ONCE at construction, dispatching each inbound
 * `ChildRunEvent` to whichever waiter its `requestId` matches, rather than
 * the preview client's per-call subscribe/unsubscribe. An unknown or
 * already-settled `requestId` (the waiter already removed from the map) is
 * silently ignored — first-wins, the same discipline as
 * `permission-broker.ts`'s `settle()`.
 *
 * No client-side timeout: the sync-join semantics (cut §0.5) rely on the
 * dispatcher's EXISTING Agent-tool timeout (`tools/agent.ts`'s metadata,
 * `dispatch/dispatcher.ts`) to bound a stuck child — this client only reacts
 * to `opts.signal` (parent turn cancel/timeout) by sending exactly one
 * `ChildRunCancel`, and never resolves a run on its own initiative: main
 * alone decides the terminal transition, only after the child's history is
 * durably flushed (cut §0.5/§2.6.3), so an aborted run's promise stays
 * pending until main's own `terminal` event arrives (typically `cancelled`).
 *
 * Two DI seams resolve fields the frozen `SessionSubagentRequest`/
 * `SubagentRunOptions` types have no room for; both are FINAL design, not
 * temporary gaps (CUT-S2 §10.5/§10.6 settle both, superseding this file's
 * earlier "frozen-contract gap" framing — a B2-temporary decision on
 * `spawnToolCallId` was tried and explicitly reverted by §10.5, see below):
 *
 *  - `permissionMode` (required on `ChildSpawnRequest`, cut §0.8: "a snapshot
 *    of the parent's mode at the moment Agent was invoked") has no home on
 *    `SessionSubagentRequest` because core does not own permission mode at
 *    all (§10.6: `ToolContext` carries no `PermissionMode`) — so it is read
 *    fresh, per `run()` call, from the injected `getPermissionMode()` seam
 *    below, which B5's wiring (host/index.ts) supplies from wherever it
 *    tracks the boot session's live mode. §10.6 confirms this DI shim as the
 *    permanent design: mode is a fact of the PARENT HOST, not of core or main.
 *  - `spawnToolCallId` IS on `SessionSubagentRequest` (added by §10.5) — it is
 *    `req.spawnToolCallId`, core's own `ctx.toolCallId`, forwarded onto the
 *    wire verbatim and returned unchanged on every outcome. This client's
 *    B2-era workaround (mint one uuid, reuse it as both `requestId` and
 *    `spawnToolCallId`) is GONE: it silently broke live-Open correlation
 *    (the renderer keys the relation-store by `spawnToolCallId` DURING the
 *    run, not only at its terminal snapshot), voided the persistence unique
 *    index's retry-idempotency intent, and undercut `shared/
 *    child-sessions.ts`'s id-shape hardening rationale, which assumes this
 *    field IS the model-visible tool_call id (§10.5, full analysis there).
 *    `requestId` remains a SEPARATE, purely wire-local correlation id (this
 *    client's own `Map<requestId, waiter>` key, minted per `run()` call for
 *    cancel-addressing and concurrent-run disambiguation) — the two ids must
 *    never be collapsed into one again.
 *
 * TASK.145 срез 1 (`req.detach`): the ONE deliberate exception to the
 * sync-join contract above. A detached run's `run()` promise settles at
 * `accepted` (admit) instead of `terminal` — the tool call that spawned it
 * returns immediately, telling the model the child is now running in the
 * background. The waiter is deliberately NOT removed at that point (unlike
 * every `finish()` call elsewhere in this file): it stays registered so the
 * EVENTUAL `terminal` event still reaches this client, where it is handed to
 * `options.onDetachedTerminal` instead of trying to resolve an
 * already-settled promise. Consequences, all confined to a detached waiter:
 *  - `progress`/`activity`/`attention` events arriving between admit and
 *    terminal are NOT bridged to `opts.onProgress` — the Agent tool call
 *    that owned that callback has already returned by the time they arrive,
 *    so its `ctx.emit` closure may belong to a turn that has already ended;
 *    nothing downstream needs a live card for a call that already settled
 *    (agent.ts's own header comment explains why no presentation is built
 *    for it either).
 *  - `rejected` is UNCHANGED for a detached request: no admission ever
 *    happened, so there is nothing to detach FROM — the tool call fails
 *    exactly like a sync one would.
 *
 * TASK.145 срез 3 (revises срез 1's original abort-listener choice): `opts.
 * signal`'s abort listener is now REMOVED at the moment a detached run
 * admits, not left armed past it. Срез 1 kept it armed on the reasoning that
 * "жизненный цикл наследуются от sync-яруса" — cancelling the parent's turn
 * should cascade into the child it just detached. Срез 3 inverts that: a
 * detach is an EXIT from the turn (design §8), and Stop cancels a TURN, not
 * every process that turn ever spawned into the background — the same
 * distinction bash background tasks and ZCode's own background tier both
 * make (neither dies when the turn that started them is cancelled/stopped).
 * Concretely, `onAbort` is unregistered in the SAME "accepted" branch that
 * resolves the promise (below), so a LATER abort of `opts.signal` (the
 * parent's Stop, or the parent's own turn timeout) no longer sends a
 * `ChildRunCancel` for this child at all — the eventual `terminal` still
 * reaches `onDetachedTerminal` normally, just never triggered by the parent
 * turn's cancellation. Cancelling a detached child is now an entirely
 * separate, EXPLICIT act: `cancelBackgroundChild`/`cancelAllBackgroundChildren`
 * below, addressed by `childSessionId` against the registry this file now
 * keeps of every live detached child — reusing the exact same
 * `ChildRunCancel` wire message `onAbort` used to send, just triggered by a
 * different caller (host/session.ts's explicit background-child cancel
 * command, or explicit session shutdown) instead of a turn's AbortSignal.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_TURNS,
  SUBAGENT_STALL_TIMEOUT_MS,
  SubagentStallClock,
  type PermissionMode,
  type SessionSubagentOutcome,
  type SessionSubagentPort,
  type SessionSubagentRequest,
  type SessionSubagentSendResult,
  type SubagentProgress,
  type SubagentRunOptions,
  type SubagentStallReport,
} from "@anycode/core";
import {
  CHILD_AGENT_TYPE_MAX_CHARS,
  CHILD_DESCRIPTION_MAX_CHARS,
  CHILD_MAX_TURNS_CEILING,
  CHILD_PROMPT_MAX_CHARS,
  CHILD_PROVIDER_MAX_CHARS,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_RUN_SEND_TYPE,
  CHILD_SPAWN_REQUEST_TYPE,
  isValidChildId,
  isChildEffort,
  isValidChildModel,
  type ChildRunCancel,
  type ChildRunEvent,
  type ChildRunSend,
  type ChildSpawnRequest,
} from "../shared/child-sessions.js";

/**
 * §2.7-family text (§10.5 addendum): the pre-flight refusal when
 * `req.spawnToolCallId` fails shape validation, BEFORE any message reaches
 * main. Necessary, not cosmetic: `parseChildSpawnRequest` on the main side is
 * fail-closed and silent (malformed input -> the message is just dropped,
 * never a reply), so without this pre-flight check a malformed id would leave
 * the caller's promise pending until the dispatcher's Agent-tool timeout — an
 * honest, immediate refusal here is the only alternative to that.
 */
const MALFORMED_SPAWN_ID_MESSAGE = "Agent: the child session failed to start (malformed spawn tool-call id).";

/**
 * Review finding F8 (TASK.102 CUT-S2, post-§10.5): `parseChildSpawnRequest`
 * (shared/child-sessions.ts) caps FIVE more fields besides `spawnToolCallId`
 * — `agentType`/`description`/`prompt`/`model`/`provider` — and is just as
 * fail-closed-and-silent about all of them (violation -> `null` -> main drops
 * the message, no reply). The pre-flight above used to check ONLY
 * `spawnToolCallId`, so an oversized value on any of these other five reached
 * main and hung the caller's promise until the dispatcher's Agent-tool
 * timeout. `description`/`prompt` in particular are free MODEL text (`tools/
 * agent.ts`'s `runSessionTier` stamps them straight from `AgentInput`,
 * unbounded) — this is reachable by an ordinary turn, no adversarial input
 * required. One message per field (same "malformed X" shape as the id
 * message above, covering both empty and over-cap — parity with how
 * `isValidChildId`'s own message reads for every shape violation of that
 * field, not just one).
 */
const MALFORMED_AGENT_TYPE_MESSAGE = "Agent: the child session failed to start (malformed agent type).";
const MALFORMED_DESCRIPTION_MESSAGE = "Agent: the child session failed to start (malformed description).";
const MALFORMED_PROMPT_MESSAGE = "Agent: the child session failed to start (malformed prompt).";
const MALFORMED_MODEL_MESSAGE = "Agent: the child session failed to start (malformed model).";
const MALFORMED_PROVIDER_MESSAGE = "Agent: the child session failed to start (malformed provider).";
// Taskana 4269: a profile-declared exact connection id, and the refusal for
// carrying both connection selectors on one spawn (two ways to name the same
// connection — ambiguous, so refused before anything is posted; the caller
// gets this message instead of hanging until the start deadline).
const MALFORMED_CONNECTION_MESSAGE = "Agent: the child session failed to start (malformed connectionId).";
const PROVIDER_CONNECTION_CONFLICT_MESSAGE =
  "Agent: \"provider\" and \"connectionId\" are mutually exclusive on one spawn; the profile selects its own connection — omit \"provider\".";
const MALFORMED_EFFORT_MESSAGE = "Agent: the child session failed to start (malformed reasoning effort).";
const MALFORMED_RESUME_MESSAGE = "Agent: the child session failed to start (malformed child session id to continue).";
const MALFORMED_MAX_TURNS_MESSAGE = "Agent: the child session failed to start (malformed turn budget).";

/**
 * Taskana 4153 / TASK.216 wire: the RPC timeout bounding a `send`
 * call. Unlike `run()` (no client-side timeout by design — the file header's
 * sync-join contract), a send is a bounded request/reply pair: exactly one
 * `sent` XOR `rejected` ack must come back for it, and a main that neither
 * admits nor refuses it leaves the model's Agent call hanging on the
 * dispatcher's far longer tool timeout. 30s matches
 * `communicationRequest`'s own 20s host RPC plus dispatch headroom.
 */
const CHILD_SEND_RPC_TIMEOUT_MS = 30_000;
export { CHILD_SEND_RPC_TIMEOUT_MS };
/** Taskana 4153: pre-flight refusal text for a malformed send (id or text) — same rationale as MALFORMED_SPAWN_ID_MESSAGE. */
const MALFORMED_SEND_MESSAGE = "Agent: malformed child session id or text.";
/** Taskana 4153: the send completed before it started (opts.signal already aborted) — same shape as run()'s F9 early return. */
const SEND_ABORTED_MESSAGE = "Agent: aborted before send.";
/** Taskana 4153: main never answered the send — delivery genuinely unknown, never silently "ok". */
const SEND_TIMEOUT_MESSAGE = "Agent: main did not answer the send; delivery unknown.";

/**
 * Taskana 4153: maps a `rejected` ack's `spawn_failed` reason + message onto
 * the coarse `SessionSubagentSendResult` reason union the core handler
 * presents. Main mints one text per refusal family (not yours / not running
 * / engine child / unreachable host); keyword matching is deliberately
 * simple — the reason is presentation-only, the MESSAGE is the load-bearing
 * refusal text either way.
 */
function mapSendRejectReason(message: string): "unavailable" | "not_running" | "not_yours" | "busy" | "host_error" {
  if (message.includes("still starting")) return "busy";
  if (message.includes("not running")) return "not_running";
  if (message.includes("cannot be addressed")) return "not_yours";
  if (message.includes("not addressable")) return "not_yours";
  if (message.includes("could not be reached")) return "host_error";
  if (message.includes("delivery state")) return "busy";
  return "host_error";
}

/**
 * Non-empty, capped free text — the exact shape `parseChildSpawnRequest`'s
 * own `isNonEmptyCappedString` (shared/child-sessions.ts, private there)
 * enforces on `agentType`/`description`/`prompt`/`provider` (`model` is
 * id-shaped, checked separately by `isValidChildModel`, S4 blocker fix).
 * Reuses
 * that module's exported char-cap CONSTANTS (never re-derives the numbers)
 * so the two sides of this wire can never silently drift apart on where the
 * line is drawn — only this trivial shape predicate is duplicated, not the
 * limits themselves.
 */
function isValidFreeText(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength;
}

/**
 * Full pre-flight shape check (F8): mirrors EVERY field
 * `parseChildSpawnRequest` validates, in the same order it checks them, so a
 * request this function accepts is one main's parser is guaranteed to also
 * accept (barring the admission-time checks, e.g. quota, that only main can
 * evaluate). Returns the model-visible refusal text for the first violation
 * found, or `null` when the request is well-formed.
 */
function findSpawnRequestShapeError(req: SessionSubagentRequest): string | null {
  if (!isValidChildId(req.spawnToolCallId)) {
    return MALFORMED_SPAWN_ID_MESSAGE;
  }
  if (!isValidFreeText(req.agentType, CHILD_AGENT_TYPE_MAX_CHARS)) {
    return MALFORMED_AGENT_TYPE_MESSAGE;
  }
  if (!isValidFreeText(req.description, CHILD_DESCRIPTION_MAX_CHARS)) {
    return MALFORMED_DESCRIPTION_MESSAGE;
  }
  if (!isValidFreeText(req.prompt, CHILD_PROMPT_MAX_CHARS)) {
    return MALFORMED_PROMPT_MESSAGE;
  }
  if (req.model !== undefined && !isValidChildModel(req.model)) {
    return MALFORMED_MODEL_MESSAGE;
  }
  if (req.provider !== undefined && !isValidFreeText(req.provider, CHILD_PROVIDER_MAX_CHARS)) {
    return MALFORMED_PROVIDER_MESSAGE;
  }
  // Taskana 4269: same shape cap as `provider`; both at once is refused with its
  // own message (nothing is posted — see the caller).
  if (req.connectionId !== undefined && !isValidFreeText(req.connectionId, CHILD_PROVIDER_MAX_CHARS)) {
    return MALFORMED_CONNECTION_MESSAGE;
  }
  if (req.provider !== undefined && req.connectionId !== undefined) {
    return PROVIDER_CONNECTION_CONFLICT_MESSAGE;
  }
  if (req.effort !== undefined && !isChildEffort(req.effort)) {
    return MALFORMED_EFFORT_MESSAGE;
  }
  if (req.resumeChildSessionId !== undefined && (!isValidChildId(req.resumeChildSessionId) || req.engine !== undefined)) {
    return MALFORMED_RESUME_MESSAGE;
  }
  // TASK.180: mirrors parseChildSpawnRequest's budget check — a defined
  // maxTurns must be a safe integer within 1..CHILD_MAX_TURNS_CEILING.
  if (
    req.maxTurns !== undefined &&
    !(typeof req.maxTurns === "number" && Number.isSafeInteger(req.maxTurns) && req.maxTurns >= 1 && req.maxTurns <= CHILD_MAX_TURNS_CEILING)
  ) {
    return MALFORMED_MAX_TURNS_MESSAGE;
  }
  return null;
}

/**
 * TASK.145 срез 1: the admit-time `finalText` for a detached run — the ONLY
 * text the model ever sees for this call, since a detached call never waits
 * for the child's own finalText. `status:"completed"` on the outcome this
 * feeds (see the "accepted" case below) is honest under the SAME reading
 * agent.ts's header comment gives it: the delegation call's own job —
 * spawn and hand off — did complete; the CHILD's work has not, and this
 * sentence says so explicitly rather than leaving that to the status enum.
 */
function detachAdmitMessage(childSessionId: string): string {
  return (
    `Agent: child session ${childSessionId} started in the background. ` +
    "It is running independently of this turn; its report will arrive as a new message once it finishes. " +
    "To send a follow-up to this same child later, pass this id as continue_session in the next agent call."
  );
}

/**
 * GitHub #17 slice D: how long a native Agent call that ASKED
 * to join (explicit `detach:false`, or an omitted detach that reached a
 * handoff-eligible request) waits for its child before handing it over to
 * background mode. Measured from the child's own `accepted` event — a request
 * merely queued for admission is not running and spends none of this budget.
 * Not a user setting and not model input: Workflow dependency joins never
 * carry the eligibility flag at all.
 */
export const CHILD_SYNC_JOIN_BUDGET_MS = 120_000;

/** The handoff result's `finalText` — the child keeps running; only the WAIT ended. */
function joinBudgetHandoffMessage(childSessionId: string): string {
  return (
    "Agent: the child is still running after 120 seconds; its report will arrive as a message. " +
    `Child session ${childSessionId} continues in the background — do not poll it, and end this turn. ` +
    "To send a follow-up to this same child later, pass this id as continue_session in the next agent call."
  );
}

/**
 * TASK.145 срез 3: one live detached (background) child, as tracked by this
 * port's own in-memory registry — surfaced host-side so `session.ts` can
 * answer "how many children are running in the background" and let the
 * renderer (a later slice's job, not this one) cancel one by id. Deliberately
 * NOT a wire type: `apps/desktop/src/shared/protocol.ts` defines its own
 * structurally-identical `WireBackgroundChild` for the host<->renderer
 * direction (the repo's existing "Wire"-prefixed-projection precedent,
 * e.g. `WireCheckpointMeta`), so this module never has to import protocol.ts
 * or reason about renderer-wire concerns.
 */
export interface BackgroundChildSnapshot {
  childSessionId: string;
  agentType: string;
  description: string;
  /**
   * GitHub #17 slice E: light optional progress, mirrored
   * identically onto the wire (`WireBackgroundChild`). Unknown counters stay
   * ABSENT — never fabricated as zero. `startedAt` remains the admission time.
   */
  turns?: number;
  toolCalls?: number;
  lastTool?: string;
  waitingForApproval?: boolean;
  /** Epoch ms, captured when this child's spawn was admitted (the "accepted" ChildRunEvent). */
  startedAt: number;
}

export interface CreateChildSessionPortOptions {
  /**
   * This host's own (root) session id — copied verbatim into every
   * outcome's `parentSessionId` (cut §2.2: "host knows [it] ... from ...
   * its own sessionId"). Fixed for the whole life of a root host process.
   */
  parentSessionId: string;
  /**
   * Reads the parent session's CURRENT permission mode. Called once per
   * `run()`, right before the spawn request is sent, so each call captures
   * an honest snapshot rather than a value cached at construction (cut
   * §0.8's "at the moment Agent was invoked" — the child never tracks the
   * parent's LIVE mode after that). See the file header for why this lives
   * here rather than on `SessionSubagentRequest`.
   */
  getPermissionMode: () => PermissionMode;
  /** Sends a ChildSpawnRequest/ChildRunCancel/ChildRunSend to main (host/index.ts: process.parentPort.postMessage). */
  send: (message: ChildSpawnRequest | ChildRunCancel | ChildRunSend) => void;
  /**
   * Registers the ONE listener for ChildRunEvent messages arriving on the
   * control-plane channel (host/index.ts: filtered off process.parentPort's
   * "message" event, matched by requestId) — called exactly once, at
   * construction, mirroring the credential/preview broker's listener-set
   * precedent (index.ts:348-377) rather than per-call subscribe/unsubscribe.
   * Returns an unsubscribe function (unused for the port's own lifetime —
   * it lives as long as the host process — but kept symmetrical with the
   * other host RPC clients' `subscribe` shape for a test double to reuse).
   */
  subscribe: (listener: (event: ChildRunEvent) => void) => () => void;
  /** Injectable request-id generator (tests only); defaults to randomUUID. */
  createRequestId?: () => string;
  /**
   * TASK.145 срез 1: invoked when a DETACHED run's `terminal` ChildRunEvent
   * arrives — strictly AFTER this same run's `run()` promise already
   * resolved at `accepted` (see the file header's TASK.145 addendum), so the
   * terminal can no longer settle it. `req` is the ORIGINAL request (the
   * outcome alone carries no `agentType`/`description`), letting the caller
   * build a delivery notification without this port knowing anything about
   * notification formatting itself — that stays the caller's job
   * (host/index.ts wires it to `formatChildTaskNotification`). Never invoked
   * for a non-detached run, whose terminal still settles `run()` directly.
   */
  onDetachedTerminal?: (outcome: SessionSubagentOutcome, req: SessionSubagentRequest) => void;
  /**
   * TASK.148 slice 2: invoked when a DETACHED run's stall clock fires — the
   * ONE case slice 1 deliberately left uncovered (the parent is not blocked
   * waiting on this child, so it can actually read and act on a notice,
   * unlike the sync tier where a stall report only ever reaches the caller's
   * own `opts.onProgress`, which nothing reads until the call itself
   * settles). `req` is the ORIGINAL request, same rationale as
   * `onDetachedTerminal` above: the report alone carries no
   * `agentType`/`description`/`spawnToolCallId`. `childSessionId` is the
   * child's id once known ("" in the practically unreachable case a stall
   * fires before "accepted" ever arrived — see ChildStallNoticeInput's own
   * doc). Formatting stays entirely the caller's job (host/index.ts wires
   * this to `formatChildStallNotice` + `ChildReportQueue.upsert`); this port
   * never touches notification text. Absent => a detached run's stall clock
   * still runs (see below) but its notice is a harmless no-op, same posture
   * as `onDetachedTerminal` being optional.
   */
  onDetachedStall?: (report: SubagentStallReport, req: SessionSubagentRequest, childSessionId: string) => void;
  /**
   * Taskana 4821: a detached child raised an approval ask (attention event with
   * the ask's identity). Nobody watches a detached child's tab, so the host
   * surfaces it to the parent instead of letting the ask silently expire.
   */
  onDetachedApproval?: (ask: { toolName: string; subject: string }, req: SessionSubagentRequest, childSessionId: string) => void;
  /**
   * Review F1 (Taskana 4821): a detached child's approval ask — one this port
   * reported through `onDetachedApproval` — has SETTLED (attention
   * waiting=false after waiting=true: answered in the child's tab, expired,
   * or force-denied by turn cancel/disconnect/shutdown). The host uses this
   * to retract the now-stale pending notice (childReportQueue.ack of
   * `approval:<spawnToolCallId>`) so the parent is not told to go answer a
   * request that no longer exists. Best-effort by design: `ack` of an
   * already-removed id is a no-op, and a settle racing the renderer's ack
   * loses harmlessly (the notice was already durably enqueued, at most one
   * redundant prompt turn). Absent => notices are never retracted.
   */
  onDetachedApprovalSettled?: (req: SessionSubagentRequest, childSessionId: string) => void;
  /**
   * Taskana 4820: invoked when a DETACHED run's progress crosses the
   * approaching-turn-budget margin (10% of `req.maxTurns`, min 1 turn) — the
   * ONE advance warning the parent gets before the child is stopped at its
   * cap. Fires at most ONCE per run (latched per waiter). `info` carries the
   * progress event's `turns` and the request's own `maxTurns`; `req` is the
   * ORIGINAL request and `childSessionId` the child's id once known, same
   * shape as `onDetachedStall` above. Never invoked for a budget-less spawn
   * (no cap to warn about) or a sync-join run (the parent is blocked inside
   * the Agent call and cannot act on a warning mid-call anyway). Absent =>
   * the latch still works but the notice is a harmless no-op.
   */
  onDetachedTurnBudget?: (
    info: { turns: number; maxTurns: number },
    req: SessionSubagentRequest,
    childSessionId: string,
  ) => void;
  /**
   * Silence threshold for this port's stall clock (TASK.148 slice 1/2).
   * SUBAGENT_STALL_TIMEOUT_MS when omitted — same resolution precedence as
   * the inline tier's `parent.subagentStallTimeoutMs ?? SUBAGENT_STALL_TIMEOUT_MS`
   * (subagents/runner.ts). Shared by BOTH the sync and detached paths (slice
   * 2 wires the detached one too — see `run()`'s own comment).
   */
  stallTimeoutMs?: number;
  /**
   * GitHub #17 slice D: test seam for the synchronous join
   * budget. Production never sets it — `CHILD_SYNC_JOIN_BUDGET_MS` applies.
   */
  syncJoinBudgetMs?: number;
  /**
   * Taskana 4704 §2.8/§3.6: cap on THIS parent's simultaneously-live detached
   * children, enforced at the detach ADMIT as an honest refusal (no queueing
   * — queueing risks unbounded hidden state, §9-Q5). Read at admit time (a
   * live cell, not a snapshot) so settings changes land on the next spawn.
   * Absent/undefined => unlimited (the behavior before per-profile caps). The
   * host passes the SHARED effective cap
   * (`host/child-session-limits.ts` → session setting, optionally lowered by
   * an explicit role profile; GitHub #17 slice B), so this
   * local guard no longer disagrees with main's per-parent limit.
   */
  maxDetachedChildren?: () => number | undefined;
}

/**
 * TASK.145 срез 3: the port's own return type widens `SessionSubagentPort`
 * (`run` alone) with the background-children surface — never part of the
 * frozen `SessionSubagentPort` core interface itself (core has no concept of
 * "background", only the host does; see `ports/session-subagent.ts`'s own
 * header on why `detach` lives on the REQUEST, not the port). host/index.ts
 * holds this richer type directly (never narrowed to `SessionSubagentPort`)
 * so `session.ts`'s `backgroundChildren` seam can read it.
 */
export interface ChildSessionPort extends SessionSubagentPort {
  /** Every currently-live detached child this port has admitted and not yet seen a terminal for. */
  listBackgroundChildren(): BackgroundChildSnapshot[];
  /**
   * Taskana 4153 / TASK.216 wire: delivers a follow-up `text` to the
   * parent's OWN STILL-RUNNING child (`childSessionId`, from that run's
   * "accepted" event), over the additive `ChildRunSend` parentPort op —
   * completely independent of any `run()` waiter: the original sync-join
   * Agent call keeps waiting, and its terminal now includes the turns the
   * delivered message causes. Never spawns, never resumes; a finished child
   * stays `continue_session`'s to address. Fail-closed on a malformed id or
   * an oversized text BEFORE anything is sent (main's parser would silently
   * drop it otherwise — same rationale as `findSpawnRequestShapeError`).
   *
   * Cross-review Finding 1 (Taskana 4153): this is now the INTERFACE method
   * name — `SessionSubagentPort.send`, what core's Agent handler calls. It
   * was originally exposed as `sendToChild`, which silently satisfied the
   * then-optional `send?` interface member and left every production
   * send_to call failing "unavailable in this host"; the interface member is
   * REQUIRED now, so this override is also the compile-time proof this port
   * implements the seam core actually calls (the seam test in this file's
   * test suite is the runtime proof).
   */
  send(req: { childSessionId: string; text: string }, opts?: { signal?: AbortSignal }): Promise<SessionSubagentSendResult>;
  /**
   * Sends a `ChildRunCancel` for the ONE detached child matching this
   * `childSessionId`, addressed via the registry's own `requestId` (the
   * model-visible `childSessionId` never rides that wire message itself —
   * see `shared/child-sessions.ts`). Returns `false` for an unknown id (never
   * registered, or already reached its terminal) — the same "not running or
   * does not exist" outcome `tasks.kill` reports for a background bash task.
   * Idempotent: a second cancel on an id already mid-cancel still returns
   * `true` but sends no second `ChildRunCancel`.
   */
  cancelBackgroundChild(childSessionId: string): boolean;
  /** Cancels every currently-live detached child (TASK.145 срез 3 §3: an explicit sweep, not a side effect of aborting a turn). */
  cancelAllBackgroundChildren(): void;
  /** Subscribes to registry changes (a child admitted or reaching its terminal). Returns an unsubscribe fn, mirroring `lsp.onStatusChange`. */
  onBackgroundChildrenChanged(listener: () => void): () => void;
}

/** One in-flight `run()` call's event handler, keyed by `requestId` in the port-wide waiter map. */
interface Waiter {
  onEvent(event: ChildRunEvent): void;
}

/** TASK.145 срез 3: one registry row — the detach waiter's `requestId` (for cancel-addressing) plus the public snapshot and its own cancel-idempotency flag. */
interface BackgroundChildEntry {
  requestId: string;
  snapshot: BackgroundChildSnapshot;
  cancelRequested: boolean;
  /** Who asked for the cancel (first request wins): the UI stop ("user") or the shutdown sweep ("shutdown"). Read at terminal to attribute the outcome. */
  cancelCause?: "user" | "shutdown";
}

/**
 * Builds the host-side `SessionSubagentPort` (cut §2.6.1): an RPC client that
 * asks main to spawn (and, on abort, cancel) a child session over the
 * `process.parentPort` control plane, bridging main's coarse `ChildRunEvent`
 * stream into `SubagentProgress` callbacks and a final `SessionSubagentOutcome`
 * — the exact shape `tools/agent.ts`'s session-tier branch (S2b B1) awaits.
 */
export function createChildSessionPort(options: CreateChildSessionPortOptions): ChildSessionPort {
  const createRequestId = options.createRequestId ?? randomUUID;
  const stallTimeoutMs = options.stallTimeoutMs ?? SUBAGENT_STALL_TIMEOUT_MS;
  const waiters = new Map<string, Waiter>();
  // TASK.145 срез 3: registry of live detached children, keyed by
  // childSessionId (the id `cancelBackgroundChild`/the renderer's future list
  // both address by) — populated at admit, removed at terminal, see the two
  // `req.detach === true` branches below.
  const backgroundChildren = new Map<string, BackgroundChildEntry>();
  const backgroundChildrenListeners = new Set<() => void>();
  // Taskana 4704 cross-review F6: detach admits that passed the cap check but
  // whose "accepted" event has not arrived yet. The registry above is keyed by
  // childSessionId, which is only known at accept — N parallel detached run()
  // calls in one assistant turn all passed the old `backgroundChildren.size`
  // check before ANY of them registered. Each pending admit reserves a slot
  // here for exactly the window between the spawn request and its accept/
  // reject/terminal, so the cap counts ADMITTED children, not just
  // already-accepted ones.
  const pendingDetachedAdmits = new Set<string>();
  function liveDetachedCount(): number {
    return backgroundChildren.size + pendingDetachedAdmits.size;
  }
  function notifyBackgroundChildrenChanged(): void {
    for (const listener of backgroundChildrenListeners) {
      try {
        listener();
      } catch {
        // GitHub #17 slice A: a view subscriber throwing must
        // never block admission settlement or terminal cleanup — the registry
        // transition has already happened by the time this fan-out runs.
      }
    }
  }

  /**
   * GitHub #17 slice E: replace one live background child's
   * lightweight progress, copying only facts the child actually reported and
   * notifying observers ONLY on a real change. A child that reports nothing
   * keeps its counters absent — never a fabricated zero.
   */
  function updateBackgroundSnapshot(childSessionId: string, patch: Partial<BackgroundChildSnapshot>): void {
    const entry = backgroundChildren.get(childSessionId);
    if (entry === undefined) return;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<BackgroundChildSnapshot>;
    const next: BackgroundChildSnapshot = { ...entry.snapshot, ...defined };
    const changed = (Object.keys(defined) as Array<keyof BackgroundChildSnapshot>).some(
      (key) => next[key] !== entry.snapshot[key],
    );
    if (!changed) return;
    backgroundChildren.set(childSessionId, { ...entry, snapshot: next });
    notifyBackgroundChildrenChanged();
  }

  options.subscribe((event) => {
    waiters.get(event.requestId)?.onEvent(event);
  });

  function run(req: SessionSubagentRequest, opts: SubagentRunOptions): Promise<SessionSubagentOutcome> {
    // Pre-flight, before minting a requestId or sending anything (§10.5,
    // widened by F8 to every capped field, not just spawnToolCallId): a
    // malformed request must fail IMMEDIATELY and HONESTLY here, rather than
    // being sent and silently dropped by main's fail-closed
    // `parseChildSpawnRequest` — that path would leave this call's promise
    // pending until the dispatcher's Agent-tool timeout with no explanation.
    const shapeError = findSpawnRequestShapeError(req);
    if (shapeError !== null) {
      return Promise.resolve({
        status: "error",
        finalText: shapeError,
        truncated: false,
        turns: 0,
        toolCalls: 0,
        durationMs: 0,
        childSessionId: "",
        parentSessionId: options.parentSessionId,
        spawnToolCallId: req.spawnToolCallId,
      });
    }

    // Taskana 4704 §2.8/§3.6: the parallel-children cap. A detach ADMIT that
    // would exceed this parent's live-detached count is refused HONESTLY,
    // here in the port (never queued — queueing risks unbounded hidden
    // state, §9-Q5). Only detach requests consume slots; sync-join spawns
    // are untouched. Read as a live cell (the getter) so a settings change
    // lands on the very next spawn. `undefined` => unlimited (pre-4704).
    // F6: counts ADMITTED children — the accepted registry PLUS every admit
    // still between the spawn request and its accepted/terminal event (N
    // parallel detached calls in one turn all passed a registry-only check
    // before any of them registered).
    let reservedAdmitSlot = false;
    if (req.detach === true) {
      const cap = options.maxDetachedChildren?.();
      if (cap !== undefined && liveDetachedCount() >= cap) {
        return Promise.resolve({
          status: "error",
          finalText: childSessionLimitMessage(liveDetachedCount()),
          truncated: false,
          turns: 0,
          toolCalls: 0,
          durationMs: 0,
          childSessionId: "",
          parentSessionId: options.parentSessionId,
          spawnToolCallId: req.spawnToolCallId,
        });
      }
      reservedAdmitSlot = true;
    }

    // F9 (review finding, found independently by all three reviewers): a
    // signal that is ALREADY aborted at this point must never reach
    // `options.send(spawnRequest)` below. The old code let `onAbort()` fire
    // synchronously (sending ChildRunCancel) and THEN still sent the spawn
    // request — main has no ledger entry yet for this requestId when the
    // cancel arrives, so it silently ignores it, then admits the spawn
    // normally moments later. An AbortSignal only ever fires "abort" once
    // (the not-aborted -> aborted transition), so no second cancel can ever
    // follow: the child would be spawned uncancellable, holding its quota
    // slot forever (violates the track invariant that a quota slot must
    // always be releasable). No child was ever asked for, so failing fast
    // here — before minting a requestId or touching `waiters` — needs no
    // main-side cooperation.
    if (opts.signal?.aborted) {
      return Promise.resolve({
        status: "cancelled",
        finalText: "",
        truncated: false,
        turns: 0,
        toolCalls: 0,
        durationMs: 0,
        childSessionId: "",
        parentSessionId: options.parentSessionId,
        spawnToolCallId: req.spawnToolCallId,
      });
    }

    const requestId = createRequestId();

    // TASK.145 срез 1: the child's own id, known only once "accepted"
    // arrives (the detach branch below sets it). Read by a DETACHED run's
    // onStall closure (TASK.148 slice 2) — declared here, ahead of both the
    // clock and the promise executor, so the same mutable binding is visible
    // to whichever of the two assigns/reads it first.
    let detachedChildSessionId: string | undefined;
    // Review F1a: true between a detached run's attention(waiting=true) with
    // an ask identity and its settling attention(waiting=false) — gates
    // onDetachedApprovalSettled so only an ask this port actually RAISED is
    // ever reported as settled.
    let detachedAskPending = false;

    // Taskana 4820: latched once this run's approaching-turn-budget notice
    // has fired — the warning is once per run, never per progress event.
    let turnBudgetNotified = false;

    // Taskana 4820 review F1: the child's EFFECTIVE turn cap this latch warns
    // against — the request's own budget, else the child host's resolved cap
    // carried on the `accepted` event, else core's DEFAULT_MAX_TURNS (the
    // SAME constant the child's own resolveChildMaxTurns/agent-loop fall
    // back to, imported — never a duplicated literal). Updated at accept
    // below; read by the progress branch's latch check.
    let effectiveMaxTurns: number = req.maxTurns ?? DEFAULT_MAX_TURNS;

    // GitHub #17 slice D: this run's settlement MODE. Every
    // event branch below routes on this state, never on the immutable request
    // flag — a joining run can become a background one at its join budget,
    // and everything a detached run does (registry, callbacks, Stop) must
    // start applying at that instant.
    // An explicitly detached request starts in background mode, so the events
    // that can precede its acknowledgement (the pre-accept approval
    // ask and its settle) keep their established detached routing.
    let mode: "joining" | "background" = req.detach === true ? "background" : "joining";
    // Whether this run's promise was already settled by a background handoff —
    // the idempotency latch for enterBackground (mode alone cannot express it:
    // an explicit detach is in background mode before it is ever handed off).
    let handedOff = false;
    let acceptedEvent: Extract<ChildRunEvent, { kind: "accepted" }> | undefined;
    let acceptedAt: number | undefined;
    let latestProgress: Partial<BackgroundChildSnapshot> = {};
    const retainProgress = (patch: Partial<BackgroundChildSnapshot>): void => {
      latestProgress = { ...latestProgress, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    };
    let terminalSeen = false;
    let joinTimer: ReturnType<typeof setTimeout> | undefined;
    // A permission ask that arrived while this run was still JOINING: a
    // handoff must seed the background waiting state and raise the parent's
    // notice once, so its later settlement retracts that same notice.
    let joiningAsk: { toolName: string; subject: string } | undefined;
    // Coarse progress can report the last completed tool after an approval ask.
    // Keep the pending tool authoritative until that ask settles.
    let approvalTool: string | undefined;
    const syncJoinBudgetMs = options.syncJoinBudgetMs ?? CHILD_SYNC_JOIN_BUDGET_MS;
    // The request the background callbacks receive: an explicitly detached run
    // keeps its own object identity; an automatically handed-off one gets a
    // derived copy (never a mutation of the caller's request).
    const backgroundRequest = (): SessionSubagentRequest => (req.detach === true ? req : { ...req, detach: true });
    function clearJoinTimer(): void {
      if (joinTimer !== undefined) {
        clearTimeout(joinTimer);
        joinTimer = undefined;
      }
    }

    // TASK.148 slice 1/2: constructed for BOTH tiers now. A non-detached
    // run's notice still bridges to opts.onProgress (unchanged from slice
    // 1). A DETACHED run's notice can no longer reach opts.onProgress (that
    // call's own closure already returned at admit, same reason
    // progress/activity/attention never bridge to it past admit below) — it
    // is routed to options.onDetachedStall instead, mirroring exactly how a
    // detached run's TERMINAL event routes to options.onDetachedTerminal
    // rather than resolving an already-settled promise.
    const stallClock = new SubagentStallClock({
      agentType: req.agentType,
      description: req.description,
      timeoutMs: stallTimeoutMs,
      onStall: (report) => {
        if (mode === "background") {
          options.onDetachedStall?.(report, backgroundRequest(), detachedChildSessionId ?? "");
          return;
        }
        opts.onProgress?.({
          kind: "stalled",
          agentType: report.agentType,
          description: report.description,
          silentMs: report.silentMs,
          ...(report.lastActivity !== undefined ? { lastActivity: report.lastActivity } : {}),
          waitingForApproval: report.waitingForApproval,
        });
      },
    });

    return new Promise<SessionSubagentOutcome>((resolve) => {
      let cancelSent = false;
      // GitHub #17 slice A: whether this detached waiter has
      // already settled its run() promise at accept. Terminal events therefore
      // distinguish \"never acknowledged\" (resolve the original tool promise,
      // no background report) from \"already handed off\" (route through the
      // background terminal callback). Duplicate accepted events are a no-op.
      let admitResultDelivered = false;

      // F6: reserve the cap slot for the whole admit->accept window (a
      // sync-join run reserved nothing — `reservedAdmitSlot` stays false and
      // every release below is a no-op for it). Released at the same
      // boundaries that end the window: reject (never admitted), the
      // detach accept (handed over to the accepted registry), and —
      // defensively — any terminal that closes this waiter.
      if (reservedAdmitSlot) {
        pendingDetachedAdmits.add(requestId);
      }

      const finish = (outcome: SessionSubagentOutcome): void => {
        clearJoinTimer();
        stallClock.dispose();
        waiters.delete(requestId);
        pendingDetachedAdmits.delete(requestId);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      const onAbort = (): void => {
        if (cancelSent) {
          return;
        }
        cancelSent = true;
        // Slice D: an abort BEFORE any handoff disarms the join budget — one
        // cancel, no background transition, unchanged cascade semantics.
        clearJoinTimer();
        options.send({ type: CHILD_RUN_CANCEL_TYPE, requestId });
        // Sync-join semantics (cut §0.5): abort never resolves this promise by
        // itself. Only main's eventual `terminal` (normally "cancelled", once
        // the child host has actually wound down and flushed its history)
        // does — the waiter stays registered above so that late event still
        // reaches `finish` normally instead of being silently dropped.
      };

      /**
       * GitHub #17 slice D: hand this run over to background
       * mode exactly once. Idempotent, and never fires for a run that has
       * already ended, been cancelled, or lost its signal — a handoff keeps
       * the SAME child (no restart, no cancel) and only stops waiting on it.
       */
      const enterBackground = (reason: "requested" | "join_budget"): void => {
        if (handedOff || terminalSeen || cancelSent || opts.signal?.aborted) return;
        if (acceptedEvent === undefined) return;
        handedOff = true;
        mode = "background";
        clearJoinTimer();
        // A detach is an exit from the turn: from here on, cancelling the
        // parent's turn must NOT cascade into this child.
        opts.signal?.removeEventListener("abort", onAbort);
        // F6: the admit window is over — the accepted registry below now owns
        // this child's slot, so the pending reservation goes the same instant.
        pendingDetachedAdmits.delete(requestId);
        detachedChildSessionId = acceptedEvent.childSessionId;
        if (req.maxTurns === undefined && acceptedEvent.maxTurns !== undefined) {
          effectiveMaxTurns = acceptedEvent.maxTurns;
        }
        backgroundChildren.set(acceptedEvent.childSessionId, {
          requestId,
          snapshot: {
            childSessionId: acceptedEvent.childSessionId,
            agentType: req.agentType,
            description: req.description,
            // Elapsed time continues from the ACTUAL admission, not the
            // handoff — a 2-minute wait is not reset to zero by the handoff.
            startedAt: acceptedAt ?? Date.now(),
            ...latestProgress,
          },
          cancelRequested: false,
        });
        admitResultDelivered = true;
        resolve({
          status: "completed",
          finalText:
            reason === "join_budget"
              ? joinBudgetHandoffMessage(acceptedEvent.childSessionId)
              : detachAdmitMessage(acceptedEvent.childSessionId),
          truncated: false,
          turns: 0,
          toolCalls: 0,
          durationMs: 0,
          childSessionId: acceptedEvent.childSessionId,
          parentSessionId: options.parentSessionId,
          spawnToolCallId: req.spawnToolCallId,
          // An admission/handoff fact, never a child terminal: consumers (the
          // host's budget bookkeeping, core's card finalization) use this to
          // avoid treating dispatch success as completed child work.
          background: { reason },
        });
        notifyBackgroundChildrenChanged();
        // An ask that was already pending when the wait ended is still
        // pending: seed the background waiting state and raise the notice
        // ONCE, so its later settlement retracts exactly this notice. The
        // permission deadline and the stall clock are NOT restarted.
        if (joiningAsk !== undefined) {
          detachedAskPending = true;
          options.onDetachedApproval?.(joiningAsk, backgroundRequest(), acceptedEvent.childSessionId);
        }
      };

      waiters.set(requestId, {
        onEvent: (event) => {
          switch (event.kind) {
            case "accepted": {
              // TASK.145 срез 1: a detached run settles `run()` HERE, at
              // admit — not at terminal. No `subagent_start` progress is
              // emitted (file header: nothing downstream needs a live card
              // for a call that already returned; agent.ts's own header
              // comment explains why finalizeSubagentCard naturally produces
              // no presentation for it). The waiter is deliberately left
              // registered (no `finish()`/no `waiters.delete`) so the
              // eventual `terminal` still reaches this `onEvent` and is
              // routed to `onDetachedTerminal` below.
              //
              // TASK.145 срез 3: the abort listener IS removed here, though
              // (file header's срез-3 addendum) — a detach is an exit from
              // the turn, so cancelling the parent's turn after this point
              // must NOT cascade into this child. Registered into the
              // background-children registry in the SAME step, so a child is
              // never observably "live" without ALSO being cancellable/listed,
              // and never listed without ALSO having had its cascade-cancel
              // disarmed.
              // GitHub #17 slice D: the admission is recorded
              // BEFORE either path acts on it — background mode (explicitly
              // detached OR already handed off), a handoff-eligible joining run
              // that starts its budget clock here, or a plain synchronous join.
              // A duplicate accepted is a no-op: settlement happens once.
              if (acceptedEvent !== undefined) return;
              acceptedEvent = event;
              acceptedAt = Date.now();
              if (mode === "background" || req.detach === true) {
                // A5 (slice D): an explicitly detached run keeps its own
                // request object and settles with `reason: "requested"`.
                enterBackground("requested");
                return;
              }
              // TASK.102 CUT-S4 §3.1: `engine` rides verbatim from the
              // REQUEST (never from main's `accepted` event, which carries
              // no engine field) — the card's chip reflects what this run
              // asked to boot, exactly like agentType/description above.
              const progress: SubagentProgress = {
                kind: "start",
                agentType: req.agentType,
                description: req.description,
                model: event.model,
                ...(req.engine !== undefined ? { engine: req.engine } : {}),
              };
              opts.onProgress?.(progress);
              // Slice D: only a native Agent call that actually joins opts in
              // (`allowBackgroundHandoff`), and only when a background terminal
              // callback exists to receive the handed-off child. Workflow and
              // legacy callers never carry the flag, so their joins are
              // unchanged. The clock starts at ADMISSION, not at the model
              // request: a request still queued has spent none of its budget.
              if (req.allowBackgroundHandoff === true && options.onDetachedTerminal !== undefined) {
                joinTimer = setTimeout(() => {
                  joinTimer = undefined;
                  enterBackground("join_budget");
                }, syncJoinBudgetMs);
              }
              return;
            }
            case "rejected": {
              // §2.7's texts are minted by main and ride verbatim in `message` —
              // this client relays it unchanged into `finalText`, the same field
              // tools/agent.ts's existing error mapping already reads for the
              // model-visible message (agent.ts: `outcome.finalText || "..."`).
              finish({
                status: "error",
                finalText: event.message,
                truncated: false,
                turns: 0,
                toolCalls: 0,
                durationMs: 0,
                childSessionId: "",
                parentSessionId: options.parentSessionId,
                spawnToolCallId: req.spawnToolCallId,
              });
              return;
            }
            case "progress": {
              // Sign of life (TASK.148 slice 1/2): silence is measured
              // against the cadence of these coarse events, exactly like the
              // inline tier's tool_result/turn_end boundary — no new wire
              // message. Fed BEFORE the detach early-return below: a
              // detached run's clock still needs to see this, even though
              // (TASK.145 срез 1, unchanged) its own tool call already
              // returned at admit, so no live card exists for opts.onProgress
              // to update.
              stallClock.noteProgress(event.lastTool);
              const lastTool = approvalTool ?? event.lastTool;
              retainProgress({ turns: event.turns, toolCalls: event.toolCalls, lastTool });
              if (mode === "background") {
                updateBackgroundSnapshot(acceptedEvent?.childSessionId ?? "", {
                  turns: event.turns,
                  toolCalls: event.toolCalls,
                  ...(lastTool !== undefined ? { lastTool } : {}),
                });
                // Taskana 4820: a detached run's progress is the only place
                // the parent can learn its child is about to hit its turn
                // cap. Checked inside the detach branch (a sync-join parent
                // is blocked inside the Agent call and cannot act on a
                // mid-call warning). Once per run: the latch above.
                //
                // F1: `effectiveMaxTurns` is the child's EFFECTIVE cap
                // (request budget > accepted-carried host limit >
                // DEFAULT_MAX_TURNS), never a bare `req.maxTurns` gate — an
                // unstamped spawn still stops at the child host's default
                // cap, and the warning must fire for it too.
                //
                // F2: codex children are SKIPPED — codex enforces no turn
                // cap, so a "turns" count against one is a warning about a
                // wall that does not exist. Small budgets (< 5) are skipped
                // too: the 10%-min-1 margin leaves no room between "warned"
                // and "stopped" for the parent to act on.
                //
                // F5 (Slice B, known limit): `event.turns` is CUMULATIVE
                // across steer continuations (a follow-up send to a live
                // child keeps counting on the same tally), while the cap the
                // child enforces is PER runTurn — the argv-stamped
                // --child-max-turns budget resets on every turn boundary. A
                // child steered many times can therefore warn (or even
                // terminal at max_turns) on a count that no single turn
                // approached; honest until the wire carries a per-turn count.
                if (
                  !turnBudgetNotified &&
                  req.engine !== "codex" &&
                  effectiveMaxTurns >= 5 &&
                  event.turns >= 1 &&
                  event.turns >= effectiveMaxTurns - Math.max(1, Math.ceil(effectiveMaxTurns / 10))
                ) {
                  turnBudgetNotified = true;
                  options.onDetachedTurnBudget?.(
                    { turns: event.turns, maxTurns: effectiveMaxTurns },
                    backgroundRequest(),
                    detachedChildSessionId ?? "",
                  );
                }
                return;
              }
              const progress: SubagentProgress = {
                kind: "progress",
                turns: event.turns,
                toolCalls: event.toolCalls,
                ...(event.lastTool !== undefined ? { lastTool: event.lastTool } : {}),
              };
              opts.onProgress?.(progress);
              return;
            }
            case "activity": {
              stallClock.noteProgress(event.toolName);
              const lastTool = approvalTool ?? event.toolName;
              retainProgress({ lastTool });
              if (mode === "background") {
                updateBackgroundSnapshot(acceptedEvent?.childSessionId ?? "", { lastTool });
                return;
              }
              const progress: SubagentProgress = { kind: "tool", toolName: event.toolName, summary: event.summary };
              opts.onProgress?.(progress);
              return;
            }
            case "attention": {
              // Waiting for a human is NOT silence (TASK.148 slice 1/2): this
              // is the real PUSHED event the session tier has that the inline
              // tier does not (the child's own broker, tapChildPermissions) —
              // no polling needed here, unlike runner.ts. Fed BEFORE the
              // detach early-return below, same rationale as progress/
              // activity above — a detached child's ask still freezes ITS
              // clock even though no live card exists to show the badge.
              if (event.waiting) {
                stallClock.pause();
              } else {
                stallClock.resume();
              }
              approvalTool = event.waiting ? event.toolName : undefined;
              retainProgress({ waitingForApproval: event.waiting, ...(event.waiting ? { lastTool: event.toolName } : {}) });
              if (mode === "joining") {
                // A joining run has no parent-side notice yet, but a handoff
                // must know whether an ask was already pending when the wait
                // ended (see enterBackground).
                joiningAsk =
                  event.waiting && event.toolName !== undefined
                    ? { toolName: event.toolName, subject: event.subject ?? "" }
                    : undefined;
              }
              if (mode === "background") {
                updateBackgroundSnapshot(acceptedEvent?.childSessionId ?? "", {
                  waitingForApproval: event.waiting,
                  ...(event.waiting && event.toolName !== undefined ? { lastTool: event.toolName } : {}),
                });
                if (event.waiting && event.toolName !== undefined) {
                  detachedAskPending = true;
                  options.onDetachedApproval?.(
                    { toolName: event.toolName, subject: event.subject ?? "" },
                    backgroundRequest(),
                    detachedChildSessionId ?? "",
                  );
                } else if (!event.waiting && detachedAskPending) {
                  // Review F1a: an ask this port reported to the parent has
                  // settled (answered, expired, or force-denied). The
                  // parent-side notice is now STALE — nobody needs to open the
                  // child's tab for it — so the host retracts the pending
                  // queue row (host/index.ts acks `approval:<spawnToolCallId>`).
                  // Idempotent on the host side (ack of an unknown id is a
                  // no-op), fires once per ask->settle cycle.
                  detachedAskPending = false;
                  options.onDetachedApprovalSettled?.(backgroundRequest(), detachedChildSessionId ?? "");
                }
                return;
              }
              const progress: SubagentProgress = { kind: "attention", waiting: event.waiting };
              opts.onProgress?.(progress);
              return;
            }
            case "terminal": {
              // GitHub #17 slice D: a real terminal always ends
              // this waiter's life — disarm the pending join budget first, so a
              // timer can never hand off a finished child.
              terminalSeen = true;
              clearJoinTimer();
              // TASK.240: the cancel cause lives only in this host's registry
              // row, which the detached branch below deletes — read it NOW,
              // while the row still exists, so a user stop reaches the parent.
              const userCancelled =
                mode === "background" &&
                event.status === "cancelled" &&
                backgroundChildren.get(event.childSessionId)?.cancelCause === "user";
              const outcome: SessionSubagentOutcome = {
                status: event.status,
                finalText: event.finalText,
                truncated: event.truncated,
                turns: event.turns,
                toolCalls: event.toolCalls,
                durationMs: event.durationMs,
                childSessionId: event.childSessionId,
                parentSessionId: options.parentSessionId,
                spawnToolCallId: req.spawnToolCallId,
                ...(event.finalTurnFinishReason !== undefined ? { finalTurnFinishReason: event.finalTurnFinishReason } : {}),
                ...(event.declaredDoneAtCeiling === true ? { declaredDoneAtCeiling: true } : {}),
                ...(event.ceiling !== undefined ? { ceiling: event.ceiling } : {}),
                // R2 (Taskana 4704): the safe error descriptor rides through
                // so the parent host's respawn classifier never sees the
                // child's free model text.
                ...(event.errorDescriptor !== undefined ? { errorDescriptor: event.errorDescriptor } : {}),
                ...(userCancelled ? { cancelledBy: "user" as const } : {}),
              };
              // TASK.145 срез 1: this run's `run()` promise already settled
              // at admit (above) — this terminal can no longer resolve it.
              // No `subagent_end` progress either (symmetry with the other
              // three cases above: no live card exists to close out). Clean
              // up HERE instead — this is the true end of this waiter's
              // life, the one point a detached waiter still needs its own
              // teardown that `finish()` would otherwise have done.
              //
              // TASK.145 срез 3: also the true end of this child's life in
              // the background-children registry — removed here (whether the
              // terminal followed an explicit `cancelBackgroundChild` or the
              // child simply finished on its own), and the abort-listener
              // removal below is now a defensive no-op in the common case
              // (срез 3 already removed it at admit) but stays cheap and
              // harmless for a request that somehow never reached "accepted"'s
              // detach branch (defense in depth, not a reachable path today).
              if (mode === "background") {
                // GitHub #17 slice A: a detached run whose
                // `accepted` acknowledgement was never delivered (missing or
                // dropped) must still settle its ORIGINAL tool promise at
                // terminal — otherwise the parent's step would hang forever.
                // There is no background child the parent was ever told about,
                // so `finish()` resolves the original run directly and no
                // background report is emitted.
                if (!admitResultDelivered) {
                  finish(outcome);
                  return;
                }
                // TASK.148 slice 2: this waiter's own stall clock stops here
                // too — the true end of its life for a detached run, same as
                // every other teardown step on this branch (`finish()` never
                // runs for a detached waiter once handed off, so nothing else
                // would ever dispose it).
                stallClock.dispose();
                waiters.delete(requestId);
                pendingDetachedAdmits.delete(requestId);
                opts.signal?.removeEventListener("abort", onAbort);
                backgroundChildren.delete(event.childSessionId);
                notifyBackgroundChildrenChanged();
                options.onDetachedTerminal?.(outcome, backgroundRequest());
                return;
              }
              // CUT-S2 §10.7 п.4: passthrough of the honest suppressed-count
              // (main relayed it verbatim from the child's own ChildTerminal)
              // — mirrors the inline runner's own `activitySuppressed` on its
              // `kind:"end"` SubagentProgress (runner.ts:573). Absent when
              // the run never crossed the activity cap, exactly like inline.
              const progress: SubagentProgress = {
                kind: "end",
                status: event.status,
                turns: event.turns,
                durationMs: event.durationMs,
                ...(event.activitySuppressed !== undefined ? { activitySuppressed: event.activitySuppressed } : {}),
                ...(event.finalTurnFinishReason !== undefined ? { finalTurnFinishReason: event.finalTurnFinishReason } : {}),
                // TASK.240/4055 (cross-review F1): the ceiling summary rides
                // the end progress — the ONLY source of subagent_end, which
                // the UI budget line and telemetry read. Mirrors runner.ts.
                ...(event.ceiling !== undefined ? { ceiling: event.ceiling } : {}),
                // Child-fact model attribution (TASK.219): the terminal's
                // `model` is the child host's ACTIVE session model (never
                // req.model nor the parent's pre-boot accepted label);
                // `responseModel` is the child's dedicated-port claim when it
                // reported one; `engine` rides the request's own engine fact.
                ...(event.model !== undefined ? { model: event.model } : {}),
                ...(event.responseModel !== undefined ? { responseModel: event.responseModel } : {}),
                ...(req.engine !== undefined ? { engine: req.engine } : {}),
              };
              opts.onProgress?.(progress);
              finish(outcome);
              return;
            }
            case "sent": {
              // Taskana 4153: ack for a ChildRunSend — a run() waiter shares
              // the requestId namespace but never sees this kind (send
              // deletes its own waiter the moment the ack lands, and main
              // never relays a send's ack into a run's lifecycle). Reachable
              // only through a same-requestId collision, which the
              // createRequestId() uuid makes practically impossible; treated
              // as a stray no-op, never a run outcome.
              return;
            }
            default: {
              // Exhaustiveness guard: a new ChildRunEvent kind fails to compile
              // here (matches the codebase's exhaustive-never discipline, e.g.
              // git-bridge.ts's GitCommand switch).
              const _exhaustive: never = event;
              void _exhaustive;
              return;
            }
          }
        },
      });

      // opts.signal, if present, is guaranteed NOT already aborted here (F9's
      // early return above handles that case before any code in this
      // executor runs, and nothing async separates the two checks).
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const spawnRequest: ChildSpawnRequest = {
        type: CHILD_SPAWN_REQUEST_TYPE,
        requestId,
        spawnToolCallId: req.spawnToolCallId,
        agentType: req.agentType,
        description: req.description,
        prompt: req.prompt,
        ...(req.provider !== undefined ? { provider: req.provider } : {}),
        ...(req.connectionId !== undefined ? { connectionId: req.connectionId } : {}),
        ...(req.model !== undefined ? { model: req.model } : {}),
        ...(req.effort !== undefined ? { effort: req.effort } : {}),
        // TASK.102 CUT-S4 §3.1: verbatim passthrough, absent = core (the
        // wire's own byte-compatible default — shared/child-sessions.ts's
        // file header).
        ...(req.engine !== undefined ? { engine: req.engine } : {}),
        ...(req.resumeChildSessionId !== undefined ? { resumeChildSessionId: req.resumeChildSessionId } : {}),
        // TASK.180: the turn budget rides only the CREATING spawn — a
        // resume request (resumeChildSessionId set) never re-imposes a budget.
        ...(req.resumeChildSessionId === undefined && req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
        // GitHub #17 slice B: the detach flag rides the wire so
        // main can refuse an over-cap detached request immediately instead of
        // parking it (a parked detached request holds the parent's whole step).
        ...(req.detach !== undefined ? { detach: req.detach } : {}),
        permissionMode: options.getPermissionMode(),
      };
      options.send(spawnRequest);
    });
  }

  /**
   * Taskana 4153 / TASK.216 wire: `ChildSessionPort.send` — see the
   * interface's own doc. Mirrors `run()`'s waiter pattern (one
   * `Map<requestId, waiter>` entry, resolved by the inbound `sent`/
   * `rejected` ack with that requestId), but bounded by
   * `CHILD_SEND_RPC_TIMEOUT_MS` — a bounded request/reply pair, not a
   * sync-join lifecycle (file header).
   */
  function send(req: { childSessionId: string; text: string }, opts?: { signal?: AbortSignal }): Promise<SessionSubagentSendResult> {
    // Pre-flight (F8/F9 discipline, same rationale as run()'s own two early
    // returns): an ALREADY-aborted signal or a malformed id/text must fail
    // immediately and honestly, never reach options.send.
    if (opts?.signal?.aborted) {
      return Promise.resolve({ ok: false, reason: "unavailable", message: SEND_ABORTED_MESSAGE });
    }
    if (!isValidChildId(req.childSessionId) || !isValidFreeText(req.text, CHILD_PROMPT_MAX_CHARS)) {
      return Promise.resolve({ ok: false, reason: "unavailable", message: MALFORMED_SEND_MESSAGE });
    }
    return new Promise<SessionSubagentSendResult>((resolve) => {
      const requestId = createRequestId();
      // Finish is referenced by the timer/abort listener before its own
      // declaration, exactly like run()'s waiter closures — hoisted const,
      // called only after both bindings exist.
      const timer = setTimeout(() => finish({ ok: false, reason: "host_error", message: SEND_TIMEOUT_MESSAGE }), CHILD_SEND_RPC_TIMEOUT_MS);
      const finish = (result: SessionSubagentSendResult): void => {
        clearTimeout(timer);
        waiters.delete(requestId);
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      // Cross-review Finding 2 (Taskana 4153): run() observes a MID-FLIGHT
      // abort through an abort listener; the send waiter must too, or a
      // parent-turn cancel leaves it lingering until the 30s RPC timeout
      // with a misleading "delivery unknown". Aborting settles the call
      // immediately with the same honest "aborted before send" text the
      // pre-flight check uses — delivery IS unknown to the caller, but the
      // reason they cancelled is the reason this stopped waiting. Unlike
      // run()'s onAbort this sends nothing (there is no cancel op for a
      // send) and, unlike run()'s sync-join discipline, it resolves the
      // promise directly: a send is a bounded request/reply pair whose only
      // outcomes are this ack, main's ack, or the timeout — none of which
      // the caller can still act on once its turn is gone. The waiter is
      // deleted here, so main's eventual ack lands as a stray no-op.
      const onAbort = (): void => {
        finish({ ok: false, reason: "unavailable", message: SEND_ABORTED_MESSAGE });
      };
      waiters.set(requestId, {
        onEvent: (event) => {
          if (event.kind !== "sent" && event.kind !== "rejected") {
            return;
          }
          finish(event.kind === "sent" ? { ok: true } : { ok: false, reason: mapSendRejectReason(event.message), message: event.message });
        },
      });
      // opts.signal, if present, is guaranteed NOT already aborted here (the
      // pre-flight return above handles that case before this executor runs).
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      options.send({ type: CHILD_RUN_SEND_TYPE, requestId, childSessionId: req.childSessionId, text: req.text });
    });
  }

  /** TASK.145 срез 3, `ChildSessionPort.listBackgroundChildren` — see that interface's own doc. */
  function listBackgroundChildren(): BackgroundChildSnapshot[] {
    return [...backgroundChildren.values()].map((entry) => entry.snapshot);
  }

  /** TASK.145 срез 3, `ChildSessionPort.cancelBackgroundChild` — see that interface's own doc. */
  function cancelBackgroundChild(childSessionId: string): boolean {
    return requestBackgroundChildCancel(childSessionId, "user");
  }

  function requestBackgroundChildCancel(childSessionId: string, cause: "user" | "shutdown"): boolean {
    const entry = backgroundChildren.get(childSessionId);
    if (entry === undefined) {
      return false;
    }
    if (!entry.cancelRequested) {
      entry.cancelRequested = true;
      entry.cancelCause = cause;
      options.send({ type: CHILD_RUN_CANCEL_TYPE, requestId: entry.requestId });
    }
    return true;
  }

  /** TASK.145 срез 3, `ChildSessionPort.cancelAllBackgroundChildren` — see that interface's own doc. */
  function cancelAllBackgroundChildren(): void {
    for (const childSessionId of [...backgroundChildren.keys()]) {
      requestBackgroundChildCancel(childSessionId, "shutdown");
    }
  }

  /** TASK.145 срез 3, `ChildSessionPort.onBackgroundChildrenChanged` — see that interface's own doc. */
  function onBackgroundChildrenChanged(listener: () => void): () => void {
    backgroundChildrenListeners.add(listener);
    return () => {
      backgroundChildrenListeners.delete(listener);
    };
  }

  return { run, send, listBackgroundChildren, cancelBackgroundChild, cancelAllBackgroundChildren, onBackgroundChildrenChanged };
}

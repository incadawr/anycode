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
import type {
  PermissionMode,
  SessionSubagentOutcome,
  SessionSubagentPort,
  SessionSubagentRequest,
  SubagentProgress,
  SubagentRunOptions,
} from "@anycode/core";
import {
  CHILD_AGENT_TYPE_MAX_CHARS,
  CHILD_DESCRIPTION_MAX_CHARS,
  CHILD_PROMPT_MAX_CHARS,
  CHILD_PROVIDER_MAX_CHARS,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_SPAWN_REQUEST_TYPE,
  isValidChildId,
  isValidChildModel,
  type ChildRunCancel,
  type ChildRunEvent,
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
    "It is running independently of this turn; its report will arrive as a new message once it finishes."
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
  /** Sends a ChildSpawnRequest/ChildRunCancel to main (host/index.ts: process.parentPort.postMessage). */
  send: (message: ChildSpawnRequest | ChildRunCancel) => void;
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
  const waiters = new Map<string, Waiter>();
  // TASK.145 срез 3: registry of live detached children, keyed by
  // childSessionId (the id `cancelBackgroundChild`/the renderer's future list
  // both address by) — populated at admit, removed at terminal, see the two
  // `req.detach === true` branches below.
  const backgroundChildren = new Map<string, BackgroundChildEntry>();
  const backgroundChildrenListeners = new Set<() => void>();
  function notifyBackgroundChildrenChanged(): void {
    for (const listener of backgroundChildrenListeners) {
      listener();
    }
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

    return new Promise<SessionSubagentOutcome>((resolve) => {
      let cancelSent = false;

      const finish = (outcome: SessionSubagentOutcome): void => {
        waiters.delete(requestId);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      const onAbort = (): void => {
        if (cancelSent) {
          return;
        }
        cancelSent = true;
        options.send({ type: CHILD_RUN_CANCEL_TYPE, requestId });
        // Sync-join semantics (cut §0.5): abort never resolves this promise by
        // itself. Only main's eventual `terminal` (normally "cancelled", once
        // the child host has actually wound down and flushed its history)
        // does — the waiter stays registered above so that late event still
        // reaches `finish` normally instead of being silently dropped.
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
              if (req.detach === true) {
                opts.signal?.removeEventListener("abort", onAbort);
                backgroundChildren.set(event.childSessionId, {
                  requestId,
                  snapshot: {
                    childSessionId: event.childSessionId,
                    agentType: req.agentType,
                    description: req.description,
                    startedAt: Date.now(),
                  },
                  cancelRequested: false,
                });
                notifyBackgroundChildrenChanged();
                resolve({
                  status: "completed",
                  finalText: detachAdmitMessage(event.childSessionId),
                  truncated: false,
                  turns: 0,
                  toolCalls: 0,
                  durationMs: 0,
                  childSessionId: event.childSessionId,
                  parentSessionId: options.parentSessionId,
                  spawnToolCallId: req.spawnToolCallId,
                });
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
              // TASK.145 срез 1: a detached run's own tool call already
              // returned at admit (above) — no live card exists for
              // opts.onProgress to update (file header).
              if (req.detach === true) {
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
              if (req.detach === true) {
                return;
              }
              const progress: SubagentProgress = { kind: "tool", toolName: event.toolName, summary: event.summary };
              opts.onProgress?.(progress);
              return;
            }
            case "attention": {
              if (req.detach === true) {
                return;
              }
              const progress: SubagentProgress = { kind: "attention", waiting: event.waiting };
              opts.onProgress?.(progress);
              return;
            }
            case "terminal": {
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
              if (req.detach === true) {
                waiters.delete(requestId);
                opts.signal?.removeEventListener("abort", onAbort);
                backgroundChildren.delete(event.childSessionId);
                notifyBackgroundChildrenChanged();
                options.onDetachedTerminal?.(outcome, req);
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
              };
              opts.onProgress?.(progress);
              finish(outcome);
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
        ...(req.model !== undefined ? { model: req.model } : {}),
        // TASK.102 CUT-S4 §3.1: verbatim passthrough, absent = core (the
        // wire's own byte-compatible default — shared/child-sessions.ts's
        // file header).
        ...(req.engine !== undefined ? { engine: req.engine } : {}),
        permissionMode: options.getPermissionMode(),
      };
      options.send(spawnRequest);
    });
  }

  /** TASK.145 срез 3, `ChildSessionPort.listBackgroundChildren` — see that interface's own doc. */
  function listBackgroundChildren(): BackgroundChildSnapshot[] {
    return [...backgroundChildren.values()].map((entry) => entry.snapshot);
  }

  /** TASK.145 срез 3, `ChildSessionPort.cancelBackgroundChild` — see that interface's own doc. */
  function cancelBackgroundChild(childSessionId: string): boolean {
    const entry = backgroundChildren.get(childSessionId);
    if (entry === undefined) {
      return false;
    }
    if (!entry.cancelRequested) {
      entry.cancelRequested = true;
      options.send({ type: CHILD_RUN_CANCEL_TYPE, requestId: entry.requestId });
    }
    return true;
  }

  /** TASK.145 срез 3, `ChildSessionPort.cancelAllBackgroundChildren` — see that interface's own doc. */
  function cancelAllBackgroundChildren(): void {
    for (const childSessionId of [...backgroundChildren.keys()]) {
      cancelBackgroundChild(childSessionId);
    }
  }

  /** TASK.145 срез 3, `ChildSessionPort.onBackgroundChildrenChanged` — see that interface's own doc. */
  function onBackgroundChildrenChanged(listener: () => void): () => void {
    backgroundChildrenListeners.add(listener);
    return () => {
      backgroundChildrenListeners.delete(listener);
    };
  }

  return { run, listBackgroundChildren, cancelBackgroundChild, cancelAllBackgroundChildren, onBackgroundChildrenChanged };
}

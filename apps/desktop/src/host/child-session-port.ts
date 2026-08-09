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
 * dispatcher's EXISTING 600s tool timeout (`tools/agent.ts`'s metadata,
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
 * the caller's promise pending until the dispatcher's 600s tool timeout — an
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
 * main and hung the caller's promise until the dispatcher's 600s tool
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
}

/** One in-flight `run()` call's event handler, keyed by `requestId` in the port-wide waiter map. */
interface Waiter {
  onEvent(event: ChildRunEvent): void;
}

/**
 * Builds the host-side `SessionSubagentPort` (cut §2.6.1): an RPC client that
 * asks main to spawn (and, on abort, cancel) a child session over the
 * `process.parentPort` control plane, bridging main's coarse `ChildRunEvent`
 * stream into `SubagentProgress` callbacks and a final `SessionSubagentOutcome`
 * — the exact shape `tools/agent.ts`'s session-tier branch (S2b B1) awaits.
 */
export function createChildSessionPort(options: CreateChildSessionPortOptions): SessionSubagentPort {
  const createRequestId = options.createRequestId ?? randomUUID;
  const waiters = new Map<string, Waiter>();

  options.subscribe((event) => {
    waiters.get(event.requestId)?.onEvent(event);
  });

  function run(req: SessionSubagentRequest, opts: SubagentRunOptions): Promise<SessionSubagentOutcome> {
    // Pre-flight, before minting a requestId or sending anything (§10.5,
    // widened by F8 to every capped field, not just spawnToolCallId): a
    // malformed request must fail IMMEDIATELY and HONESTLY here, rather than
    // being sent and silently dropped by main's fail-closed
    // `parseChildSpawnRequest` — that path would leave this call's promise
    // pending until the dispatcher's 600s tool timeout with no explanation.
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
              const progress: SubagentProgress = { kind: "tool", toolName: event.toolName, summary: event.summary };
              opts.onProgress?.(progress);
              return;
            }
            case "attention": {
              const progress: SubagentProgress = { kind: "attention", waiting: event.waiting };
              opts.onProgress?.(progress);
              return;
            }
            case "terminal": {
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
              finish({
                status: event.status,
                finalText: event.finalText,
                truncated: event.truncated,
                turns: event.turns,
                toolCalls: event.toolCalls,
                durationMs: event.durationMs,
                childSessionId: event.childSessionId,
                parentSessionId: options.parentSessionId,
                spawnToolCallId: req.spawnToolCallId,
              });
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

  return { run };
}

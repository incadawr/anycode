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
  CHILD_RUN_CANCEL_TYPE,
  CHILD_SPAWN_REQUEST_TYPE,
  isValidChildId,
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
    // Pre-flight, before minting a requestId or sending anything (§10.5): a
    // malformed spawnToolCallId must fail IMMEDIATELY and HONESTLY here,
    // rather than being sent and silently dropped by main's fail-closed
    // `parseChildSpawnRequest` — that path would leave this call's promise
    // pending until the dispatcher's 600s tool timeout with no explanation.
    if (!isValidChildId(req.spawnToolCallId)) {
      return Promise.resolve({
        status: "error",
        finalText: MALFORMED_SPAWN_ID_MESSAGE,
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
              const progress: SubagentProgress = {
                kind: "start",
                agentType: req.agentType,
                description: req.description,
                model: event.model,
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
              const progress: SubagentProgress = {
                kind: "end",
                status: event.status,
                turns: event.turns,
                durationMs: event.durationMs,
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

      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const spawnRequest: ChildSpawnRequest = {
        type: CHILD_SPAWN_REQUEST_TYPE,
        requestId,
        spawnToolCallId: req.spawnToolCallId,
        agentType: req.agentType,
        description: req.description,
        prompt: req.prompt,
        ...(req.provider !== undefined ? { provider: req.provider } : {}),
        ...(req.model !== undefined ? { model: req.model } : {}),
        permissionMode: options.getPermissionMode(),
      };
      options.send(spawnRequest);
    });
  }

  return { run };
}

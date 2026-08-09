/**
 * Control-plane protocol for the host<->main child-session wire (TASK.102
 * CUT-S2 §2.3, frozen in slice S2a). A "child session" is a full session
 * running in ITS OWN utilityProcess, spawned by a root session's `Agent
 * tier:"session"` tool call — distinct from the in-process inline subagent
 * (ports/subagent.ts), which never leaves the parent's process.
 *
 * Two independent message families ride this file, mirroring
 * shared/credentials.ts's precedent:
 *  - parent host <-> main: ChildSpawnRequest / ChildRunCancel (host -> main)
 *    and ChildRunEvent (main -> host) — the parent's RPC client (host/
 *    child-session-port.ts, S2b) correlates replies by `requestId`.
 *  - child host <-> main: ChildReady / ChildProgress / ChildTerminal (child ->
 *    main) and ChildStart (main -> child host). Main correlates these SOLELY
 *    by the sending process (`tab.proc === sender`, then `tab.childOf.
 *    requestId`) — never by any id carried in the payload. A child never
 *    states its own parentSessionId/childSessionId on this wire; main already
 *    knows both from the TabHost it forked (S2b, main/tabs.ts).
 *
 * VALUE-ONLY module, ZERO runtime imports: like credentials.ts/preview.ts, both
 * the host (utilityProcess) and main import this file, so it must never drag
 * zod or the @anycode/core runtime into either bundle. The one `PermissionMode`
 * reference below is `import type` only (fully erased at compile time); the
 * literal five-value set is duplicated locally for the fail-closed validator,
 * the same "verbatim over this wire" precedent as preview.ts's result shapes.
 *
 * Every `parseXxx` below is fail-closed: malformed input, wrong-typed fields,
 * missing required fields, or an object carrying EXTRA unknown keys all return
 * `null` — they never throw. Main and the hosts must never trust ambient
 * identity-shaped payload fields (see the child-message correlation note
 * above); these parsers only prove the message is WELL-FORMED, not that its
 * sender is authorized to say it.
 */

import type { PermissionMode } from "@anycode/core";

// ── parentPort message types (parent host <-> main, child host <-> main) ──

export const CHILD_SPAWN_REQUEST_TYPE = "anycode:child-spawn-request" as const; // parent host -> main
export const CHILD_RUN_CANCEL_TYPE = "anycode:child-run-cancel" as const; // parent host -> main
export const CHILD_RUN_EVENT_TYPE = "anycode:child-run-event" as const; // main -> parent host
export const CHILD_READY_TYPE = "anycode:child-ready" as const; // child host -> main
export const CHILD_START_TYPE = "anycode:child-start" as const; // main -> child host
export const CHILD_PROGRESS_TYPE = "anycode:child-progress" as const; // child host -> main
export const CHILD_TERMINAL_TYPE = "anycode:child-terminal" as const; // child host -> main

// ── parent host -> main ──

/**
 * Requests a new child session. `spawnToolCallId` is the Agent tool call's own
 * id (the parent's dispatcher already minted it) — it becomes the child's
 * `spawn_tool_call_id` persistence column (§2.4) once main admits the spawn.
 * `permissionMode` is a snapshot of the parent's mode at the moment `Agent`
 * was invoked (§0.8) — the child never tracks the parent's LIVE mode.
 */
export interface ChildSpawnRequest {
  type: typeof CHILD_SPAWN_REQUEST_TYPE;
  requestId: string;
  spawnToolCallId: string;
  agentType: string;
  description: string;
  prompt: string;
  provider?: string;
  model?: string;
  permissionMode: PermissionMode;
}

/** Aborts a running child (parent turn cancel/timeout, §0.5's ctx.abortSignal). */
export interface ChildRunCancel {
  type: typeof CHILD_RUN_CANCEL_TYPE;
  requestId: string;
}

export type ChildRunStatus = "completed" | "max_turns" | "cancelled" | "error";

const CHILD_RUN_STATUSES: readonly ChildRunStatus[] = ["completed", "max_turns", "cancelled", "error"];

export type ChildRunRejectReason =
  | "limit_parent"
  | "limit_global"
  | "recursion"
  | "not_ready"
  | "closing"
  | "spawn_failed";

const CHILD_RUN_REJECT_REASONS: readonly ChildRunRejectReason[] = [
  "limit_parent",
  "limit_global",
  "recursion",
  "not_ready",
  "closing",
  "spawn_failed",
];

/**
 * main -> parent host. One `requestId` correlates a whole run's lifecycle:
 * exactly one `accepted` XOR `rejected`, then zero or more `progress`/
 * `activity`/`attention`, then exactly one `terminal` (§0.5/§0.6).
 */
export type ChildRunEvent = { type: typeof CHILD_RUN_EVENT_TYPE; requestId: string } & (
  | { kind: "accepted"; childSessionId: string; childTabId: string; model: string }
  | { kind: "rejected"; reason: ChildRunRejectReason; message: string }
  | { kind: "progress"; turns: number; toolCalls: number; lastTool?: string }
  | { kind: "activity"; toolName: string; summary: string }
  | { kind: "attention"; waiting: boolean }
  | {
      kind: "terminal";
      status: ChildRunStatus;
      finalText: string;
      truncated: boolean;
      turns: number;
      toolCalls: number;
      durationMs: number;
      childSessionId: string;
      /**
       * Additive field (TASK.102 CUT-S2 §10.7 п.4, authorized amendment to
       * this otherwise-frozen S2a type): mirrors `ChildTerminal
       * .activitySuppressed` through to the parent-host wire — main relays it
       * verbatim from the child's own `ChildTerminal` (§2.6.4). Present only
       * when >0 (parity with `runner.ts:573`'s inline `activitySuppressed`
       * and `ChildTerminal`'s own doc comment: without this the honest count
       * dies in main, contradicting `ChildTerminal`'s "S1 parity" promise).
       */
      activitySuppressed?: number;
    }
);

// ── child host <-> main ──

/** child host -> main: sent on the child Session's FIRST ui_ready (§2.6.3), not at process boot. */
export interface ChildReady {
  type: typeof CHILD_READY_TYPE;
}

/** main -> child host: the queued initial prompt, released once `child-ready` arrives. */
export interface ChildStart {
  type: typeof CHILD_START_TYPE;
  prompt: string;
}

/** child host -> main: coarse progress, relayed by main into the matching ChildRunEvent (minus childSessionId/childTabId, which main already owns). */
export type ChildProgress = { type: typeof CHILD_PROGRESS_TYPE } & (
  | { kind: "progress"; turns: number; toolCalls: number; lastTool?: string }
  | { kind: "activity"; toolName: string; summary: string }
  | { kind: "attention"; waiting: boolean }
);

/**
 * child host -> main: sent exactly once, ONLY after the child's history has
 * been durably flushed (§0.5's `flushChecked()` ordering). `activitySuppressed`
 * mirrors AgentEvent's `subagent_end` field (S1 parity).
 */
export interface ChildTerminal {
  type: typeof CHILD_TERMINAL_TYPE;
  status: ChildRunStatus;
  finalText: string;
  truncated: boolean;
  turns: number;
  toolCalls: number;
  durationMs: number;
  activitySuppressed?: number;
}

// ── admission/timing constants (§2.3) ──

/** Max concurrently running/starting/cancelling children per parent session. */
export const CHILD_RUNS_PER_PARENT_MAX = 3;
/** Max concurrently running/starting/cancelling children application-wide. */
export const CHILD_RUNS_GLOBAL_MAX = 8;
/** No `child-ready` within this window after fork -> cascade-cancel, terminal `error`. */
export const CHILD_START_DEADLINE_MS = 30_000;
/** Bound on the child's host-side steer-message queue (§0.5/§1.1); beyond this, `turn_rejected busy`. */
export const CHILD_STEER_QUEUE_MAX = 16;

// ── field-length caps (review finding 1, TASK.102 S2a): every string field on
// this wire that can originate from MODEL-controlled text (a provider mints
// `part.toolCallId` verbatim on OpenAI-compatible connects — see
// stream-translator.ts — and the parent's prompt/description are user/model
// text) is bounded here. Two families:
//  - id-shaped fields (requestId/spawnToolCallId/childSessionId/childTabId):
//    `spawnToolCallId` becomes a literal argv value in `--child-spawn-call`
//    (§2.6.2, boot.ts's `parseHostArgs`, which reads `argv[i+1]` positionally)
//    — an unbounded or dash-leading value would desync the whole arg list.
//    `isIdString` below enforces the shape; the other three id fields are
//    main-generated, not model text, but are capped the same way for a single
//    consistent "id" contract across the wire rather than a one-off carve-out.
//  - free-text fields (agentType/description/prompt/model/provider/finalText/
//    toolName/summary): capped, never rejected-on-shape — an oversized value
//    is refused (fail-closed, like every other check in this file), never
//    silently truncated. Values mirror existing project precedent (see each
//    constant's comment) rather than inventing a new scale.

/** Uuid-scale, with headroom over `MAX_ENGINE_ARG_LENGTH` (main/tabs.ts:128, the argv-bound precedent this mirrors) since a provider tool-call id can run longer than an internal preset id. */
export const CHILD_ID_MAX_CHARS = 256;
/** Mirrors `SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS` (packages/core/src/types/config.ts). */
export const CHILD_AGENT_TYPE_MAX_CHARS = 100;
/** Mirrors `SUBAGENT_CARD_DESCRIPTION_MAX_CHARS` (config.ts) — the same string is later projected onto the subagent card at this exact cap (subagent-card.ts), so this is a no-op for any value that would survive the card anyway. */
export const CHILD_DESCRIPTION_MAX_CHARS = 500;
/** Mirrors `SUBAGENT_CARD_MODEL_MAX_CHARS` (config.ts). */
export const CHILD_MODEL_MAX_CHARS = 200;
/** No existing per-provider-connection-id cap in the project; sized like `CHILD_MODEL_MAX_CHARS` (same "connection id" order of magnitude). */
export const CHILD_PROVIDER_MAX_CHARS = 200;
/** Mirrors `SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS` (config.ts). */
export const CHILD_TOOL_NAME_MAX_CHARS = 80;
/** Mirrors `SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS` (subagents/summarize-tool.ts). */
export const CHILD_SUMMARY_MAX_CHARS = 160;
/** Mirrors `WORKFLOW_STEP_PROMPT_MAX_BYTES` (config.ts, 2x `SUBAGENT_OUTPUT_MAX_BYTES`) — the largest free-text field on this wire. Counted in code units (this file's style never does UTF-8 byte accounting elsewhere), not bytes; a reject threshold this large tolerates the difference. */
export const CHILD_PROMPT_MAX_CHARS = 200_000;
/** Mirrors `SUBAGENT_OUTPUT_MAX_BYTES` (config.ts) — the SAME cap §2.6.3 already applies at the child-host producer. This is the defense-in-depth copy at the parser: the producer's own discipline is not what this validator exists to prove, so an unbounded `finalText` must never silently pass through it regardless of which producer sent it. */
export const CHILD_FINAL_TEXT_MAX_CHARS = 100_000;

// ── fail-closed shape validators ──
// Style precedent: main/tabs.ts's registerEngineProcess (manual field-by-field
// checks, malformed/stale -> silently ignored, never throws).

/**
 * Local duplicate of types/permissions.ts's PERMISSION_MODES (see file header:
 * no VALUE import of @anycode/core here). Exported (review finding 4) SOLELY
 * so child-sessions.test.ts can assert parity against the real
 * `PERMISSION_MODES` export — a value import is fine there (tests never ship
 * in the desktop bundle), just never in this production file. Typed as a
 * plain `readonly string[]` rather than `typeof PERMISSION_MODES` on purpose:
 * a type-only reference to core's tuple would still couple this file's type
 * to core's exact literal set, defeating the point of the duplicate.
 */
export const PERMISSION_MODE_VALUES: readonly string[] = ["plan", "build", "edit", "auto", "yolo"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Forbidden anywhere in an id-shaped field: any whitespace or C0/DEL control character — not just at the edges, since the value can become a literal argv entry or a Map key, never a delimiter. */
const ID_FORBIDDEN_CHARS = /[\s\x00-\x1f\x7f]/;

/**
 * An id-shaped string: non-empty, at most `maxLength` code units, never
 * starting with `-`, and free of whitespace/control characters. The leading-
 * dash rule exists because `host/boot.ts`'s `parseHostArgs` consumes flag
 * values positionally off argv (`argv[i + 1]`) — a value starting with `-`
 * would be swallowed as the FOLLOWING flag instead of this one's value,
 * desynchronizing the rest of the arg list (review finding 1).
 */
function isIdString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.startsWith("-") &&
    !ID_FORBIDDEN_CHARS.test(value)
  );
}

/**
 * Public pre-flight variant of `isIdString`, capped at `CHILD_ID_MAX_CHARS`
 * (TASK.102 CUT-S2 §10.5, additive to the frozen S2a file). Lets the parent
 * host's RPC client (`host/child-session-port.ts`) validate a model/provider-
 * minted `spawnToolCallId` BEFORE putting it on the wire, using the EXACT
 * same shape rule `parseChildSpawnRequest` enforces on the other end. This
 * parity is load-bearing: `parseChildSpawnRequest` is fail-closed and silent
 * (malformed input -> `null`, never a thrown/relayed error), so a pre-flight
 * check that disagreed with it would let a malformed id through, main would
 * drop the message with no reply, and the sender's promise would hang until
 * the dispatcher's 600s tool timeout — a slow, confusing failure instead of
 * an immediate, honest one.
 */
export function isValidChildId(value: unknown): value is string {
  return isIdString(value, CHILD_ID_MAX_CHARS);
}

/** Non-empty string, capped at `maxLength` code units — the shape most free-text required fields on this wire share (agentType/description/prompt/model/provider/toolName). */
function isNonEmptyCappedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** Possibly-empty string, capped at `maxLength` code units — for fields an empty value is legitimately well-formed for (finalText, ChildStart's prompt, summary, lastTool). */
function isCappedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

/** Non-negative finite integer (turn counts, durations, byte counts on this wire are never negative or fractional). */
function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODE_VALUES.includes(value);
}

/** Fail-closed on any key not in `allowed` — a well-formed message never carries surprise fields. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const CHILD_SPAWN_REQUEST_KEYS = [
  "type",
  "requestId",
  "spawnToolCallId",
  "agentType",
  "description",
  "prompt",
  "provider",
  "model",
  "permissionMode",
] as const;

export function parseChildSpawnRequest(msg: unknown): ChildSpawnRequest | null {
  if (!isRecord(msg) || msg.type !== CHILD_SPAWN_REQUEST_TYPE) {
    return null;
  }
  if (!hasOnlyKeys(msg, CHILD_SPAWN_REQUEST_KEYS)) {
    return null;
  }
  if (
    !isIdString(msg.requestId, CHILD_ID_MAX_CHARS) ||
    !isIdString(msg.spawnToolCallId, CHILD_ID_MAX_CHARS) ||
    !isNonEmptyCappedString(msg.agentType, CHILD_AGENT_TYPE_MAX_CHARS) ||
    !isNonEmptyCappedString(msg.description, CHILD_DESCRIPTION_MAX_CHARS) ||
    !isNonEmptyCappedString(msg.prompt, CHILD_PROMPT_MAX_CHARS)
  ) {
    return null;
  }
  if (msg.provider !== undefined && !isNonEmptyCappedString(msg.provider, CHILD_PROVIDER_MAX_CHARS)) {
    return null;
  }
  if (msg.model !== undefined && !isNonEmptyCappedString(msg.model, CHILD_MODEL_MAX_CHARS)) {
    return null;
  }
  if (!isPermissionMode(msg.permissionMode)) {
    return null;
  }
  return {
    type: CHILD_SPAWN_REQUEST_TYPE,
    requestId: msg.requestId,
    spawnToolCallId: msg.spawnToolCallId,
    agentType: msg.agentType,
    description: msg.description,
    prompt: msg.prompt,
    ...(msg.provider !== undefined ? { provider: msg.provider as string } : {}),
    ...(msg.model !== undefined ? { model: msg.model as string } : {}),
    permissionMode: msg.permissionMode,
  };
}

const CHILD_RUN_CANCEL_KEYS = ["type", "requestId"] as const;

export function parseChildRunCancel(msg: unknown): ChildRunCancel | null {
  if (!isRecord(msg) || msg.type !== CHILD_RUN_CANCEL_TYPE) {
    return null;
  }
  if (!hasOnlyKeys(msg, CHILD_RUN_CANCEL_KEYS)) {
    return null;
  }
  if (!isIdString(msg.requestId, CHILD_ID_MAX_CHARS)) {
    return null;
  }
  return { type: CHILD_RUN_CANCEL_TYPE, requestId: msg.requestId };
}

const CHILD_RUN_EVENT_ACCEPTED_KEYS = ["type", "requestId", "kind", "childSessionId", "childTabId", "model"] as const;
const CHILD_RUN_EVENT_REJECTED_KEYS = ["type", "requestId", "kind", "reason", "message"] as const;
const CHILD_RUN_EVENT_PROGRESS_KEYS = ["type", "requestId", "kind", "turns", "toolCalls", "lastTool"] as const;
const CHILD_RUN_EVENT_ACTIVITY_KEYS = ["type", "requestId", "kind", "toolName", "summary"] as const;
const CHILD_RUN_EVENT_ATTENTION_KEYS = ["type", "requestId", "kind", "waiting"] as const;
const CHILD_RUN_EVENT_TERMINAL_KEYS = [
  "type",
  "requestId",
  "kind",
  "status",
  "finalText",
  "truncated",
  "turns",
  "toolCalls",
  "durationMs",
  "childSessionId",
  // TASK.102 CUT-S2 §10.7 п.4: additive key, authorized amendment.
  "activitySuppressed",
] as const;

export function parseChildRunEvent(msg: unknown): ChildRunEvent | null {
  if (!isRecord(msg) || msg.type !== CHILD_RUN_EVENT_TYPE) {
    return null;
  }
  if (!isIdString(msg.requestId, CHILD_ID_MAX_CHARS) || !isString(msg.kind)) {
    return null;
  }
  const requestId = msg.requestId;
  switch (msg.kind) {
    case "accepted": {
      if (!hasOnlyKeys(msg, CHILD_RUN_EVENT_ACCEPTED_KEYS)) {
        return null;
      }
      if (
        !isIdString(msg.childSessionId, CHILD_ID_MAX_CHARS) ||
        !isIdString(msg.childTabId, CHILD_ID_MAX_CHARS) ||
        !isNonEmptyCappedString(msg.model, CHILD_MODEL_MAX_CHARS)
      ) {
        return null;
      }
      return {
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "accepted",
        childSessionId: msg.childSessionId,
        childTabId: msg.childTabId,
        model: msg.model,
      };
    }
    case "rejected": {
      if (!hasOnlyKeys(msg, CHILD_RUN_EVENT_REJECTED_KEYS)) {
        return null;
      }
      if (!isString(msg.reason) || !CHILD_RUN_REJECT_REASONS.includes(msg.reason as ChildRunRejectReason)) {
        return null;
      }
      if (!isString(msg.message)) {
        return null;
      }
      return {
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "rejected",
        reason: msg.reason as ChildRunRejectReason,
        message: msg.message,
      };
    }
    case "progress": {
      if (!hasOnlyKeys(msg, CHILD_RUN_EVENT_PROGRESS_KEYS)) {
        return null;
      }
      if (!isCounter(msg.turns) || !isCounter(msg.toolCalls)) {
        return null;
      }
      if (msg.lastTool !== undefined && !isCappedString(msg.lastTool, CHILD_TOOL_NAME_MAX_CHARS)) {
        return null;
      }
      return {
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "progress",
        turns: msg.turns,
        toolCalls: msg.toolCalls,
        ...(msg.lastTool !== undefined ? { lastTool: msg.lastTool as string } : {}),
      };
    }
    case "activity": {
      if (!hasOnlyKeys(msg, CHILD_RUN_EVENT_ACTIVITY_KEYS)) {
        return null;
      }
      if (
        !isNonEmptyCappedString(msg.toolName, CHILD_TOOL_NAME_MAX_CHARS) ||
        !isCappedString(msg.summary, CHILD_SUMMARY_MAX_CHARS)
      ) {
        return null;
      }
      return { type: CHILD_RUN_EVENT_TYPE, requestId, kind: "activity", toolName: msg.toolName, summary: msg.summary };
    }
    case "attention": {
      if (!hasOnlyKeys(msg, CHILD_RUN_EVENT_ATTENTION_KEYS)) {
        return null;
      }
      if (!isBoolean(msg.waiting)) {
        return null;
      }
      return { type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: msg.waiting };
    }
    case "terminal": {
      if (!hasOnlyKeys(msg, CHILD_RUN_EVENT_TERMINAL_KEYS)) {
        return null;
      }
      if (!isString(msg.status) || !CHILD_RUN_STATUSES.includes(msg.status as ChildRunStatus)) {
        return null;
      }
      if (
        !isCappedString(msg.finalText, CHILD_FINAL_TEXT_MAX_CHARS) ||
        !isBoolean(msg.truncated) ||
        !isCounter(msg.turns) ||
        !isCounter(msg.toolCalls) ||
        !isCounter(msg.durationMs) ||
        !isIdString(msg.childSessionId, CHILD_ID_MAX_CHARS)
      ) {
        return null;
      }
      if (msg.activitySuppressed !== undefined && !isCounter(msg.activitySuppressed)) {
        return null;
      }
      return {
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "terminal",
        status: msg.status as ChildRunStatus,
        finalText: msg.finalText,
        truncated: msg.truncated,
        turns: msg.turns,
        toolCalls: msg.toolCalls,
        durationMs: msg.durationMs,
        childSessionId: msg.childSessionId,
        ...(msg.activitySuppressed !== undefined ? { activitySuppressed: msg.activitySuppressed as number } : {}),
      };
    }
    default:
      return null;
  }
}

const CHILD_READY_KEYS = ["type"] as const;

export function parseChildReady(msg: unknown): ChildReady | null {
  if (!isRecord(msg) || msg.type !== CHILD_READY_TYPE) {
    return null;
  }
  if (!hasOnlyKeys(msg, CHILD_READY_KEYS)) {
    return null;
  }
  return { type: CHILD_READY_TYPE };
}

const CHILD_START_KEYS = ["type", "prompt"] as const;

export function parseChildStart(msg: unknown): ChildStart | null {
  if (!isRecord(msg) || msg.type !== CHILD_START_TYPE) {
    return null;
  }
  if (!hasOnlyKeys(msg, CHILD_START_KEYS)) {
    return null;
  }
  if (!isCappedString(msg.prompt, CHILD_PROMPT_MAX_CHARS)) {
    return null;
  }
  return { type: CHILD_START_TYPE, prompt: msg.prompt };
}

const CHILD_PROGRESS_PROGRESS_KEYS = ["type", "kind", "turns", "toolCalls", "lastTool"] as const;
const CHILD_PROGRESS_ACTIVITY_KEYS = ["type", "kind", "toolName", "summary"] as const;
const CHILD_PROGRESS_ATTENTION_KEYS = ["type", "kind", "waiting"] as const;

export function parseChildProgress(msg: unknown): ChildProgress | null {
  if (!isRecord(msg) || msg.type !== CHILD_PROGRESS_TYPE) {
    return null;
  }
  if (!isString(msg.kind)) {
    return null;
  }
  switch (msg.kind) {
    case "progress": {
      if (!hasOnlyKeys(msg, CHILD_PROGRESS_PROGRESS_KEYS)) {
        return null;
      }
      if (!isCounter(msg.turns) || !isCounter(msg.toolCalls)) {
        return null;
      }
      if (msg.lastTool !== undefined && !isCappedString(msg.lastTool, CHILD_TOOL_NAME_MAX_CHARS)) {
        return null;
      }
      return {
        type: CHILD_PROGRESS_TYPE,
        kind: "progress",
        turns: msg.turns,
        toolCalls: msg.toolCalls,
        ...(msg.lastTool !== undefined ? { lastTool: msg.lastTool as string } : {}),
      };
    }
    case "activity": {
      if (!hasOnlyKeys(msg, CHILD_PROGRESS_ACTIVITY_KEYS)) {
        return null;
      }
      if (
        !isNonEmptyCappedString(msg.toolName, CHILD_TOOL_NAME_MAX_CHARS) ||
        !isCappedString(msg.summary, CHILD_SUMMARY_MAX_CHARS)
      ) {
        return null;
      }
      return { type: CHILD_PROGRESS_TYPE, kind: "activity", toolName: msg.toolName, summary: msg.summary };
    }
    case "attention": {
      if (!hasOnlyKeys(msg, CHILD_PROGRESS_ATTENTION_KEYS)) {
        return null;
      }
      if (!isBoolean(msg.waiting)) {
        return null;
      }
      return { type: CHILD_PROGRESS_TYPE, kind: "attention", waiting: msg.waiting };
    }
    default:
      return null;
  }
}

const CHILD_TERMINAL_KEYS = [
  "type",
  "status",
  "finalText",
  "truncated",
  "turns",
  "toolCalls",
  "durationMs",
  "activitySuppressed",
] as const;

export function parseChildTerminal(msg: unknown): ChildTerminal | null {
  if (!isRecord(msg) || msg.type !== CHILD_TERMINAL_TYPE) {
    return null;
  }
  if (!hasOnlyKeys(msg, CHILD_TERMINAL_KEYS)) {
    return null;
  }
  if (!isString(msg.status) || !CHILD_RUN_STATUSES.includes(msg.status as ChildRunStatus)) {
    return null;
  }
  if (
    !isCappedString(msg.finalText, CHILD_FINAL_TEXT_MAX_CHARS) ||
    !isBoolean(msg.truncated) ||
    !isCounter(msg.turns) ||
    !isCounter(msg.toolCalls) ||
    !isCounter(msg.durationMs)
  ) {
    return null;
  }
  if (msg.activitySuppressed !== undefined && !isCounter(msg.activitySuppressed)) {
    return null;
  }
  return {
    type: CHILD_TERMINAL_TYPE,
    status: msg.status as ChildRunStatus,
    finalText: msg.finalText,
    truncated: msg.truncated,
    turns: msg.turns,
    toolCalls: msg.toolCalls,
    durationMs: msg.durationMs,
    ...(msg.activitySuppressed !== undefined ? { activitySuppressed: msg.activitySuppressed as number } : {}),
  };
}

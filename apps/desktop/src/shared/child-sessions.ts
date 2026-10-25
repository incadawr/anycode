/**
 * Control-plane protocol for the host<->main child-session wire (TASK.102
 * CUT-S2 §2.3, frozen in slice S2a). A "child session" is a full session
 * running in ITS OWN utilityProcess, spawned by a root session's `Agent
 * tier:"session"` tool call — distinct from the in-process inline subagent
 * (ports/subagent.ts), which never leaves the parent's process.
 *
 * Two independent message families ride this file, mirroring
 * shared/credentials.ts's precedent:
 *  - parent host <-> main: ChildSpawnRequest / ChildRunCancel /
 *    ChildRunSend (host -> main) and ChildRunEvent (main -> host) — the
 *    parent's RPC client (host/child-session-port.ts, S2b) correlates replies
 *    by `requestId`.
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
 * `null` — they never throw. `ChildTerminal` is the TASK 4239 exception:
 * unknown additive keys are stripped (forward-compat with newer child hosts);
 * malformed known fields still fail closed. Main and the hosts must never trust ambient
 * identity-shaped payload fields (see the child-message correlation note
 * above); these parsers only prove the message is WELL-FORMED, not that its
 * sender is authorized to say it.
 */

import type { PermissionMode, ReasoningEffort } from "@anycode/core";

// ── parentPort message types (parent host <-> main, child host <-> main) ──

/**
 * Child effort vocabulary: the core ReasoningEffort tiers plus "xhigh",
 * carried verbatim for engine children (claude/codex); core consumption
 * boundaries map xhigh to the existing core "max".
 */
export type ChildEffort = ReasoningEffort | "xhigh";

export const CHILD_SPAWN_REQUEST_TYPE = "anycode:child-spawn-request" as const; // parent host -> main
export const CHILD_RUN_CANCEL_TYPE = "anycode:child-run-cancel" as const; // parent host -> main
export const CHILD_RUN_SEND_TYPE = "anycode:child-run-send" as const; // parent host -> main
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
  /**
   * Taskana 4269: EXACT connection id from a profile's `connection:` frontmatter
   * (relayed via `SessionSubagentRequest.connectionId`). Main resolves it against
   * the live connections registry and pins the child's env to it. Mutually
   * exclusive with `provider` — a request carrying both is refused. Rides the
   * creating spawn only; never a resume.
   */
  connectionId?: string;
  model?: string;
  /**
   * Reasoning tier from the profile's `effort:` frontmatter. Core children:
   * main stamps it as the child host's ANYCODE_REASONING_EFFORT (mapping
   * "xhigh" to "max"), which the host resolves against the child model's own
   * tiers; engine children carry it verbatim to the engine CLI. Absent = the
   * connection's default.
   */
  effort?: ChildEffort;
  permissionMode: PermissionMode;
  /**
   * Child engine (TASK.102 CUT-S4 §3.1). Absent = core (byte-compatible with
   * every S2 producer): the child runs the in-process AgentLoop, exactly as
   * before this field existed. Present = the child boots that engine's own
   * interactive CLI (startClaudeEngine/startCodexEngine) instead — set ONLY
   * by the core-side engine-profile route (`tools/agent.ts`'s
   * `SessionSubagentRequest.engine`, CUT-S4 §2.3), never model-visible.
   */
  engine?: "claude" | "codex";
  /**
   * Follow-up to an earlier finished core child of the sender's session: main
   * resumes that child session instead of minting a new one, and `prompt` is
   * its next message. Main alone decides whether it is resumable.
   */
  resumeChildSessionId?: string;
  /**
   * Turn budget for the creating spawn (TASK.180): from a profile's turnBudget
   * frontmatter. Validated as a safe integer within
   * 1..CHILD_MAX_TURNS_CEILING (mirrors core's SUBAGENT_MAX_TURNS_CEILING,
   * duplicated here to keep this module value-only). Absent = existing
   * defaults; follow-up (resume) requests never carry it.
   */
  maxTurns?: number;
}

/** Aborts a running child (parent turn cancel/timeout, §0.5's ctx.abortSignal). */
export interface ChildRunCancel {
  type: typeof CHILD_RUN_CANCEL_TYPE;
  requestId: string;
}

/** Parent host -> main: deliver a follow-up to the sender's OWN RUNNING child (Taskana 4153 / TASK.216 wire). */
export interface ChildRunSend {
  type: typeof CHILD_RUN_SEND_TYPE;
  /** Wire-local correlation id, same role as ChildSpawnRequest.requestId. */
  requestId: string;
  /** The child session id from the run's "accepted" event — main re-derives ownership, never trusts the payload alone. */
  childSessionId: string;
  /** Free text; bounded by the same validator family as prompt. */
  text: string;
}

export type ChildRunStatus = "completed" | "max_turns" | "cancelled" | "error";

const CHILD_RUN_STATUSES: readonly ChildRunStatus[] = ["completed", "max_turns", "cancelled", "error"];

/**
 * TASK.240/4055: mirror of core's CeilingRefusalReason for the child-fact
 * wire. Kept as an explicit literal copy (not imported from @anycode/core)
 * because this file is the shared/main boundary — it must parse before any
 * core import exists in the child-host boot path and its tests run without
 * the package graph. If core's enum changes, this list MUST change with it
 * (a parse here is a whitelist: an unknown reason fails closed to null).
 */
export type ChildCeilingRefusalReason =
  | "ladder_disabled"
  | "rounds_exhausted"
  | "no_successful_tool_calls"
  | "grant_budget_exhausted"
  | "window_collapsed"
  | "unreadable_verdict"
  | "verdict_rejected"
  | "stalled";

const CHILD_CEILING_REFUSAL_REASONS: readonly ChildCeilingRefusalReason[] = [
  "ladder_disabled",
  "rounds_exhausted",
  "no_successful_tool_calls",
  "grant_budget_exhausted",
  "window_collapsed",
  "unreadable_verdict",
  "verdict_rejected",
  "stalled",
];

/** TASK.240/4055: the child's ceiling ladder summary on the wire — numbers + closed enum only. */
export interface ChildCeilingSummary {
  rounds: number;
  grantedTurns: number;
  lastRefusal?: ChildCeilingRefusalReason;
}

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
  | { kind: "attention"; waiting: boolean; toolName?: string; subject?: string }
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
      /** Present only when the child's final turn_end carried finishReason "length" (output-token ceiling cut). */
      finalTurnFinishReason?: "length";
      /** Additive (TASK 4149): the child declared its work finished at its turn ceiling; present only when true. */
      declaredDoneAtCeiling?: boolean;
      /** Additive (TASK.219): the child host's ACTIVE session model at terminal. Absent on legacy payloads. */
      model?: string;
      /** Additive (TASK.219): the child's dedicated-port provider claim at terminal, when attributable. Absent on legacy payloads. */
      responseModel?: string;
      /** TASK.240/4055 (additive): the child's ceiling ladder summary. Absent on legacy payloads and runs that never tripped the ceiling. */
      ceiling?: ChildCeilingSummary;
      /**
       * R2 (Taskana 4704, additive): the redacted SAFE error descriptor of an
       * error terminal (finalText's first line), carried separately so the
       * parent host's infra-failure classifier never sees the child's free
       * model text. Absent on non-error terminals and legacy payloads.
       */
      errorDescriptor?: string;
    }
  /**
   * Additive (Taskana 4153): ack for a `ChildRunSend` — the follow-up message
   * was queued for the parent's OWN RUNNING child (main already verified
   * ownership and the child's running state). Carries no payload: the ack
   * waiter in the parent host only needs the requestId correlation.
   */
  | { kind: "sent" }
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
  | { kind: "attention"; waiting: boolean; toolName?: string; subject?: string }
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
  /** Present only when the child's final turn_end carried finishReason "length" (output-token ceiling cut). */
  finalTurnFinishReason?: "length";
  /** Additive (TASK 4149): present only when true. */
  declaredDoneAtCeiling?: boolean;
  /**
   * Additive (TASK.219): the child host's ACTIVE session model at terminal —
   * the literal configured/sent model, never the request's `model:` nor the
   * parent's pre-boot accepted label. Absent on legacy payloads.
   */
  model?: string;
  /**
   * Additive (TASK.219): the child's dedicated model-port provider claim at
   * terminal, when one is attributable. Absent on legacy payloads and when
   * no claim exists.
   */
  responseModel?: string;
  /** TASK.240/4055 (additive): the child's ceiling ladder summary. Absent on legacy payloads. */
  ceiling?: ChildCeilingSummary;
  /**
   * R2 (Taskana 4704, additive): the redacted SAFE error descriptor of an
   * error terminal (finalText's first line). Absent on non-error terminals
   * and legacy payloads.
   */
  errorDescriptor?: string;
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
/**
 * Max spawn requests parked waiting for a per-parent/global slot,
 * application-wide (TASK.147 срез 1: a cap-exceeding spawn now queues
 * instead of being refused outright). Bounds the queue itself — an
 * unbounded queue would only trade a lost task for a silently, indefinitely
 * stuck one, which the task's own "Границы решения" rules out just as
 * firmly as dropping the cap would be. Sized like `CHILD_STEER_QUEUE_MAX`
 * (no empirical basis exists yet for either number; TASK.147 срез 2
 * revisits both).
 */
export const CHILD_SPAWN_QUEUE_MAX = 16;

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
/**
 * TASK.180: ceiling for `ChildSpawnRequest.maxTurns` — a local duplicate of
 * core's `SUBAGENT_MAX_TURNS_CEILING` (packages/core/src/types/config.ts),
 * same "verbatim value, duplicated to keep this module free of runtime
 * imports" discipline as `PERMISSION_MODE_VALUES` above.
 */
export const CHILD_MAX_TURNS_CEILING = 200;

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

/**
 * Local dictionary for `ChildSpawnRequest.engine` (TASK.102 CUT-S4 §3.1) —
 * same "verbatim over this wire, duplicated to avoid a runtime import"
 * discipline as `PERMISSION_MODE_VALUES` above. `"core"` is deliberately NOT
 * a member: core is spelled by the field's ABSENCE (file header), never by a
 * literal — a message carrying `engine: "core"` is malformed, not a
 * synonym for omitting the field.
 */
const CHILD_ENGINE_VALUES: readonly string[] = ["claude", "codex"];

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

/**
 * Public pre-flight variant of `isIdString` for `ChildSpawnRequest.model`
 * (TASK.102 S4 blocker fix), capped at `CHILD_MODEL_MAX_CHARS` rather than
 * `CHILD_ID_MAX_CHARS` — `isValidChildId` cannot be reused directly since the
 * two caps differ (model 200, id 256). `model` is model-authored and, on the
 * main side, becomes a literal `--engine-model` argv value forwarded onto the
 * child host's own argv (`main/tabs.ts`); the same leading-dash desync this
 * file's header describes for id-shaped fields applies here too, since
 * `host/boot.ts`'s `parseHostArgs` has no branch for that flag and would
 * misread a dash-leading value as the FOLLOWING flag instead.
 */
export function isValidChildModel(value: unknown): value is string {
  return isIdString(value, CHILD_MODEL_MAX_CHARS);
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
  "connectionId",
  "model",
  "effort",
  "permissionMode",
  // TASK.102 CUT-S4 §3.1: additive key, authorized amendment (mirrors the
  // §2.6 п.4 amendment style already used for `activitySuppressed` below).
  "engine",
  "resumeChildSessionId",
  // TASK.180: additive key (profile turn budget for the creating spawn).
  "maxTurns",
] as const;

const CHILD_EFFORT_VALUES: readonly string[] = ["off", "low", "medium", "high", "xhigh", "max"] satisfies readonly ChildEffort[];

export function isChildEffort(value: unknown): value is ChildEffort {
  return typeof value === "string" && CHILD_EFFORT_VALUES.includes(value);
}

function isChildEngine(value: unknown): value is "claude" | "codex" {
  return typeof value === "string" && CHILD_ENGINE_VALUES.includes(value);
}

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
  // Taskana 4269: same shape cap as `provider`; both at once rejects the whole
  // message (they are two ways to select the same connection).
  if (msg.connectionId !== undefined && !isNonEmptyCappedString(msg.connectionId, CHILD_PROVIDER_MAX_CHARS)) {
    return null;
  }
  if (msg.provider !== undefined && msg.connectionId !== undefined) {
    return null;
  }
  if (msg.model !== undefined && !isIdString(msg.model, CHILD_MODEL_MAX_CHARS)) {
    return null;
  }
  if (msg.effort !== undefined && !isChildEffort(msg.effort)) {
    return null;
  }
  if (!isPermissionMode(msg.permissionMode)) {
    return null;
  }
  // Fail-closed drop (file header): an `engine` outside the dictionary
  // rejects the WHOLE message, exactly like an invalid `permissionMode`
  // above — never silently downgraded to absent/core.
  if (msg.engine !== undefined && !isChildEngine(msg.engine)) {
    return null;
  }
  if (msg.resumeChildSessionId !== undefined && !isIdString(msg.resumeChildSessionId, CHILD_ID_MAX_CHARS)) {
    return null;
  }
  // TASK.180: absent stays valid; a defined budget must be a safe integer
  // within 1..CHILD_MAX_TURNS_CEILING — anything else rejects the whole
  // message (fail-closed, like every other invalid field above).
  if (
    msg.maxTurns !== undefined &&
    !(typeof msg.maxTurns === "number" && Number.isSafeInteger(msg.maxTurns) && msg.maxTurns >= 1 && msg.maxTurns <= CHILD_MAX_TURNS_CEILING)
  ) {
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
    ...(msg.connectionId !== undefined ? { connectionId: msg.connectionId as string } : {}),
    ...(msg.model !== undefined ? { model: msg.model as string } : {}),
    ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
    permissionMode: msg.permissionMode,
    ...(msg.engine !== undefined ? { engine: msg.engine } : {}),
    ...(msg.resumeChildSessionId !== undefined ? { resumeChildSessionId: msg.resumeChildSessionId as string } : {}),
    ...(msg.maxTurns !== undefined ? { maxTurns: msg.maxTurns as number } : {}),
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

const CHILD_RUN_SEND_KEYS = ["type", "requestId", "childSessionId", "text"] as const;

/**
 * Fail-closed parser for `ChildRunSend` (Taskana 4153), mirroring
 * `parseChildRunCancel`'s discipline: exact keys, id-shaped `requestId`/
 * `childSessionId`, and `text` bounded by the same prompt cap the spawn
 * request's prompt rides. Proves WELL-FORMED only — ownership and the
 * child's running state are main's to re-derive (file header).
 */
export function parseChildRunSend(msg: unknown): ChildRunSend | null {
  if (!isRecord(msg) || msg.type !== CHILD_RUN_SEND_TYPE) {
    return null;
  }
  if (!hasOnlyKeys(msg, CHILD_RUN_SEND_KEYS)) {
    return null;
  }
  if (!isIdString(msg.requestId, CHILD_ID_MAX_CHARS) || !isIdString(msg.childSessionId, CHILD_ID_MAX_CHARS)) {
    return null;
  }
  if (!isNonEmptyCappedString(msg.text, CHILD_PROMPT_MAX_CHARS)) {
    return null;
  }
  return { type: CHILD_RUN_SEND_TYPE, requestId: msg.requestId, childSessionId: msg.childSessionId, text: msg.text };
}

const CHILD_RUN_EVENT_ACCEPTED_KEYS = ["type", "requestId", "kind", "childSessionId", "childTabId", "model"] as const;
const CHILD_RUN_EVENT_REJECTED_KEYS = ["type", "requestId", "kind", "reason", "message"] as const;
const CHILD_RUN_EVENT_SENT_KEYS = ["type", "requestId", "kind"] as const;
const CHILD_RUN_EVENT_PROGRESS_KEYS = ["type", "requestId", "kind", "turns", "toolCalls", "lastTool"] as const;
const CHILD_RUN_EVENT_ACTIVITY_KEYS = ["type", "requestId", "kind", "toolName", "summary"] as const;
const CHILD_RUN_EVENT_ATTENTION_KEYS = ["type", "requestId", "kind", "waiting", "toolName", "subject"] as const;
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
  "finalTurnFinishReason",
  "declaredDoneAtCeiling",
  // TASK.219: additive child-fact model attribution keys.
  "model",
  "responseModel",
  // TASK.240/4055: additive ceiling-ladder summary key.
  "ceiling",
  // R2 (Taskana 4704): additive safe-error-descriptor key.
  "errorDescriptor",
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
      // Taskana 4821: optional ask identity (what the child is blocked on).
      if (msg.toolName !== undefined && !isNonEmptyCappedString(msg.toolName, CHILD_TOOL_NAME_MAX_CHARS)) {
        return null;
      }
      if (msg.subject !== undefined && !isCappedString(msg.subject, CHILD_SUMMARY_MAX_CHARS)) {
        return null;
      }
      return {
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "attention",
        waiting: msg.waiting,
        ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
        ...(msg.subject !== undefined ? { subject: msg.subject } : {}),
      };
    }
    case "sent": {
      // Taskana 4153: ack for ChildRunSend — requestId correlation only, no payload.
      if (!hasOnlyKeys(msg, CHILD_RUN_EVENT_SENT_KEYS)) {
        return null;
      }
      return { type: CHILD_RUN_EVENT_TYPE, requestId, kind: "sent" };
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
      if (
        (msg.model !== undefined && !isNonEmptyCappedString(msg.model, CHILD_MODEL_MAX_CHARS)) ||
        (msg.responseModel !== undefined && !isNonEmptyCappedString(msg.responseModel, CHILD_MODEL_MAX_CHARS))
      ) {
        return null;
      }
      if (
        (msg.finalTurnFinishReason !== undefined && msg.finalTurnFinishReason !== "length") ||
        (msg.declaredDoneAtCeiling !== undefined && msg.declaredDoneAtCeiling !== true)
      ) {
        return null;
      }
      // TASK.240/4055: the ceiling summary is validated structurally —
      // counters + a whitelist refusal reason; anything else fails closed.
      const ceiling = parseChildCeilingSummary(msg.ceiling);
      if (msg.ceiling !== undefined && ceiling === null) {
        return null;
      }
      // R2: the safe error descriptor is present only on error terminals and
      // only as a capped string — anything else fails closed (dropped, the
      // classifier then falls back to the finalText's first line).
      if (
        msg.errorDescriptor !== undefined &&
        ((msg.status as string) !== "error" || !isCappedString(msg.errorDescriptor, CHILD_FINAL_TEXT_MAX_CHARS))
      ) {
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
        ...(msg.model !== undefined ? { model: msg.model as string } : {}),
        ...(msg.responseModel !== undefined ? { responseModel: msg.responseModel as string } : {}),
        ...(msg.activitySuppressed !== undefined ? { activitySuppressed: msg.activitySuppressed as number } : {}),
        ...(msg.finalTurnFinishReason !== undefined ? { finalTurnFinishReason: msg.finalTurnFinishReason as "length" } : {}),
        ...(msg.declaredDoneAtCeiling === true ? { declaredDoneAtCeiling: true as const } : {}),
        ...(ceiling !== null ? { ceiling } : {}),
        ...(msg.errorDescriptor !== undefined ? { errorDescriptor: msg.errorDescriptor as string } : {}),
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
const CHILD_PROGRESS_ATTENTION_KEYS = ["type", "kind", "waiting", "toolName", "subject"] as const;

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
      if (msg.toolName !== undefined && !isNonEmptyCappedString(msg.toolName, CHILD_TOOL_NAME_MAX_CHARS)) {
        return null;
      }
      if (msg.subject !== undefined && !isCappedString(msg.subject, CHILD_SUMMARY_MAX_CHARS)) {
        return null;
      }
      return {
        type: CHILD_PROGRESS_TYPE,
        kind: "attention",
        waiting: msg.waiting,
        ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
        ...(msg.subject !== undefined ? { subject: msg.subject } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * TASK.240/4055: structural validation of a wire `ceiling` summary — an
 * object of exactly {rounds, grantedTurns, lastRefusal?}, counters required,
 * `lastRefusal` (when present) must be on the whitelist. Returns the typed
 * summary, or null for absent/invalid (callers fail closed on invalid).
 */
function parseChildCeilingSummary(value: unknown): ChildCeilingSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!hasOnlyKeys(value, ["rounds", "grantedTurns", "lastRefusal"])) {
    return null;
  }
  if (!isCounter(value.rounds) || !isCounter(value.grantedTurns)) {
    return null;
  }
  if (
    value.lastRefusal !== undefined &&
    !CHILD_CEILING_REFUSAL_REASONS.includes(value.lastRefusal as ChildCeilingRefusalReason)
  ) {
    return null;
  }
  return {
    rounds: value.rounds,
    grantedTurns: value.grantedTurns,
    ...(value.lastRefusal !== undefined ? { lastRefusal: value.lastRefusal as ChildCeilingRefusalReason } : {}),
  };
}

export function parseChildTerminal(msg: unknown): ChildTerminal | null {
  if (!isRecord(msg) || msg.type !== CHILD_TERMINAL_TYPE) {
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
  if (
    (msg.model !== undefined && !isNonEmptyCappedString(msg.model, CHILD_MODEL_MAX_CHARS)) ||
    (msg.responseModel !== undefined && !isNonEmptyCappedString(msg.responseModel, CHILD_MODEL_MAX_CHARS))
  ) {
    return null;
  }
  if (
    (msg.finalTurnFinishReason !== undefined && msg.finalTurnFinishReason !== "length") ||
    (msg.declaredDoneAtCeiling !== undefined && msg.declaredDoneAtCeiling !== true)
  ) {
    return null;
  }
  // TASK.240/4055: structural validation, fail closed on an invalid summary.
  const ceiling = parseChildCeilingSummary(msg.ceiling);
  if (msg.ceiling !== undefined && ceiling === null) {
    return null;
  }
  // R2 (Taskana 4704): same fail-closed posture as the run-event parser.
  if (
    msg.errorDescriptor !== undefined &&
    ((msg.status as string) !== "error" || !isCappedString(msg.errorDescriptor, CHILD_FINAL_TEXT_MAX_CHARS))
  ) {
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
    ...(msg.model !== undefined ? { model: msg.model as string } : {}),
    ...(msg.responseModel !== undefined ? { responseModel: msg.responseModel as string } : {}),
    ...(msg.activitySuppressed !== undefined ? { activitySuppressed: msg.activitySuppressed as number } : {}),
    ...(msg.finalTurnFinishReason !== undefined ? { finalTurnFinishReason: msg.finalTurnFinishReason as "length" } : {}),
    ...(msg.declaredDoneAtCeiling === true ? { declaredDoneAtCeiling: true as const } : {}),
    ...(ceiling !== null ? { ceiling } : {}),
    ...(msg.errorDescriptor !== undefined ? { errorDescriptor: msg.errorDescriptor as string } : {}),
  };
}

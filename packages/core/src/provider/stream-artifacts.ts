/**
 * Classifier for unparsable provider stream artifacts (slice 3.7 R1).
 *
 * Anthropic-compatible backends occasionally stream chunks whose shape is not in
 * `@ai-sdk/anthropic`'s closed `anthropicChunkSchema` union — most notably z.ai,
 * which streams a server built-in `webReader` result as a `content_block_start`
 * carrying `content_block.type: "tool_result"` (a variant that only exists in
 * user messages on the Anthropic wire, never in an assistant stream). On such a
 * chunk `createEventSourceResponseHandler` returns `{success:false, error:
 * TypeValidationError}` PER CHUNK and the provider transform enqueues
 * `{type:"error", error}` and CONTINUES the stream — the message frame and the
 * final text still arrive. Left unhandled, our `AiSdkModelPort` yields that
 * error mid-stream, `AgentLoop` sets `streamErrored=true`, and the turn dies as
 * `loop_end: error` even though `finish` was received.
 *
 * This module decides, fail-closed, which of those chunk-parse errors are safe
 * to drop (warn + `continue`) versus which stay fatal. The decision keys on the
 * deterministic shape of `TypeValidationError.value` (the raw failed chunk) —
 * `value.type` — never on the error message. `TypeValidationError.isInstance`
 * is symbol-based (robust to duplicate package copies in the dependency tree).
 */

import { TypeValidationError } from "ai";

/**
 * Top-level event types of the Anthropic streaming protocol union. A chunk-parse
 * failure on `message_start`/`message_delta`/`message_stop`/`error` is critical
 * for usage/finish and stays fatal; `ping` carries no payload. Membership here is
 * the fail-closed boundary: an UNKNOWN top-level type is treated as a
 * forward-compat event the client should ignore (Anthropic streaming spec).
 */
const KNOWN_TOP_LEVEL_EVENT_TYPES = new Set<string>([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "error",
  "ping",
]);

/**
 * Content-block-level event types. A parse failure at this level means the
 * message frame is intact but a single block (its start, a delta, or its stop)
 * was an unknown/non-standard variant (the z.ai `tool_result` case) — safe to
 * drop while the surrounding stream continues.
 */
const CONTENT_BLOCK_LEVEL_EVENT_TYPES = new Set<string>([
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** The nested block/delta discriminator of a failed chunk, or "" when absent. */
function extractSubType(value: Record<string, unknown>): string {
  const block = asRecord(value.content_block);
  if (block !== undefined && typeof block.type === "string") {
    return block.type;
  }
  const delta = asRecord(value.delta);
  if (delta !== undefined && typeof delta.type === "string") {
    return delta.type;
  }
  return "";
}

/** The failed raw chunk carried by a chunk-parse TypeValidationError, if this is one. */
function chunkValue(error: unknown): Record<string, unknown> | undefined {
  if (!TypeValidationError.isInstance(error)) {
    return undefined;
  }
  return asRecord(error.value);
}

/**
 * Stable signature of a failed chunk for warn deduplication:
 * "<top-type>/<block-or-delta-type>" (e.g. "content_block_start/tool_result").
 * Best-effort for inputs that are not chunk-parse artifacts (only ever used for
 * warn dedup, gated behind `isIgnorableStreamArtifact`).
 */
export function describeStreamArtifact(error: unknown): string {
  const value = chunkValue(error);
  if (value === undefined) {
    return error instanceof Error ? error.name : typeof error;
  }
  const top = typeof value.type === "string" ? value.type : "unknown";
  return `${top}/${extractSubType(value)}`;
}

/**
 * true ⇔ `error` is a provider chunk-parse `TypeValidationError` that is safe to
 * drop without killing the turn:

 *       delta (the z.ai `tool_result` case); the message frame is intact; OR

 *       event type the streaming spec requires clients to ignore (forward-compat).
 * false for EVERYTHING else (fail-closed): parse failures of known
 * message-level types (`message_start`/`message_delta`/`message_stop`/`error`/
 * `ping`) remain fatal (critical for usage/finish); non-`TypeValidationError`;
 * a `value` without a string `type`; `undefined`.
 */
export function isIgnorableStreamArtifact(error: unknown): boolean {
  const value = chunkValue(error);
  if (value === undefined || typeof value.type !== "string") {
    return false;
  }
  if (CONTENT_BLOCK_LEVEL_EVENT_TYPES.has(value.type)) {
    return true;
  }
  return !KNOWN_TOP_LEVEL_EVENT_TYPES.has(value.type);
}

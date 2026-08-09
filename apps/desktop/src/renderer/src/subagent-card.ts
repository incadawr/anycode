/**
 * Persisted subagent card decode + projection (TASK.102 slice S1 W4,
 * CUT-S1 §3 W4). Two pure functions, no I/O:
 *
 * - `decodeSubagentCardSnapshot` is the LAST line of defense on the read
 *   path: `loadHistory` parses persisted JSON with an unchecked `JSON.parse`
 *   (sqlite-persistence.ts), so a `presentation.subagent` blob reaching this
 *   function can be anything — a stale/foreign shape, a future writer's
 *   version, or outright garbage. It NEVER throws; any structural mismatch
 *   decodes to `null` (fail-soft), while an oversized-but-well-typed payload
 *   is normalized (sliced/ring-capped) rather than rejected, mirroring
 *   `packages/core/src/subagents/card-snapshot.ts`'s write-side reducer.
 * - `projectSubagentCard` is a straight 1:1 field mapping onto the existing
 *   renderer `SubagentSubStatus` shape (store.ts) — the same shape the LIVE
 *   subagent_* event patches already populate, so a hydrated card renders
 *   through the SAME `AgentCardBody`/`SubagentStatus`/`ActivityFeed` atoms
 *   (ToolCallCard.tsx) with no component changes.
 *
 * Types are type-only imports from `@anycode/core` (CUT-S1 §2.4): all
 * renderer PRODUCTION code imports core type-only, never as a value — value
 * imports pull the whole core module graph (node dependencies included)
 * into the browser bundle. The seven cap constants below (five `SUBAGENT_CARD_*`
 * plus the activity-entry field caps `ACTIVITY_TOOL_NAME_MAX_CHARS`/
 * `ACTIVITY_SUMMARY_MAX_CHARS`) are therefore re-declared locally rather than
 * imported; their parity with the real `@anycode/core` exports (and with the
 * renderer's own live `SUBAGENT_ACTIVITY_RING`, store.ts) is asserted by a
 * dedicated test in subagent-card.test.ts, where a value import IS allowed
 * (vitest node, never bundled).
 */
import type {
  SubagentCardActivityEntry,
  SubagentCardFinalStatus,
  SubagentCardSnapshotV1,
  SubagentCardTarget,
} from "@anycode/core";
import type { SubagentSubStatus } from "./store.js";

// Local mirrors of packages/core/src/types/config.ts's SUBAGENT_CARD_* constants
// (CUT-S1 §2.2). MUST stay numerically equal to the real exports — see the
// parity test in subagent-card.test.ts.
export const ACTIVITY_RING = 100;
export const ACTIVITY_MAX_BYTES = 32_768;
export const AGENT_TYPE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_CHARS = 500;
export const MODEL_MAX_CHARS = 200;

// Mirrors of packages/core/src/types/config.ts's SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS
// (80, re-exported from @anycode/core's curated types/index.ts barrel) and
// packages/core/src/subagents/summarize-tool.ts's SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS
// (160, re-exported from subagents/index.ts's wildcard barrel — summarize-tool.ts
// isn't a types/ file, so it doesn't ride the types/index.ts curated list like the
// five SUBAGENT_CARD_* constants above). Both are exported here (like the five
// above) so subagent-card.test.ts's parity test can assert equality against the
// real @anycode/core exports — a drifted local value now fails a test, not a
// doc comment nobody re-reads.
export const ACTIVITY_TOOL_NAME_MAX_CHARS = 80;
export const ACTIVITY_SUMMARY_MAX_CHARS = 160;

const FINAL_STATUSES: ReadonlySet<SubagentCardFinalStatus> = new Set(["completed", "max_turns", "cancelled", "error"]);
const ENGINES: ReadonlySet<string> = new Set(["codex", "claude"]);

/** Caps `text` to `maxChars` CODE POINTS (never mid-surrogate-pair), truncating without an ellipsis marker. Mirrors card-snapshot.ts's write-side helper. */
function capCodePoints(text: string, maxChars: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= maxChars ? text : codePoints.slice(0, maxChars).join("");
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeTarget(raw: unknown, toolCallId: string): SubagentCardTarget | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (raw.kind === "inline") {
    return { kind: "inline" };
  }
  if (raw.kind === "session") {
    const { childSessionId, parentSessionId, spawnToolCallId } = raw;
    if (typeof childSessionId !== "string" || childSessionId.length === 0) return null;
    if (typeof parentSessionId !== "string" || parentSessionId.length === 0) return null;
    if (typeof spawnToolCallId !== "string" || spawnToolCallId.length === 0) return null;
    if (spawnToolCallId !== toolCallId) return null;
    return { kind: "session", childSessionId, parentSessionId, spawnToolCallId };
  }
  return null;
}

function decodeIdentity(raw: unknown): SubagentCardSnapshotV1["identity"] | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.agentType !== "string") return null;
  if (typeof raw.description !== "string") return null;
  if (!(typeof raw.model === "string" || raw.model === null)) return null;
  if (!(raw.engine === null || (typeof raw.engine === "string" && ENGINES.has(raw.engine)))) return null;
  return {
    agentType: capCodePoints(raw.agentType, AGENT_TYPE_MAX_CHARS),
    description: capCodePoints(raw.description, DESCRIPTION_MAX_CHARS),
    model: raw.model === null ? null : capCodePoints(raw.model, MODEL_MAX_CHARS),
    engine: raw.engine as "codex" | "claude" | null,
  };
}

function decodeCounters(raw: unknown): SubagentCardSnapshotV1["counters"] | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (!isNonNegativeSafeInteger(raw.turns)) return null;
  if (!isNonNegativeSafeInteger(raw.toolCalls)) return null;
  if (!(typeof raw.lastTool === "string" || raw.lastTool === null)) return null;
  return { turns: raw.turns, toolCalls: raw.toolCalls, lastTool: raw.lastTool };
}

/**
 * Normalizes the activity ring/byte caps exactly like
 * `reduceSubagentCardEvent` (packages/core/src/subagents/card-snapshot.ts):
 * evicts the OLDEST surviving entry until both caps are satisfied, so the
 * tail (most recent activity) always survives regardless of which cap binds.
 * Unlike the write-side reducer this is a defensive hardening path (S1's own
 * writer never exceeds these caps), so a payload that DOES exceed them here
 * only happens via corruption/tampering — still honestly counted into
 * `dropped` rather than silently shortened.
 */
function decodeActivity(raw: unknown): SubagentCardSnapshotV1["activity"] | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (!Array.isArray(raw.entries)) return null;
  if (!isNonNegativeSafeInteger(raw.dropped)) return null;

  const normalized: SubagentCardActivityEntry[] = [];
  for (const entry of raw.entries) {
    if (!isPlainObject(entry)) return null;
    if (typeof entry.toolName !== "string" || typeof entry.summary !== "string") return null;
    normalized.push({
      toolName: capCodePoints(entry.toolName, ACTIVITY_TOOL_NAME_MAX_CHARS),
      summary: capCodePoints(entry.summary, ACTIVITY_SUMMARY_MAX_CHARS),
    });
  }

  // Single backward pass instead of a per-eviction `entries.slice(1)` (review
  // finding: the old loop re-copied the shrinking array on every evicted
  // entry, ~O(n²) total on a large/corrupted payload). Bytes are
  // non-negative, so both `survivingCount` and `bytesAccum` grow
  // monotonically as the scan walks from the tail (most recent) toward the
  // front (oldest): once including one more (older) entry would violate
  // either cap, every still-older entry would violate it too, so the scan
  // can stop at the first violation and take exactly one `slice` of the
  // surviving suffix — same oldest-evicted/tail-survives/arrival-order
  // result as the old per-entry loop, computed in one linear pass.
  const n = normalized.length;
  let survivingCount = 0;
  let bytesAccum = 0;
  let startIndex = n;
  for (let i = n - 1; i >= 0; i--) {
    const entry = normalized[i];
    if (entry === undefined) break;
    const entryBytes = utf8ByteLength(entry.toolName) + utf8ByteLength(entry.summary);
    if (survivingCount + 1 > ACTIVITY_RING || bytesAccum + entryBytes > ACTIVITY_MAX_BYTES) {
      break;
    }
    bytesAccum += entryBytes;
    survivingCount += 1;
    startIndex = i;
  }
  const entries = startIndex === 0 ? normalized : normalized.slice(startIndex);
  const extraDropped = n - survivingCount;

  return { entries, dropped: raw.dropped + extraDropped };
}

function decodeFinal(raw: unknown): SubagentCardSnapshotV1["final"] | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.status !== "string" || !FINAL_STATUSES.has(raw.status as SubagentCardFinalStatus)) return null;
  if (typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs) || raw.durationMs < 0) return null;
  return { status: raw.status as SubagentCardFinalStatus, durationMs: raw.durationMs };
}

/**
 * Decodes an untrusted `presentation.subagent` blob into a validated
 * `SubagentCardSnapshotV1`, or `null` on ANY structural mismatch (fail-soft
 * — see module doc comment). `ctx.toolName` gates on the Agent tool
 * specifically (a subagent presentation planted on a foreign tool's result
 * is ignored); `ctx.toolCallId` is the correlation id a `session`-kind
 * target's `spawnToolCallId` must match (S2 contract, CUT-S1 §2.1 — S1
 * itself never writes a `session` target, but decode validates it anyway).
 */
export function decodeSubagentCardSnapshot(
  value: unknown,
  ctx: { toolCallId: string; toolName: string },
): SubagentCardSnapshotV1 | null {
  try {
    if (ctx.toolName !== "Agent") return null;
    if (!isPlainObject(value)) return null;
    if (value.kind !== "subagent") return null;
    if (value.version !== 1) return null;
    if (value.attention !== undefined && value.attention !== "waiting_permission") return null;

    const target = decodeTarget(value.target, ctx.toolCallId);
    if (target === null) return null;
    const identity = decodeIdentity(value.identity);
    if (identity === null) return null;
    const counters = decodeCounters(value.counters);
    if (counters === null) return null;
    const activity = decodeActivity(value.activity);
    if (activity === null) return null;
    // REQUIRED (CUT-S1 §0.4): a persisted snapshot without a terminal status
    // is a contradiction — `finalizeSubagentCard` (core) never writes one.
    const final = decodeFinal(value.final);
    if (final === null) return null;

    return {
      kind: "subagent",
      version: 1,
      target,
      identity,
      counters,
      activity,
      final,
      ...(value.attention === "waiting_permission" ? { attention: value.attention } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Straight 1:1 field mapping onto `SubagentSubStatus` (store.ts) — `attention`
 * is S2-reserved and never projected (CUT-S1 §0.3 vердикт 3, §3 W4).
 * `sessionChild` (TASK.102 CUT-S2 §10.8.1 vердикт 1) is the one exception:
 * presence-encoded, set ONLY when `snapshot.target.kind === "session"`. This
 * is a DISCRIMINANT, not the target itself — the three ids on a `"session"`
 * target (childSessionId/parentSessionId/spawnToolCallId) deliberately never
 * cross into the projection (§10.8.1 point 2): `spawnToolCallId` is already
 * redundant with `block.toolCallId` (decodeTarget rejected any mismatch),
 * and `parentSessionId`/`childSessionId` are unvalidated payload claims a
 * future reader could wrongly prefer over the checked ambient
 * `tab.sessionId` — exactly the plaiting CUT-S2 §2.3's header forbids.
 */
export function projectSubagentCard(snapshot: SubagentCardSnapshotV1): SubagentSubStatus {
  return {
    agentType: snapshot.identity.agentType,
    description: snapshot.identity.description,
    model: snapshot.identity.model,
    engine: snapshot.identity.engine,
    turns: snapshot.counters.turns,
    toolCalls: snapshot.counters.toolCalls,
    lastTool: snapshot.counters.lastTool,
    activity: snapshot.activity.entries,
    activityDropped: snapshot.activity.dropped,
    final: snapshot.final,
    ...(snapshot.target.kind === "session" ? { sessionChild: true } : {}),
  };
}

/**
 * Pure reducer for the persisted subagent card snapshot (TASK.102 slice S1
 * W1, CUT-S1 §3 W1). Three immutable, I/O-free functions turn the coarse
 * subagent_* AgentEvent stream (already bridged by tools/agent.ts) into the
 * `SubagentCardSnapshotV1` that rides the paired tool_result's `presentation`
 * field. One accumulator per Agent tool call — correlation across toolCallId
 * happens at the call site (tools/agent.ts), not here.
 */

import type {
  SubagentCardActivityEntry,
  SubagentCardFinalStatus,
  SubagentCardSnapshotV1,
  SubagentCardTarget,
} from "../types/subagent-card.js";
import type { ToolEmittedEvent } from "../types/tools.js";
import {
  SUBAGENT_CARD_ACTIVITY_MAX_BYTES,
  SUBAGENT_CARD_ACTIVITY_RING,
  SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS,
  SUBAGENT_CARD_DESCRIPTION_MAX_CHARS,
  SUBAGENT_CARD_MODEL_MAX_CHARS,
} from "../types/config.js";

export type SubagentCardEvent = Extract<ToolEmittedEvent, { type: `subagent_${string}` }>;

/** Internal accumulator. `end` is nullable while running; the persisted V1 shape's `final` is never nullable. */
export interface SubagentCardAccumulator {
  started: boolean;
  identity: SubagentCardSnapshotV1["identity"] | null;
  counters: { turns: number; toolCalls: number; lastTool: string | null };
  /** Oldest-first, already ring/byte-capped. */
  entries: SubagentCardActivityEntry[];
  /** UTF-8 byte sum of toolName+summary across `entries` (running total, avoids re-scanning on every append). */
  entryBytes: number;
  /** Ring-cap evictions + byte-cap evictions (activitySuppressed is added only at finalize). */
  dropped: number;
  end: {
    status: SubagentCardFinalStatus;
    turns: number;
    durationMs: number;
    activitySuppressed?: number;
    /** Provider-reported model id, capped at SUBAGENT_CARD_MODEL_MAX_CHARS. The provider's CLAIM, not proof of serving. */
    responseModel?: string;
  } | null;
}

export function createSubagentCardAccumulator(): SubagentCardAccumulator {
  return {
    started: false,
    identity: null,
    counters: { turns: 0, toolCalls: 0, lastTool: null },
    entries: [],
    entryBytes: 0,
    dropped: 0,
    end: null,
  };
}

/** Caps `text` to `maxChars` CODE POINTS (never mid-surrogate-pair), truncating without an ellipsis marker. */
function capCodePoints(text: string, maxChars: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) {
    return text;
  }
  return codePoints.slice(0, maxChars).join("");
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function entryByteLength(entry: SubagentCardActivityEntry): number {
  return utf8ByteLength(entry.toolName) + utf8ByteLength(entry.summary);
}

/**
 * Feeds one subagent_* event into the accumulator. Pure — returns a new
 * accumulator, never mutates `acc`. `subagent_progress`/`subagent_activity`
 * before `subagent_start` are no-ops (the child never actually started); the
 * first `subagent_start`/`subagent_end` wins on a duplicate (replay-safe: a
 * dubious re-delivery of a start/end can never reset or clobber the record).
 */
export function reduceSubagentCardEvent(
  acc: SubagentCardAccumulator,
  ev: SubagentCardEvent,
): SubagentCardAccumulator {
  switch (ev.type) {
    case "subagent_start": {
      if (acc.started) {
        return acc;
      }
      return {
        ...acc,
        started: true,
        identity: {
          agentType: capCodePoints(ev.agentType, SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS),
          description: capCodePoints(ev.description, SUBAGENT_CARD_DESCRIPTION_MAX_CHARS),
          model: ev.model !== undefined ? capCodePoints(ev.model, SUBAGENT_CARD_MODEL_MAX_CHARS) : null,
          engine: ev.engine ?? null,
        },
      };
    }
    case "subagent_progress": {
      if (!acc.started) {
        return acc;
      }
      return {
        ...acc,
        counters: { turns: ev.turns, toolCalls: ev.toolCalls, lastTool: ev.lastTool ?? null },
      };
    }
    case "subagent_activity": {
      if (!acc.started) {
        return acc;
      }
      const entries = [...acc.entries, { toolName: ev.toolName, summary: ev.summary }];
      let entryBytes = acc.entryBytes + utf8ByteLength(ev.toolName) + utf8ByteLength(ev.summary);
      let dropped = acc.dropped;
      // Ring cap and byte cap are enforced together: whichever bites first
      // evicts the oldest surviving entry, so the tail (most recent activity)
      // always survives regardless of which limit is the binding one.
      while (entries.length > SUBAGENT_CARD_ACTIVITY_RING || entryBytes > SUBAGENT_CARD_ACTIVITY_MAX_BYTES) {
        const removed = entries.shift();
        if (removed === undefined) {
          break;
        }
        entryBytes -= entryByteLength(removed);
        dropped += 1;
      }
      return { ...acc, entries, entryBytes, dropped };
    }
    case "subagent_end": {
      if (!acc.started || acc.end !== null) {
        return acc;
      }
      return {
        ...acc,
        end: {
          status: ev.status,
          turns: ev.turns,
          durationMs: ev.durationMs,
          ...(ev.activitySuppressed !== undefined ? { activitySuppressed: ev.activitySuppressed } : {}),
          ...(ev.responseModel !== undefined
            ? { responseModel: capCodePoints(ev.responseModel, SUBAGENT_CARD_MODEL_MAX_CHARS) }
            : {}),
        },
      };
    }
    case "subagent_attention": {
      // No-op for the PERSISTED snapshot: attention is transient live-only
      // state (a permission-broker wait on a session-tier child), not part of
      // the terminal record (TASK.102 CUT-S2 §2.2/§0.8, CUT-S1 §2.1).
      return acc;
    }
    case "subagent_stalled": {
      // No-op for the PERSISTED snapshot (TASK.148 slice 1): a stall report is
      // transient live-only state, exactly like subagent_attention above — a
      // finished card's terminal record never carries "was silent for a
      // while, then kept going" as part of the result.
      return acc;
    }
    default: {
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}

/**
 * Produces the persisted V1 snapshot, or null when the child never actually
 * started (an early failure before the first progress callback — CUT-S1 §3
 * W1: "the card is not fabricated"). `fallback` supplies status/durationMs
 * when no `subagent_end` was ever seen (the caller settled from its own known
 * outcome, e.g. a throw in the runner that skipped the end-progress callback).
 *
 * `target` (TASK.102 CUT-S2 §2.1, ADDITIVE third parameter): optional,
 * defaults to `{kind:"inline"}` — every S1 call site (inline tier) omits it
 * and keeps producing exactly what it always did. The session tier
 * (tools/agent.ts, S2b) passes the three ids the host's accepted-relay +
 * its own sessionId already established; this function only copies them,
 * never invents any.
 */
export function finalizeSubagentCard(
  acc: SubagentCardAccumulator,
  fallback: { status: SubagentCardFinalStatus; durationMs: number },
  target?: SubagentCardTarget,
): SubagentCardSnapshotV1 | null {
  if (!acc.started || acc.identity === null) {
    return null;
  }
  const final =
    acc.end !== null
      ? {
          status: acc.end.status,
          durationMs: acc.end.durationMs,
          ...(acc.end.responseModel !== undefined ? { responseModel: acc.end.responseModel } : {}),
        }
      : fallback;
  return {
    kind: "subagent",
    version: 1,
    target: target ?? { kind: "inline" },
    identity: acc.identity,
    counters: {
      turns: acc.end?.turns ?? acc.counters.turns,
      toolCalls: acc.counters.toolCalls,
      lastTool: acc.counters.lastTool,
    },
    activity: {
      entries: acc.entries,
      dropped: acc.dropped + (acc.end?.activitySuppressed ?? 0),
    },
    final,
  };
}

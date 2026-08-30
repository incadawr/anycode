/**
 * Pure reducer for the persisted workflow card snapshot (TASK.191 slice S5).
 * Mirror of subagents/card-snapshot.ts: three immutable, I/O-free functions
 * turn the coarse workflow_* AgentEvent stream (already bridged by
 * tools/workflow.ts's own mapProgressToEvent) into the `WorkflowCardSnapshotV1`
 * that rides the paired tool_result's `presentation` field. One accumulator
 * per Workflow tool call.
 */

import type {
  WorkflowCardActivityEntry,
  WorkflowCardRunStatus,
  WorkflowCardSnapshotV1,
  WorkflowCardStep,
  WorkflowCardStepResult,
} from "../types/workflow-card.js";
import type { ToolEmittedEvent } from "../types/tools.js";
import { WORKFLOW_CARD_ACTIVITY_MAX_BYTES, WORKFLOW_CARD_ACTIVITY_RING } from "../types/config.js";

export type WorkflowCardEvent = Extract<ToolEmittedEvent, { type: `workflow_${string}` }>;

/** Internal accumulator. `end` is nullable while running; the persisted V1 shape's `final` is never nullable. */
export interface WorkflowCardAccumulator {
  started: boolean;
  identity: { workflow: string; totalSteps: number } | null;
  /** Definition-order step graph (id/agentType/dependsOn), copied verbatim off workflow_start's own `steps` — never re-derived, never re-ordered. */
  graph: readonly Omit<WorkflowCardStep, "result">[] | null;
  /** stepId -> terminal result, filled by workflow_step_end (first end per id wins — replay-safe). */
  results: Map<string, WorkflowCardStepResult>;
  /** Oldest-first, already ring/byte-capped. ONE lane shared by every concurrent step. */
  entries: WorkflowCardActivityEntry[];
  /** UTF-8 byte sum of toolName+summary across `entries` (running total, avoids re-scanning on every append). */
  entryBytes: number;
  /** Ring-cap evictions + byte-cap evictions. */
  dropped: number;
  end: { status: WorkflowCardRunStatus; durationMs: number } | null;
}

export function createWorkflowCardAccumulator(): WorkflowCardAccumulator {
  return {
    started: false,
    identity: null,
    graph: null,
    results: new Map(),
    entries: [],
    entryBytes: 0,
    dropped: 0,
    end: null,
  };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function entryByteLength(entry: WorkflowCardActivityEntry): number {
  return utf8ByteLength(entry.toolName) + utf8ByteLength(entry.summary);
}

/**
 * Feeds one workflow_* event into the accumulator. Pure — returns a new
 * accumulator, never mutates `acc`. Events before `workflow_start` are
 * no-ops (the run never actually started); the first `workflow_start`/
 * `workflow_end` wins on a duplicate, and the first `workflow_step_end` per
 * stepId wins on a duplicate (replay-safe: a dubious re-delivery can never
 * reset or clobber the record).
 */
export function reduceWorkflowCardEvent(
  acc: WorkflowCardAccumulator,
  ev: WorkflowCardEvent,
): WorkflowCardAccumulator {
  switch (ev.type) {
    case "workflow_start": {
      if (acc.started) {
        return acc;
      }
      return {
        ...acc,
        started: true,
        identity: { workflow: ev.workflow, totalSteps: ev.totalSteps },
        graph: ev.steps.map((step) => ({
          id: step.id,
          agentType: step.agentType,
          ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
        })),
      };
    }
    case "workflow_step_start": {
      // No-op for the PERSISTED snapshot: "ready, deps satisfied" is transient
      // live-only state (the workflow mirror of subagent_attention in
      // subagents/card-snapshot.ts) — the step's identity already arrived on
      // workflow_start's graph, and its terminal record lands on
      // workflow_step_end below.
      return acc;
    }
    case "workflow_step_running": {
      // No-op for the same reason: "queued -> running" (the step's actual,
      // post-semaphore start — TASK.191 slice S3) is a live-view transition,
      // not part of a settled run's record.
      return acc;
    }
    case "workflow_step_progress": {
      // No-op: every field this carries (turns/toolCalls/lastTool/usage) is
      // an IN-FLIGHT number superseded by workflow_step_end's own turns/
      // durationMs/usage once the step settles. Unlike subagent_progress —
      // the ONLY source for the persisted card's toolCalls/lastTool, because
      // subagent_end never repeats them — workflow_step_end already carries
      // everything a persisted per-step result needs (status/turns/
      // durationMs/usage), so there is nothing here worth keeping.
      return acc;
    }
    case "workflow_step_activity": {
      if (!acc.started) {
        return acc;
      }
      const entries = [...acc.entries, { stepId: ev.stepId, toolName: ev.toolName, summary: ev.summary }];
      let entryBytes = acc.entryBytes + utf8ByteLength(ev.toolName) + utf8ByteLength(ev.summary);
      let dropped = acc.dropped;
      // Ring cap and byte cap are enforced together: whichever bites first
      // evicts the oldest surviving entry, so the tail (most recent activity,
      // from whichever step produced it) always survives regardless of which
      // limit is the binding one. This lane is shared across every concurrent
      // step of the run — an eviction here is a RUN-level fact, not a
      // per-step one, which is exactly why `dropped` lives on the run-level
      // `activity` object and not inside any one step's result.
      while (entries.length > WORKFLOW_CARD_ACTIVITY_RING || entryBytes > WORKFLOW_CARD_ACTIVITY_MAX_BYTES) {
        const removed = entries.shift();
        if (removed === undefined) {
          break;
        }
        entryBytes -= entryByteLength(removed);
        dropped += 1;
      }
      return { ...acc, entries, entryBytes, dropped };
    }
    case "workflow_step_end": {
      if (!acc.started || acc.results.has(ev.stepId)) {
        return acc;
      }
      const results = new Map(acc.results);
      results.set(ev.stepId, {
        status: ev.status,
        turns: ev.turns,
        durationMs: ev.durationMs,
        ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
      });
      return { ...acc, results };
    }
    case "workflow_end": {
      if (!acc.started || acc.end !== null) {
        return acc;
      }
      return { ...acc, end: { status: ev.status, durationMs: ev.durationMs } };
    }
    default: {
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}

/**
 * Produces the persisted V1 snapshot, or null when the run never actually
 * started (an unknown workflow name / pre-aborted signal / unknown agentType
 * all fail BEFORE the engine's first onProgress call — workflow/engine.ts's
 * own early-return paths — so the card is never fabricated from nothing,
 * mirroring subagents/card-snapshot.ts's finalizeSubagentCard). `fallback`
 * supplies status/durationMs when no `workflow_end` was ever seen (the
 * caller settled from its own known outcome).
 */
export function finalizeWorkflowCard(
  acc: WorkflowCardAccumulator,
  fallback: { status: WorkflowCardRunStatus; durationMs: number },
): WorkflowCardSnapshotV1 | null {
  if (!acc.started || acc.identity === null || acc.graph === null) {
    return null;
  }
  return {
    kind: "workflow",
    version: 1,
    workflow: acc.identity.workflow,
    totalSteps: acc.identity.totalSteps,
    steps: acc.graph.map((node) => {
      const result = acc.results.get(node.id);
      return result !== undefined ? { ...node, result } : { ...node };
    }),
    activity: {
      entries: acc.entries,
      dropped: acc.dropped,
    },
    final: acc.end ?? fallback,
  };
}

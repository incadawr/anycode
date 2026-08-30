/**
 * Pure reducer tests for the persisted workflow card snapshot (TASK.191 slice
 * S5). Hermetic: feeds WorkflowCardEvent values directly into the three pure
 * functions, no ports/tools involved. Mirror of subagents/card-snapshot.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  createWorkflowCardAccumulator,
  finalizeWorkflowCard,
  reduceWorkflowCardEvent,
  type WorkflowCardEvent,
} from "./card-snapshot.js";
import { WORKFLOW_CARD_ACTIVITY_MAX_BYTES, WORKFLOW_CARD_ACTIVITY_RING } from "../types/config.js";

function start(overrides: Partial<Extract<WorkflowCardEvent, { type: "workflow_start" }>> = {}): WorkflowCardEvent {
  return {
    type: "workflow_start",
    toolCallId: "call-1",
    workflow: "build",
    totalSteps: 2,
    steps: [
      { id: "a", agentType: "general-purpose" },
      { id: "b", agentType: "explore", dependsOn: ["a"] },
    ],
    ...overrides,
  };
}

function stepStart(stepId: string, agentType = "general-purpose"): WorkflowCardEvent {
  return { type: "workflow_step_start", toolCallId: "call-1", stepId, agentType };
}

function stepRunning(stepId: string): WorkflowCardEvent {
  return { type: "workflow_step_running", toolCallId: "call-1", stepId };
}

function stepProgress(
  overrides: Partial<Extract<WorkflowCardEvent, { type: "workflow_step_progress" }>> = {},
): WorkflowCardEvent {
  return { type: "workflow_step_progress", toolCallId: "call-1", stepId: "a", turns: 1, toolCalls: 1, ...overrides };
}

function activity(stepId: string, toolName: string, summary: string): WorkflowCardEvent {
  return { type: "workflow_step_activity", toolCallId: "call-1", stepId, toolName, summary };
}

function stepEnd(overrides: Partial<Extract<WorkflowCardEvent, { type: "workflow_step_end" }>> = {}): WorkflowCardEvent {
  return { type: "workflow_step_end", toolCallId: "call-1", stepId: "a", status: "completed", turns: 2, durationMs: 100, ...overrides };
}

function end(overrides: Partial<Extract<WorkflowCardEvent, { type: "workflow_end" }>> = {}): WorkflowCardEvent {
  return {
    type: "workflow_end",
    toolCallId: "call-1",
    status: "completed",
    completedSteps: 2,
    totalSteps: 2,
    durationMs: 500,
    ...overrides,
  };
}

describe("reduceWorkflowCardEvent — workflow_start", () => {
  it("creates identity and the full step graph, dependsOn included (TASK.191 S5 pin: dependsOn survives into the snapshot)", () => {
    const acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    expect(acc.started).toBe(true);
    expect(acc.identity).toEqual({ workflow: "build", totalSteps: 2 });
    expect(acc.graph).toEqual([
      { id: "a", agentType: "general-purpose" },
      { id: "b", agentType: "explore", dependsOn: ["a"] },
    ]);
    expect(acc.results.size).toBe(0);
    expect(acc.entries).toEqual([]);
    expect(acc.dropped).toBe(0);
  });

  it("a source step (no dependsOn on the wire) carries no dependsOn key in the graph (no silent [] default)", () => {
    const acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    const nodeA = acc.graph?.find((n) => n.id === "a");
    expect(nodeA && "dependsOn" in nodeA).toBe(false);
  });

  it("a duplicate start is a no-op — the first start wins", () => {
    const first = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start({ workflow: "build" }));
    const second = reduceWorkflowCardEvent(
      first,
      start({ workflow: "other", totalSteps: 9, steps: [{ id: "z", agentType: "explore" }] }),
    );
    expect(second.identity?.workflow).toBe("build");
    expect(second).toEqual(first);
  });
});

describe("reduceWorkflowCardEvent — workflow_step_start / workflow_step_running / workflow_step_progress", () => {
  it("are no-ops for the persisted snapshot: live-only transient state, terminal record lands on workflow_step_end", () => {
    let withLive = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    withLive = reduceWorkflowCardEvent(withLive, stepStart("a"));
    withLive = reduceWorkflowCardEvent(withLive, stepRunning("a"));
    withLive = reduceWorkflowCardEvent(
      withLive,
      stepProgress({ stepId: "a", turns: 5, toolCalls: 9, lastTool: "Bash", usage: { totalTokens: 999 } }),
    );
    withLive = reduceWorkflowCardEvent(withLive, stepEnd({ stepId: "a" }));
    withLive = reduceWorkflowCardEvent(withLive, end());

    let withoutLive = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    withoutLive = reduceWorkflowCardEvent(withoutLive, stepEnd({ stepId: "a" }));
    withoutLive = reduceWorkflowCardEvent(withoutLive, end());

    // Byte-for-byte snapshot equality is the discriminating assert — it would
    // catch a reducer that merely avoided throwing but still let interim
    // turns/toolCalls/usage leak into the persisted result.
    const fallback = { status: "failed" as const, durationMs: 1 };
    expect(finalizeWorkflowCard(withLive, fallback)).toEqual(finalizeWorkflowCard(withoutLive, fallback));
  });

  it("each individually leaves the accumulator unchanged before start", () => {
    const beforeStart = createWorkflowCardAccumulator();
    expect(reduceWorkflowCardEvent(beforeStart, stepStart("a"))).toEqual(beforeStart);
    expect(reduceWorkflowCardEvent(beforeStart, stepRunning("a"))).toEqual(beforeStart);
    expect(reduceWorkflowCardEvent(beforeStart, stepProgress())).toEqual(beforeStart);
  });
});

describe("reduceWorkflowCardEvent — workflow_step_activity", () => {
  it("appends in arrival order, stamped with stepId", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, activity("a", "Bash", "one"));
    acc = reduceWorkflowCardEvent(acc, activity("b", "Read", "two"));
    expect(acc.entries).toEqual([
      { stepId: "a", toolName: "Bash", summary: "one" },
      { stepId: "b", toolName: "Read", summary: "two" },
    ]);
  });

  it("activity before start is a no-op", () => {
    const acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), activity("a", "Bash", "x"));
    expect(acc.started).toBe(false);
    expect(acc.entries).toEqual([]);
  });

  it("ring cap: keeps the last WORKFLOW_CARD_ACTIVITY_RING entries across the WHOLE RUN, tail survives, dropped counts the eviction (TASK.191 S5 pin: ring eviction)", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    const total = WORKFLOW_CARD_ACTIVITY_RING + 11;
    for (let i = 0; i < total; i += 1) {
      // Interleave two steps' lanes to prove the ring is shared, not per-step.
      acc = reduceWorkflowCardEvent(acc, activity(i % 2 === 0 ? "a" : "b", "Bash", `entry-${i}`));
    }
    expect(acc.entries).toHaveLength(WORKFLOW_CARD_ACTIVITY_RING);
    expect(acc.entries[0]!.summary).toBe("entry-11");
    expect(acc.entries[acc.entries.length - 1]!.summary).toBe(`entry-${total - 1}`);
    expect(acc.dropped).toBe(11);
  });

  it("byte cap: 4-byte code points evict oldest entries before the ring cap engages, tail survives", () => {
    const emoji = "\u{1F600}".repeat(240); // 960 UTF-8 bytes/entry
    expect(new TextEncoder().encode(emoji).length).toBe(960);

    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    const total = 80; // 80*960 = 76800 > 65536 (WORKFLOW_CARD_ACTIVITY_MAX_BYTES), well under the 200-entry ring
    for (let i = 0; i < total; i += 1) {
      acc = reduceWorkflowCardEvent(acc, activity("a", "", `${emoji}${i}`));
    }
    const totalBytes = acc.entries.reduce(
      (sum, e) => sum + new TextEncoder().encode(e.toolName).length + new TextEncoder().encode(e.summary).length,
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(WORKFLOW_CARD_ACTIVITY_MAX_BYTES);
    expect(acc.entries.length).toBeLessThan(WORKFLOW_CARD_ACTIVITY_RING);
    expect(acc.entries[acc.entries.length - 1]!.summary).toBe(`${emoji}${total - 1}`);
    expect(acc.dropped).toBeGreaterThan(0);
    expect(acc.dropped).toBe(total - acc.entries.length);
  });
});

describe("reduceWorkflowCardEvent — workflow_step_end", () => {
  it("records status/turns/durationMs into results, keyed by stepId", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, stepEnd({ stepId: "a", status: "completed", turns: 3, durationMs: 250 }));
    expect(acc.results.get("a")).toEqual({ status: "completed", turns: 3, durationMs: 250 });
  });

  it("copies usage through untouched when present (TASK.191 S5 pin: per-step spend)", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(
      acc,
      stepEnd({ stepId: "a", status: "completed", turns: 1, durationMs: 50, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    );
    expect(acc.results.get("a")?.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("usage absent on the event => absent on the result (no silent zero)", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, stepEnd({ stepId: "a" }));
    const result = acc.results.get("a");
    expect(result && "usage" in result).toBe(false);
  });

  it("records a 'skipped' step end (never-launched step, TASK.191 S3's synthetic end)", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, stepEnd({ stepId: "b", status: "skipped", turns: 0, durationMs: 0 }));
    expect(acc.results.get("b")).toEqual({ status: "skipped", turns: 0, durationMs: 0 });
  });

  it("end before start is a no-op", () => {
    const acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), stepEnd());
    expect(acc.started).toBe(false);
    expect(acc.results.size).toBe(0);
  });

  it("a duplicate step_end for the same stepId is a no-op — the first one wins", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, stepEnd({ stepId: "a", status: "completed", turns: 2, durationMs: 100 }));
    acc = reduceWorkflowCardEvent(acc, stepEnd({ stepId: "a", status: "error", turns: 99, durationMs: 999 }));
    expect(acc.results.get("a")).toEqual({ status: "completed", turns: 2, durationMs: 100 });
  });
});

describe("reduceWorkflowCardEvent — workflow_end", () => {
  it("fixes status/durationMs", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, end({ status: "failed", durationMs: 4321 }));
    expect(acc.end).toEqual({ status: "failed", durationMs: 4321 });
  });

  it("end before start is a no-op", () => {
    const acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), end());
    expect(acc.started).toBe(false);
    expect(acc.end).toBeNull();
  });

  it("a duplicate end is a no-op — the first end wins", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, end({ status: "completed", durationMs: 100 }));
    acc = reduceWorkflowCardEvent(acc, end({ status: "failed", durationMs: 999 }));
    expect(acc.end).toEqual({ status: "completed", durationMs: 100 });
  });
});

describe("finalizeWorkflowCard", () => {
  const fallback = { status: "failed" as const, durationMs: 42 };

  it("returns null when the run never started (TASK.191 S5 pin: the card is never fabricated)", () => {
    const snapshot = finalizeWorkflowCard(createWorkflowCardAccumulator(), fallback);
    expect(snapshot).toBeNull();
  });

  it("without a workflow_end, uses the fallback status/durationMs", () => {
    const acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    const snapshot = finalizeWorkflowCard(acc, fallback);
    expect(snapshot?.final).toEqual({ status: "failed", durationMs: 42 });
  });

  it("with a workflow_end, uses its status/durationMs (not the fallback)", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, end({ status: "completed", durationMs: 777 }));
    const snapshot = finalizeWorkflowCard(acc, fallback);
    expect(snapshot?.final).toEqual({ status: "completed", durationMs: 777 });
  });

  it("a graph step with no result yet is present with no `result` key (not fabricated)", () => {
    const acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    const snapshot = finalizeWorkflowCard(acc, fallback);
    expect(snapshot?.steps).toEqual([
      { id: "a", agentType: "general-purpose" },
      { id: "b", agentType: "explore", dependsOn: ["a"] },
    ]);
    expect(snapshot?.steps.every((s) => !("result" in s))).toBe(true);
  });

  it("produces the full V1 shape: dependsOn on the graph, a skipped step's result, dropped, activity, final (TASK.191 S5 pins: dependsOn + skipped + dropped + usage)", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    acc = reduceWorkflowCardEvent(acc, activity("a", "Read", "file.ts"));
    acc = reduceWorkflowCardEvent(
      acc,
      stepEnd({ stepId: "a", status: "completed", turns: 2, durationMs: 500, usage: { totalTokens: 40 } }),
    );
    // "b" depends on "a"; here it never actually launched (engine fail-fast) —
    // TASK.191 slice S3's synthetic skipped end.
    acc = reduceWorkflowCardEvent(acc, stepEnd({ stepId: "b", status: "skipped", turns: 0, durationMs: 0 }));
    acc = reduceWorkflowCardEvent(acc, end({ status: "failed", completedSteps: 1, totalSteps: 2, durationMs: 600 }));

    const snapshot = finalizeWorkflowCard(acc, fallback);
    expect(snapshot).toEqual({
      kind: "workflow",
      version: 1,
      workflow: "build",
      totalSteps: 2,
      steps: [
        {
          id: "a",
          agentType: "general-purpose",
          result: { status: "completed", turns: 2, durationMs: 500, usage: { totalTokens: 40 } },
        },
        {
          id: "b",
          agentType: "explore",
          dependsOn: ["a"],
          result: { status: "skipped", turns: 0, durationMs: 0 },
        },
      ],
      activity: { entries: [{ stepId: "a", toolName: "Read", summary: "file.ts" }], dropped: 0 },
      final: { status: "failed", durationMs: 600 },
    });
  });

  it("dropped in the finalized snapshot reflects ring evictions across the whole run", () => {
    let acc = reduceWorkflowCardEvent(createWorkflowCardAccumulator(), start());
    const total = WORKFLOW_CARD_ACTIVITY_RING + 6;
    for (let i = 0; i < total; i += 1) {
      acc = reduceWorkflowCardEvent(acc, activity("a", "Bash", `e${i}`));
    }
    const snapshot = finalizeWorkflowCard(acc, fallback);
    expect(snapshot?.activity.dropped).toBe(6);
    expect(snapshot?.activity.entries).toHaveLength(WORKFLOW_CARD_ACTIVITY_RING);
  });
});

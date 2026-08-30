/**
 * Tests for the S5 persisted workflow-card decode/project pair (TASK.191
 * slice S5). `decodeWorkflowCardSnapshot` is the LAST line of defense before
 * a persisted `presentation.workflow` blob (parsed by `loadHistory` with an
 * unchecked `JSON.parse`, sqlite-persistence.ts) reaches the store — it must
 * never throw, and any structurally-wrong payload must decode to `null`
 * rather than propagate garbage into the transcript. Mirror of
 * subagent-card.test.ts's own structure and discipline.
 *
 * The parity-test block at the bottom value-imports the REAL `@anycode/core`
 * constants — allowed in a test file (vitest node, never bundled) even though
 * renderer PRODUCTION code may only type-import core. Every local cap is
 * pinned against its live counterpart, so a change to the real constant fails
 * this file rather than passing silently: a hand-copied literal would agree
 * with itself forever and detect exactly nothing, which is the failure mode
 * this block exists to prevent.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowCardSnapshotV1 } from "@anycode/core";
import {
  SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS,
  SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS,
  WORKFLOW_CARD_ACTIVITY_MAX_BYTES as CORE_WORKFLOW_CARD_ACTIVITY_MAX_BYTES,
  WORKFLOW_CARD_ACTIVITY_RING as CORE_WORKFLOW_CARD_ACTIVITY_RING,
} from "@anycode/core";
import {
  ACTIVITY_STEP_ID_MAX_CHARS,
  ACTIVITY_SUMMARY_MAX_CHARS,
  ACTIVITY_TOOL_NAME_MAX_CHARS,
  WORKFLOW_CARD_ACTIVITY_MAX_BYTES,
  WORKFLOW_CARD_ACTIVITY_RING,
  decodeWorkflowCardSnapshot,
  projectWorkflowCard,
} from "./workflow-card.js";
import { WORKFLOW_ACTIVITY_RING } from "./store.js";

const CTX = { toolCallId: "call-1", toolName: "Workflow" };

const VALID_SNAPSHOT: WorkflowCardSnapshotV1 = {
  kind: "workflow",
  version: 1,
  workflow: "explore-and-fix",
  totalSteps: 3,
  steps: [
    {
      id: "survey",
      agentType: "explore",
      result: { status: "completed", turns: 4, durationMs: 12_000, usage: { inputTokens: 500, outputTokens: 200 } },
    },
    {
      id: "fix",
      agentType: "coder",
      dependsOn: ["survey"],
      result: { status: "error", turns: 2, durationMs: 5_000 },
    },
    {
      id: "verify",
      agentType: "reviewer",
      dependsOn: ["fix"],
      result: { status: "skipped", turns: 0, durationMs: 0 },
    },
  ],
  activity: {
    entries: [
      { stepId: "survey", toolName: "Read", summary: "src/index.ts" },
      { stepId: "fix", toolName: "Bash", summary: "npm test" },
    ],
    dropped: 1,
  },
  final: { status: "failed", durationMs: 17_000 },
};

describe("decodeWorkflowCardSnapshot — valid payload", () => {
  it("round-trips a valid v1 snapshot unchanged", () => {
    expect(decodeWorkflowCardSnapshot(VALID_SNAPSHOT, CTX)).toEqual(VALID_SNAPSHOT);
  });

  it("ignores unknown top-level and nested keys (forward-compat with a future writer)", () => {
    const withExtras = {
      ...VALID_SNAPSHOT,
      somethingFromTheFuture: true,
      steps: VALID_SNAPSHOT.steps.map((step) => ({ ...step, extraField: 123 })),
      activity: {
        ...VALID_SNAPSHOT.activity,
        entries: VALID_SNAPSHOT.activity.entries.map((e) => ({ ...e, extra: "x" })),
      },
    };
    expect(decodeWorkflowCardSnapshot(withExtras, CTX)).toEqual(VALID_SNAPSHOT);
  });

  it("accepts a step with no result at all (workflow_step_end never arrived — the type's own doc comment allows it structurally even though the real writer never leaves one settled this way)", () => {
    const { result: _result, ...stepWithoutResult } = VALID_SNAPSHOT.steps[2] as NonNullable<
      (typeof VALID_SNAPSHOT.steps)[number]
    >;
    const withPendingStep: WorkflowCardSnapshotV1 = {
      ...VALID_SNAPSHOT,
      steps: [VALID_SNAPSHOT.steps[0]!, VALID_SNAPSHOT.steps[1]!, stepWithoutResult],
    };
    const decoded = decodeWorkflowCardSnapshot(withPendingStep, CTX);
    expect(decoded).toEqual(withPendingStep);
    expect(decoded?.steps[2]?.result).toBeUndefined();
  });

  it("accepts a step with no dependsOn at all (a source step)", () => {
    expect(decodeWorkflowCardSnapshot(VALID_SNAPSHOT, CTX)?.steps[0]?.dependsOn).toBeUndefined();
  });
});

describe("decodeWorkflowCardSnapshot — structural gates", () => {
  it("returns null when the paired tool call is not Workflow (a workflow presentation planted on a foreign tool result is ignored)", () => {
    expect(decodeWorkflowCardSnapshot(VALID_SNAPSHOT, { toolCallId: "call-1", toolName: "Agent" })).toBeNull();
  });

  it("returns null for an unknown version (a future writer's shape this reader doesn't understand)", () => {
    expect(decodeWorkflowCardSnapshot({ ...VALID_SNAPSHOT, version: 2 }, CTX)).toBeNull();
  });

  it("returns null when final is missing (a persisted snapshot without a terminal status is a contradiction)", () => {
    const { final: _final, ...withoutFinal } = VALID_SNAPSHOT;
    expect(decodeWorkflowCardSnapshot(withoutFinal, CTX)).toBeNull();
  });

  it("returns null when final is explicitly null", () => {
    expect(decodeWorkflowCardSnapshot({ ...VALID_SNAPSHOT, final: null }, CTX)).toBeNull();
  });
});

describe("decodeWorkflowCardSnapshot — malformed payloads never throw and decode to null", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", "just a string"],
    ["null", null],
    ["undefined", undefined],
    ["an array instead of an object", [1, 2, 3]],
    ["wrong kind discriminant", { ...VALID_SNAPSHOT, kind: "subagent" }],
    ["workflow is missing", { ...VALID_SNAPSHOT, workflow: undefined }],
    ["workflow is an empty string", { ...VALID_SNAPSHOT, workflow: "" }],
    ["workflow is a number", { ...VALID_SNAPSHOT, workflow: 42 }],
    ["totalSteps is a float", { ...VALID_SNAPSHOT, totalSteps: 1.5 }],
    ["totalSteps is negative", { ...VALID_SNAPSHOT, totalSteps: -1 }],
    ["steps is not an array", { ...VALID_SNAPSHOT, steps: "nope" }],
    ["a step is missing entirely (null entry)", { ...VALID_SNAPSHOT, steps: [null] }],
    ["a step's id is an empty string", { ...VALID_SNAPSHOT, steps: [{ id: "", agentType: "explore" }] }],
    ["a step's id is a number", { ...VALID_SNAPSHOT, steps: [{ id: 1, agentType: "explore" }] }],
    ["a step's agentType is a number", { ...VALID_SNAPSHOT, steps: [{ id: "s", agentType: 1 }] }],
    [
      "a step's dependsOn is not an array",
      { ...VALID_SNAPSHOT, steps: [{ id: "s", agentType: "explore", dependsOn: "s0" }] },
    ],
    [
      "a step's dependsOn contains a non-string",
      { ...VALID_SNAPSHOT, steps: [{ id: "s", agentType: "explore", dependsOn: ["ok", 2] }] },
    ],
    [
      "a step's result.status is an invalid enum value",
      { ...VALID_SNAPSHOT, steps: [{ id: "s", agentType: "explore", result: { status: "ok", turns: 0, durationMs: 0 } }] },
    ],
    [
      "a step's result.turns is negative",
      {
        ...VALID_SNAPSHOT,
        steps: [{ id: "s", agentType: "explore", result: { status: "completed", turns: -1, durationMs: 0 } }],
      },
    ],
    [
      "a step's result.durationMs is a float (workflow card requires an INTEGER duration, unlike the subagent card's finite-number rule)",
      {
        ...VALID_SNAPSHOT,
        steps: [{ id: "s", agentType: "explore", result: { status: "completed", turns: 0, durationMs: 1.5 } }],
      },
    ],
    [
      "a step's result.usage has a non-numeric field",
      {
        ...VALID_SNAPSHOT,
        steps: [
          {
            id: "s",
            agentType: "explore",
            result: { status: "completed", turns: 0, durationMs: 0, usage: { inputTokens: "many" } },
          },
        ],
      },
    ],
    ["activity.entries is not an array", { ...VALID_SNAPSHOT, activity: { entries: "nope", dropped: 0 } }],
    [
      "an activity entry is missing stepId",
      { ...VALID_SNAPSHOT, activity: { entries: [{ toolName: "Bash", summary: "x" }], dropped: 0 } },
    ],
    [
      "an activity entry's toolName is a number",
      { ...VALID_SNAPSHOT, activity: { entries: [{ stepId: "s", toolName: 1, summary: "x" }], dropped: 0 } },
    ],
    ["activity.dropped is negative", { ...VALID_SNAPSHOT, activity: { ...VALID_SNAPSHOT.activity, dropped: -3 } }],
    ["final.status is an invalid enum value", { ...VALID_SNAPSHOT, final: { status: "ok", durationMs: 1 } }],
    ["final.durationMs is negative", { ...VALID_SNAPSHOT, final: { status: "failed", durationMs: -1 } }],
    ["final.durationMs is a float", { ...VALID_SNAPSHOT, final: { status: "failed", durationMs: 1.5 } }],
    ["final.durationMs is NaN", { ...VALID_SNAPSHOT, final: { status: "failed", durationMs: Number.NaN } }],
  ];

  for (const [label, value] of cases) {
    it(label, () => {
      expect(() => decodeWorkflowCardSnapshot(value, CTX)).not.toThrow();
      expect(decodeWorkflowCardSnapshot(value, CTX)).toBeNull();
    });
  }
});

describe("decodeWorkflowCardSnapshot — oversized activity entries normalize bounded (slice, not reject)", () => {
  it("caps an oversized entry field (stepId/toolName/summary) to its code-point limit instead of rejecting the payload", () => {
    const oversizedStepId = "s".repeat(ACTIVITY_STEP_ID_MAX_CHARS + 10);
    const oversizedToolName = "t".repeat(ACTIVITY_TOOL_NAME_MAX_CHARS + 10);
    const oversizedSummary = "u".repeat(ACTIVITY_SUMMARY_MAX_CHARS + 10);
    const decoded = decodeWorkflowCardSnapshot(
      {
        ...VALID_SNAPSHOT,
        activity: {
          entries: [{ stepId: oversizedStepId, toolName: oversizedToolName, summary: oversizedSummary }],
          dropped: 0,
        },
      },
      CTX,
    );
    expect(decoded?.activity.entries[0]).toEqual({
      stepId: "s".repeat(ACTIVITY_STEP_ID_MAX_CHARS),
      toolName: "t".repeat(ACTIVITY_TOOL_NAME_MAX_CHARS),
      summary: "u".repeat(ACTIVITY_SUMMARY_MAX_CHARS),
    });
  });

  it("caps an oversized activity ring by dropping the OLDEST entries and honestly bumping `dropped`, keeping the tail", () => {
    const entries = Array.from({ length: WORKFLOW_CARD_ACTIVITY_RING + 10 }, (_, i) => ({
      stepId: "s",
      toolName: "Bash",
      summary: `cmd ${i}`,
    }));
    const decoded = decodeWorkflowCardSnapshot({ ...VALID_SNAPSHOT, activity: { entries, dropped: 0 } }, CTX);
    expect(decoded?.activity.entries).toHaveLength(WORKFLOW_CARD_ACTIVITY_RING);
    // Oldest 10 (cmd 0..9) evicted; the tail (most recent) survives.
    expect(decoded?.activity.entries[0]).toEqual({ stepId: "s", toolName: "Bash", summary: "cmd 10" });
    expect(decoded?.activity.entries[WORKFLOW_CARD_ACTIVITY_RING - 1]).toEqual({
      stepId: "s",
      toolName: "Bash",
      summary: `cmd ${WORKFLOW_CARD_ACTIVITY_RING + 9}`,
    });
    expect(decoded?.activity.dropped).toBe(10);
  });

  it("caps an oversized activity byte total (entry count well under the ring cap), honestly bumping `dropped`, keeping the tail", () => {
    // Each field's own code-point cap is applied BEFORE the byte-cap eviction
    // runs (decodeActivity normalizes fields first, ring/byte-evicts second),
    // and ASCII content maxed at all three field caps totals only
    // 64+80+160=304 bytes/entry — 200 (the ring cap) of those is only 60,800
    // bytes, so ASCII content alone can NEVER make the byte cap the binding
    // constraint before the ring cap already would. 4-byte UTF-8 code points
    // are needed so the SAME code-point caps still yield enough bytes to
    // blow the 65,536 byte cap at an entry count well under the 200 ring.
    // Each entry's `summary` carries its own index as a plain-ASCII PREFIX
    // (kept intact by capCodePoints, which slices from the front) so the
    // surviving tail is identifiable by content after truncation.
    const emoji = "\u{1F600}"; // U+1F600 GRINNING FACE — 4 UTF-8 bytes per code point.
    const total = 60;
    const entries = Array.from({ length: total }, (_, i) => ({
      stepId: emoji.repeat(100),
      toolName: emoji.repeat(100),
      summary: `${i}${emoji.repeat(200)}`,
    }));
    const decoded = decodeWorkflowCardSnapshot({ ...VALID_SNAPSHOT, activity: { entries, dropped: 0 } }, CTX);
    expect(decoded).not.toBeNull();
    expect(decoded!.activity.entries.length).toBeLessThan(total);
    expect(decoded!.activity.entries.length).toBeLessThan(WORKFLOW_CARD_ACTIVITY_RING);
    const totalBytes = decoded!.activity.entries.reduce(
      (sum, e) => sum + new TextEncoder().encode(e.stepId).length + new TextEncoder().encode(e.toolName).length + new TextEncoder().encode(e.summary).length,
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(WORKFLOW_CARD_ACTIVITY_MAX_BYTES);
    expect(decoded!.activity.dropped).toBeGreaterThan(0);
    // The tail (most recent entry, index 59) survived.
    expect(decoded!.activity.entries.at(-1)?.summary.startsWith(String(total - 1))).toBe(true);
  });

  it("truncation at the code-point limit never splits a surrogate pair (4-byte emoji)", () => {
    const emoji = "\u{1F600}"; // U+1F600 GRINNING FACE — one code point, a surrogate PAIR in UTF-16.
    const oversizedSummary = emoji.repeat(ACTIVITY_SUMMARY_MAX_CHARS + 5);
    const decoded = decodeWorkflowCardSnapshot(
      {
        ...VALID_SNAPSHOT,
        activity: { entries: [{ stepId: "s", toolName: "Bash", summary: oversizedSummary }], dropped: 0 },
      },
      CTX,
    );
    const summary = decoded?.activity.entries[0]?.summary ?? "";
    expect(Array.from(summary)).toHaveLength(ACTIVITY_SUMMARY_MAX_CHARS);
    // No lone surrogate at either boundary — a split pair produces an
    // unpaired code unit that round-trips to U+FFFD or throws under strict
    // UTF-8 re-encoding; Array.from's code-point iteration above already
    // proves no split occurred (a split pair would count as 2 malformed
    // units, changing the length assertion), but this also directly checks
    // re-encoding validity.
    expect(() => new TextEncoder().encode(summary)).not.toThrow();
    expect(summary.endsWith(emoji)).toBe(true);
  });
});

describe("projectWorkflowCard", () => {
  it("maps every field onto WorkflowSubStatus", () => {
    expect(projectWorkflowCard(VALID_SNAPSHOT)).toEqual({
      workflow: "explore-and-fix",
      totalSteps: 3,
      steps: [
        {
          stepId: "survey",
          agentType: "explore",
          dependsOn: [],
          turns: 4,
          toolCalls: 0,
          lastTool: null,
          usage: { inputTokens: 500, outputTokens: 200 },
          started: true,
          running: false,
          final: { status: "completed", durationMs: 12_000 },
        },
        {
          stepId: "fix",
          agentType: "coder",
          dependsOn: ["survey"],
          turns: 2,
          toolCalls: 0,
          lastTool: null,
          usage: null,
          started: true,
          running: false,
          final: { status: "error", durationMs: 5_000 },
        },
        {
          stepId: "verify",
          agentType: "reviewer",
          dependsOn: ["fix"],
          turns: 0,
          toolCalls: 0,
          lastTool: null,
          usage: null,
          started: false,
          running: false,
          final: { status: "skipped", durationMs: 0 },
        },
      ],
      activity: [
        { stepId: "survey", toolName: "Read", summary: "src/index.ts" },
        { stepId: "fix", toolName: "Bash", summary: "npm test" },
      ],
      activityDropped: 1,
      final: { status: "failed", completedSteps: 1, durationMs: 17_000 },
    });
  });

  it("a skipped step projects started: false (never launched, same reading the live S3 card gives a step that never got step_start)", () => {
    const projected = projectWorkflowCard(VALID_SNAPSHOT);
    expect(projected.steps.find((s) => s.stepId === "verify")?.started).toBe(false);
  });

  it("a settled non-skipped step (completed OR error) projects started: true", () => {
    const projected = projectWorkflowCard(VALID_SNAPSHOT);
    expect(projected.steps.find((s) => s.stepId === "survey")?.started).toBe(true);
    expect(projected.steps.find((s) => s.stepId === "fix")?.started).toBe(true);
  });

  it("running is always false, on every step and regardless of outcome mix", () => {
    const projected = projectWorkflowCard(VALID_SNAPSHOT);
    expect(projected.steps.every((s) => s.running === false)).toBe(true);
  });

  it("completedSteps counts only 'completed' steps, never error/max_turns/cancelled/skipped", () => {
    const allOutcomes: WorkflowCardSnapshotV1 = {
      ...VALID_SNAPSHOT,
      totalSteps: 5,
      steps: [
        { id: "a", agentType: "x", result: { status: "completed", turns: 1, durationMs: 1 } },
        { id: "b", agentType: "x", result: { status: "completed", turns: 1, durationMs: 1 } },
        { id: "c", agentType: "x", result: { status: "error", turns: 1, durationMs: 1 } },
        { id: "d", agentType: "x", result: { status: "max_turns", turns: 1, durationMs: 1 } },
        { id: "e", agentType: "x", result: { status: "cancelled", turns: 1, durationMs: 1 } },
      ],
    };
    expect(projectWorkflowCard(allOutcomes).final?.completedSteps).toBe(2);
  });

  it("a step with no result at all projects final: null, turns: 0, usage: null, started: false", () => {
    const { result: _result, ...pendingStep } = VALID_SNAPSHOT.steps[2] as NonNullable<
      (typeof VALID_SNAPSHOT.steps)[number]
    >;
    const withPending: WorkflowCardSnapshotV1 = { ...VALID_SNAPSHOT, steps: [pendingStep] };
    const [projectedStep] = projectWorkflowCard(withPending).steps;
    expect(projectedStep).toEqual({
      stepId: "verify",
      agentType: "reviewer",
      dependsOn: ["fix"],
      turns: 0,
      toolCalls: 0,
      lastTool: null,
      usage: null,
      started: false,
      running: false,
      final: null,
    });
  });
});

describe("projectWorkflowCard — invariant pin backing the toolCalls: 0 / lastTool: null decision", () => {
  it("every step that HAD a `result` on the snapshot projects final !== null (the fact workflowStepMeta's toolCalls/lastTool read relies on being unreachable)", () => {
    const projected = projectWorkflowCard(VALID_SNAPSHOT);
    for (const step of VALID_SNAPSHOT.steps) {
      const projectedStep = projected.steps.find((s) => s.stepId === step.id);
      expect(step.result !== undefined).toBe(true); // fixture sanity: every VALID_SNAPSHOT step has a result
      expect(projectedStep?.final).not.toBeNull();
    }
  });

  it("the run-level final is never null for a projected card (the snapshot's own final is required, never optional)", () => {
    expect(projectWorkflowCard(VALID_SNAPSHOT).final).not.toBeNull();
  });
});

describe("constant parity (a silent renderer/core cap drift would shorten the post-reload ring)", () => {
  it("the two per-activity-entry field caps reused from the subagent side equal the real @anycode/core exports", () => {
    expect(ACTIVITY_TOOL_NAME_MAX_CHARS).toBe(SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS);
    expect(ACTIVITY_SUMMARY_MAX_CHARS).toBe(SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS);
  });

  it("the ring cap equals the renderer's own live WORKFLOW_ACTIVITY_RING (store.ts) — post-reload '+N earlier' must never read shorter than the live feed", () => {
    expect(WORKFLOW_CARD_ACTIVITY_RING).toBe(WORKFLOW_ACTIVITY_RING);
  });

  it("the two workflow-card caps equal the real @anycode/core exports (live import, not a hand-copied literal)", () => {
    expect(WORKFLOW_CARD_ACTIVITY_RING).toBe(CORE_WORKFLOW_CARD_ACTIVITY_RING);
    expect(WORKFLOW_CARD_ACTIVITY_MAX_BYTES).toBe(CORE_WORKFLOW_CARD_ACTIVITY_MAX_BYTES);
  });
});

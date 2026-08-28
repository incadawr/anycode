/**
 * Tests for the S1 persisted-card decode/project pair (TASK.102 slice S1 W4,
 * CUT-S1 §3 W4). `decodeSubagentCardSnapshot` is the LAST line of defense
 * before a persisted `presentation.subagent` blob (parsed by `loadHistory`
 * with an unchecked `JSON.parse`, sqlite-persistence.ts) reaches the store —
 * it must never throw, and any structurally-wrong payload must decode to
 * `null` rather than propagate garbage into the transcript.
 *
 * The parity test at the bottom is a value-import of the REAL
 * `@anycode/core` constants — allowed in a test file (vitest node, never
 * bundled; precedent: apps/desktop/src/main/engine-reaper.test.ts's
 * `SIGKILL_GRACE_MS` import) even though renderer PRODUCTION code may only
 * type-import core (CUT-S1 §0.3/§2.4).
 */
import { describe, expect, it } from "vitest";
import type { SubagentCardSnapshotV1 } from "@anycode/core";
import {
  SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS,
  SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS,
  SUBAGENT_CARD_ACTIVITY_MAX_BYTES,
  SUBAGENT_CARD_ACTIVITY_RING,
  SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS,
  SUBAGENT_CARD_DESCRIPTION_MAX_CHARS,
  SUBAGENT_CARD_MODEL_MAX_CHARS,
} from "@anycode/core";
import {
  ACTIVITY_MAX_BYTES,
  ACTIVITY_RING,
  ACTIVITY_SUMMARY_MAX_CHARS,
  ACTIVITY_TOOL_NAME_MAX_CHARS,
  AGENT_TYPE_MAX_CHARS,
  DESCRIPTION_MAX_CHARS,
  MODEL_MAX_CHARS,
  decodeSubagentCardSnapshot,
  projectSubagentCard,
} from "./subagent-card.js";
import { SUBAGENT_ACTIVITY_RING } from "./store.js";

const CTX = { toolCallId: "call-1", toolName: "Agent" };

const VALID_SNAPSHOT: SubagentCardSnapshotV1 = {
  kind: "subagent",
  version: 1,
  target: { kind: "inline" },
  identity: { agentType: "explore", description: "survey the repo", model: "claude-sonnet", engine: "claude" },
  counters: { turns: 3, toolCalls: 4, lastTool: "Grep" },
  activity: {
    entries: [
      { toolName: "Read", summary: "src/index.ts" },
      { toolName: "Bash", summary: "npm test" },
    ],
    dropped: 1,
  },
  final: { status: "completed", durationMs: 4200 },
};

describe("decodeSubagentCardSnapshot — valid payload", () => {
  it("round-trips a valid v1 snapshot unchanged", () => {
    expect(decodeSubagentCardSnapshot(VALID_SNAPSHOT, CTX)).toEqual(VALID_SNAPSHOT);
  });

  it("accepts a session target whose spawnToolCallId matches the paired tool call (S2 shape, decode is forward-compatible even though S1 never writes it)", () => {
    const withSessionTarget: SubagentCardSnapshotV1 = {
      ...VALID_SNAPSHOT,
      target: { kind: "session", childSessionId: "child-1", parentSessionId: "parent-1", spawnToolCallId: CTX.toolCallId },
    };
    expect(decodeSubagentCardSnapshot(withSessionTarget, CTX)).toEqual(withSessionTarget);
  });

  it("ignores unknown top-level and nested keys (forward-compat with a future writer)", () => {
    const withExtras = {
      ...VALID_SNAPSHOT,
      somethingFromTheFuture: true,
      identity: { ...VALID_SNAPSHOT.identity, extraField: 123 },
      activity: {
        ...VALID_SNAPSHOT.activity,
        entries: VALID_SNAPSHOT.activity.entries.map((e) => ({ ...e, extra: "x" })),
      },
    };
    expect(decodeSubagentCardSnapshot(withExtras, CTX)).toEqual(VALID_SNAPSHOT);
  });

  it("accepts attention: 'waiting_permission' on decode (S2-reserved) but the shape carries it through untouched", () => {
    const withAttention: SubagentCardSnapshotV1 = { ...VALID_SNAPSHOT, attention: "waiting_permission" };
    expect(decodeSubagentCardSnapshot(withAttention, CTX)).toEqual(withAttention);
  });

  it("round-trips final.responseModel when present (TASK.161 slice C1)", () => {
    const withResponseModel: SubagentCardSnapshotV1 = {
      ...VALID_SNAPSHOT,
      final: { ...VALID_SNAPSHOT.final, responseModel: "glm-5.3" },
    };
    expect(decodeSubagentCardSnapshot(withResponseModel, CTX)).toEqual(withResponseModel);
  });

  it("a valid final with no responseModel decodes with the key absent — never a fabricated fallback (TASK.161 slice C1)", () => {
    const decoded = decodeSubagentCardSnapshot(VALID_SNAPSHOT, CTX);
    expect(decoded !== null && "responseModel" in decoded.final).toBe(false);
  });
});

describe("decodeSubagentCardSnapshot — final.responseModel is best-effort, never a rejection reason (TASK.161 slice C1)", () => {
  it("a wrong-typed final.responseModel is treated as absent without rejecting the otherwise-valid snapshot", () => {
    const malformed = { ...VALID_SNAPSHOT, final: { ...VALID_SNAPSHOT.final, responseModel: 12345 } };
    const decoded = decodeSubagentCardSnapshot(malformed, CTX);
    expect(decoded).not.toBeNull();
    expect(decoded !== null && "responseModel" in decoded.final).toBe(false);
  });

  it("caps an oversized final.responseModel at MODEL_MAX_CHARS instead of rejecting the payload", () => {
    const overlong = "y".repeat(MODEL_MAX_CHARS + 25);
    const decoded = decodeSubagentCardSnapshot(
      { ...VALID_SNAPSHOT, final: { ...VALID_SNAPSHOT.final, responseModel: overlong } },
      CTX,
    );
    expect(decoded?.final.responseModel).toBe("y".repeat(MODEL_MAX_CHARS));
  });
});

describe("decodeSubagentCardSnapshot — structural gates", () => {
  it("returns null when the paired tool call is not Agent (a subagent presentation planted on a foreign tool result is ignored)", () => {
    expect(decodeSubagentCardSnapshot(VALID_SNAPSHOT, { toolCallId: "call-1", toolName: "Bash" })).toBeNull();
  });

  it("returns null for an unknown version (a future writer's shape this reader doesn't understand)", () => {
    expect(decodeSubagentCardSnapshot({ ...VALID_SNAPSHOT, version: 2 }, CTX)).toBeNull();
  });

  it("returns null when final is missing (CUT-S1 §0.4: a persisted snapshot without a terminal status is a contradiction)", () => {
    const { final: _final, ...withoutFinal } = VALID_SNAPSHOT;
    expect(decodeSubagentCardSnapshot(withoutFinal, CTX)).toBeNull();
  });

  it("returns null when final is explicitly null", () => {
    expect(decodeSubagentCardSnapshot({ ...VALID_SNAPSHOT, final: null }, CTX)).toBeNull();
  });

  it("returns null when a session target's spawnToolCallId doesn't match the paired tool call", () => {
    const mismatched = {
      ...VALID_SNAPSHOT,
      target: { kind: "session", childSessionId: "child-1", parentSessionId: "parent-1", spawnToolCallId: "call-OTHER" },
    };
    expect(decodeSubagentCardSnapshot(mismatched, CTX)).toBeNull();
  });

  it("rejects an invalid attention value", () => {
    expect(decodeSubagentCardSnapshot({ ...VALID_SNAPSHOT, attention: "bogus" }, CTX)).toBeNull();
  });
});

describe("decodeSubagentCardSnapshot — malformed payloads never throw and decode to null", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", "just a string"],
    ["null", null],
    ["undefined", undefined],
    ["an array instead of an object", [1, 2, 3]],
    ["wrong kind discriminant", { ...VALID_SNAPSHOT, kind: "workflow" }],
    ["target is a bare string", { ...VALID_SNAPSHOT, target: "inline" }],
    ["target.kind is neither inline nor session", { ...VALID_SNAPSHOT, target: { kind: "bogus" } }],
    ["identity missing entirely", { ...VALID_SNAPSHOT, identity: undefined }],
    ["identity.agentType is a number", { ...VALID_SNAPSHOT, identity: { ...VALID_SNAPSHOT.identity, agentType: 42 } }],
    ["identity.model is a number (must be string|null)", { ...VALID_SNAPSHOT, identity: { ...VALID_SNAPSHOT.identity, model: 7 } }],
    ["identity.engine is an invalid enum value", { ...VALID_SNAPSHOT, identity: { ...VALID_SNAPSHOT.identity, engine: "gpt" } }],
    ["counters.turns is a float", { ...VALID_SNAPSHOT, counters: { ...VALID_SNAPSHOT.counters, turns: 1.5 } }],
    ["counters.toolCalls is negative", { ...VALID_SNAPSHOT, counters: { ...VALID_SNAPSHOT.counters, toolCalls: -1 } }],
    ["counters.lastTool is a number", { ...VALID_SNAPSHOT, counters: { ...VALID_SNAPSHOT.counters, lastTool: 5 } }],
    ["activity.entries is not an array", { ...VALID_SNAPSHOT, activity: { entries: "nope", dropped: 0 } }],
    [
      "an activity entry is missing summary",
      { ...VALID_SNAPSHOT, activity: { entries: [{ toolName: "Bash" }], dropped: 0 } },
    ],
    [
      "an activity entry's toolName is a number",
      { ...VALID_SNAPSHOT, activity: { entries: [{ toolName: 1, summary: "x" }], dropped: 0 } },
    ],
    ["activity.dropped is negative", { ...VALID_SNAPSHOT, activity: { ...VALID_SNAPSHOT.activity, dropped: -3 } }],
    ["final.status is an invalid enum value", { ...VALID_SNAPSHOT, final: { status: "ok", durationMs: 1 } }],
    ["final.durationMs is negative", { ...VALID_SNAPSHOT, final: { status: "completed", durationMs: -1 } }],
    ["final.durationMs is NaN", { ...VALID_SNAPSHOT, final: { status: "completed", durationMs: Number.NaN } }],
  ];

  for (const [label, value] of cases) {
    it(label, () => {
      expect(() => decodeSubagentCardSnapshot(value, CTX)).not.toThrow();
      expect(decodeSubagentCardSnapshot(value, CTX)).toBeNull();
    });
  }
});

describe("decodeSubagentCardSnapshot — oversized payloads normalize bounded (slice, not reject)", () => {
  it("caps an oversized identity string to its code-point limit instead of rejecting the payload", () => {
    const oversized = "x".repeat(AGENT_TYPE_MAX_CHARS + 50);
    const decoded = decodeSubagentCardSnapshot(
      { ...VALID_SNAPSHOT, identity: { ...VALID_SNAPSHOT.identity, agentType: oversized } },
      CTX,
    );
    expect(decoded?.identity.agentType).toBe("x".repeat(AGENT_TYPE_MAX_CHARS));
    expect(decoded?.identity.agentType.length).toBe(AGENT_TYPE_MAX_CHARS);
  });

  it("caps an oversized activity ring by dropping the oldest entries and honestly bumping `dropped`, keeping the tail", () => {
    const entries = Array.from({ length: ACTIVITY_RING + 10 }, (_, i) => ({ toolName: "Bash", summary: `cmd ${i}` }));
    const decoded = decodeSubagentCardSnapshot({ ...VALID_SNAPSHOT, activity: { entries, dropped: 0 } }, CTX);
    expect(decoded?.activity.entries).toHaveLength(ACTIVITY_RING);
    // Oldest 10 (cmd 0..9) evicted; the tail (most recent) survives.
    expect(decoded?.activity.entries[0]).toEqual({ toolName: "Bash", summary: "cmd 10" });
    expect(decoded?.activity.entries[ACTIVITY_RING - 1]).toEqual({ toolName: "Bash", summary: `cmd ${ACTIVITY_RING + 9}` });
    expect(decoded?.activity.dropped).toBe(10);
  });

  it("caps an oversized activity byte total, honestly bumping `dropped`, keeping the tail (4-byte code points, same construction discipline as the core reducer's own test)", () => {
    // U+1F600 (grinning face) is 4 UTF-8 bytes; ~240 bytes per entry keeps
    // this well under the ring cap while blowing the byte cap alone.
    const fourByteChar = "\u{1F600}";
    const entries = Array.from({ length: 200 }, (_, i) => ({
      toolName: fourByteChar.repeat(30),
      summary: `${fourByteChar.repeat(30)}${i}`,
    }));
    const decoded = decodeSubagentCardSnapshot({ ...VALID_SNAPSHOT, activity: { entries, dropped: 0 } }, CTX);
    expect(decoded).not.toBeNull();
    const totalBytes = decoded!.activity.entries.reduce(
      (sum, e) => sum + new TextEncoder().encode(e.toolName).length + new TextEncoder().encode(e.summary).length,
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(ACTIVITY_MAX_BYTES);
    expect(decoded!.activity.dropped).toBeGreaterThan(0);
    // The tail (most recent entry) survived.
    expect(decoded!.activity.entries.at(-1)?.summary.endsWith("199")).toBe(true);
  });
});

describe("decodeSubagentCardSnapshot — large corrupted/tampered payload (review finding: O(n²) eviction loop)", () => {
  it(
    "evicts a 100k-entry ring overflow in roughly linear time, preserving correctness (oldest evicted, tail order intact, honest drop count)",
    () => {
      // Simulates a corrupted/tampered sqlite row: ~100k tiny entries, small
      // enough in total bytes to never trip the 32 KiB byte cap, so eviction
      // is driven purely by the ring cap (mirrors the review finding's
      // scenario). A naive `entries = entries.slice(1)` per evicted entry
      // makes each eviction step re-copy the shrinking array, so ~99,900
      // evictions cost ~O(n²) total copies; this test's generous time bound
      // would fail against that implementation while staying flake-safe
      // against a correct O(n) single-pass eviction.
      const total = 100_000;
      const entries = Array.from({ length: total }, (_, i) => ({ toolName: "T", summary: `s${i}` }));

      const startedAt = performance.now();
      const decoded = decodeSubagentCardSnapshot(
        { ...VALID_SNAPSHOT, activity: { entries, dropped: 5 } },
        CTX,
      );
      const elapsedMs = performance.now() - startedAt;

      expect(decoded).not.toBeNull();
      // Correctness: same result an eviction that removes the oldest entries
      // one at a time would produce — ring-capped length, oldest evicted,
      // arrival order preserved among survivors, honest dropped count.
      expect(decoded!.activity.entries).toHaveLength(ACTIVITY_RING);
      expect(decoded!.activity.entries[0]).toEqual({ toolName: "T", summary: `s${total - ACTIVITY_RING}` });
      expect(decoded!.activity.entries.at(-1)).toEqual({ toolName: "T", summary: `s${total - 1}` });
      expect(decoded!.activity.dropped).toBe(5 + (total - ACTIVITY_RING));

      // Generous, flake-resistant ceiling (not a tight benchmark): the fixed
      // O(n) single pass measured ~10ms locally for this input, a ~200x
      // margin under this bound. The reverted-to-`slice(1)`-per-eviction
      // implementation measured ~4-5 SECONDS for the same input locally —
      // this threshold sits comfortably below that floor without being a
      // hair-trigger benchmark assertion.
      expect(elapsedMs).toBeLessThan(2_000);
    },
    20_000,
  );
});

describe("projectSubagentCard", () => {
  it("maps every field onto SubagentSubStatus, including null model/engine and activity order", () => {
    const nulled: SubagentCardSnapshotV1 = {
      ...VALID_SNAPSHOT,
      identity: { agentType: "explore", description: "d", model: null, engine: null },
    };
    expect(projectSubagentCard(nulled)).toEqual({
      agentType: "explore",
      description: "d",
      model: null,
      engine: null,
      turns: 3,
      toolCalls: 4,
      lastTool: "Grep",
      activity: [
        { toolName: "Read", summary: "src/index.ts" },
        { toolName: "Bash", summary: "npm test" },
      ],
      activityDropped: 1,
      final: { status: "completed", durationMs: 4200 },
    });
  });

  it("maps a non-null model/engine identity through unchanged", () => {
    expect(projectSubagentCard(VALID_SNAPSHOT)).toMatchObject({ model: "claude-sonnet", engine: "claude" });
  });

  it("copies final.responseModel through the projection unchanged (TASK.161 slice C1)", () => {
    const withResponseModel: SubagentCardSnapshotV1 = {
      ...VALID_SNAPSHOT,
      final: { ...VALID_SNAPSHOT.final, responseModel: "glm-5.3" },
    };
    expect(projectSubagentCard(withResponseModel).final).toEqual({
      status: "completed",
      durationMs: 4200,
      responseModel: "glm-5.3",
    });
  });
});

describe("projectSubagentCard — sessionChild discriminant (TASK.102 CUT-S2 §10.8.1)", () => {
  const SESSION_SNAPSHOT: SubagentCardSnapshotV1 = {
    ...VALID_SNAPSHOT,
    target: { kind: "session", childSessionId: "child-1", parentSessionId: "parent-1", spawnToolCallId: CTX.toolCallId },
  };

  it("1. a session-target snapshot projects sessionChild: true", () => {
    expect(projectSubagentCard(SESSION_SNAPSHOT).sessionChild).toBe(true);
  });

  it("2. an inline-target snapshot has NO sessionChild key at all (not sessionChild: false) — deep-equal pin against S1's byte-identical inline projection", () => {
    const projected = projectSubagentCard(VALID_SNAPSHOT);
    expect("sessionChild" in projected).toBe(false);
    expect(projected).toEqual({
      agentType: "explore",
      description: "survey the repo",
      model: "claude-sonnet",
      engine: "claude",
      turns: 3,
      toolCalls: 4,
      lastTool: "Grep",
      activity: [
        { toolName: "Read", summary: "src/index.ts" },
        { toolName: "Bash", summary: "npm test" },
      ],
      activityDropped: 1,
      final: { status: "completed", durationMs: 4200 },
    });
  });

  it("3. anti-plaiting pin: the three target ids never cross the projection, session-target snapshot included", () => {
    const projected = projectSubagentCard(SESSION_SNAPSHOT);
    const keys = Object.keys(projected);
    expect(keys).not.toContain("childSessionId");
    expect(keys).not.toContain("parentSessionId");
    expect(keys).not.toContain("spawnToolCallId");
  });
});

describe("constant parity (CUT-S1 §5 anti-facade #2: a silent renderer/core cap drift would shorten the post-reload ring)", () => {
  it("subagent-card.ts's local mirrors equal the real @anycode/core exports", () => {
    expect(ACTIVITY_RING).toBe(SUBAGENT_CARD_ACTIVITY_RING);
    expect(ACTIVITY_MAX_BYTES).toBe(SUBAGENT_CARD_ACTIVITY_MAX_BYTES);
    expect(AGENT_TYPE_MAX_CHARS).toBe(SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS);
    expect(DESCRIPTION_MAX_CHARS).toBe(SUBAGENT_CARD_DESCRIPTION_MAX_CHARS);
    expect(MODEL_MAX_CHARS).toBe(SUBAGENT_CARD_MODEL_MAX_CHARS);
  });

  it("subagent-card.ts's per-activity-entry field caps equal the real @anycode/core exports (review finding: these two were previously hardcoded with no parity coverage)", () => {
    expect(ACTIVITY_TOOL_NAME_MAX_CHARS).toBe(SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS);
    expect(ACTIVITY_SUMMARY_MAX_CHARS).toBe(SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS);
  });

  it("the ring cap equals the renderer's own live SUBAGENT_ACTIVITY_RING (store.ts) — post-reload '+N earlier' must never read shorter than the live feed", () => {
    expect(ACTIVITY_RING).toBe(SUBAGENT_ACTIVITY_RING);
  });
});

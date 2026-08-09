/**
 * Pure reducer tests for the persisted subagent card snapshot (TASK.102 slice
 * S1 W1, CUT-S1 §3 W1). Hermetic: feeds SubagentCardEvent values directly into
 * the three pure functions, no ports/loop involved.
 */

import { describe, expect, it } from "vitest";
import {
  createSubagentCardAccumulator,
  finalizeSubagentCard,
  reduceSubagentCardEvent,
  type SubagentCardEvent,
} from "./card-snapshot.js";
import {
  SUBAGENT_CARD_ACTIVITY_MAX_BYTES,
  SUBAGENT_CARD_ACTIVITY_RING,
  SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS,
  SUBAGENT_CARD_DESCRIPTION_MAX_CHARS,
  SUBAGENT_CARD_MODEL_MAX_CHARS,
} from "../types/config.js";

function start(overrides: Partial<Extract<SubagentCardEvent, { type: "subagent_start" }>> = {}): SubagentCardEvent {
  return {
    type: "subagent_start",
    toolCallId: "call-1",
    agentType: "explore",
    description: "look around",
    ...overrides,
  };
}

function progress(overrides: Partial<Extract<SubagentCardEvent, { type: "subagent_progress" }>> = {}): SubagentCardEvent {
  return { type: "subagent_progress", toolCallId: "call-1", turns: 1, toolCalls: 1, ...overrides };
}

function activity(toolName: string, summary: string): SubagentCardEvent {
  return { type: "subagent_activity", toolCallId: "call-1", toolName, summary };
}

function end(overrides: Partial<Extract<SubagentCardEvent, { type: "subagent_end" }>> = {}): SubagentCardEvent {
  return { type: "subagent_end", toolCallId: "call-1", status: "completed", turns: 2, durationMs: 100, ...overrides };
}

describe("reduceSubagentCardEvent — subagent_start", () => {
  it("creates identity and zeroed counters", () => {
    const acc = reduceSubagentCardEvent(
      createSubagentCardAccumulator(),
      start({ agentType: "general-purpose", description: "do stuff", model: "glm-4.6", engine: "codex" }),
    );
    expect(acc.started).toBe(true);
    expect(acc.identity).toEqual({
      agentType: "general-purpose",
      description: "do stuff",
      model: "glm-4.6",
      engine: "codex",
    });
    expect(acc.counters).toEqual({ turns: 0, toolCalls: 0, lastTool: null });
    expect(acc.entries).toEqual([]);
    expect(acc.dropped).toBe(0);
  });

  it("model/engine absent on the event => null in identity (no silent default)", () => {
    const acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    expect(acc.identity?.model).toBeNull();
    expect(acc.identity?.engine).toBeNull();
  });

  it("a duplicate start is a no-op — the first start wins", () => {
    const first = reduceSubagentCardEvent(createSubagentCardAccumulator(), start({ agentType: "explore" }));
    const second = reduceSubagentCardEvent(first, start({ agentType: "general-purpose", description: "different" }));
    expect(second.identity?.agentType).toBe("explore");
    expect(second).toEqual(first);
  });

  it("write-side caps identity strings at code-point boundaries (CUT-S1 §2.2)", () => {
    const longType = "a".repeat(SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS + 50);
    const longDesc = "b".repeat(SUBAGENT_CARD_DESCRIPTION_MAX_CHARS + 50);
    const longModel = "c".repeat(SUBAGENT_CARD_MODEL_MAX_CHARS + 50);
    const acc = reduceSubagentCardEvent(
      createSubagentCardAccumulator(),
      start({ agentType: longType, description: longDesc, model: longModel }),
    );
    expect(acc.identity?.agentType.length).toBe(SUBAGENT_CARD_AGENT_TYPE_MAX_CHARS);
    expect(acc.identity?.description.length).toBe(SUBAGENT_CARD_DESCRIPTION_MAX_CHARS);
    expect(acc.identity?.model?.length).toBe(SUBAGENT_CARD_MODEL_MAX_CHARS);
  });
});

describe("reduceSubagentCardEvent — subagent_progress", () => {
  it("replaces counters without touching activity", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    acc = reduceSubagentCardEvent(acc, activity("Bash", "echo hi"));
    acc = reduceSubagentCardEvent(acc, progress({ turns: 3, toolCalls: 5, lastTool: "Bash" }));
    expect(acc.counters).toEqual({ turns: 3, toolCalls: 5, lastTool: "Bash" });
    expect(acc.entries).toEqual([{ toolName: "Bash", summary: "echo hi" }]);
  });

  it("progress before start is a no-op", () => {
    const acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), progress());
    expect(acc.started).toBe(false);
    expect(acc.counters).toEqual({ turns: 0, toolCalls: 0, lastTool: null });
  });

  it("lastTool absent on the event => null (no silent stringification)", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    acc = reduceSubagentCardEvent(acc, progress({ lastTool: undefined }));
    expect(acc.counters.lastTool).toBeNull();
  });
});

describe("reduceSubagentCardEvent — subagent_activity", () => {
  it("appends in arrival order", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    acc = reduceSubagentCardEvent(acc, activity("Bash", "one"));
    acc = reduceSubagentCardEvent(acc, activity("Read", "two"));
    acc = reduceSubagentCardEvent(acc, activity("Grep", "three"));
    expect(acc.entries.map((e) => e.summary)).toEqual(["one", "two", "three"]);
  });

  it("activity before start is a no-op", () => {
    const acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), activity("Bash", "x"));
    expect(acc.started).toBe(false);
    expect(acc.entries).toEqual([]);
  });

  it("ring cap: keeps the last SUBAGENT_CARD_ACTIVITY_RING entries, tail survives", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    const total = SUBAGENT_CARD_ACTIVITY_RING + 7;
    for (let i = 0; i < total; i += 1) {
      acc = reduceSubagentCardEvent(acc, activity("Bash", `entry-${i}`));
    }
    expect(acc.entries).toHaveLength(SUBAGENT_CARD_ACTIVITY_RING);
    expect(acc.entries[0]!.summary).toBe(`entry-7`);
    expect(acc.entries[acc.entries.length - 1]!.summary).toBe(`entry-${total - 1}`);
    expect(acc.dropped).toBe(7);
  });

  it("byte cap: 4-byte code points evict oldest entries before the ring cap engages, tail survives", () => {
    // U+1F600 ("😀") encodes to 4 UTF-8 bytes. 240 code points => 960 bytes per
    // entry (toolName empty, summary carries the payload), well under the
    // ring's 100-entry cap (which would allow ~100*960 = 96000 bytes) but well
    // over SUBAGENT_CARD_ACTIVITY_MAX_BYTES (32768) after ~35 entries.
    const emoji = "\u{1F600}".repeat(240);
    expect(new TextEncoder().encode(emoji).length).toBe(960);

    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    const total = 40;
    for (let i = 0; i < total; i += 1) {
      acc = reduceSubagentCardEvent(acc, { type: "subagent_activity", toolCallId: "call-1", toolName: "", summary: `${emoji}${i}` });
    }
    // Never exceeds the byte cap.
    const totalBytes = acc.entries.reduce(
      (sum, e) => sum + new TextEncoder().encode(e.toolName).length + new TextEncoder().encode(e.summary).length,
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(SUBAGENT_CARD_ACTIVITY_MAX_BYTES);
    // Never hit the ring cap (byte cap bites first).
    expect(acc.entries.length).toBeLessThan(SUBAGENT_CARD_ACTIVITY_RING);
    // The tail survives — the last entry pushed is still present.
    expect(acc.entries[acc.entries.length - 1]!.summary).toBe(`${emoji}${total - 1}`);
    expect(acc.dropped).toBeGreaterThan(0);
    expect(acc.dropped).toBe(total - acc.entries.length);
  });
});

describe("reduceSubagentCardEvent — subagent_end", () => {
  it("fixes status/turns/durationMs/activitySuppressed", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    acc = reduceSubagentCardEvent(acc, end({ status: "max_turns", turns: 8, durationMs: 5000, activitySuppressed: 3 }));
    expect(acc.end).toEqual({ status: "max_turns", turns: 8, durationMs: 5000, activitySuppressed: 3 });
  });

  it("end before start is a no-op", () => {
    const acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), end());
    expect(acc.started).toBe(false);
    expect(acc.end).toBeNull();
  });

  it("a duplicate end is a no-op — the first end wins", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    acc = reduceSubagentCardEvent(acc, end({ status: "completed", turns: 2, durationMs: 100 }));
    acc = reduceSubagentCardEvent(acc, end({ status: "error", turns: 99, durationMs: 999 }));
    expect(acc.end).toEqual({ status: "completed", turns: 2, durationMs: 100 });
  });

  it("activitySuppressed absent on the event => absent on acc.end (no silent zero)", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    acc = reduceSubagentCardEvent(acc, end());
    expect(acc.end && "activitySuppressed" in acc.end).toBe(false);
  });
});

describe("reduceSubagentCardEvent — subagent_attention (TASK.102 CUT-S2 §2.2/§0.8)", () => {
  const fallback = { status: "error" as const, durationMs: 42 };

  it("is a no-op for the persisted snapshot — attention is transient live-only state, not part of the terminal record (CUT-S1 §2.1)", () => {
    let withAttention = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    withAttention = reduceSubagentCardEvent(withAttention, {
      type: "subagent_attention",
      toolCallId: "call-1",
      waiting: true,
    });
    withAttention = reduceSubagentCardEvent(withAttention, end());

    let withoutAttention = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    withoutAttention = reduceSubagentCardEvent(withoutAttention, end());

    // Byte-for-byte snapshot equality is the discriminating assert: a reducer
    // that merely avoided throwing (e.g. accidentally bumped a counter, added
    // an activity entry, or touched `end`) would still pass a "does not crash"
    // check but would fail this equality.
    expect(finalizeSubagentCard(withAttention, fallback)).toEqual(finalizeSubagentCard(withoutAttention, fallback));
  });

  it("leaves the accumulator itself unchanged, before or after start", () => {
    const beforeStart = createSubagentCardAccumulator();
    expect(
      reduceSubagentCardEvent(beforeStart, { type: "subagent_attention", toolCallId: "call-1", waiting: false }),
    ).toEqual(beforeStart);

    const afterStart = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    expect(
      reduceSubagentCardEvent(afterStart, { type: "subagent_attention", toolCallId: "call-1", waiting: true }),
    ).toEqual(afterStart);
  });
});

describe("finalizeSubagentCard", () => {
  const fallback = { status: "error" as const, durationMs: 42 };

  it("returns null when the accumulator never started (early failure before start)", () => {
    const snapshot = finalizeSubagentCard(createSubagentCardAccumulator(), fallback);
    expect(snapshot).toBeNull();
  });

  it("without an end event, uses the fallback status/durationMs", () => {
    const acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start({ agentType: "explore", description: "d" }));
    const snapshot = finalizeSubagentCard(acc, fallback);
    expect(snapshot?.final).toEqual({ status: "error", durationMs: 42 });
  });

  it("with an end event, uses the end's status/durationMs (not the fallback)", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    acc = reduceSubagentCardEvent(acc, end({ status: "completed", turns: 4, durationMs: 777 }));
    const snapshot = finalizeSubagentCard(acc, fallback);
    expect(snapshot?.final).toEqual({ status: "completed", durationMs: 777 });
    expect(snapshot?.counters.turns).toBe(4);
  });

  it("dropped sums ring/byte evictions and activitySuppressed", () => {
    let acc = reduceSubagentCardEvent(createSubagentCardAccumulator(), start());
    const total = SUBAGENT_CARD_ACTIVITY_RING + 10;
    for (let i = 0; i < total; i += 1) {
      acc = reduceSubagentCardEvent(acc, activity("Bash", `e${i}`));
    }
    expect(acc.dropped).toBe(10);
    acc = reduceSubagentCardEvent(acc, end({ status: "completed", turns: 1, durationMs: 1, activitySuppressed: 5 }));
    const snapshot = finalizeSubagentCard(acc, fallback);
    expect(snapshot?.activity.dropped).toBe(15);
    expect(snapshot?.activity.entries).toHaveLength(SUBAGENT_CARD_ACTIVITY_RING);
  });

  it("produces the full V1 shape: kind/version/target inline/identity/counters/activity/final", () => {
    let acc = reduceSubagentCardEvent(
      createSubagentCardAccumulator(),
      start({ agentType: "general-purpose", description: "do it", model: "glm-4.6", engine: "claude" }),
    );
    acc = reduceSubagentCardEvent(acc, activity("Read", "file.ts"));
    acc = reduceSubagentCardEvent(acc, end({ status: "completed", turns: 2, durationMs: 500 }));
    const snapshot = finalizeSubagentCard(acc, fallback);
    expect(snapshot).toEqual({
      kind: "subagent",
      version: 1,
      target: { kind: "inline" },
      identity: { agentType: "general-purpose", description: "do it", model: "glm-4.6", engine: "claude" },
      counters: { turns: 2, toolCalls: 0, lastTool: null },
      activity: { entries: [{ toolName: "Read", summary: "file.ts" }], dropped: 0 },
      final: { status: "completed", durationMs: 500 },
    });
    expect(snapshot && "attention" in snapshot).toBe(false);
  });
});

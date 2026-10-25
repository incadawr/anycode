/**
 * Taskana 4742 — tests for the checkpoint/rewind pure model (the survivors
 * of the removed TimelinePanel + the new turn→checkpoint matching). Same
 * jsdom-free discipline as TranscriptMinimap.test.ts: pure units only.
 *
 * The `deriveTurnLabel` table mirrors core's shadow-git.test.ts
 * `deriveCheckpointLabel` block (packages/core/src/checkpoints/) so the
 * renderer-side copy cannot drift from the rule that actually minted the
 * labels; `sortCheckpointsNewestFirst`/`buildRewindRequest` assertions were
 * ported from the deleted TimelinePanel.test.ts before that file died.
 */
import { describe, expect, it } from "vitest";
import type { WireCheckpointMeta } from "../../../shared/protocol.js";
import {
  CHECKPOINT_LABEL_MAX_CHARS,
  buildRewindRequest,
  deriveTurnLabel,
  matchCheckpointsToTurns,
  sortCheckpointsNewestFirst,
} from "./checkpoint-model.js";

function checkpoint(overrides: Partial<WireCheckpointMeta> = {}): WireCheckpointMeta {
  return {
    id: "cp-1",
    label: "turn 1",
    createdAt: 1_000,
    reason: "auto",
    ...overrides,
  };
}

describe("deriveTurnLabel (renderer mirror of core's deriveCheckpointLabel)", () => {
  it("takes only the first line", () => {
    expect(deriveTurnLabel("first line\nsecond line")).toBe("first line");
  });

  it("returns empty for empty/blank input", () => {
    expect(deriveTurnLabel("")).toBe("");
    expect(deriveTurnLabel("   \n  ")).toBe("");
  });

  it("strips control characters (tab/CR) and trims", () => {
    expect(deriveTurnLabel("hello\tworld\r")).toBe("helloworld");
    expect(deriveTurnLabel("  spaced  ")).toBe("spaced");
  });

  it("drops DEL and other C1-adjacent control chars per the core rule (code < 0x20 or 0x7f)", () => {
    expect(deriveTurnLabel("a\u007fb")).toBe("ab");
    expect(deriveTurnLabel("a\u001fb")).toBe("ab");
    // 0x80+ (C1/Unicode) is NOT stripped — core's rule is C0+DEL only.
    expect(deriveTurnLabel("a\u00e9b")).toBe("aéb");
  });

  it("truncates to CHECKPOINT_LABEL_MAX_CHARS (64)", () => {
    const label = deriveTurnLabel("x".repeat(100));
    expect(label).toHaveLength(CHECKPOINT_LABEL_MAX_CHARS);
    expect(CHECKPOINT_LABEL_MAX_CHARS).toBe(64);
  });
});

describe("sortCheckpointsNewestFirst (moved verbatim from TimelinePanel)", () => {
  it("returns an empty array for an empty list", () => {
    expect(sortCheckpointsNewestFirst([])).toEqual([]);
  });

  it("orders newest createdAt first regardless of input order", () => {
    const oldest = checkpoint({ id: "a", createdAt: 100 });
    const middle = checkpoint({ id: "b", createdAt: 200 });
    const newest = checkpoint({ id: "c", createdAt: 300 });
    expect(sortCheckpointsNewestFirst([oldest, newest, middle])).toEqual([newest, middle, oldest]);
  });

  it("does not mutate the input array", () => {
    const list = [checkpoint({ id: "a", createdAt: 100 }), checkpoint({ id: "b", createdAt: 200 })];
    const original = [...list];
    sortCheckpointsNewestFirst(list);
    expect(list).toEqual(original);
  });
});

describe("buildRewindRequest (moved verbatim from TimelinePanel)", () => {
  it("builds a scope:both rewind_request carrying the given checkpoint/requestId (v1 has no scope toggle, design §4)", () => {
    expect(buildRewindRequest("cp-42", "req-7")).toEqual({
      type: "rewind_request",
      requestId: "req-7",
      checkpointId: "cp-42",
      scope: "both",
    });
  });
});

describe("matchCheckpointsToTurns (Taskana 4742 §2.3)", () => {
  it("returns an empty array for no turns", () => {
    expect(matchCheckpointsToTurns([], [checkpoint()])).toEqual([]);
  });

  it("returns all-null for no checkpoints", () => {
    expect(matchCheckpointsToTurns(["a", "b"], [])).toEqual([null, null]);
  });

  it("matches exact labels in chronological order", () => {
    const cps = [checkpoint({ id: "cp-a", label: "first question", createdAt: 100 }), checkpoint({ id: "cp-b", label: "second question", createdAt: 200 })];
    expect(matchCheckpointsToTurns(["first question", "second question"], cps)).toEqual(["cp-a", "cp-b"]);
  });

  it("maps unmatched turns to null between matched ones (a turn without a write has no checkpoint)", () => {
    const cps = [checkpoint({ id: "cp-a", label: "write something", createdAt: 100 }), checkpoint({ id: "cp-c", label: "write again", createdAt: 300 })];
    expect(matchCheckpointsToTurns(["write something", "just chatting", "write again"], cps)).toEqual(["cp-a", null, "cp-c"]);
  });

  it("duplicate prompts: 'continue' x3 with 2 checkpoints -> first two matched in order, third null", () => {
    const cps = [checkpoint({ id: "cp-1", label: "continue", createdAt: 100 }), checkpoint({ id: "cp-2", label: "continue", createdAt: 200 })];
    expect(matchCheckpointsToTurns(["continue", "continue", "continue"], cps)).toEqual(["cp-1", "cp-2", null]);
  });

  it("never reuses one checkpoint for two turns even out of label order (forward-only cursor)", () => {
    // Turn 1's checkpoint sits chronologically AFTER turn 2's would-be match
    // but before an unmatched label — the cursor must only move forward.
    const cps = [
      checkpoint({ id: "cp-1", label: "b-prompt", createdAt: 100 }),
      checkpoint({ id: "cp-2", label: "a-prompt", createdAt: 200 }),
    ];
    // Turn texts in transcript order: a-prompt, b-prompt, a-prompt.
    // Turn 1 matches cp-2 (first unconsumed at/after cursor with that label).
    // Turn 2 matches cp-1? NO — cp-1 precedes the cursor now; honest null.
    // Turn 3's a-prompt: cp-2 is consumed -> null.
    expect(matchCheckpointsToTurns(["a-prompt", "b-prompt", "a-prompt"], cps)).toEqual(["cp-2", null, null]);
  });

  it("ignores pre-rewind checkpoints entirely", () => {
    const cps = [
      checkpoint({ id: "cp-auto", label: "real turn", createdAt: 100 }),
      checkpoint({ id: "cp-safety", label: "real turn", createdAt: 200, reason: "pre-rewind" }),
    ];
    expect(matchCheckpointsToTurns(["real turn"], cps)).toEqual(["cp-auto"]);
  });

  it("a label longer than 64 chars still matches (both sides truncated by the same rule)", () => {
    const long = "y".repeat(100);
    const cps = [checkpoint({ id: "cp-long", label: "y".repeat(64), createdAt: 100 })];
    expect(matchCheckpointsToTurns([long], cps)).toEqual(["cp-long"]);
  });

  it("a multiline prompt matches on its first line", () => {
    const cps = [checkpoint({ id: "cp-ml", label: "header line", createdAt: 100 })];
    expect(matchCheckpointsToTurns(["header line\nbody of the message"], cps)).toEqual(["cp-ml"]);
  });

  it("control characters in the prompt are dropped before comparing", () => {
    const cps = [checkpoint({ id: "cp-ctrl", label: "helloworld", createdAt: 100 })];
    expect(matchCheckpointsToTurns(["hello\tworld\r"], cps)).toEqual(["cp-ctrl"]);
  });

  it("an empty derived label never matches (empty prompts label nothing)", () => {
    const cps = [checkpoint({ id: "cp-x", label: "", createdAt: 100 })];
    expect(matchCheckpointsToTurns([""], cps)).toEqual([null]);
    expect(matchCheckpointsToTurns(["   \n  "], cps)).toEqual([null]);
  });

  it("sorts checkpoints ascending by createdAt before walking (wire order is a store-read detail)", () => {
    const cps = [
      checkpoint({ id: "cp-late", label: "q", createdAt: 300 }),
      checkpoint({ id: "cp-early", label: "q", createdAt: 100 }),
    ];
    expect(matchCheckpointsToTurns(["q", "q"], cps)).toEqual(["cp-early", "cp-late"]);
  });

  it("ties on createdAt stay stable (input order breaks the tie)", () => {
    const cps = [checkpoint({ id: "cp-1", label: "q", createdAt: 100 }), checkpoint({ id: "cp-2", label: "q", createdAt: 100 })];
    expect(matchCheckpointsToTurns(["q", "q"], cps)).toEqual(["cp-1", "cp-2"]);
  });
});

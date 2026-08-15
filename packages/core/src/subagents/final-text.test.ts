/**
 * Pure state-transition tests for the final-text accumulator (TASK.102
 * CUT-S2 §2.6.3, slice S2b B4). Each test discriminates against a specific
 * plausible facade of runner.ts's `currentTurnText`/`finalText` semantics:
 * a reset that also clobbers `final`, a stream_retry treated as a no-op
 * (leaking a discarded attempt's text into the result), a `final` that
 * tracks `current` live instead of only at `turn_end`, or a later turn
 * silently overwriting an already-fixated result before its OWN turn_end.
 */

import { describe, expect, it } from "vitest";
import {
  appendFinalText,
  createFinalTextAccumulator,
  finalizeFinalText,
  fixateFinalText,
  resetFinalText,
  type FinalTextAccumulator,
} from "./final-text.js";

describe("createFinalTextAccumulator", () => {
  it("starts with both current and final empty", () => {
    expect(createFinalTextAccumulator()).toEqual({ current: "", final: "" });
  });
});

describe("appendFinalText (text_delta)", () => {
  it("concatenates successive deltas onto `current`, never touching `final`", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "Hello, ");
    acc = appendFinalText(acc, "world");
    acc = appendFinalText(acc, "!");
    expect(acc.current).toBe("Hello, world!");
    expect(acc.final).toBe("");
  });

  it("is a no-op for an empty delta (identity, not just equal)", () => {
    const acc = appendFinalText(createFinalTextAccumulator(), "seed");
    const next = appendFinalText(acc, "");
    expect(next).toBe(acc);
  });
});

describe("resetFinalText (turn_start / stream_retry)", () => {
  it("clears `current` and leaves an already-fixated `final` untouched", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "first attempt");
    acc = fixateFinalText(acc);
    acc = appendFinalText(acc, " garbage after fixation is impossible in practice, but reset must still be pure");
    acc = resetFinalText(acc);
    expect(acc.current).toBe("");
    expect(acc.final).toBe("first attempt");
  });

  it("stream_retry discards a partial attempt's text — a facade that treats retry as a no-op would leak it into the next fixation", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "partial attempt before the connection dropped");
    // The provider adapter emits stream_retry; the step is replayed from scratch.
    acc = resetFinalText(acc);
    acc = appendFinalText(acc, "clean retry text");
    acc = fixateFinalText(acc);
    expect(acc.final).toBe("clean retry text");
    expect(acc.final).not.toContain("partial attempt");
  });
});

describe("fixateFinalText (turn_end)", () => {
  it("commits `current` into `final`", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "the answer");
    acc = fixateFinalText(acc);
    expect(acc.final).toBe("the answer");
  });

  it("a cutoff turn_start with no matching turn_end (e.g. max_turns) never overwrites the last fixated final — the exact runner.ts guarantee this module mirrors", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "turn one's answer");
    acc = fixateFinalText(acc); // turn_end for turn 1

    // Turn 2 starts, produces some output, but is cut off (max_turns) before
    // ITS OWN turn_end ever arrives — no fixateFinalText call for it.
    acc = resetFinalText(acc); // turn_start for turn 2
    acc = appendFinalText(acc, "turn two's incomplete output");

    expect(acc.final).toBe("turn one's answer");
  });

  it("re-fixates over a prior committed result on a later completed turn (multi-turn chaining, CUT-S2 §1.1)", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "turn one");
    acc = fixateFinalText(acc);
    expect(acc.final).toBe("turn one");

    acc = resetFinalText(acc);
    acc = appendFinalText(acc, "turn two");
    acc = fixateFinalText(acc);
    expect(acc.final).toBe("turn two");
  });

  it("is a no-op (same reference) when `final` already equals `current`", () => {
    const acc: FinalTextAccumulator = { current: "same", final: "same" };
    expect(fixateFinalText(acc)).toBe(acc);
  });
});

describe("finalizeFinalText", () => {
  it("returns the fixated final text untruncated when under the byte cap", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "short answer");
    acc = fixateFinalText(acc);
    expect(finalizeFinalText(acc, 1_000)).toEqual({ text: "short answer", truncated: false });
  });

  it("caps to maxBytes and reports truncated:true, mirroring runner.ts's capUtf8Bytes(finalText, SUBAGENT_OUTPUT_MAX_BYTES) step", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "abcdefghij");
    acc = fixateFinalText(acc);
    expect(finalizeFinalText(acc, 5)).toEqual({ text: "abcde", truncated: true });
  });

  it("never reads the UNCOMMITTED `current` text, even when non-empty", () => {
    let acc = createFinalTextAccumulator();
    acc = appendFinalText(acc, "committed");
    acc = fixateFinalText(acc);
    acc = appendFinalText(acc, " plus an in-flight, never-fixated turn");
    expect(finalizeFinalText(acc, 1_000)).toEqual({ text: "committed", truncated: false });
  });
});

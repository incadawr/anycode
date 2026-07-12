/**
 * Pure-logic tests for R3 turn-liveness (design/slice-R3-cut.md §12.1). Same
 * `.test.ts`-only rationale as ToolCallCard.test.ts / PermissionModal.test.ts:
 * this package's vitest runs in a `node` environment (no jsdom), so the
 * exported pure functions are covered directly instead of through DOM
 * rendering. Covers WorkingRow's clock/verb/format helpers, MessageList's
 * `isTailLive` predicate, and ReasoningBlock's `reasoningTailPreview`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatElapsed,
  getTurnStartedAt,
  VERB_ROTATE_SECONDS,
  WORKING_VERBS,
  workingVerb,
} from "./WorkingRow.js";
import { isTailLive } from "./MessageList.js";
import { reasoningTailPreview } from "./ReasoningBlock.js";
import type { ToolCallCardStatus, TranscriptBlock } from "../store.js";

describe("formatElapsed", () => {
  it("renders bare seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(7)).toBe("7s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("renders minutes with a zero-padded seconds field", () => {
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(64)).toBe("1m 04s");
    expect(formatElapsed(3599)).toBe("59m 59s");
  });

  it("renders hours with a zero-padded minutes field", () => {
    expect(formatElapsed(3600)).toBe("1h 00m");
    expect(formatElapsed(3720)).toBe("1h 02m");
  });

  it("clamps negatives to zero", () => {
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("workingVerb", () => {
  it("opens with Working and rotates every 12s in fixed order", () => {
    expect(workingVerb(0)).toBe("Working");
    expect(workingVerb(11)).toBe("Working");
    expect(workingVerb(12)).toBe("Thinking");
    expect(workingVerb(24)).toBe("Reviewing");
    expect(workingVerb(36)).toBe("Checking");
  });

  it("wraps back to Working after the fourth band", () => {
    expect(workingVerb(48)).toBe("Working");
  });

  it("treats negative elapsed as the opening verb", () => {
    expect(workingVerb(-3)).toBe("Working");
  });

  it("keeps the rotation constant and the band width consistent", () => {
    expect(WORKING_VERBS).toEqual(["Working", "Thinking", "Reviewing", "Checking"]);
    expect(VERB_ROTATE_SECONDS).toBe(12);
  });
});

describe("getTurnStartedAt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is idempotent for a given turnId (later reads never re-stamp)", () => {
    let clock = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
    const first = getTurnStartedAt("turn-idempotent");
    const second = getTurnStartedAt("turn-idempotent");
    expect(second).toBe(first);
  });

  it("stamps distinct turnIds with their own first-observation time", () => {
    let clock = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
    const a = getTurnStartedAt("turn-distinct-a");
    const b = getTurnStartedAt("turn-distinct-b");
    expect(b).not.toBe(a);
  });

  it("evicts the oldest entry once the 32-entry cap is exceeded", () => {
    let clock = 500_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
    const firstStamp = getTurnStartedAt("evict-0");
    // Insert 32 more distinct ids: the map exceeds 32 entries on the 33rd
    // insertion and drops the oldest (evict-0) in insertion order.
    for (let i = 1; i <= 32; i += 1) {
      getTurnStartedAt(`evict-${i}`);
    }
    // evict-0 is gone → a fresh query re-stamps it with a NEW (later) time.
    const reStamp = getTurnStartedAt("evict-0");
    expect(reStamp).not.toBe(firstStamp);
    // A survivor (inserted after evict-0) keeps its original stamp.
    const survivor = getTurnStartedAt("evict-32");
    const survivorAgain = getTurnStartedAt("evict-32");
    expect(survivorAgain).toBe(survivor);
  });
});

/** Minimal tool_call block for the predicate, varying only `status`. */
function toolCallBlock(status: ToolCallCardStatus): TranscriptBlock {
  return {
    kind: "tool_call",
    id: `tc-${status}`,
    toolCallId: `tc-${status}`,
    toolName: "Bash",
    input: {},
    status,
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
  };
}

describe("isTailLive", () => {
  it("is false for an undefined tail (empty transcript)", () => {
    expect(isTailLive(undefined)).toBe(false);
  });

  it("treats streaming prose and reasoning tails as live", () => {
    expect(isTailLive({ kind: "assistant_text", id: "a", text: "hi" })).toBe(true);
    expect(isTailLive({ kind: "reasoning", id: "r", text: "hmm", collapsed: false })).toBe(true);
  });

  it("treats a post-send user_text tail as dead air (the row's raison d'être)", () => {
    expect(isTailLive({ kind: "user_text", id: "u", text: "do the thing" })).toBe(false);
  });

  it("treats error and loop_end tails as not live", () => {
    expect(isTailLive({ kind: "error", id: "e", error: { name: "Boom", message: "x" } })).toBe(false);
    expect(isTailLive({ kind: "loop_end", id: "l", reason: "done", turns: 3 })).toBe(false);
  });

  it("treats only proposed/running tool-call tails as live", () => {
    expect(isTailLive(toolCallBlock("proposed"))).toBe(true);
    expect(isTailLive(toolCallBlock("running"))).toBe(true);
    for (const settled of ["success", "error", "invalid_input", "denied", "timed_out", "cancelled"] as const) {
      expect(isTailLive(toolCallBlock(settled))).toBe(false);
    }
  });
});

describe("reasoningTailPreview", () => {
  // Pre-fix behavior preserved where the new sanitizer naturally reproduces
  // it (design/slice-P7.2-cut.md §4): a single meaningful, markdown-free last
  // line still returns as-is.
  it("returns the last line of multiline text", () => {
    expect(reasoningTailPreview("first line\nsecond line\nthird line")).toBe("third line");
  });

  it("ignores trailing blank lines and trims the surviving tail line", () => {
    expect(reasoningTailPreview("keep me\nlast real line\n\n\n")).toBe("last real line");
    expect(reasoningTailPreview("  padded tail  \n")).toBe("padded tail");
  });

  it("returns an empty string for empty text", () => {
    expect(reasoningTailPreview("")).toBe("");
  });

  it("falls back to a plain tail slice when the capped window has no whitespace to cut at", () => {
    const long = "x".repeat(200);
    const preview = reasoningTailPreview(long);
    expect(preview.startsWith("…")).toBe(true);
    // 160 tail chars + the leading ellipsis — no word boundary to cut at, so
    // the old plain-slice fallback still applies.
    expect(preview.length).toBe(161);
    expect(preview).toBe(`…${"x".repeat(160)}`);
  });

  it("owner screenshot case: a markdown list item cut mid-inline-code sanitizes to clean plain text", () => {



    // trailing colon is swept too -> `Second`.
    const raw = '…\n- Second: "B `' + "`";
    const preview = reasoningTailPreview(raw);
    expect(preview).toBe("Second");
    expect(preview).not.toMatch(/[`"*#[\]]/);
  });

  it("strips block + inline markdown syntax to plain words", () => {
    expect(reasoningTailPreview("# Heading text")).toBe("Heading text");
    expect(reasoningTailPreview("**bold** word")).toBe("bold word");
    expect(reasoningTailPreview("some `code` here")).toBe("some code here");
    expect(reasoningTailPreview("see [link text](https://example.com) end")).toBe("see link text end");
    expect(reasoningTailPreview("> a quoted line")).toBe("a quoted line");
    expect(reasoningTailPreview("1. first numbered item")).toBe("first numbered item");
  });

  it("cuts long text at a word boundary so the ellipsized preview never opens mid-word", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const preview = reasoningTailPreview(words);
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(161);
    const afterEllipsis = preview.slice(1);
    expect(afterEllipsis).toBe(afterEllipsis.trimStart());
    // The char immediately preceding the kept window (in the un-ellipsized
    // source) must have been whitespace, i.e. the preview restarts a whole word.
    expect(words.endsWith(afterEllipsis)).toBe(true);
    expect(words[words.length - afterEllipsis.length - 1]).toBe(" ");
  });

  it("sweeps a trailing orphan opener/dangler back to the previous word boundary", () => {
    expect(reasoningTailPreview('text "')).toBe("text");
    expect(reasoningTailPreview("text (")).toBe("text");
    expect(reasoningTailPreview("text \\")).toBe("text");
    expect(reasoningTailPreview("text-")).toBe("text");
    expect(reasoningTailPreview("text:")).toBe("text");
    expect(reasoningTailPreview("text,")).toBe("text");
  });

  it("collapses whitespace runs, including the newline between joined tail lines", () => {
    // Last raw line is marker-only (strips to empty) -> lookback joins the
    // previous line, whose own internal run of spaces also collapses.
    expect(reasoningTailPreview("alpha   beta\n- ")).toBe("alpha beta");
    expect(reasoningTailPreview("first\n\t second  \nthird   line")).toBe("third line");
  });

  it("returns empty for whitespace-only or markers-only text", () => {
    expect(reasoningTailPreview("   \n  \n")).toBe("");
    expect(reasoningTailPreview("-\n*\n>\n#")).toBe("");
  });

  it("is idempotent over the sanitized corpus (f(f(x)) === f(x))", () => {
    const corpus = [
      "third line",
      "Second",
      "Heading text",
      "bold word",
      "some code here",
      "see link text end",
      "text",
      "alpha beta",
    ];
    for (const s of corpus) {
      const once = reasoningTailPreview(s);
      expect(reasoningTailPreview(once)).toBe(once);
    }
  });

  // codex finding: a single strip pass only peeled the OUTER marker of a
  // nested block (e.g. blockquoted list item), leaking the inner one raw.
  it("strips nested/stacked leading markers to a fixpoint, not just one layer", () => {
    expect(reasoningTailPreview("> - **nested** item")).toBe("nested item");
    expect(reasoningTailPreview("> - > - deeply nested")).toBe("deeply nested");
    expect(reasoningTailPreview("1. - mixed nesting")).toBe("mixed nesting");
  });

  // codex finding: when the last raw line strips down to nothing (a bare
  // stacked marker with no content yet, e.g. "> -"), the old code fed the
  // lone marker residue into the sweep step, which then swept the WHOLE
  // thing away — losing the real content on the previous line instead of
  // falling back to it.
  it("falls back to the previous line when the last line strips to nothing after full marker removal", () => {
    expect(reasoningTailPreview("previous\n> -")).toBe("previous");
  });

  it("cuts on a code-point boundary, never splitting a surrogate pair (e.g. emoji)", () => {
    const long = "😀".repeat(80) + "x";
    const preview = reasoningTailPreview(long);
    expect(preview.startsWith("…")).toBe(true);
    // If the cut split the leading emoji's surrogate pair, index 1 (right
    // after the ellipsis) would be a lone low surrogate, not the full 😀
    // code point.
    expect(preview.codePointAt(1)).toBe(0x1f600);
  });

  it("bounding the raw input to a fixed tail does not change the sanitized output vs. an unbounded stream", () => {
    const tail = "- reasoning about **bold** things and `code` here\nfinal line of the tail";
    // Padding far larger than the internal pipeline-input cap, with nothing
    // in it that could ever surface in a 4-line/160-char tail preview.
    const padding = "lorem ipsum filler reasoning text that keeps the stream long. ".repeat(200);
    const short = tail;
    const long = `${padding}\n${tail}`;
    expect(long.length).toBeGreaterThan(2000);
    expect(reasoningTailPreview(long)).toBe(reasoningTailPreview(short));
  });
});

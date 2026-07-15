import { describe, expect, it } from "vitest";
import {
  aggregateStackStatus,
  FOLLOW_THRESHOLD_PX,
  formatErrorRetrySuffix,
  formatStreamRetryLine,
  groupTranscriptBlocks,
  isAtBottom,
  isTerminalStatus,
  needsSnap,
  showTryAgainButton,
  showStandaloneRetry,
  shouldShowJumpButton,
  shouldShowTranscriptEmpty,
  stackBadgeText,
  stackHeaderLabel,
  stackLabel,
  stackStatusClass,
  STARTER_CHIPS,
} from "./MessageList.js";
import type { ErrorRetryMeta, RetryOffer, ToolCallBlock, TranscriptBlock } from "../store.js";

describe("shouldShowTranscriptEmpty (R11)", () => {
  it("shows only for a zero-block idle transcript", () => {
    expect(shouldShowTranscriptEmpty(0, false)).toBe(true);
  });

  it("hides while a turn runs (WorkingRow owns the zero-block running state)", () => {
    expect(shouldShowTranscriptEmpty(0, true)).toBe(false);
  });

  it("hides once any block exists", () => {
    expect(shouldShowTranscriptEmpty(1, false)).toBe(false);
    expect(shouldShowTranscriptEmpty(3, true)).toBe(false);
  });
});

describe("STARTER_CHIPS (R11 contract: static, exactly three, labels fixed)", () => {
  it("carries the three contract labels in order", () => {
    expect(STARTER_CHIPS.map((c) => c.label)).toEqual([
      "Explain this codebase",
      "Fix a failing test",
      "Review my latest diff",
    ]);
  });

  it("every chip inserts non-empty prompt text", () => {
    for (const chip of STARTER_CHIPS) {
      expect(chip.insert.length).toBeGreaterThan(0);
    }
  });
});

describe("isAtBottom (F17 sticky-follow)", () => {
  it("is true at the exact bottom (zero distance)", () => {
    expect(isAtBottom(500, 1000, 500)).toBe(true);
  });

  it("is true within the threshold band", () => {
    expect(isAtBottom(500 - FOLLOW_THRESHOLD_PX, 1000, 500)).toBe(true);
  });

  it("is false just beyond the threshold", () => {
    expect(isAtBottom(500 - FOLLOW_THRESHOLD_PX - 1, 1000, 500)).toBe(false);
  });

  it("is true for a non-overflowing container regardless of scrollTop", () => {
    expect(isAtBottom(0, 400, 500)).toBe(true);
  });

  it("clamps a negative distance (scrollHeight momentarily behind clientHeight) to at-bottom", () => {
    expect(isAtBottom(50, 400, 500)).toBe(true);
  });

  it("honors a custom threshold override", () => {
    expect(isAtBottom(0, 1000, 500, 0)).toBe(false);
    expect(isAtBottom(500, 1000, 500, 0)).toBe(true);
  });
});

describe("shouldShowJumpButton (F17 sticky-follow)", () => {
  it("hides while following, regardless of block count", () => {
    expect(shouldShowJumpButton(true, 0)).toBe(false);
    expect(shouldShowJumpButton(true, 10)).toBe(false);
  });

  it("hides when not following but the transcript is empty", () => {
    expect(shouldShowJumpButton(false, 0)).toBe(false);
  });

  it("shows when not following and blocks exist", () => {
    expect(shouldShowJumpButton(false, 1)).toBe(true);
    expect(shouldShowJumpButton(false, 42)).toBe(true);
  });
});

describe("needsSnap (F17 sticky-follow, codex P7.3-F finding 4 dedup helper)", () => {
  it("needs a snap when scrolled away from the exact bottom and nothing snapped yet this frame", () => {
    expect(needsSnap(400, 1000, 500, false)).toBe(true);
  });

  it("does not need a snap once already at the exact bottom", () => {
    expect(needsSnap(500, 1000, 500, false)).toBe(false);
  });

  it("does not need a snap for a non-overflowing container", () => {
    expect(needsSnap(0, 400, 500, false)).toBe(false);
  });

  it("skips a second caller in the same frame even if geometry alone would call for a snap", () => {
    expect(needsSnap(400, 1000, 500, true)).toBe(false);
  });

  it("is strict (zero threshold), unlike the looser isAtBottom used for the follow/jump-chip gate", () => {
    // Within FOLLOW_THRESHOLD_PX of the bottom but not exactly there: the
    // follow gate already reads this as "at bottom" (jump chip stays
    // hidden), but a snap write is still worth doing to close the gap.
    expect(isAtBottom(500 - FOLLOW_THRESHOLD_PX, 1000, 500)).toBe(true);
    expect(needsSnap(500 - FOLLOW_THRESHOLD_PX, 1000, 500, false)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TASK.31 — Stack consecutive terminal tool-call cards (ANY mix of tool
// names — a single-tool run is the special case). Pure-logic tests for the
// grouping projection and its helpers (no DOM, no jsdom — same posture as the
// isAtBottom/needsSnap tests above).
// ─────────────────────────────────────────────────────────────────────────

/** Minimal tool_call block builder — only the fields the projection reads. */
function mkToolCall(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    kind: "tool_call",
    id: "tc-1",
    toolCallId: "tc-1",
    toolName: "Bash",
    input: { command: "ls" },
    status: "success",
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
    ...overrides,
  };
}

describe("isTerminalStatus (TASK.31)", () => {
  it("returns true for every settled outcome", () => {
    for (const status of ["success", "error", "invalid_input", "denied", "timed_out", "cancelled"] as const) {
      expect(isTerminalStatus(status)).toBe(true);
    }
  });

  it("returns false for live statuses (proposed/running must stay visible)", () => {
    expect(isTerminalStatus("proposed")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("aggregateStackStatus (TASK.31)", () => {
  it("is success iff every member is success", () => {
    expect(aggregateStackStatus([mkToolCall({ status: "success" }), mkToolCall({ status: "success" })])).toBe(
      "success",
    );
  });

  it("is mixed when any member is not success", () => {
    expect(aggregateStackStatus([mkToolCall({ status: "success" }), mkToolCall({ status: "error" })])).toBe("mixed");
    expect(aggregateStackStatus([mkToolCall({ status: "error" }), mkToolCall({ status: "denied" })])).toBe("mixed");
  });
});

describe("stackBadgeText (TASK.31)", () => {
  it("reports Success when no member failed", () => {
    expect(stackBadgeText([mkToolCall({ status: "success" }), mkToolCall({ status: "success" })])).toBe("Success");
  });

  it("reports Failed when every member failed", () => {
    expect(stackBadgeText([mkToolCall({ status: "error" }), mkToolCall({ status: "denied" })])).toBe("Failed");
  });

  it("reports the failed count for a mixed stack", () => {
    expect(
      stackBadgeText([
        mkToolCall({ status: "success" }),
        mkToolCall({ status: "error" }),
        mkToolCall({ status: "denied" }),
      ]),
    ).toBe("2 failed");
  });
});

describe("stackLabel (TASK.31)", () => {
  it("pluralizes for a stack (≥2)", () => {
    expect(stackLabel(2)).toBe("2 calls");
    expect(stackLabel(3)).toBe("3 calls");
    expect(stackLabel(10)).toBe("10 calls");
  });

  it("uses the singular form at count 1 (defensive — a stack always holds ≥2)", () => {
    expect(stackLabel(1)).toBe("1 call");
  });
});

describe("stackHeaderLabel (TASK.31 — never masquerade as one tool name)", () => {
  it("returns the single tool name for a one-type run", () => {
    expect(stackHeaderLabel([mkToolCall({ toolName: "Bash" }), mkToolCall({ toolName: "Bash" })])).toBe("Bash");
  });

  it("joins two distinct names with a comma (first-appearance order)", () => {
    expect(stackHeaderLabel([mkToolCall({ toolName: "Bash" }), mkToolCall({ toolName: "Read" })])).toBe("Bash, Read");
  });

  it("deduplicates repeated names within a two-type run", () => {
    expect(
      stackHeaderLabel([
        mkToolCall({ toolName: "Bash" }),
        mkToolCall({ toolName: "Read" }),
        mkToolCall({ toolName: "Bash" }),
      ]),
    ).toBe("Bash, Read");
  });

  it("collapses three distinct names to the first two + a count tail", () => {
    expect(
      stackHeaderLabel([
        mkToolCall({ toolName: "Bash" }),
        mkToolCall({ toolName: "Read" }),
        mkToolCall({ toolName: "Grep" }),
      ]),
    ).toBe("Bash, Read +1");
  });

  it("falls back to the neutral 'Tool calls' label for a run spanning 4+ distinct tools", () => {
    expect(
      stackHeaderLabel([
        mkToolCall({ toolName: "Bash" }),
        mkToolCall({ toolName: "Read" }),
        mkToolCall({ toolName: "Grep" }),
        mkToolCall({ toolName: "Glob" }),
      ]),
    ).toBe("Tool calls");
  });
});

describe("stackStatusClass (TASK.31)", () => {
  it("maps an all-success stack to the success tint", () => {
    expect(stackStatusClass([mkToolCall({ status: "success" }), mkToolCall({ status: "success" })])).toBe(
      "tool-call-status-success",
    );
  });

  it("maps a mixed or all-failed stack to the error tint", () => {
    expect(stackStatusClass([mkToolCall({ status: "success" }), mkToolCall({ status: "error" })])).toBe(
      "tool-call-status-error",
    );
    expect(stackStatusClass([mkToolCall({ status: "error" }), mkToolCall({ status: "denied" })])).toBe(
      "tool-call-status-error",
    );
  });
});

describe("groupTranscriptBlocks (TASK.31 — any adjacent terminal tool calls stack)", () => {
  it("returns an empty array for no blocks", () => {
    expect(groupTranscriptBlocks([])).toEqual([]);
  });

  it("emits a single item for one tool_call", () => {
    const block = mkToolCall({ id: "a" });
    expect(groupTranscriptBlocks([block])).toEqual([{ kind: "single", block }]);
  });

  it("stacks two adjacent identical terminal tool calls (single-tool special case)", () => {
    const a = mkToolCall({ id: "a", toolCallId: "a" });
    const b = mkToolCall({ id: "b", toolCallId: "b" });
    const items = groupTranscriptBlocks([a, b]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool_stack", status: "success" });
    expect((items[0] as { blocks: ToolCallBlock[] }).blocks).toEqual([a, b]);
  });

  it("stacks two adjacent terminal tool calls with DIFFERENT tool names", () => {
    const a = mkToolCall({ id: "a", toolName: "Bash" });
    const b = mkToolCall({ id: "b", toolName: "Read" });
    const items = groupTranscriptBlocks([a, b]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool_stack" });
    expect((items[0] as { blocks: ToolCallBlock[] }).blocks).toEqual([a, b]);
  });

  it("stacks three adjacent mixed terminal tool calls and preserves order", () => {
    const a = mkToolCall({ id: "a", toolName: "Bash" });
    const b = mkToolCall({ id: "b", toolName: "Read" });
    const c = mkToolCall({ id: "c", toolName: "Grep" });
    const items = groupTranscriptBlocks([a, b, c]);
    expect(items).toHaveLength(1);
    const stack = items[0] as { kind: "tool_stack"; blocks: ToolCallBlock[] };
    expect(stack.blocks.map((blk) => blk.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a run when a different kind sits between terminal calls", () => {
    const a = mkToolCall({ id: "a" });
    const sep: TranscriptBlock = { kind: "assistant_text", id: "sep", text: "thinking..." };
    const b = mkToolCall({ id: "b" });
    expect(groupTranscriptBlocks([a, sep, b])).toEqual([
      { kind: "single", block: a },
      { kind: "single", block: sep },
      { kind: "single", block: b },
    ]);
  });

  it("does NOT stack a proposed/running card next to a terminal one (active work stays visible)", () => {
    const running = mkToolCall({ id: "r", status: "running" });
    const terminal = mkToolCall({ id: "t", status: "success" });
    expect(groupTranscriptBlocks([running, terminal])).toEqual([
      { kind: "single", block: running },
      { kind: "single", block: terminal },
    ]);
    expect(groupTranscriptBlocks([terminal, running])).toEqual([
      { kind: "single", block: terminal },
      { kind: "single", block: running },
    ]);
  });

  it("aggregates a mixed-status stack as mixed with an honest failed count", () => {
    const a = mkToolCall({ id: "a", status: "success" });
    const b = mkToolCall({ id: "b", status: "error" });
    const items = groupTranscriptBlocks([a, b]);
    expect(items).toHaveLength(1);
    const stack = items[0] as { kind: "tool_stack"; status: string; blocks: ToolCallBlock[] };
    expect(stack.status).toBe("mixed");
    expect(stackBadgeText(stack.blocks)).toBe("1 failed");
  });

  it("never wraps a lone eligible card (minimum-2 invariant)", () => {
    const a = mkToolCall({ id: "a" });
    const sep: TranscriptBlock = { kind: "assistant_text", id: "sep", text: "x" };
    const b = mkToolCall({ id: "b" });
    // a and b are both terminal, but separated by a non-tool block → each is a lone single.
    const items = groupTranscriptBlocks([a, sep, b]);
    expect(items.every((it) => it.kind === "single")).toBe(true);
    expect(items.filter((it) => it.kind === "tool_stack")).toHaveLength(0);
  });

  it("preserves block order across a mix of stacks and singles", () => {
    const a = mkToolCall({ id: "a", toolName: "Bash" });
    const b = mkToolCall({ id: "b", toolName: "Read" });
    const sep: TranscriptBlock = { kind: "assistant_text", id: "sep", text: "x" };
    const c = mkToolCall({ id: "c", toolName: "Grep" });
    // a+b form a mixed-type stack; sep breaks the run; c is a lone single.
    const items = groupTranscriptBlocks([a, b, sep, c]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "tool_stack" });
    expect((items[0] as { blocks: ToolCallBlock[] }).blocks.map((blk) => blk.id)).toEqual(["a", "b"]);
    expect(items[1]).toMatchObject({ kind: "single", block: sep });
    expect(items[2]).toMatchObject({ kind: "single" });
  });

  it("starts a fresh run after a gap splits a sequence of terminal calls", () => {
    const a = mkToolCall({ id: "a" });
    const b = mkToolCall({ id: "b" });
    const sep: TranscriptBlock = { kind: "assistant_text", id: "sep", text: "x" };
    const c = mkToolCall({ id: "c" });
    const d = mkToolCall({ id: "d" });
    const items = groupTranscriptBlocks([a, b, sep, c, d]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "tool_stack" });
    expect(items[1]).toMatchObject({ kind: "single", block: sep });
    expect(items[2]).toMatchObject({ kind: "tool_stack" });
  });
});

function retryMeta(overrides: Partial<ErrorRetryMeta> = {}): ErrorRetryMeta {
  return { attemptsMade: 3, maxAttempts: 3, retryable: true, hadModelOutput: false, code: "connect_timeout", ...overrides };
}

describe("formatErrorRetrySuffix (TASK.33 W8 — mirrors cli/render.ts wording)", () => {
  it("is empty when the event carries no retry metadata (pre-W7b byte parity)", () => {
    expect(formatErrorRetrySuffix(undefined)).toBe("");
  });

  it("is empty when the turn never retried (attemptsMade === 0)", () => {
    expect(formatErrorRetrySuffix(retryMeta({ attemptsMade: 0 }))).toBe("");
  });

  it("uses the singular 'attempt' for exactly one retry", () => {
    expect(formatErrorRetrySuffix(retryMeta({ attemptsMade: 1 }))).toBe(" (failed after 1 attempt)");
  });

  it("uses the plural 'attempts' for more than one retry", () => {
    expect(formatErrorRetrySuffix(retryMeta({ attemptsMade: 3 }))).toBe(" (failed after 3 attempts)");
  });
});

describe("formatStreamRetryLine (TASK.33 W8 — mirrors cli/render.ts's '[retry N/M in Xms: reason]')", () => {
  it("formats attempt/limit/delay/reason", () => {
    expect(formatStreamRetryLine(1, 3, 500, "connect refused")).toBe("Retry 1/3 in 500ms: connect refused");
    expect(formatStreamRetryLine(2, 3, 1000, "ECONNRESET")).toBe("Retry 2/3 in 1000ms: ECONNRESET");
  });
});

describe("showTryAgainButton (TASK.33 W8 button-visibility truth-table)", () => {
  const offer: RetryOffer = { loopEndBlockId: "loop_end:turn-1", text: "hello", images: [] };

  it("hidden when there is no armed offer at all (nonretryable / mid-stream — the store never arms `retry`)", () => {
    expect(showTryAgainButton(null, "loop_end:turn-1", "ready")).toBe(false);
  });

  it("shown on the SPECIFIC loop_end block the offer names, while connected", () => {
    expect(showTryAgainButton(offer, "loop_end:turn-1", "ready")).toBe(true);
  });

  it("hidden on any other block — an older failed turn's button never reappears once a newer turn supersedes it", () => {
    expect(showTryAgainButton(offer, "loop_end:turn-0", "ready")).toBe(false);
  });

  it("hidden while the connection is not ready (TASK.33 W8-FIX #1) — a click would silently drop the resend since setHostExited preserves the armed offer", () => {
    expect(showTryAgainButton(offer, "loop_end:turn-1", "host_exited")).toBe(false);
    expect(showTryAgainButton(offer, "loop_end:turn-1", "awaiting_port")).toBe(false);
    expect(showTryAgainButton(offer, "loop_end:turn-1", "awaiting_host_ready")).toBe(false);
  });
});

describe("showStandaloneRetry (TASK.33 FIX-A — fallback row visibility when the anchor is lost to respawn)", () => {
  const offer: RetryOffer = { loopEndBlockId: "loop_end:turn-1", text: "hello", images: [] };
  const anchorBlock: TranscriptBlock = { kind: "loop_end", id: "loop_end:turn-1", reason: "retryable", turns: 1 };
  // Hydration-shaped transcript (store.ts's projectHistoryToBlocks): ids are
  // `${item.id}:${partIdx}`, a namespace that can never contain a live-minted
  // `loop_end:${turnId}` — this is the exact post-respawn shape.
  const hydratedBlocks: TranscriptBlock[] = [
    { kind: "user_text", id: "abc-123:0", text: "hello" },
  ];

  it("hidden when there is no armed offer at all", () => {
    expect(showStandaloneRetry(null, hydratedBlocks, "ready")).toBe(false);
  });

  it("shown when armed + ready + no block in the transcript carries the anchor id (the respawn case)", () => {
    expect(showStandaloneRetry(offer, hydratedBlocks, "ready")).toBe(true);
  });

  it("hidden when the anchor block IS present — mutually exclusive with the anchored button, no double render", () => {
    expect(showStandaloneRetry(offer, [anchorBlock], "ready")).toBe(false);
  });

  it("hidden while the connection is not ready, even with the anchor absent", () => {
    expect(showStandaloneRetry(offer, hydratedBlocks, "host_exited")).toBe(false);
    expect(showStandaloneRetry(offer, hydratedBlocks, "awaiting_port")).toBe(false);
    expect(showStandaloneRetry(offer, hydratedBlocks, "awaiting_host_ready")).toBe(false);
  });

  it("discriminating pair: against a hydration-shaped transcript, showTryAgainButton is false for EVERY block while showStandaloneRetry is true — the unit-level encoding of the defect this fix closes", () => {
    for (const block of hydratedBlocks) {
      expect(showTryAgainButton(offer, block.id, "ready")).toBe(false);
    }
    expect(showStandaloneRetry(offer, hydratedBlocks, "ready")).toBe(true);
  });
});

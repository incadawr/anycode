/**
 * Pure-logic tests for the composer's context-meter percentage (design §2.4).
 * `.test.ts` under a node (no-jsdom) vitest env: `contextMeterPercent` carries
 * the round/guard logic behind the footer meter and is covered directly.
 */
import { describe, expect, it } from "vitest";
import type { CodexRateLimitsWire } from "@anycode/core";
import type { ContextUsage, SessionTokens } from "../store.js";
import type { WireContextBreakdown } from "../../../shared/protocol.js";
import {
  CTX_RING_CIRCUMFERENCE,
  buildQuotaPopoverView,
  contextMeterPercent,
  ctxPopoverAnchorFromRect,
  ctxPopoverBodyState,
  ctxPopoverHeadline,
  ctxPopoverLoading,
  ctxPopoverRows,
  ctxRingDashOffset,
  formatCtxTokenCount,
  formatQuotaCreditsLine,
  formatQuotaWindowLine,
  formatSessionTokensLine,
  formatLatestCacheHitLine,
  hasSendableDraft,
  insertDraftText,
  quotaWindowLabel,
  shouldEnqueue,
  sniffComposerImageMediaType,
} from "./Composer.js";

function usage(estimatedTokens: number, budgetTokens: number): ContextUsage {
  return { estimatedTokens, budgetTokens, source: "provider" };
}

describe("contextMeterPercent", () => {
  it("returns null when there is no reading", () => {
    expect(contextMeterPercent(null)).toBeNull();
  });

  it("rounds estimated/budget to a whole percent", () => {
    expect(contextMeterPercent(usage(4200, 10_000))).toBe(42);
    expect(contextMeterPercent(usage(4250, 10_000))).toBe(43); // 42.5 -> 43
    expect(contextMeterPercent(usage(4249, 10_000))).toBe(42);
  });

  it("reports a full/over-budget reading", () => {
    expect(contextMeterPercent(usage(10_000, 10_000))).toBe(100);
    expect(contextMeterPercent(usage(11_000, 10_000))).toBe(110);
  });

  it("guards against a non-positive budget (no NaN/Infinity)", () => {
    expect(contextMeterPercent(usage(500, 0))).toBeNull();
    expect(contextMeterPercent(usage(500, -1))).toBeNull();
  });
});

describe("ctxRingDashOffset", () => {
  it("returns the full circumference at 0% (empty ring)", () => {
    expect(ctxRingDashOffset(0)).toBe(CTX_RING_CIRCUMFERENCE);
  });

  it("returns half the circumference at 50%", () => {
    expect(ctxRingDashOffset(50)).toBeCloseTo(CTX_RING_CIRCUMFERENCE / 2);
  });

  it("returns 0 at 100% (full ring)", () => {
    expect(ctxRingDashOffset(100)).toBe(0);
  });

  it("clamps out-of-range percentages", () => {
    expect(ctxRingDashOffset(150)).toBe(0);
    expect(ctxRingDashOffset(-5)).toBe(CTX_RING_CIRCUMFERENCE);
  });
});

describe("insertDraftText (R11 starter-chip insert)", () => {
  it("replaces an empty draft and puts the caret at the end", () => {
    expect(insertDraftText("", "Fix it.")).toEqual({ text: "Fix it.", caret: 7 });
  });

  it("appends on a new line for a non-empty draft (never destroys typed input)", () => {
    const result = insertDraftText("hello", "Fix it.");
    expect(result.text).toBe("hello\nFix it.");
    expect(result.caret).toBe(result.text.length);
  });

  it("does not double a trailing newline", () => {
    expect(insertDraftText("hello\n", "Fix it.").text).toBe("hello\nFix it.");
  });
});

describe("shouldEnqueue (F15 — enqueue-vs-direct decision uses the truly-idle predicate)", () => {
  const IN_FLIGHT = { requestId: "r1", item: { id: "i1", text: "x", images: [] } } as const;

  it("direct-sends (returns false) ONLY when truly idle: turn idle AND no item in flight", () => {
    expect(shouldEnqueue("idle", null)).toBe(false);
  });

  it("enqueues while a turn is running (regardless of in-flight slot)", () => {
    expect(shouldEnqueue("running", null)).toBe(true);
    expect(shouldEnqueue("running", IN_FLIGHT)).toBe(true);
  });

  it("enqueues during the in-flight window: turn momentarily idle but a drained item is still in flight (the lost-prompt bug)", () => {
    expect(shouldEnqueue("idle", IN_FLIGHT)).toBe(true);
  });
});

describe("hasSendableDraft (F15 — the running-mode Queue button gate mirrors canSend)", () => {
  it("is false for an empty or whitespace-only draft with no images (button must not be clickable)", () => {
    expect(hasSendableDraft("", 0)).toBe(false);
    expect(hasSendableDraft("   ", 0)).toBe(false);
    expect(hasSendableDraft("\n\t ", 0)).toBe(false);
  });

  it("is true when trimmed text is non-empty", () => {
    expect(hasSendableDraft("hi", 0)).toBe(true);
    expect(hasSendableDraft("  hi  ", 0)).toBe(true);
  });

  it("is true when at least one image is attached even with whitespace-only text", () => {
    expect(hasSendableDraft("   ", 1)).toBe(true);
    expect(hasSendableDraft("", 2)).toBe(true);
  });
});

function breakdown(overrides: Partial<WireContextBreakdown> = {}): WireContextBreakdown {
  return {
    messagesTokens: 900,
    systemToolsTokens: 60,
    mcpToolsTokens: 8,
    skillsTokens: 6,
    systemPromptTokens: 20,
    metaTokens: 6,
    totalEstimatedTokens: 1000,
    ...overrides,
  };
}

describe("formatCtxTokenCount (ctx-popover, slice P7.17 · F12 W3)", () => {
  it("renders sub-1000 counts as a plain rounded integer", () => {
    expect(formatCtxTokenCount(0)).toBe("0");
    expect(formatCtxTokenCount(900)).toBe("900");
    expect(formatCtxTokenCount(999.6)).toBe("1000");
  });

  it("renders thousands with one decimal and a K suffix, trimming a trailing .0", () => {
    expect(formatCtxTokenCount(198_300)).toBe("198.3K");
    expect(formatCtxTokenCount(1_000)).toBe("1K");
    expect(formatCtxTokenCount(1_500)).toBe("1.5K");
  });

  it("renders millions with one decimal and an M suffix, trimming a trailing .0", () => {
    expect(formatCtxTokenCount(1_000_000)).toBe("1M");
    expect(formatCtxTokenCount(2_500_000)).toBe("2.5M");
  });
});

describe("ctxPopoverHeadline (slice P7.17 · F12 W3)", () => {
  it("returns null before the first contextUsage reading or percent", () => {
    expect(ctxPopoverHeadline(null, 20)).toBeNull();
    expect(ctxPopoverHeadline(usage(198_300, 1_000_000), null)).toBeNull();
  });

  it("formats <estimated>/<budget> (<percent>%), reusing the ring-parity percent as-is", () => {
    expect(ctxPopoverHeadline(usage(198_300, 1_000_000), 20)).toBe("198.3K/1M (20%)");
  });
});

describe("ctxPopoverRows (slice P7.17 · F12 W3)", () => {
  it("returns empty before the breakdown has arrived or when totals are non-positive", () => {
    expect(ctxPopoverRows(null)).toEqual([]);
    expect(ctxPopoverRows(breakdown({ totalEstimatedTokens: 0 }))).toEqual([]);
  });

  it("computes each category's percent share of the total, in owner-reference order", () => {
    expect(ctxPopoverRows(breakdown())).toEqual([
      { label: "Messages", percent: 90 },
      { label: "System tools", percent: 6 },
      { label: "MCP tools", percent: 0.8 },
      { label: "Skills", percent: 0.6 },
      { label: "System prompt", percent: 2 },
      { label: "Meta context", percent: 0.6 },
    ]);
  });

  it("hides zero-token categories (e.g. a workspace with no skills/MCP tools)", () => {
    const rows = ctxPopoverRows(breakdown({ mcpToolsTokens: 0, skillsTokens: 0, totalEstimatedTokens: 986 }));
    expect(rows.map((r) => r.label)).toEqual(["Messages", "System tools", "System prompt", "Meta context"]);
  });
});

describe("ctxPopoverLoading (slice P7.17 · F12 W3)", () => {
  it("is true only while open with no breakdown yet", () => {
    expect(ctxPopoverLoading(true, null)).toBe(true);
    expect(ctxPopoverLoading(false, null)).toBe(false);
    expect(ctxPopoverLoading(true, breakdown())).toBe(false);
  });
});

describe("ctxPopoverBodyState (P7.17 W3-FIX P2-a — indefinite-loading-skeleton fix)", () => {
  it("renders the skeleton while loading and the timeout hasn't fired yet", () => {
    expect(ctxPopoverBodyState(true, true, false)).toBe("skeleton");
  });

  it("renders the unavailable-empty state once the loading timeout has elapsed (a lost request)", () => {
    expect(ctxPopoverBodyState(true, true, true)).toBe("empty");
  });

  it("renders rows once loading is false, even if a stale timed-out flag hasn't reset yet", () => {
    // `loading` is false as soon as `contextBreakdown` arrives, so `timedOut`'s
    // value is irrelevant at that point — rows must win either way (the
    // component resets `timedOut` on the same transition, but this function
    // must not rely on that ordering).
    expect(ctxPopoverBodyState(true, false, true)).toBe("rows");
    expect(ctxPopoverBodyState(true, false, false)).toBe("rows");
  });
});

describe("ctxPopoverBodyState — unsupported breakdown (codex-profiles cut §5.2, C-bug-1)", () => {
  it("renders 'unsupported' the instant supportsBreakdown is false, regardless of loading/timedOut", () => {
    // Codex reports supportsContextUsage but never supportsContextBreakdown —
    // this is what stops the popover body from spinning a skeleton forever
    // for an engine that will NEVER answer a context_breakdown_request.
    expect(ctxPopoverBodyState(false, true, false)).toBe("unsupported");
    expect(ctxPopoverBodyState(false, true, true)).toBe("unsupported");
    expect(ctxPopoverBodyState(false, false, false)).toBe("unsupported");
  });
});

describe("ctxPopoverAnchorFromRect (P7.17 W3-FIX P2-b — resize re-clamp fix)", () => {
  it("computes left (right-edge-anchored, offset by the popover width) and bottom (above the trigger)", () => {
    expect(ctxPopoverAnchorFromRect({ right: 800, top: 700 }, 1200, 800)).toEqual({ left: 520, bottom: 108 });
  });

  it("re-clamps left to stay on-screen when the viewport narrows after open (the resize regression)", () => {
    const rect = { right: 800, top: 700 };
    const wide = ctxPopoverAnchorFromRect(rect, 1200, 800);
    expect(wide.left).toBe(520);

    // Same trigger rect (cached from open-time), but the window has since
    // been narrowed — recomputing (as the resize listener now does) must
    // clamp `left` back on-screen instead of reusing the stale wide-viewport
    // value, which would otherwise run the 280px-wide popover off-screen.
    const narrow = ctxPopoverAnchorFromRect(rect, 400, 800);
    expect(narrow.left).toBe(112);
    expect(narrow.left).toBeLessThan(wide.left);
  });
});

describe("formatSessionTokensLine (slice P7.17 · F12 W3)", () => {
  it("returns null when nothing has finished yet this session", () => {
    expect(formatSessionTokensLine(null)).toBeNull();
  });

  it("formats in/out/total with the same compact token formatting", () => {
    const tokens: SessionTokens = { input: 198_300, output: 4_500, total: 202_800 };
    expect(formatSessionTokensLine(tokens)).toBe("in 198.3K · out 4.5K · total 202.8K");
  });
});

describe("formatLatestCacheHitLine", () => {
  it("formats the last provider cache-read metric against that request's input", () => {
    expect(formatLatestCacheHitLine({
      input: 91_700,
      output: 99,
      total: 91_799,
      latestCacheRead: 87_115,
      latestCacheInput: 91_700,
    })).toBe("Latest cache hit: 95% (87.1K/91.7K input)");
  });

  it("states when the active provider did not report a cache metric", () => {
    expect(formatLatestCacheHitLine(null)).toBeNull();
    expect(formatLatestCacheHitLine({ input: 100, output: 5, total: 105 })).toBe(
      "Latest cache hit: not reported by provider",
    );
  });
});

describe("quotaWindowLabel (TASK.51, cut §6.2 — label derived from windowDurationMins, never hardcoded)", () => {
  it("uses the cut's exact table for the five confirmed durations", () => {
    expect(quotaWindowLabel(60, null)).toBe("1h");
    expect(quotaWindowLabel(300, null)).toBe("5h");
    expect(quotaWindowLabel(1440, null)).toBe("Daily");
    expect(quotaWindowLabel(10_080, null)).toBe("Weekly");
    expect(quotaWindowLabel(43_200, null)).toBe("Monthly");
  });

  it("RED-PROOF: derives a nonstandard duration instead of falling back to a hardcoded 5h/Weekly pair", () => {
    // amendment §A3.2: the live plan reports exactly ONE window (10080/Weekly)
    // — a hardcoded "5h"/"Weekly" pair (the old C-bug-1 shape) would pass every
    // assertion above by coincidence. This 90-minute fixture is NOT in the
    // table, so only genuine derivation from windowDurationMins survives it —
    // a hardcoded implementation returns "5h" or "Weekly" here and fails.
    expect(quotaWindowLabel(90, null)).toBe("1.5h");
    // A multi-day, non-tabulated duration exercises the day-rounding branch.
    expect(quotaWindowLabel(2880, null)).toBe("2d");
  });

  it("falls back to limitName, then the literal Limit, when windowDurationMins is absent", () => {
    expect(quotaWindowLabel(null, "Custom limit")).toBe("Custom limit");
    expect(quotaWindowLabel(undefined, null)).toBe("Limit");
  });
});

describe("formatQuotaWindowLine (TASK.51, cut §6.2)", () => {
  it("formats <label> · <percent left>% left · resets in <relative>", () => {
    // resetsAt is epoch SECONDS on the wire (amendment §A3.1); now=0 here and
    // resetsAt=432000s (5 days) exercises the single ×1000 conversion point.
    expect(formatQuotaWindowLine({ usedPercent: 35, windowDurationMins: 10_080, resetsAt: 432_000 }, null, 0)).toBe(
      "Weekly · 65% left · resets in 5d",
    );
  });

  it("omits the resets clause when resetsAt is absent", () => {
    expect(formatQuotaWindowLine({ usedPercent: 20, windowDurationMins: 1440 }, null, 0)).toBe("Daily · 80% left");
  });

  it("returns null for a missing window (never a fabricated 0%)", () => {
    expect(formatQuotaWindowLine(null, null, 0)).toBeNull();
    expect(formatQuotaWindowLine(undefined, null, 0)).toBeNull();
  });
});

describe("formatQuotaCreditsLine (cut §6.2 — rendered ONLY when hasCredits)", () => {
  it("hides the line entirely when hasCredits is false or credits are absent", () => {
    expect(formatQuotaCreditsLine(null)).toBeNull();
    expect(formatQuotaCreditsLine({ hasCredits: false, unlimited: false })).toBeNull();
  });

  it("shows Unlimited for an unlimited plan, ignoring balance", () => {
    expect(formatQuotaCreditsLine({ hasCredits: true, unlimited: true, balance: "0" })).toBe("Credits: Unlimited");
  });

  it("shows the raw wire balance string (never coerced to a number)", () => {
    expect(formatQuotaCreditsLine({ hasCredits: true, unlimited: false, balance: "12.50" })).toBe("Credits: 12.50");
  });
});

function quota(overrides: Partial<CodexRateLimitsWire> = {}): CodexRateLimitsWire {
  return { observedAt: "2026-07-16T00:00:00.000Z", ...overrides };
}

describe("buildQuotaPopoverView (cut §6.2 — hidden block, never 0%)", () => {
  it("returns null when there is no quota snapshot at all", () => {
    expect(buildQuotaPopoverView(null, 0)).toBeNull();
  });

  it("returns null when the snapshot carries no window and no credits (block stays hidden, not 0%)", () => {
    expect(buildQuotaPopoverView(quota({ credits: { hasCredits: false, unlimited: false } }), 0)).toBeNull();
  });

  it("renders the live single-window shape (amendment §A3.2: primary only, secondary present-but-null)", () => {
    const view = buildQuotaPopoverView(
      quota({
        primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 432_000 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        planType: "plus",
      }),
      0,
    );
    expect(view).toEqual({ primaryLine: "Weekly · 65% left · resets in 5d", secondaryLine: null, creditsLine: null });
  });
});

describe("composer image helpers", () => {
  it("sniffs the supported image formats from magic bytes", () => {
    expect(sniffComposerImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffComposerImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(sniffComposerImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(sniffComposerImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(sniffComposerImageMediaType(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
  });
});

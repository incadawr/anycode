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
  ctxMeterLabel,
  CTX_WINDOW_ASSUMED_HINT,
  ctxWindowAssumedHint,
  ctxPopoverLoading,
  ctxPopoverRows,
  ctxRingDashOffset,
  formatCtxTokenCount,
  formatQuotaCreditsLine,
  formatQuotaWindowLine,
  formatUsageCostLedger,
  formatUsageAuditStepRow,
  shouldRefreshUsageAudit,
  currentTurnSteps,
  formatTurnStepSummary,
  hasSendableDraft,
  insertDraftText,
  quotaWindowLabel,
  isImageAttachBlockedByModel,
  isSendBlockedByModelImages,
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

  it("TASK.146: enqueues while a manual compaction holds the session (the host would busy-reject a direct send)", () => {
    expect(shouldEnqueue("compacting", null)).toBe(true);
    expect(shouldEnqueue("compacting", IN_FLIGHT)).toBe(true);
  });

  it("TASK.102 CUT-S2 §10.15.1: a child surface ALWAYS direct-sends (false), even while running or in-flight — its renderer queue has no drainer, so parking there would strand the message forever", () => {
    expect(shouldEnqueue("running", null, true)).toBe(false);
    expect(shouldEnqueue("idle", IN_FLIGHT, true)).toBe(false);
  });

  it("TASK.55 DoD regression: submit while running routes to ENQUEUE, submit while truly idle routes to DIRECT SEND", () => {
    expect(shouldEnqueue("running", null)).toBe(true); // running ⇒ enqueue
    expect(shouldEnqueue("idle", null)).toBe(false); // idle ⇒ direct send
  });

  // Taskana 4110 (TASK.123) branch-table pin for handleSend's steer path:
  // the NEW steer branch sits BEFORE this predicate and takes the message
  // only when ALL of: not a child surface, turn not idle, no images, and
  // `steering.supported === true` (verified end-to-end in session/store
  // tests). shouldEnqueue itself is UNCHANGED — these cases pin that a
  // running-but-UNsupported session still falls through to the queue (the
  // honest fallback: claude, image-bearing sends, legacy hosts).
  it("Taskana 4110: running + steering-unsupported keeps the queue fallback (shouldEnqueue unchanged by the steer branch)", () => {
    // The steer branch never engages when steerSupported is false, so the
    // decision reduces to the pre-4110 predicate verbatim:
    expect(shouldEnqueue("running", null)).toBe(true);
    expect(shouldEnqueue("compacting", null)).toBe(true);
    // Images while running never steer (engine.steer is text-only) — they
    // queue on every engine, supported or not.
    expect(shouldEnqueue("running", IN_FLIGHT)).toBe(true);
    // Truly idle still direct-sends regardless of steering capability.
    expect(shouldEnqueue("idle", null)).toBe(false);
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
  it("computes left (right-edge-anchored, offset by the popover width), bottom (above the trigger) and the room above the trigger", () => {
    expect(ctxPopoverAnchorFromRect({ right: 800, top: 700 }, 1200, 800)).toEqual({ left: 520, bottom: 108, maxHeight: 684 });
  });

  it("keeps the box inside a short window: the height ceiling leaves a margin above the trigger's top edge", () => {
    // 480px tall window, trigger near the bottom (the real composer footer
    // placement): without a ceiling the popover grew upward off-screen and
    // took its header and spend total with it.
    const anchor = ctxPopoverAnchorFromRect({ right: 800, top: 440 }, 1000, 480);
    expect(anchor.maxHeight).toBe(424);
    expect(anchor.bottom).toBe(48);
    // top edge = trigger top - gap - maxHeight, i.e. the 8px viewport margin.
    expect(440 - 8 - anchor.maxHeight).toBe(8);
    // The ceiling never collapses to nothing when the trigger sits high...
    expect(ctxPopoverAnchorFromRect({ right: 800, top: 20 }, 1000, 480).maxHeight).toBe(4);
    // ...and it is a height limit, not a width one.
    expect(anchor.left).toBe(520);
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

describe("isImageAttachBlockedByModel (TASK.56 W3 — model-level attach gate, layered on the engine-level supportsImages; TASK.198 срез D — a configured recognizer fallback unblocks a blind model)", () => {
  it("blocks on an explicit false verdict when no recognizer fallback is configured", () => {
    expect(isImageAttachBlockedByModel(false, undefined)).toBe(true);
  });

  it("does not block on true or on an absent verdict (legacy host / no seam = today's behavior)", () => {
    expect(isImageAttachBlockedByModel(true, undefined)).toBe(false);
    expect(isImageAttachBlockedByModel(undefined, undefined)).toBe(false);
  });

  it("TASK.198: a configured recognizer fallback unblocks a blind model", () => {
    expect(isImageAttachBlockedByModel(false, true)).toBe(false);
  });

  it("TASK.198: an explicit non-true fallback (false) does NOT unblock a blind model", () => {
    expect(isImageAttachBlockedByModel(false, false)).toBe(true);
  });

  it("TASK.198: a vision-capable model is never blocked regardless of fallback state", () => {
    expect(isImageAttachBlockedByModel(true, true)).toBe(false);
    expect(isImageAttachBlockedByModel(true, false)).toBe(false);
  });
});

describe("isSendBlockedByModelImages (TASK.56 W3(c) — attached images on a vision -> non-vision switch block send, never vanish; TASK.198 срез D — recognizer fallback pair)", () => {
  it("blocks send only when the model rejects images AND the draft actually has some attached AND no fallback is configured", () => {
    expect(isSendBlockedByModelImages(false, undefined, 1)).toBe(true);
    expect(isSendBlockedByModelImages(false, undefined, 3)).toBe(true);
  });

  it("does not block a text-only draft even on a false verdict (nothing image-related to block)", () => {
    expect(isSendBlockedByModelImages(false, undefined, 0)).toBe(false);
  });

  it("does not block when the verdict is true or absent, regardless of attachment count", () => {
    expect(isSendBlockedByModelImages(true, undefined, 2)).toBe(false);
    expect(isSendBlockedByModelImages(undefined, undefined, 2)).toBe(false);
  });

  it("TASK.198: a configured recognizer fallback unblocks send for a blind model with attachments", () => {
    expect(isSendBlockedByModelImages(false, true, 3)).toBe(false);
  });

  it("TASK.198: fallback unblocking still respects the zero-attachment short-circuit", () => {
    expect(isSendBlockedByModelImages(false, true, 0)).toBe(false);
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

describe("assumed context window hint (Taskana 4127)", () => {
  it("states the assumption and where to fix it", () => {
    expect(CTX_WINDOW_ASSUMED_HINT).toContain("assumed 8K total");
    const usage = { estimatedTokens: 15500, budgetTokens: 2048 } as Parameters<typeof ctxWindowAssumedHint>[0];
    expect(ctxWindowAssumedHint(usage)).toContain("output reserve: 2K");
    expect(ctxWindowAssumedHint(usage)).toContain("connection settings");
    expect(ctxPopoverHeadline(usage, 757)).toContain("/2K");
    expect(ctxWindowAssumedHint({ ...usage!, budgetTokens: 4096 })).toContain("output reserve: 4.1K");
  });

  it("marks the ctx meter label only when the window is assumed", () => {
    expect(ctxMeterLabel(42, true)).toBe("\u224842% ctx");
    expect(ctxMeterLabel(42, false)).toBe("42% ctx");
  });
});

describe("formatUsageAuditStepRow (Taskana 4083 / TASK.34)", () => {
  it("omits cached/retry parts when undefined/0", () => {
    const base = { turnId: "t1", createdAt: 1, finishReason: "stop" };
    expect(formatUsageAuditStepRow({ ...base, step: 1, inputTokens: 10, outputTokens: 4, transportRetries: 0 })).toBe(
      "step 1 · in 10 · out 4 · cost price unknown",
    );
    expect(
      formatUsageAuditStepRow({ ...base, step: 2, inputTokens: 85_900, cachedInputTokens: 85_400, outputTokens: 500, transportRetries: 2 }),
    ).toBe("step 2 · in 85.9K · cached 85.4K · out 500 · retry 2 · cost price unknown");
  });

  it("shows each stored step's price or subscription without inventing a price", () => {
    const step = { turnId: "t", step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0 };
    expect(formatUsageAuditStepRow({ ...step, costUsd: 0.2 })).toBe("step 1 · cost ≈ $0.2000");
    expect(formatUsageAuditStepRow({ ...step, priceBasisId: "subscription" })).toBe("step 1 · cost by subscription");
    expect(formatUsageAuditStepRow(step)).toBe("step 1 · cost price unknown");
  });
});


describe("Claude result accounting", () => {
  it("names unknown and subscription portions of mixed turns", () => {
    const step = { turnId: "t", step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0 };
    expect(formatTurnStepSummary([{ ...step, priceBasisId: "subscription" }, { ...step, step: 2 }])).toContain("by subscription · some steps price unknown");
    expect(formatTurnStepSummary([{ ...step, priceBasisId: "subscription" }, { ...step, step: 2, costUsd: 1 }])).toContain("plus subscription");
  });
  it("labels the reported aggregate as a turn, even when its price is unknown", () => {
    const turn = { turnId: "t", step: 1, createdAt: 1, finishReason: "result", transportRetries: 0, inputTokens: 100, cachedInputTokens: 80, outputTokens: 5 };
    expect(formatUsageAuditStepRow(turn)).toBe("turn total · in 100 · cached 80 · out 5 · cost price unknown");
    // The turn line reads its own cache percentage off such a row.
    expect(formatTurnStepSummary([{ ...turn, costUsd: 0.2 }])).toBe("This turn: 1 step · ≈ $0.2 · cache 80%");
  });
});

describe("visible cost refresh", () => {
  it("refreshes after a turn or compaction only while the popover is open", () => {
    expect(shouldRefreshUsageAudit(true, "running", "idle")).toBe(true);
    expect(shouldRefreshUsageAudit(true, "compacting", "idle")).toBe(true);
    expect(shouldRefreshUsageAudit(false, "running", "idle")).toBe(false);
    expect(shouldRefreshUsageAudit(true, "idle", "running")).toBe(false);
    expect(shouldRefreshUsageAudit(true, "idle", "idle")).toBe(false);
  });
});

describe("formatUsageCostLedger (one session total, one footnote)", () => {
  const base = { input: 0, output: 0, total: 0, stepsReported: 2, stepsWithCache: 1 };

  it("leads with the session total and folds tokens, savings and the rate basis into one footnote", () => {
    const ledger = formatUsageCostLedger(
      { ...base, input: 142_800, output: 536, total: 143_336, costUsd: 0.0053, cacheSavingsUsd: 0.0378 },
      { input: 142_800, output: 536, total: 143_336 } as SessionTokens,
    );
    expect(ledger).toEqual({
      total: "Spent in this session: ≈ $0.0053",
      qualifier: null,
      subagentSuffix: null,
      footnote: "Tokens in 142.8K · out 536 · cache saved ≈ $0.0378 · estimated rates",
    });
  });

  it("distinguishes short-context estimates from provider-reported costs", () => {
    expect(formatUsageCostLedger({ ...base, costUsd: 1, priceBasisIds: ["gpt-6.1-sol-openai-2026-10-27"] }, null).footnote).toContain("short-context rate estimates");
    expect(formatUsageCostLedger({ ...base, costUsd: 1, priceBasisIds: ["claude-cli-reported"] }, null).footnote).toBeNull();
    expect(formatUsageCostLedger({ ...base, costUsd: 1, priceBasisIds: ["deepseek-v4-pro-deepseek-peak-2026-10-27"] }, null).footnote).toContain("peak-rate estimates");
    // The tariff band rides in the basis id, so an off-peak session is labelled
    // as such — and a session that spans both bands says both. These are
    // exact strings on purpose: "off-peak-rate estimates" contains the
    // substring "peak-rate estimates".
    expect(formatUsageCostLedger({ ...base, costUsd: 1, priceBasisIds: ["deepseek-v4-pro-deepseek-peak-2026-10-27+off-peak"] }, null).footnote)
      .toBe("off-peak-rate estimates");
    expect(formatUsageCostLedger({
      ...base,
      costUsd: 1,
      priceBasisIds: ["deepseek-v4-pro-deepseek-peak-2026-10-27", "deepseek-flash-deepseek-peak-2026-10-27+off-peak"],
    }, null).footnote).toBe("peak & off-peak rate estimates");
  });

  it("shows an honest unknown instead of inventing a price", () => {
    expect(formatUsageCostLedger(null, null)).toEqual({
      total: "Spent in this session: price unknown",
      qualifier: null,
      subagentSuffix: null,
      footnote: null,
    });
    // Tokens known, nothing priced: the tokens still render, no estimate claim.
    expect(formatUsageCostLedger(null, { input: 1_000, output: 20, total: 1_020 })).toEqual({
      total: "Spent in this session: price unknown",
      qualifier: null,
      subagentSuffix: null,
      footnote: "Tokens in 1K · out 20",
    });
  });

  it("marks a lower bound when any parent or child step is unpriced", () => {
    // The qualifier is its own field (rendered on its own line), never a tail
    // of the total that could overflow the popover.
    expect(formatUsageCostLedger({ ...base, costUsd: 0.2, unpricedSteps: 1 }, null))
      .toMatchObject({ total: "Spent in this session: ≥ $0.2000", qualifier: "some steps price unknown" });
    // An unpriced CHILD step makes the session figure a bound too.
    expect(formatUsageCostLedger({ ...base, costUsd: 0.2, subagentCount: 1, subagentUnpriced: 1 }, null))
      .toMatchObject({ total: "Spent in this session: ≥ $0.2000", qualifier: "some steps price unknown" });
  });

  it("keeps the subscription wording, alone and mixed, in sentence case", () => {
    expect(formatUsageCostLedger({ ...base, subscriptionSteps: 1 }, null))
      .toMatchObject({ total: "Spent in this session: by subscription", qualifier: null });
    expect(formatUsageCostLedger({ ...base, subscriptionSteps: 1, unpricedSteps: 1 }, null))
      .toMatchObject({ total: "Spent in this session: by subscription", qualifier: "some steps price unknown" });
    expect(formatUsageCostLedger({ ...base, costUsd: 0.2, subscriptionSteps: 1 }, null))
      .toMatchObject({ total: "Spent in this session: ≈ $0.2000", qualifier: "plus subscription" });
    expect(formatUsageCostLedger({ ...base, costUsd: 0.2, subscriptionSteps: 1, unpricedSteps: 1 }, null).qualifier)
      .toBe("some steps price unknown · plus subscription");
  });

  it("adds the subagent share to the total and names it in a muted suffix", () => {
    const ledger = formatUsageCostLedger(
      { ...base, costUsd: 0.0053, subagentCostUsd: 0.004, subagentCount: 2 },
      null,
    );
    // The total INCLUDES the children: 0.0053 + 0.0040.
    expect(ledger.total).toBe("Spent in this session: ≈ $0.0093");
    expect(ledger.subagentSuffix).toBe("incl. subagents ≈ $0.0040");
  });

  it("keeps the native-Claude caveat beside the number it qualifies", () => {
    expect(
      formatUsageCostLedger({ ...base, costUsd: 0.5, subagentCostUsd: 0.25, subagentCount: 1, subagentIncludedInReportedCost: true }, null)
        .subagentSuffix,
    ).toBe("incl. subagents ≈ $0.2500 · native Claude costs may already be included");
  });

  it("names an unpriced or subscription subagent share without inventing one", () => {
    expect(formatUsageCostLedger({ ...base, costUsd: 0.5, subagentCount: 1, subagentUnpriced: 1 }, null))
      .toMatchObject({ subagentSuffix: "incl. subagents price unknown" });
    expect(formatUsageCostLedger({ ...base, costUsd: 0.5, subagentCount: 1, subagentSubscription: 1 }, null))
      .toMatchObject({ total: "Spent in this session: ≈ $0.5000", qualifier: "plus subscription", subagentSuffix: "incl. subagents by subscription" });
  });

  it("says nothing about subagents when the session has none", () => {
    expect(formatUsageCostLedger({ ...base, costUsd: 0.2, subagentCount: 0 }, null).subagentSuffix).toBeNull();
    expect(formatUsageCostLedger({ ...base, costUsd: 0.2 }, null).subagentSuffix).toBeNull();
  });

  it("flags partly-unknown cache savings inside the same footnote", () => {
    expect(
      formatUsageCostLedger({ ...base, costUsd: 0.2, cacheSavingsUsd: 0.1, unknownSavingsSteps: 1 }, null).footnote,
    ).toBe("cache saved ≈ $0.1000 · some steps savings unknown · estimated rates");
  });

  it("keeps one fact per field so the render never joins them into a clipping line", () => {
    const ledger = formatUsageCostLedger({ ...base, costUsd: 0.2, subagentCostUsd: 0.1, subagentCount: 1 }, null);
    // Exactly the fields the render maps onto separate rows.
    expect(Object.keys(ledger).sort()).toEqual(["footnote", "qualifier", "subagentSuffix", "total"]);
  });
});

describe("currentTurnSteps (ctx popover: one turn at a time)", () => {
  // The host sends `usage_audit` newest-first (pushUsageAudit reverses the last
  // 50 stored rows), so a previous turn's tail sits directly under the new
  // turn's first step. These rows reproduce the reported defect: turn b's
  // steps 1,2 followed by turn a's steps 20,21.
  const list = [
    { turnId: "b", step: 2, createdAt: 50, finishReason: "result", transportRetries: 0 },
    { turnId: "b", step: 1, createdAt: 40, finishReason: "stop", transportRetries: 0 },
    { turnId: "a", step: 21, createdAt: 30, finishReason: "stop", transportRetries: 0 },
    { turnId: "a", step: 20, createdAt: 20, finishReason: "stop", transportRetries: 0 },
  ];

  it("returns only the newest turn's steps, in step order", () => {
    expect(currentTurnSteps(list).map((step) => `${step.turnId}:${step.step}`)).toEqual(["b:1", "b:2"]);
  });

  it("never lets a previous turn's step leak into the new turn", () => {
    const steps = currentTurnSteps(list);
    expect(steps.every((step) => step.turnId === "b")).toBe(true);
    expect(steps.some((step) => step.step === 21)).toBe(false);
  });

  it("identifies the current turn by its newest timestamp, not by list position", () => {
    // Same rows in oldest-first order: still turn b, still ascending.
    expect(currentTurnSteps([...list].reverse()).map((step) => `${step.turnId}:${step.step}`)).toEqual(["b:1", "b:2"]);
  });

  it("returns nothing for an unloaded or empty list", () => {
    expect(currentTurnSteps(null)).toEqual([]);
    expect(currentTurnSteps([])).toEqual([]);
  });
});

describe("formatTurnStepSummary (collapsed per-turn line)", () => {
  const step = (overrides: Partial<Parameters<typeof formatUsageAuditStepRow>[0]> = {}) => ({
    turnId: "t",
    step: 1,
    createdAt: 1,
    finishReason: "stop",
    transportRetries: 0,
    ...overrides,
  });

  it("labels itself as THIS turn: '<n> steps · ≈ <cost> · cache <pct>%'", () => {
    const steps = [
      step({ step: 1, inputTokens: 85_900, cachedInputTokens: 85_400, outputTokens: 100, costUsd: 0.002 }),
      step({ step: 2, inputTokens: 86_000, cachedInputTokens: 85_500, outputTokens: 100, costUsd: 0.002 }),
    ];
    // The "This turn:" prefix is what stops this figure being read as the
    // session total printed directly above it.
    expect(formatTurnStepSummary(steps)).toBe("This turn: 2 steps · ≈ $0.004 · cache 99%");
  });

  it("says 'step' for a single-step turn and drops the cache part when nobody reported it", () => {
    expect(formatTurnStepSummary([step({ inputTokens: 10, outputTokens: 4, costUsd: 1.5 })]))
      .toBe("This turn: 1 step · ≈ $1.5");
  });

  it("never invents a cost or a cache percentage", () => {
    expect(formatTurnStepSummary([step({ inputTokens: 10, outputTokens: 4 })])).toBe("This turn: 1 step · price unknown");
    expect(formatTurnStepSummary([step({ inputTokens: 10, outputTokens: 4, priceBasisId: "subscription" })]))
      .toBe("This turn: 1 step · by subscription");
    // A turn mixing priced and unpriced rows is a lower bound, marked as such.
    expect(formatTurnStepSummary([step({ costUsd: 0.002 }), step({ step: 2 })]))
      .toBe("This turn: 2 steps · ≥ $0.002 · some steps price unknown");
    // Cached input without a reported input count cannot yield a percentage.
    expect(formatTurnStepSummary([step({ cachedInputTokens: 5, costUsd: 0.002 })]))
      .toBe("This turn: 1 step · ≈ $0.002");
  });

  it("has no summary at all when there is no current turn", () => {
    expect(formatTurnStepSummary([])).toBeNull();
  });
});

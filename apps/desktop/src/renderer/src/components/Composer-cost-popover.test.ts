/**
 * Regression tests for the ctx popover's cost block, from a live UI audit of
 * the shipped build (renderer, node env — markup + stylesheet level, no DOM):
 *
 * - the session spend line used to be ONE nowrap/overflow line in a fixed
 *   280px popover, so "· incl. subagents ≈ $0.0041" was clipped ("incl.
 *   subage"). The total now carries only the headline number and each
 *   qualifier gets its own wrapping row;
 * - a step row split "cost ≈" from "$0.0021"; the money group is nowrap;
 * - mixed case mid-sentence ("cost By subscription", "Spent in this
 *   session: Price unknown") — sentence case inside a sentence everywhere,
 *   while the drawer's pricing OPTION stays a capitalised label.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WireUsageAuditStep, WireUsageAuditTotals } from "../../../shared/protocol.js";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { findCatalogEntry } from "@anycode/core/catalog";
import { sessionUsageRow } from "../../../host/usage-recording.js";
import { summarizeWithChildren } from "../../../host/usage-summary.js";
import {
  UsageCostBlock,
  contextWindowSettingsTarget,
  showCustomPricingHint,
  formatTurnStepSummary,
  formatUsageAuditStepRow,
  formatUsageCostLedger,
} from "./Composer.js";

const rendererRoot = resolve(import.meta.dirname, "..");

/** The popover's stylesheets, concatenated (tokens first, like the renderer loads them). */
function popoverCss(): string {
  return ["tokens.css", "app.css"].map((file) => readFileSync(resolve(rendererRoot, file), "utf8")).join("\n");
}

/**
 * Bodies of every flat rule whose selector list contains `selector` exactly.
 * The rules under test are plain one-level rules, so a non-nesting scan is
 * enough (nested @media blocks only ever WRAP such a rule, they never change
 * its body).
 */
function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const block of css.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
    const [selectors = "", body = ""] = block.split("{");
    if (selectors.split(",").map((part) => part.trim()).includes(selector)) {
      bodies.push(body);
    }
  }
  return bodies;
}

function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, "");
}

const base: WireUsageAuditTotals = { input: 0, output: 0, total: 0, stepsReported: 2, stepsWithCache: 1 };
const step = (overrides: Partial<WireUsageAuditStep> = {}): WireUsageAuditStep => ({
  turnId: "turn",
  step: 1,
  createdAt: 1,
  finishReason: "stop",
  transportRetries: 0,
  ...overrides,
});

describe("the session spend line never clips", () => {
  const totals: WireUsageAuditTotals = {
    ...base,
    costUsd: 0.0271,
    subagentCostUsd: 0.0041,
    subagentCount: 1,
    unpricedSteps: 1,
    subscriptionSteps: 1,
  };

  it("renders the total alone, with the qualifier and the subagent share on their own rows", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageCostBlock, { ledger: formatUsageCostLedger(totals, null), turnSummary: null, turnSteps: [], expanded: false, onToggle: () => {} }),
    );
    // The headline number stands alone — it no longer carries the " · …" tail
    // that overflowed the 280px popover.
    expect(markup).toContain('<div class="ctx-popover-total ctx-popover-cost-line" tabindex="0"');
    expect(textOf(markup)).toContain("Spent in this session: ≥ $0.0312");
    // Each qualifier is a block of its own, complete (never truncated) text.
    expect(markup).toContain('<div class="ctx-popover-total-qualifier" title="some steps price unknown · plus subscription">some steps price unknown · plus subscription</div>');
    expect(markup).toContain('<div class="ctx-popover-total-sub" title="incl. subagents ≈ $0.0041">incl. subagents ≈ $0.0041</div>');
    // The total row itself contains no qualifier text.
    const totalRow = /<div class="ctx-popover-total[^"]*"[^>]*>([^<]*)<\/div>/.exec(markup);
    expect(totalRow, "the total row must be plain text, not a container for the qualifiers").not.toBeNull();
    expect(totalRow![1]).toBe("Spent in this session: ≥ $0.0312");
  });

  it("lets the cost line wrap instead of hiding the overflow", () => {
    const bodies = ruleBodies(popoverCss(), ".ctx-popover-cost-line");
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).not.toMatch(/white-space:\s*nowrap/);
    // No hiding mechanism at all: no scroll container, no clipped overflow.
    expect(body).not.toMatch(/overflow(-x|-y)?:\s*(hidden|auto|scroll)/);
    expect(body).not.toMatch(/text-overflow:/);
  });
});

describe("a step row keeps its money group in one piece", () => {
  it("wraps 'cost ≈ <amount>' in one nowrap span and the stylesheet keeps it nowrap", () => {
    const steps = [step({ costUsd: 0.0021, inputTokens: 6_700, cachedInputTokens: 6_400, outputTokens: 120 })];
    const markup = renderToStaticMarkup(
      createElement(UsageCostBlock, { ledger: formatUsageCostLedger({ ...base, costUsd: 0.0021 }, null), turnSummary: formatTurnStepSummary(steps), turnSteps: steps, expanded: true, onToggle: () => {} }),
    );
    expect(markup).toContain('<span class="ctx-popover-step-cost">cost ≈ $0.0021</span>');
    // Readable as one row of text once the markup is stripped.
    expect(textOf(markup)).toContain("step 1 · in 6.7K · cached 6.4K · out 120 · cost ≈ $0.0021");
    const bodies = ruleBodies(popoverCss(), ".ctx-popover-step-cost");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/white-space:\s*nowrap/);
  });
});

describe("sentence case inside a sentence", () => {
  it("writes 'by subscription' and 'price unknown' in the total and in step rows", () => {
    expect(formatUsageCostLedger({ ...base, subscriptionSteps: 1 }, null).total).toBe("Spent in this session: by subscription");
    expect(formatUsageCostLedger({ ...base, subscriptionSteps: 1, unpricedSteps: 1 }, null).qualifier).toBe("some steps price unknown");
    expect(formatUsageAuditStepRow(step({ priceBasisId: "subscription" }))).toBe("step 1 · cost by subscription");
    expect(formatUsageAuditStepRow(step())).toBe("step 1 · cost price unknown");
  });

  it("renders no capitalised cost phrase mid-sentence anywhere in the popover", () => {
    const subscriptionSteps = [step({ priceBasisId: "subscription" }), step({ step: 2 })];
    const markup = renderToStaticMarkup(
      createElement(UsageCostBlock, {
        ledger: formatUsageCostLedger({ ...base, subscriptionSteps: 1, unpricedSteps: 1, subagentCount: 1, subagentSubscription: 1 }, null),
        turnSummary: formatTurnStepSummary(subscriptionSteps),
        turnSteps: subscriptionSteps,
        expanded: true,
        onToggle: () => {},
      }),
    );
    const text = textOf(markup);
    expect(text).toContain("by subscription");
    expect(text).toContain("price unknown");
    expect(text).not.toMatch(/By subscription|Price unknown/);
  });

  it("keeps the capitalised form where it starts a label (the drawer's pricing option)", () => {
    expect(readFileSync(resolve(rendererRoot, "components/ConnectionDrawer.tsx"), "utf8")).toContain(
      '<option value="subscription">By subscription</option>',
    );
  });
});

describe("popover code has no other clipping cost rows", () => {
  it("no popover cost/session rule uses nowrap + hidden overflow together", () => {
    const css = popoverCss();
    const rules = css.match(/\.ctx-popover[^{}]*\{[^{}]*\}/g) ?? [];
    const clipped = rules.filter((rule) => {
      const body = rule.split("{")[1] ?? "";
      return /white-space:\s*nowrap/.test(body) && /overflow(-x|-y)?:\s*(hidden|auto|scroll)/.test(body);
    });
    expect(clipped).toEqual([]);
  });
});


it("shows the sum of model prices and points an unpriced pinned custom connection to settings", () => {
  const markup = renderToStaticMarkup(createElement(UsageCostBlock, { ledger: formatUsageCostLedger({ ...base, costUsd: .003 + .007 }, null), turnSummary: null, turnSteps: [], expanded: false, onToggle: () => {} }));
  expect(textOf(markup)).toContain("Spent in this session: ≈ $0.0100");
  const connections = [{ id: "custom", providerId: "custom:fixture" }, { id: "active", providerId: "z-ai" }];
  const target = contextWindowSettingsTarget(connections, "a", "custom", "active");
  expect(showCustomPricingHint(target, { ...base, unpricedSteps: 1, costUsd: .003 })).toBe(true);
  expect(showCustomPricingHint(target, { ...base, subagentUnpriced: 1 })).toBe(true);
  expect(showCustomPricingHint(target, { ...base, costUsd: .01 })).toBe(false);
  expect(showCustomPricingHint(contextWindowSettingsTarget(connections, "a", "active", "custom"), { ...base, unpricedSteps: 1 })).toBe(false);
});

describe("the popover prices DeepSeek by the step's time of day", () => {
  it("shows the off-peak price at night and labels the estimate off-peak", async () => {
    const pricing = findCatalogEntry("deepseek")!.models.find((model) => model.id === "deepseek-v4-pro")!.pricing!;
    // Wednesday 2026-10-28 20:00 UTC — outside DeepSeek's peak windows.
    const night = Date.UTC(2026, 9, 28, 20, 0);
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };

    // Drive the REAL host recording path (the row builder the session sink
    // calls) with a controlled clock, persist it, close, reopen and read the
    // summary the popover actually renders. Building the ledger straight from
    // `calculateUsageCost` would still pass if the host stopped passing the
    // timestamp, and night sessions would then persist peak prices.
    const row = sessionUsageRow(
      { turnId: "turn-night", step: 1, finishReason: "stop", transportRetries: 0, model: "deepseek-v4-pro", ...usage },
      { price: pricing, pricingRaw: undefined, model: "deepseek-v4-pro", now: () => night },
      "night-session",
    );
    expect(row.costUsd).toBeCloseTo(2.64); // half of the $5.28 peak ceiling
    expect(row.priceBasisId).toBe("deepseek-v4-pro-deepseek-peak-2026-10-27+off-peak");

    const dir = mkdtempSync(join(tmpdir(), "anycode-popover-night-"));
    const dbPath = join(dir, "usage.db");
    try {
      const first = new SqlitePersistenceAdapter(dbPath);
      try {
        await first.createSession({ id: "night-session", workspace: "/w", model: "deepseek-v4-pro", mode: "build" });
        await first.recordProviderUsage(row);
      } finally {
        await first.close();
      }
      const reopened = new SqlitePersistenceAdapter(dbPath);
      try {
        const summary = await summarizeWithChildren(reopened, "night-session");
        const ledger = formatUsageCostLedger(summary.totals, null);
        expect(ledger.total).toBe("Spent in this session: ≈ $2.6400");
        // The footnote is a " · "-joined list: assert the band as a WHOLE part
        // ("off-peak-rate estimates" contains the substring "peak-rate
        // estimates", so a substring check would be blind here).
        const parts = ledger.footnote?.split(" · ") ?? [];
        expect(parts).toContain("off-peak-rate estimates");
        expect(parts).not.toContain("peak-rate estimates");

        const markup = renderToStaticMarkup(
          createElement(UsageCostBlock, { ledger, turnSummary: null, turnSteps: [], expanded: false, onToggle: () => {} }),
        );
        const text = textOf(markup);
        expect(text).toContain("Spent in this session: ≈ $2.6400");
        expect(text).toContain("off-peak-rate estimates");
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

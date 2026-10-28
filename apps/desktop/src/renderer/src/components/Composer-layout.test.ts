import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatTurnStepSummary, formatUsageCostLedger, UsageCostBlock } from "./Composer.js";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("cost popover layout", () => {
  it.skipIf(!existsSync(chrome))("renders every cost row without clipping at 280px", () => {
    const step = { turnId: "turn", step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0 };
    const steps = [
      { ...step, costUsd: 0.2, inputTokens: 100_000, cachedInputTokens: 99_000, outputTokens: 400 },
      { ...step, step: 2, costUsd: 0.0021, inputTokens: 6_700, cachedInputTokens: 6_400, outputTokens: 120 },
      { ...step, step: 3, priceBasisId: "subscription" },
    ];
    const ledger = formatUsageCostLedger({ input: 142_800, output: 536, total: 143_336, stepsReported: 3, stepsWithCache: 1, costUsd: 0.2, unpricedSteps: 1, subscriptionSteps: 1, subagentCount: 1, subagentCostUsd: 0.1, subagentIncludedInReportedCost: true, cacheSavingsUsd: 0.04, unknownSavingsSteps: 1, priceBasisIds: ["deepseek-v4-pro-deepseek-peak-2026-10-27"] }, null);
    // Expanded: the step rows are part of the same anti-clipping contract.
    const markup = renderToStaticMarkup(createElement(UsageCostBlock, { ledger, turnSummary: formatTurnStepSummary(steps), turnSteps: steps, expanded: true, onToggle: () => {} }));
    const cssRoot = resolve(import.meta.dirname, "..");
    const css = ["tokens.css", "app.css"].map((file) => readFileSync(resolve(cssRoot, file), "utf8")).join("\n");
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-cost-layout-"));
    try {
      const file = resolve(directory, "fixture.html");
      writeFileSync(file, `<style>${css}</style><div class="ctx-popover" style="position:static;animation:none">${markup}</div><pre id="result"></pre><script>
        const rows = [...document.querySelectorAll('.ctx-popover-total, .ctx-popover-total-qualifier, .ctx-popover-total-sub, .ctx-popover-steps-toggle, .ctx-popover-footnote, .ctx-popover-step-row')];
        const box = row => { const style = getComputedStyle(row); const line = parseFloat(style.lineHeight); const font = parseFloat(style.fontSize); const old = row.scrollLeft; row.scrollLeft = row.scrollWidth; return { height: row.getBoundingClientRect().height, line: Number.isFinite(line) ? line : font * 1.2, width: row.clientWidth, content: row.scrollWidth, canScroll: row.scrollLeft > old, title: row.title, text: row.textContent, whiteSpace: style.whiteSpace, overflowX: style.overflowX, overflowY: style.overflowY }; };
        const metrics = rows.map(box);
        // A money group must never split across lines: one client rect per span.
        const costs = [...document.querySelectorAll('.ctx-popover-step-cost')].map(span => ({ text: span.textContent, lines: span.getClientRects().length, right: span.getBoundingClientRect().right, popRight: document.querySelector('.ctx-popover').getBoundingClientRect().right }));
        document.querySelector('#result').textContent = JSON.stringify({ popWidth: document.querySelector('.ctx-popover').getBoundingClientRect().width, metrics, costs });
      </script>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-features=OverlayScrollbar", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as {
        popWidth: number;
        metrics: Array<{ height: number; line: number; width: number; content: number; canScroll: boolean; title: string; text: string; whiteSpace: string; overflowX: string; overflowY: string }>;
        costs: Array<{ text: string; lines: number; right: number; popRight: number }>;
      };
      expect(result.popWidth).toBe(280);
      // total, qualifier, subagent share, turn line, footnote, three step rows.
      expect(result.metrics).toHaveLength(8);
      for (const row of result.metrics) {
        // Wrapping, never a scroll/clip container: everything fits inside the row.
        expect(row.whiteSpace).not.toBe("nowrap");
        expect(row.overflowX).not.toBe("hidden");
        expect(row.overflowX).not.toBe("auto");
        expect(row.overflowY).not.toBe("hidden");
        expect(row.canScroll).toBe(false);
        expect(row.content).toBeLessThanOrEqual(row.width);
        expect(row.width).toBeLessThan(280);
      }
      // DOM order: total, qualifier, subagent share, turn line, step rows…, footnote.
      const total = result.metrics[0]!;
      const qualifier = result.metrics[1]!;
      const sub = result.metrics[2]!;
      const turn = result.metrics[3]!;
      const footnote = result.metrics[7]!;
      expect(total.text).toBe("Spent in this session: ≥ $0.3000");
      expect(total.text).not.toContain("incl. subagents");
      expect(total.title).toContain("incl. subagents");
      expect(qualifier.text).toBe("some steps price unknown · plus subscription");
      expect(sub.text).toContain("incl. subagents ≈ $0.1000");
      expect(sub.text).toContain("may already be included");
      expect(turn.text).toContain("This turn: 3 steps");
      expect(footnote.text).toContain("peak-rate estimates");
      expect(footnote.height).toBeGreaterThan(footnote.line);
      // A5: "cost ≈ $0.0021" is one unbreakable group inside a 280px popover.
      expect(result.costs).toHaveLength(3);
      for (const cost of result.costs) {
        expect(cost.lines).toBe(1);
        expect(cost.right).toBeLessThanOrEqual(cost.popRight);
      }
      expect(result.costs[1]!.text).toBe("cost ≈ $0.0021");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 40_000);
});

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
  it.skipIf(!existsSync(chrome))("renders cost qualifiers without clipping at 280px", () => {
    const step = { turnId: "turn", step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0 };
    const steps = [{ ...step, costUsd: 0.2, inputTokens: 100_000, cachedInputTokens: 99_000 }, { ...step, step: 2 }, { ...step, step: 3, priceBasisId: "subscription" }];
    const ledger = formatUsageCostLedger({ input: 142_800, output: 536, total: 143_336, stepsReported: 3, stepsWithCache: 1, costUsd: 0.2, unpricedSteps: 1, subscriptionSteps: 1, subagentCount: 1, subagentCostUsd: 0.1, subagentIncludedInReportedCost: true, cacheSavingsUsd: 0.04, unknownSavingsSteps: 1, priceBasisIds: ["deepseek-v4-pro-deepseek-peak-2026-10-27"] }, null);
    const markup = renderToStaticMarkup(createElement(UsageCostBlock, { ledger, turnSummary: formatTurnStepSummary(steps), turnSteps: steps, expanded: false, onToggle: () => {} }));
    const cssRoot = resolve(import.meta.dirname, "..");
    const css = ["tokens.css", "app.css"].map((file) => readFileSync(resolve(cssRoot, file), "utf8")).join("\n");
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-cost-layout-"));
    try {
      const file = resolve(directory, "fixture.html");
      writeFileSync(file, `<style>${css}</style><div class="ctx-popover" style="position:static;animation:none">${markup}</div><pre id="result"></pre><script>
        const rows = [...document.querySelectorAll('.ctx-popover-cost-line, .ctx-popover-footnote')];
        const metrics = rows.map(row => { const line = parseFloat(getComputedStyle(row).lineHeight); const font = parseFloat(getComputedStyle(row).fontSize); const height = row.getBoundingClientRect().height; const old = row.scrollLeft; row.scrollLeft = row.scrollWidth; const style = getComputedStyle(row); return { height, line: Number.isFinite(line) ? line : font * 1.2, width: row.clientWidth, content: row.scrollWidth, canScroll: row.scrollLeft > old, title: row.title, text: row.textContent, whiteSpace: style.whiteSpace, overflowX: style.overflowX, overflowY: style.overflowY }; });
        document.querySelector('#result').textContent = JSON.stringify({popWidth: document.querySelector('.ctx-popover').getBoundingClientRect().width, metrics});
      </script>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-features=OverlayScrollbar", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as { popWidth: number; metrics: Array<{ height: number; line: number; width: number; content: number; canScroll: boolean; title: string; text: string; whiteSpace: string; overflowX: string; overflowY: string }> };
      expect(result.popWidth).toBe(280);
      expect(result.metrics).toHaveLength(3);
      for (const row of result.metrics.slice(0, 2)) {
        expect(row.height).toBeLessThanOrEqual(row.line + 8);
        expect(row.width).toBeLessThan(280);
        expect(row.title.length).toBeGreaterThan(0);
        if (row.content > row.width) expect(row.canScroll).toBe(true);
      }
      expect(result.metrics[0]!.title).toContain("price unknown");
      expect(result.metrics[0]!.title).toContain("subscription");
      expect(result.metrics[0]!.title).toContain("may already be included");
      expect(result.metrics[1]!.title).toContain("subscription");
      const footnote = result.metrics[2]!;
      expect(footnote.text).toContain("peak-rate estimates");
      expect(footnote.whiteSpace).not.toBe("nowrap");
      expect(footnote.overflowX).toBe("visible");
      expect(footnote.overflowY).toBe("visible");
      expect(footnote.content).toBeLessThanOrEqual(footnote.width);
      expect(footnote.height).toBeGreaterThan(footnote.line);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 40_000);
});

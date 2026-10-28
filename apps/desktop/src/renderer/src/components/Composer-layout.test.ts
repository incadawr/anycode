import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatTurnStepSummary, formatUsageCostLedger, ctxPopoverAnchorFromRect, UsageCostBlock } from "./Composer.js";

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

  it.skipIf(!existsSync(chrome))("keeps a long expanded turn on screen and scrolls its body in a short window", () => {
    const steps = Array.from({ length: 30 }, (_, index) => ({
      turnId: "turn",
      step: index + 1,
      createdAt: index + 1,
      finishReason: "stop",
      transportRetries: 0,
      costUsd: 0.0021,
      inputTokens: 6_700,
      cachedInputTokens: 6_400,
      outputTokens: 120,
    }));
    const ledger = formatUsageCostLedger({
      input: 201_000, output: 3_600, total: 204_600, stepsReported: 30, stepsWithCache: 30,
      costUsd: 0.063, unpricedSteps: 0, subscriptionSteps: 0, subagentCount: 0, subagentCostUsd: 0,
      subagentIncludedInReportedCost: false, cacheSavingsUsd: 0, unknownSavingsSteps: 0,
      priceBasisIds: ["deepseek-v4-pro-deepseek-peak-2026-10-27"],
    }, null);
    const markup = renderToStaticMarkup(createElement(UsageCostBlock, {
      ledger, turnSummary: formatTurnStepSummary(steps), turnSteps: steps, expanded: true, onToggle: () => {},
    }));
    const cssRoot = resolve(import.meta.dirname, "..");
    const css = ["tokens.css", "app.css"].map((file) => readFileSync(resolve(cssRoot, file), "utf8")).join("\n");
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-cost-viewport-"));
    const args = (file: string) => ["--headless", "--no-sandbox", "--disable-gpu", "--disable-features=OverlayScrollbar", "--disable-background-networking", "--no-first-run", "--window-size=1000,480", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`];
    const dump = (file: string) => {
      const run = spawnSync(chrome, args(file), { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      return JSON.parse(match![1]!);
    };
    try {
      // Pass 1: the short viewport this window size actually gives us; the
      // anchor is then computed for the REAL geometry, exactly like the
      // component does on open.
      const probe = resolve(directory, "probe.html");
      writeFileSync(probe, `<pre id="result"></pre><script>document.querySelector('#result').textContent = JSON.stringify({ width: window.innerWidth, height: window.innerHeight });</script>`);
      const viewport = dump(probe) as { width: number; height: number };
      // A composer footer trigger near the bottom of the window is the real
      // placement of the ctx meter; the room above it is what must bound the
      // popover.
      const triggerRect = { right: viewport.width - 20, top: viewport.height - 40 };
      const anchor = ctxPopoverAnchorFromRect(triggerRect, viewport.width, viewport.height);
      const file = resolve(directory, "short-window.html");
      writeFileSync(file, `<style>${css}
        html, body { margin: 0; height: 100%; }
        #trigger { position: fixed; left: ${triggerRect.right - 200}px; top: ${triggerRect.top}px; width: 200px; height: 28px; }
      </style>
      <div id="trigger" aria-hidden="true"></div>
      <div class="ctx-popover" role="dialog" aria-label="Context window breakdown" style="position:fixed;left:${anchor.left}px;bottom:${anchor.bottom}px;max-height:${anchor.maxHeight}px;animation:none">
        <div class="ctx-popover-header"><span class="ctx-popover-title">Context window</span><span class="ctx-popover-headline">204.6K/1M (20%)</span></div>
        <div class="ctx-popover-body">
          <div class="ctx-popover-bar"><div class="ctx-popover-bar-fill" style="width:20%"></div></div>
          <div class="ctx-popover-divider"></div>
          ${markup}
        </div>
      </div>
      <pre id="result"></pre><script>
        const trigger = document.querySelector('#trigger').getBoundingClientRect();
        const pop = document.querySelector('.ctx-popover');
        const popBox = pop.getBoundingClientRect();
        const header = pop.querySelector('.ctx-popover-header');
        const body = pop.querySelector('.ctx-popover-body');
        const style = getComputedStyle(body);
        const rows = [...pop.querySelectorAll('.ctx-popover-step-row')];
        const popTop = popBox.top;
        const headerVisibleAtTop = header.getBoundingClientRect().top >= popBox.top - 1;
        body.scrollTop = body.scrollHeight;
        const bodyBox = body.getBoundingClientRect();
        const lastRow = rows[rows.length - 1].getBoundingClientRect();
        document.querySelector('#result').textContent = JSON.stringify({
          viewport: { width: window.innerWidth, height: window.innerHeight },
          triggerTop: trigger.top,
          popTop, popBottom: popBox.bottom, popHeight: popBox.height, popWidth: popBox.width,
          maxHeight: parseFloat(getComputedStyle(pop).maxHeight),
          overflowY: style.overflowY,
          scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
          scrollTopAfterScroll: body.scrollTop,
          headerVisibleAtTop,
          headerVisibleAfterScroll: header.getBoundingClientRect().top >= popBox.top - 1,
          lastRowReachable: lastRow.bottom <= bodyBox.bottom + 1 && lastRow.top >= bodyBox.top - 1,
          rowCount: rows.length,
        });
      </script>`);
      const result = dump(file) as {
        viewport: { width: number; height: number };
        triggerTop: number; popTop: number; popBottom: number; popHeight: number; popWidth: number;
        maxHeight: number; overflowY: string; scrollHeight: number; clientHeight: number;
        scrollTopAfterScroll: number; headerVisibleAtTop: boolean; headerVisibleAfterScroll: boolean;
        lastRowReachable: boolean; rowCount: number;
      };
      // A short window: the 480px-class minimum, not the 600px default.
      expect(result.viewport.height).toBeLessThanOrEqual(480);
      expect(result.rowCount).toBe(30);
      expect(result.popWidth).toBe(280);
      // The whole box stays inside the window, above the trigger that anchors
      // it — no part of the popover (header, spend total, qualifiers) is
      // pushed off the top edge.
      expect(result.popTop).toBeGreaterThanOrEqual(0);
      expect(result.popBottom).toBeLessThanOrEqual(result.triggerTop);
      expect(result.popHeight).toBeLessThanOrEqual(result.maxHeight + 1);
      expect(result.maxHeight).toBeGreaterThan(0);
      // Overflow goes into a vertical scroll inside the body; the header
      // stays pinned and every expanded step is reachable.
      expect(result.overflowY).toBe("auto");
      expect(result.scrollHeight).toBeGreaterThan(result.clientHeight);
      expect(result.headerVisibleAtTop).toBe(true);
      expect(result.headerVisibleAfterScroll).toBe(true);
      expect(result.scrollTopAfterScroll).toBeGreaterThan(0);
      expect(result.lastRowReachable).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatTurnStepSummary, formatUsageCostLedger, ctxPopoverAnchorFromRect, UsageCostBlock } from "./Composer.js";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("main window controls", () => {
  it.skipIf(!existsSync(chrome))("keeps composer controls usable and workflow states distinct in both themes", () => {
    const cssRoot = resolve(import.meta.dirname, "..");
    const css = ["tokens.css", "app.css", "tool-cards.css", "ui/ui.css"].map(file => readFileSync(resolve(cssRoot, file), "utf8")).join("\n");
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-control-layout-"));
    try {
      const file = resolve(directory, "fixture.html");
      writeFileSync(file, `<!doctype html><html data-theme="dark"><style>${css}</style><body>
        <div class="composer-footer"><button class="mode-chip mode-chip-build">Build</button><button class="model-pill-chip">Model</button><button class="composer-attach">+</button></div>
        <div class="workflow-ticks" style="width:30px;max-width:none"><span class="workflow-tick substatus-running"></span>${'<span class="workflow-tick substatus-queued"></span>'.repeat(8)}</div>
        <span class="ak-chip--selected">Selected</span><pre id="result"></pre>
        <script>
          const read = () => {
            const style = selector => getComputedStyle(document.querySelector(selector));
            const controls = ['.mode-chip', '.model-pill-chip', '.composer-attach'].map(selector => { const s=style(selector); return {height:s.height, background:s.backgroundColor, border:s.borderTopColor}; });
            return {controls, controlBg:style('html').getPropertyValue('--bg-control').trim(), running:style('.substatus-running').borderRadius, queued:style('.substatus-queued').borderRadius, runningWidth:document.querySelector('.substatus-running').getBoundingClientRect().width, queuedWidth:document.querySelector('.substatus-queued').getBoundingClientRect().width, text:style('.ak-chip--selected').color, text1:style('html').getPropertyValue('--text-1').trim()};
          };
          const dark=read(); document.documentElement.dataset.theme='light'; const light=read(); document.querySelector('#result').textContent=JSON.stringify({dark,light});
        </script></body></html>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], {encoding:"utf8", timeout:30_000});
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as Record<string, {controls:Array<{height:string; background:string; border:string}>; running:string; queued:string; runningWidth:number; queuedWidth:number; text:string}>;
      for (const state of Object.values(result)) {
        expect(state.controls.map(control => control.height)).toEqual(["28px", "28px", "28px"]);
        expect(new Set(state.controls.map(control => control.background)).size).toBe(1);
        expect(new Set(state.controls.map(control => control.border)).size).toBe(1);
        expect(state.running).not.toBe(state.queued);
        expect(state.queuedWidth).toBe(2);
        expect(state.runningWidth).toBeGreaterThanOrEqual(6);
      }
      expect(result.dark!.text).toBe("rgb(236, 233, 227)");
      expect(result.light!.text).toBe("rgb(28, 26, 23)");
    } finally { rmSync(directory, {recursive:true, force:true}); }
  }, 60_000);
});

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
        // The usage bar and its divider are text-less flex children with a
        // fixed height: they must keep that height instead of being squeezed
        // to 0px while the long turn overflows the body. Their natural height
        // is measured from the same markup in an unconstrained column, so the
        // assertion does not hard-code 4px / 1px.
        const bar = pop.querySelector('.ctx-popover-bar');
        const divider = pop.querySelector('.ctx-popover-divider');
        const natural = document.createElement('div');
        natural.className = 'ctx-popover-body';
        natural.style.cssText = 'position:fixed;top:0;left:0;width:280px;height:auto;overflow:visible;z-index:-1';
        natural.innerHTML = '<div class="ctx-popover-bar"></div><div class="ctx-popover-divider"></div>';
        document.body.appendChild(natural);
        const naturalBarHeight = natural.querySelector('.ctx-popover-bar').getBoundingClientRect().height;
        const naturalDividerHeight = natural.querySelector('.ctx-popover-divider').getBoundingClientRect().height;
        natural.remove();
        const barBox = bar.getBoundingClientRect();
        const bodyBoxAtRest = body.getBoundingClientRect();
        const barFillHeight = bar.querySelector('.ctx-popover-bar-fill').getBoundingClientRect().height;
        const dividerHeight = divider.getBoundingClientRect().height;
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
          barHeight: barBox.height, barTop: barBox.top, barBottom: barBox.bottom,
          barFillHeight, dividerHeight, naturalBarHeight, naturalDividerHeight,
          bodyTopAtRest: bodyBoxAtRest.top, bodyBottomAtRest: bodyBoxAtRest.bottom,
        });
      </script>`);
      const result = dump(file) as {
        viewport: { width: number; height: number };
        triggerTop: number; popTop: number; popBottom: number; popHeight: number; popWidth: number;
        maxHeight: number; overflowY: string; scrollHeight: number; clientHeight: number;
        scrollTopAfterScroll: number; headerVisibleAtTop: boolean; headerVisibleAfterScroll: boolean;
        lastRowReachable: boolean; rowCount: number;
        barHeight: number; barTop: number; barBottom: number; barFillHeight: number;
        dividerHeight: number; naturalBarHeight: number; naturalDividerHeight: number;
        bodyTopAtRest: number; bodyBottomAtRest: number;
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
      // The usage bar and its divider keep their natural height (4px / 1px):
      // a long expanded turn must not squeeze them out of existence.
      expect(result.naturalBarHeight).toBeCloseTo(4, 1);
      expect(result.barHeight).toBeCloseTo(result.naturalBarHeight, 1);
      expect(result.barFillHeight).toBeCloseTo(result.barHeight, 1);
      expect(result.naturalDividerHeight).toBeCloseTo(1, 1);
      expect(result.dividerHeight).toBeCloseTo(result.naturalDividerHeight, 1);
      // …and the bar is visible at the top of the scroll, inside the body.
      expect(result.barTop).toBeGreaterThanOrEqual(result.bodyTopAtRest - 1);
      expect(result.barBottom).toBeLessThanOrEqual(result.bodyBottomAtRest + 1);
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

  it.skipIf(!existsSync(chrome))("tints the usage bar warning / danger near the limit", () => {
    // The fill is neutral by default; at ≥80% / ≥95% the popover carries
    // the same warning/danger class as its trigger and the fill must resolve
    // `currentColor` to that tint. The rule lives in app.css, so a comment
    // above it that the parser does not treat as a comment silently drops it
    // and the bar stays blue all the way to the limit.
    const cssRoot = resolve(import.meta.dirname, "..");
    const css = ["tokens.css", "app.css"].map((file) => readFileSync(resolve(cssRoot, file), "utf8")).join("\n");
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-ctx-bar-tint-"));
    try {
      const popover = (tint: string, percent: number): string =>
        `<div class="ctx-popover${tint}" style="position:static;animation:none">` +
        `<div class="ctx-popover-bar"><div class="ctx-popover-bar-fill" style="width:${percent}%"></div></div></div>`;
      const file = resolve(directory, "meter-tint.html");
      writeFileSync(file, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body>
        ${popover("", 20)}
        ${popover(" composer-ctx-meter-warning", 85)}
        ${popover(" composer-ctx-meter-danger", 97)}
        <div id="accent" style="background: var(--text-2)"></div>
        <pre id="result"></pre><script>
          const read = pop => ({ color: getComputedStyle(pop).color, fill: getComputedStyle(pop.querySelector('.ctx-popover-bar-fill')).backgroundColor });
          document.querySelector('#result').textContent = JSON.stringify({
            cases: [...document.querySelectorAll('.ctx-popover')].map(read),
            accent: getComputedStyle(document.querySelector('#accent')).backgroundColor,
          });
        </script></body></html>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as { cases: Array<{ color: string; fill: string }>; accent: string };
      const [normal, warning, danger] = result.cases;
      // The tokens resolve in a themed document: the accent is a real colour.
      expect(result.accent).toMatch(/^rgb\(/);
      // Below the limit the fill is neutral, not the inherited text colour.
      expect(normal!.fill).toBe(result.accent);
      expect(normal!.color).not.toBe(result.accent);
      // At the limit it is the popover's own colour (currentColor), not the accent.
      expect(warning!.fill).toBe(warning!.color);
      expect(danger!.fill).toBe(danger!.color);
      expect(warning!.fill).not.toBe(result.accent);
      expect(danger!.fill).not.toBe(result.accent);
      // …and the two tints stay distinct from each other.
      expect(warning!.fill).not.toBe(danger!.fill);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 40_000);
});

describe("composer chip row geometry", () => {
  /**
   * The owner-reported chip-row bug: the Orchestrate text chip wrapped to two
   * lines and its ink painted past the footer's fixed 28px height, reading as
   * overlapping buttons. The contract: every chip stays one 28px line, the
   * row never overflows (session footer clips; the start screen's open footer
   * must not spill into the send column), and narrow width truncates labels
   * with an ellipsis instead of wrapping or overlapping.
   */
  it.skipIf(!existsSync(chrome))("keeps the codex chip row one fixed-height line, no wrap and no overlap, at narrow and wide widths", () => {
    const cssRoot = resolve(import.meta.dirname, "..");
    const css = ["tokens.css", "app.css"].map((file) => readFileSync(resolve(cssRoot, file), "utf8")).join("\n");
    // One codex session row (overflow-hidden footer) and one start-screen
    // codex draft row (overflow-visible footer), each at wide and narrow
    // width — the four surfaces of one contract, verified in a single run.
    const row = (id: string, width: number, start: boolean): string =>
      `<div class="composer${start ? " start-composer" : ""}" style="width:${width}px">` +
      `<div class="composer-footer"><div class="composer-footer-left" id="${id}">` +
      `<button class="orchestrate-toggle" aria-pressed="true" aria-label="Orchestrate"><svg width="16" height="16"></svg></button>` +
      `<div class="model-pill"><button class="model-pill-chip"><span class="model-pill-label">Full access</span><svg class="model-pill-chevron" width="12" height="12"></svg></button></div>` +
      `<button class="composer-attach"><svg width="16" height="16"></svg></button>` +
      `<div class="model-pill"><button class="model-pill-chip"><span class="model-pill-label">GPT-6.1-Sol · medium</span><svg class="model-pill-chevron" width="12" height="12"></svg></button></div>` +
      `</div><div class="composer-footer-right"><button class="composer-send">Send</button></div></div></div>`;
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-chip-row-layout-"));
    try {
      const file = resolve(directory, "fixture.html");
      writeFileSync(file, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body>
        ${row("session-wide", 700, false)}
        ${row("session-narrow", 300, false)}
        ${row("start-wide", 700, true)}
        ${row("start-narrow", 300, true)}
        <pre id="result"></pre><script>
          const read = id => {
            const left = document.getElementById(id);
            const chips = [...left.children].filter(el => el.getBoundingClientRect().height > 0);
            const boxes = chips.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, scrollH: el.scrollHeight, clientH: el.clientHeight }; });
            // Pairwise overlap probe, in row order (flex layout never reorders).
            const overlaps = [];
            for (let i = 1; i < boxes.length; i++) if (boxes[i].left < boxes[i - 1].right - 0.6) overlaps.push(i);
            const label = left.querySelector('.model-pill:last-child .model-pill-label');
            return {
              heights: boxes.map(box => box.height),
              wrapped: boxes.filter(box => box.scrollH > box.clientH + 0.6).length,
              overlaps,
              rowSpill: left.scrollWidth - left.clientWidth,
              rightEdge: left.getBoundingClientRect().right,
              sendLeft: left.parentElement.querySelector('.composer-footer-right').getBoundingClientRect().left,
              labelTruncated: label.scrollWidth - label.clientWidth > 0.6,
              toggleWidth: left.querySelector('.orchestrate-toggle').getBoundingClientRect().width,
            };
          };
          const ids = ['session-wide', 'session-narrow', 'start-wide', 'start-narrow'];
          document.querySelector('#result').textContent = JSON.stringify(Object.fromEntries(ids.map(id => [id, read(id)])));
        </script></body></html>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as Record<string, { heights: number[]; wrapped: number; overlaps: number[]; rowSpill: number; rightEdge: number; sendLeft: number; labelTruncated: boolean; toggleWidth: number }>;
      for (const [id, row] of Object.entries(result)) {
        // One fixed-height line: every control is the 28px footer surface and
        // nothing grew a second line of ink.
        expect(row.heights, id).toEqual([28, 28, 28, 28]);
        expect(row.wrapped, id).toBe(0);
        expect(row.overlaps, id).toEqual([]);
        expect(row.toggleWidth, id).toBe(28);
      }
      // Narrow must truncate, not clip: the model label actually ellipsizes.
      expect(result["session-narrow"]!.labelTruncated).toBe(true);
      // The session footer contains its row (the chips FIT in the clipped box,
      // ellipsis did the yielding — not the clip edge).
      expect(result["session-narrow"]!.rowSpill).toBeLessThanOrEqual(0.6);
      // The start screen's overflow-visible footer must not spill into the
      // send column at either width.
      for (const id of ["start-wide", "start-narrow"]) {
        expect(result[id]!.rightEdge).toBeLessThanOrEqual(result[id]!.sendLeft + 0.6);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);
});

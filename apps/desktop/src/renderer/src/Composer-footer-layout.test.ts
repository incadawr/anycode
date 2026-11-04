import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The composer bottom row (admission preset, speed chip, attach, model pill,
 * context meter, stop/send) must stay overlap-free at any composer width:
 * the footer-left box has to shrink to its grid column instead of holding
 * its whole nowrap content width, which would slide the model pill under
 * the context meter in a narrow pane. Like the CSS audit tests, the honest
 * check is the browser's own layout over the shipped `tokens.css` +
 * `app.css` — measured with getBoundingClientRect at three window widths,
 * each rendering a full-width composer plus two pane-narrow ones. Skipped
 * where Chrome is absent.
 */
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const stylesRoot = import.meta.dirname;
const css = ["tokens.css", "app.css"].map((file) => readFileSync(resolve(stylesRoot, file), "utf8")).join("\n");

const MODEL_LABEL = "GPT-6.1 Terra · high";
/** 600 stays under the 640px container query (no hint column), 400/340 squeeze. */
const COMPOSER_WIDTHS = [600, 400, 340, 690];

const fixture = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}
  body { margin: 0; }
  .composer { width: var(--probe-width) !important; }
</style></head><body>
  ${COMPOSER_WIDTHS.map(
    (width) => `<div class="composer" style="--probe-width:${width}px">
    <div class="composer-footer">
      <div class="composer-footer-left">
        <div class="model-pill"><button type="button" class="model-pill-chip"><span class="model-pill-label">Read Only</span></button></div>
        <button type="button" class="model-pill-chip" title="Standard"><span class="model-pill-label">Standard</span></button>
        <button type="button" class="composer-attach"><span>+</span></button>
        <div class="model-pill"><button type="button" class="model-pill-chip" title="${MODEL_LABEL}"><span class="model-pill-label">${MODEL_LABEL}</span><span class="model-pill-chevron">▾</span></button></div>
      </div>
      <span class="composer-hint visually-hidden">Enter send · Shift+Enter newline</span>
      <div class="composer-footer-right">
        <div class="ctx-popover-root"><button type="button" class="composer-ctx-meter composer-ctx-meter-danger"><svg class="composer-ctx-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle class="composer-ctx-ring-track" cx="7" cy="7" r="6" fill="none" stroke-width="1.5"/><circle class="composer-ctx-ring-fill" cx="7" cy="7" r="6" fill="none" stroke-width="1.5"/></svg>93% ctx</button></div>
        <button type="button" class="composer-stop"><span>■</span></button>
      </div>
    </div>
  </div>`.replace(/\n/g, ""),
  ).join("\n")}
  <pre id="result"></pre><script>
    const rows = [...document.querySelectorAll('.composer')].map((root) => {
      const q = (selector) => root.querySelector(selector);
      const rect = (selector) => q(selector).getBoundingClientRect();
      const pills = [...root.querySelectorAll('.composer-footer-left .model-pill')];
      const pillBox = pills[pills.length - 1].getBoundingClientRect();
      const label = pills[pills.length - 1].querySelector('.model-pill-label');
      return {
        width: parseInt(root.style.getPropertyValue('--probe-width'), 10),
        windowWidth: window.innerWidth,
        pillRight: pillBox.right,
        meterLeft: q('.composer-ctx-meter').getBoundingClientRect().left,
        leftRight: q('.composer-footer-left').getBoundingClientRect().right,
        rightLeft: q('.composer-footer-right').getBoundingClientRect().left,
        composerRight: root.getBoundingClientRect().right,
        hintLeft: q('.composer-hint').getBoundingClientRect().left,
        labelClient: label.clientWidth,
        labelScroll: label.scrollWidth,
        tooltip: pills[pills.length - 1].querySelector('.model-pill-chip').title,
        kids: [...root.querySelectorAll('.composer-footer-left > *, .composer-footer-right > *')].map((el) => {
          const s = getComputedStyle(el);
          return { cls: String(el.className), cw: el.clientWidth, sw: el.scrollWidth, ox: s.overflowX, to: s.textOverflow };
        }),
      };
    });
    document.querySelector('#result').textContent = JSON.stringify(rows);
  </script></body></html>`;

describe("composer bottom row layout", () => {
  it.skipIf(!existsSync(chrome))("keeps the model pill clear of the context meter at narrow widths", () => {
    const widths = [1280, 720, 500];
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-footer-layout-"));
    try {
      const file = resolve(directory, "footer.html");
      writeFileSync(file, fixture);
      for (const windowWidth of widths) {
        const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile-${windowWidth}`, `--window-size=${windowWidth},600`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
        expect(run.status, run.stderr).toBe(0);
        const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
        expect(match, run.stdout.slice(-500)).not.toBeNull();
        const rows = JSON.parse(match![1]!) as Array<{ width: number; windowWidth: number; pillRight: number; meterLeft: number; leftRight: number; rightLeft: number; composerRight: number; hintLeft: number; labelClient: number; labelScroll: number; tooltip: string; kids: Array<{ cls: string; cw: number; sw: number; ox: string; to: string }> }>;
        expect(rows.map((row) => row.width)).toEqual(COMPOSER_WIDTHS);
        for (const row of rows) {
          // The pill never slides under the context meter, and the left
          // column never spills into the right one, at any width.
          expect(row.pillRight, `window ${windowWidth} width ${row.width}`).toBeLessThanOrEqual(row.meterLeft + 0.5);
          expect(row.leftRight, `window ${windowWidth} width ${row.width}`).toBeLessThanOrEqual(row.rightLeft + 0.5);
          // The row stays inside the composer card on both sides.
          expect(row.rightLeft, `window ${windowWidth} width ${row.width}`).toBeLessThanOrEqual(row.composerRight + 0.5);
          // The full model name stays reachable via the tooltip.
          expect(row.tooltip).toBe(MODEL_LABEL);
          // Per control: the content stays inside its own border box — or the
          // element itself is the clipping layer (overflow hidden + ellipsis).
          // A squeezed chip must never paint past its own border.
          for (const kid of row.kids) {
            expect(kid.sw <= kid.cw + 1 || (kid.ox === "hidden" && kid.to === "ellipsis"), `window ${windowWidth} width ${row.width} <${kid.cls}> content ${kid.sw} > box ${kid.cw}`).toBe(true);
          }
        }
        // Squeezing truncates the model label instead of overlapping. A
        // pane under the 640px container query that fits the row shows the
        // whole name; the two narrow panes truncate (and so does a wide
        // pane's pill, which yields room to the centered hint column). The
        // 400px pane keeps over a quarter of the label's width as truncation
        // slack, so a somewhat narrower system font cannot flip it to "fits".
        const [wide2col, squeezed, tight, wide3col] = rows;
        if (wide2col!.windowWidth > wide2col!.width + 1) {
          expect(wide2col!.labelScroll, `window ${windowWidth}: ${JSON.stringify(rows)}`).toBeLessThanOrEqual(wide2col!.labelClient + 1);
        }
        expect(squeezed!.labelScroll).toBeGreaterThan(squeezed!.labelClient + 1);
        expect(tight!.labelScroll).toBeGreaterThan(tight!.labelClient + 1);
        // Above the container query the inline hint takes the middle grid
        // column; the pill may truncate but must never run under it.
        if (wide3col!.windowWidth > wide3col!.width + 1) {
          expect(wide3col!.pillRight, `hint underlap at window ${windowWidth}: ${JSON.stringify(rows)}`).toBeLessThanOrEqual(wide3col!.hintLeft + 0.5);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

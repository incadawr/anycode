import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Layout regressions from the UI/UX audit C8/C9/C12. These are CSS-only fixes,
 * so the honest test is the browser's own computed style over the real
 * `tokens.css` + `app.css` — no component stub can prove that a chip uses the
 * free space. Skipped where Chrome is absent, like css-comments.test.ts.
 */
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const stylesRoot = import.meta.dirname;
const css = ["tokens.css", "app.css"].map((file) => readFileSync(resolve(stylesRoot, file), "utf8")).join("\n");

const markup = (footerWidth: number): string => `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}
  body { margin: 0; }
  #narrow { width: 140px; }
</style></head><body>
  <div class="composer-footer" id="wide" style="display:flex;width:${footerWidth}px">
    <div class="composer-footer-left">
      <span class="mode-chip">Build</span>
      <div class="model-pill"><button type="button" class="model-pill-chip">
        <span class="model-pill-label" id="label-wide">Claude Sonnet 4.5 · Thinking high</span>
      </button></div>
    </div>
  </div>
  <div class="composer-footer" id="narrow" style="display:flex;width:140px">
    <div class="composer-footer-left">
      <span class="mode-chip">Build</span>
      <div class="model-pill"><button type="button" class="model-pill-chip">
        <span class="model-pill-label" id="label-narrow">Claude Sonnet 4.5 · Thinking high</span>
      </button></div>
    </div>
  </div>
  <div class="md-preview-view"><div class="md-preview-view-body"><div class="md-preview-view-rendered message-markdown">
    <table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
  </div></div></div>
  <div class="message-markdown" id="transcript"><table class="md-table"><tbody><tr><td id="t-cell">1</td></tr></tbody></table></div>
  <button class="sidebar-row sidebar-row-open" id="row-current" aria-current="true">Current</button>
  <button class="sidebar-row sidebar-row-open" id="row-open">Open in background</button>
  <pre id="result"></pre><script>
    const wideLabel = document.querySelector('#label-wide');
    const narrowLabel = document.querySelector('#label-narrow');
    const narrowChip = document.querySelector('#narrow .model-pill-chip').getBoundingClientRect();
    const narrowFooter = document.querySelector('#narrow .composer-footer-left').getBoundingClientRect();
    const cell = getComputedStyle(document.querySelector('.md-preview-view-rendered .md-table td'));
    const th = getComputedStyle(document.querySelector('.md-preview-view-rendered .md-table th'));
    const transcriptCell = getComputedStyle(document.querySelector('#t-cell'));
    const current = getComputedStyle(document.querySelector('#row-current'));
    const open = getComputedStyle(document.querySelector('#row-open'));
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    document.querySelector('#result').textContent = JSON.stringify({
      wide: { clipped: wideLabel.scrollWidth > wideLabel.clientWidth + 1 },
      narrow: {
        clipped: narrowLabel.scrollWidth > narrowLabel.clientWidth + 1,
        fits: narrowChip.right <= narrowFooter.right + 0.5,
      },
      previewCell: { width: cell.borderLeftWidth, style: cell.borderLeftStyle },
      previewHead: { width: th.borderBottomWidth, background: th.backgroundColor },
      transcriptCell: { width: transcriptCell.borderLeftWidth, style: transcriptCell.borderLeftStyle },
      sidebar: { current: current.boxShadow, open: open.boxShadow, accent },
    });
  </script></body></html>`;

describe("UI audit C8/C9/C12 — computed styles over the shipped CSS", () => {
  it.skipIf(!existsSync(chrome))("uses footer space, frames preview tables, marks one active row", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-css-audit-"));
    try {
      const file = resolve(directory, "audit.html");
      writeFileSync(file, markup(640));
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as {
        wide: { clipped: boolean };
        narrow: { clipped: boolean; fits: boolean };
        previewCell: { width: string; style: string };
        previewHead: { width: string; background: string };
        transcriptCell: { width: string; style: string };
        sidebar: { current: string; open: string; accent: string };
      };

      // C8 — a short model name in a footer with room must not be ellipsized.
      expect(result.wide.clipped).toBe(false);
      // C8 — a cramped footer still truncates, and the chip must not overflow it.
      expect(result.narrow.clipped).toBe(true);
      expect(result.narrow.fits).toBe(true);

      // C9 — the document preview frames cells; the transcript keeps row rules.
      expect(result.previewCell).toEqual({ width: "1px", style: "solid" });
      expect(result.previewHead.width).toBe("1px");
      expect(result.previewHead.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(result.transcriptCell).toEqual({ width: "0px", style: "none" });

      // C12 — exactly one row (the current tab) wears the accent bar; another
      // open tab is marked, but differently.
      expect(result.sidebar.current).not.toBe(result.sidebar.open);
      expect(result.sidebar.current).toContain("2px");
      expect(result.sidebar.open).toContain("2px");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

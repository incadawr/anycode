import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const css = ["tokens.css", "accents.css", "ui/ui.css", "app.css", "settings.css"].map((file) => readFileSync(resolve(import.meta.dirname, file), "utf8")).join("\n");
const tile = (selected: boolean) => `<div class="connection-tile${selected ? " connection-tile-selected" : ""}" style="width:208px"><button class="connection-tile-select"><div class="connection-tile-header"><span class="connection-tile-provider">An exceptionally long provider label for this connection</span><span class="connection-tile-selected-marker">${selected ? '<svg class="connection-tile-selected-icon"></svg>' : ''}</span></div><div class="connection-tile-name">Connection</div><div class="connection-tile-model">Model</div><div class="connection-quota">5h · 80% left · resets in 2h\nWeekly · 60% left · resets in 5d</div></button></div>`;

describe("connection tile layout", () => {
  it.skipIf(!existsSync(chrome))("keeps headers aligned and both quota windows readable", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-tile-layout-"));
    try {
      const file = resolve(directory, "tile.html");
      writeFileSync(file, `<!doctype html><style>${css}</style>${tile(false)}${tile(true)}<pre id="result"></pre><script>document.querySelector('#result').textContent=JSON.stringify([...document.querySelectorAll('.connection-tile')].map(t=>{const h=t.querySelector('.connection-tile-header'), p=t.querySelector('.connection-tile-provider'), q=t.querySelector('.connection-quota'), s=getComputedStyle(p), qs=getComputedStyle(q); return {height:h.getBoundingClientRect().height, white:s.whiteSpace, ellipsis:s.textOverflow, labelHeight:p.getBoundingClientRect().height, line:parseFloat(s.lineHeight), quotaHeight:q.getBoundingClientRect().height, quotaLine:parseFloat(qs.lineHeight), client:q.clientWidth, scroll:q.scrollWidth};}));</script>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const rows = JSON.parse(match![1]!) as Array<{height:number; white:string; ellipsis:string; quotaHeight:number; quotaLine:number; client:number; scroll:number}>;
      expect(rows[0]!.height).toBeCloseTo(rows[1]!.height, 1);
      for (const row of rows) {
        expect(row.white).toBe("nowrap");
        expect(row.ellipsis).toBe("ellipsis");
        expect(row.quotaHeight).toBeGreaterThanOrEqual(row.quotaLine * 1.9);
        expect(row.scroll).toBeLessThanOrEqual(row.client + 1);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 60000);
});

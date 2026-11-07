import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
it.skipIf(!existsSync(chrome))("preserves the branch after the folder collapses and never wraps the trigger", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "environment-layout-"));
  const css = ["tokens.css", "app.css"].map(f => readFileSync(resolve(import.meta.dirname, "..", f), "utf8")).join("\n");
  try {
    const file = resolve(dir, "index.html");
    writeFileSync(file, `<style>${css}</style>${[1000, 600, 320].map(width => `<header class="session-header" style="width:${width}px"><span class="session-header-title">Project</span><div class="environment-control environment-control-header"><button class="environment-trigger environment-trigger-has-branch"><svg></svg><span class="environment-workspace">a-very-long-workspace-folder-name</span><span class="environment-separator">/</span><svg></svg><span class="environment-branch">feature/a-very-long-branch-name-for-review</span><span>⌄</span></button></div><button class="session-extensions-trigger"><svg width="16"></svg><span class="session-extensions-label">Extensions</span></button></header>`).join("")}<pre id="result"></pre><script>
    document.querySelector('#result').textContent=JSON.stringify([...document.querySelectorAll('header')].map(h=>{const q=s=>h.querySelector(s), b=q('.environment-branch'),t=q('.environment-trigger');return {folder:getComputedStyle(q('.environment-workspace')).display,extensions:getComputedStyle(q('.session-extensions-label')).display,branch:b.clientWidth,scroll:b.scrollWidth,nowrap:getComputedStyle(t).flexWrap,overflow:h.scrollWidth>h.clientWidth+1};}));</script>`);
    const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${dir}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
    expect(run.status, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)![1]!) as Array<{folder:string;extensions:string;branch:number;scroll:number;nowrap:string;overflow:boolean}>;
    expect(rows[0]!.folder).not.toBe("none");
    expect(rows[0]!.extensions).not.toBe("none");
    for (const row of rows.slice(1)) {
      expect(row.folder).toBe("none"); expect(row.extensions).toBe("none");
      expect(row.branch).toBeGreaterThan(20); expect(row.nowrap).toBe("nowrap"); expect(row.overflow).toBe(false);
    }
    expect(rows[2]!.branch).toBeLessThan(rows[2]!.scroll);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

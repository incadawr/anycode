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
    writeFileSync(file, `<html data-platform="darwin"><style>${css}</style>${[1000, 600, 320].map(width => `<header class="session-header" style="width:${width}px"><span class="session-header-title">Project</span><div class="environment-control environment-control-header"><button class="environment-trigger environment-trigger-has-branch"><svg></svg><span class="environment-workspace">a-very-long-workspace-folder-name</span><span class="environment-separator">/</span><svg></svg><span class="environment-branch">feature/a-very-long-branch-name-for-review</span><span class="environment-risks"><span class="environment-risk-icons"><svg width="16"></svg><svg width="16"></svg></span><span class="environment-risk-summary"><svg width="16"></svg>2</span></span><span>⌄</span></button></div><button class="session-extensions-trigger"><svg width="16"></svg><span class="session-extensions-label">Extensions</span></button></header>`).join("")}<pre id="result"></pre><script>
    document.querySelector('#result').textContent=JSON.stringify([...document.querySelectorAll('header')].map(h=>{const q=s=>h.querySelector(s), b=q('.environment-branch'),t=q('.environment-trigger');return {risks:getComputedStyle(q(".environment-risk-icons")).display,summary:getComputedStyle(q(".environment-risk-summary")).display,folder:getComputedStyle(q('.environment-workspace')).display,extensions:getComputedStyle(q('.session-extensions-label')).display,branch:b.clientWidth,scroll:b.scrollWidth,nowrap:getComputedStyle(t).flexWrap,overflow:h.scrollWidth>h.clientWidth+1};}));</script>`);
    const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${dir}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
    expect(run.status, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)![1]!) as Array<{risks:string;summary:string;folder:string;extensions:string;branch:number;scroll:number;nowrap:string;overflow:boolean}>;
    expect(rows[0]!.risks).not.toBe("none"); expect(rows[0]!.summary).toBe("none");
    expect(rows[0]!.folder).not.toBe("none");
    expect(rows[0]!.extensions).not.toBe("none");
    for (const row of rows.slice(1)) {
      expect(row.risks).toBe("none"); expect(row.summary).not.toBe("none");
      expect(row.folder).toBe("none"); expect(row.extensions).toBe("none");
      expect(row.branch, JSON.stringify(rows)).toBeGreaterThan(20); expect(row.nowrap).toBe("nowrap"); expect(row.overflow).toBe(false);
    }
    expect(rows[2]!.branch).toBeLessThan(rows[2]!.scroll);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

it("removes the separate header chips while keeping child worktree policy controls", () => {
  const header = readFileSync(new URL("./SessionHeader.tsx", import.meta.url), "utf8");
  expect(header).not.toMatch(/session-header-worktree|session-header-browser-access/);
  expect(header).toContain("<ChildWorktreeControl");
});

it.skipIf(!existsSync(chrome))("keeps the child worktree label within its trigger under header pressure", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "child-worktree-layout-"));
  const css = ["tokens.css", "app.css"].map(f => readFileSync(resolve(import.meta.dirname, "..", f), "utf8")).join("\n");
  try {
    const file = resolve(dir, "index.html");
    writeFileSync(file, `<html><style>${css}</style>${[900, 450, 80].map(width => `<div style="display:flex;width:${width}px"><span style="min-width:0;flex:1 1 auto">A long session title that can shrink</span><details class="environment-control child-worktree-control"><summary class="environment-trigger"><span>Child worktrees · ON</span></summary></details><div style="min-width:0;flex:1 1 auto;overflow:hidden">Workspace / master ●2 ↑2306 ↓2767</div></div>`).join("")}<pre id="result"></pre><script>document.querySelector('#result').textContent=JSON.stringify([...document.querySelectorAll('summary')].map(s=>({width:s.clientWidth,scroll:s.scrollWidth,label:s.querySelector('span').getBoundingClientRect().width, labelScroll:s.querySelector('span').scrollWidth})));</script>`);
    const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${dir}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
    expect(run.status, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)![1]!) as Array<{width:number;scroll:number;label:number;labelScroll:number}>;
    for (const row of rows) expect(row.scroll).toBeLessThanOrEqual(row.width + 1);
    for (const row of rows.slice(0, 2)) expect(row.label + 1).toBeGreaterThanOrEqual(row.labelScroll);
    expect(rows[2]!.label).toBeLessThan(rows[2]!.labelScroll);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

it.skipIf(!existsSync(chrome))("keeps crowded header controls and Git indicators inside their boxes", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "crowded-header-"));
  const css = ["tokens.css", "app.css"].map(f => readFileSync(resolve(import.meta.dirname, "..", f), "utf8")).join("\n");
  try {
    const file = resolve(dir, "index.html");
    const header = (windowWidth: number) => `<header class="session-header" style="width:${windowWidth - 264}px"><span class="session-header-title session-header-title-wrap">A crowded session header demonstrating child worktree layout and review</span><span class="engine-identity session-header-engine">Codex</span><details class="environment-control child-worktree-control"><summary class="environment-trigger"><span>Child worktrees</span></summary></details><div class="environment-control environment-control-header"><button class="environment-trigger environment-trigger-has-branch"><svg></svg><span class="environment-workspace">a-very-long-workspace-folder-name</span><span class="environment-separator">/</span><svg></svg><span class="environment-branch">master</span><span class="environment-git-count">●2</span><span class="environment-git-count">↑2306 ↓2767</span><span>⌄</span></button></div><button class="session-extensions-trigger"><svg width="16" height="16"></svg><span class="session-extensions-label">Extensions</span></button><span class="session-header-connection"><svg width="8" height="8"></svg></span></header>`;
    writeFileSync(file, `<html data-platform="darwin"><style>${css}</style>${[900, 1400].map(header).join("")}<pre id="result"></pre><script>
      document.querySelector('#result').textContent=JSON.stringify([...document.querySelectorAll('header')].map(h=>{const controls=[...h.children].map(e=>e.getBoundingClientRect());const pills=[...h.querySelectorAll('.environment-trigger')].map(p=>{const box=p.getBoundingClientRect();return {width:p.clientWidth,scroll:p.scrollWidth, outside:[...p.children].filter(c=>getComputedStyle(c).display!=='none').some(c=>{const r=c.getBoundingClientRect();return r.left<box.left-1||r.right>box.right+1})}});return {overlap:controls.some((r,i)=>i>0&&r.left<controls[i-1].right-1), pills, overflow:h.scrollWidth>h.clientWidth+1}}));</script>`);
    const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${dir}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
    expect(run.status, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)![1]!) as Array<{overlap:boolean;overflow:boolean;pills:Array<{width:number;scroll:number;outside:boolean}>}>;
    for (const row of rows) {
      expect(row.overlap, JSON.stringify(row)).toBe(false);
      expect(row.overflow, JSON.stringify(row)).toBe(false);
      for (const pill of row.pills) {
        expect(pill.outside, JSON.stringify(row)).toBe(false);
        expect(pill.scroll, JSON.stringify(row)).toBeLessThanOrEqual(pill.width + 1);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

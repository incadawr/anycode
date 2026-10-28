import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const stylesRoot = import.meta.dirname;

const stylesheets = (): string[] =>
  readdirSync(stylesRoot, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".css"))
    .map((entry) => resolve(stylesRoot, entry));

/**
 * A comment terminator written INSIDE a comment closes it early. Everything
 * up to the next `{` is then read as a selector, so the browser throws the
 * following rule away without a word — exactly what a `mcp-*`-style glob
 * ending in a slash does. Quoted values are blanked out first so a legitimate
 * `content: "/*"` string cannot be mistaken for comment structure.
 */
function commentFaults(css: string): string[] {
  const faults: string[] = [];
  const source = css.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (match) => " ".repeat(match.length));
  let open = false;
  for (const match of source.matchAll(/\/\*|\*\//g)) {
    const line = source.slice(0, match.index).split("\n").length;
    if (match[0] === "/*") {
      if (open) faults.push(`line ${line}: a comment opens inside another comment`);
      open = true;
    } else if (open) {
      open = false;
    } else {
      faults.push(`line ${line}: this terminator has no opening comment before it, so the text before it reads as a selector and the next rule is dropped`);
    }
  }
  if (open) faults.push("a comment opens and is never closed");
  return faults;
}

describe("renderer stylesheets — comment integrity", () => {
  it("opens and closes every comment exactly once", () => {
    const files = stylesheets();
    expect(files.length).toBeGreaterThan(9);
    const faults = files.flatMap((file) => commentFaults(readFileSync(file, "utf8")).map((fault) => `${file.endsWith(".css") ? file.slice(stylesRoot.length + 1) : file}: ${fault}`));
    expect(faults).toEqual([]);
  });

  it.skipIf(!existsSync(chrome))("keeps the rules that follow those comments in force", () => {
    // Rule-level counterpart: the layout rule right after each repaired
    // comment must actually apply. `.git-panel` follows the GUI-git comment
    // and `.skills-pane` the Skills-pane one.
    const css = ["tokens.css", "app.css", "settings.css"]
      .map((file) => readFileSync(resolve(stylesRoot, file), "utf8"))
      .join("\n");
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-css-comments-"));
    try {
      const file = resolve(directory, "rules.html");
      writeFileSync(file, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body>
        <aside class="git-panel" id="git"></aside>
        <div class="skills-pane" id="skills"></div>
        <pre id="result"></pre><script>
          const git = getComputedStyle(document.querySelector('#git'));
          const skills = getComputedStyle(document.querySelector('#skills'));
          document.querySelector('#result').textContent = JSON.stringify({
            git: { position: git.position, display: git.display },
            skills: { rowGap: skills.rowGap },
          });
        </script></body></html>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as { git: { position: string; display: string }; skills: { rowGap: string } };
      expect(result.git.position).toBe("relative");
      expect(result.git.display).toBe("flex");
      expect(result.skills.rowGap).toBe("16px");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});

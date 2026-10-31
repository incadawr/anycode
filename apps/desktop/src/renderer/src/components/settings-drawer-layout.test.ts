import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Layout faults need a real engine to pin them, so this runs a headless
 * browser against the shipped stylesheet: the advanced form's field-to-field
 * gutter, the secondary hint size, and the custom-provider row size (it used
 * to inherit the 16px body size and read as a heading). Markup below mirrors
 * the drawer's classes.
 */
describe("connection drawer field rhythm", () => {
  it.skipIf(!existsSync(chrome))("separates advanced fields and sizes hints/rows like the rest of Settings", () => {
    const root = resolve(import.meta.dirname, "..");
    const css = ["tokens.css", "settings.css"].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");
    const directory = mkdtempSync(resolve(tmpdir(), "anycode-drawer-layout-"));
    try {
      const file = resolve(directory, "fixture.html");
      writeFileSync(file, `<style>${css}</style><details class="connection-drawer-advanced" open>
        <summary>Advanced</summary>
        <label class="settings-field">
          <span class="settings-field-label">Max output tokens</span>
          <input class="settings-field-input" value="8192">
          <span class="settings-field-hint">Blank = provider default.</span>
        </label>
        <label class="settings-field">
          <span class="settings-field-label">Context window</span>
          <input class="settings-field-input" placeholder="Auto uses the catalog.">
        </label>
        <label class="settings-field connection-drawer-model-curation">
          <legend class="settings-field-label">Models to show in the selector</legend>
          <label class="settings-field-checkbox connection-drawer-model-curation-row"><input type="checkbox" checked>model-a</label>
        </label>
      </details>
      <div class="custom-provider-row"><span class="custom-provider-name">Local endpoint</span><span class="custom-provider-detail">http://localhost:1234/v1</span></div>
      <pre id="result"></pre>
      <script>
        const advanced = document.querySelector('.connection-drawer-advanced');
        const hint = document.querySelector('.connection-drawer-advanced .settings-field-hint');
        const name = document.querySelector('.custom-provider-name');
        const detail = document.querySelector('.custom-provider-detail');
        const curation = document.querySelector('.connection-drawer-model-curation');
        document.querySelector('#result').textContent = JSON.stringify({
          gap: parseFloat(getComputedStyle(advanced).rowGap),
          hint: parseFloat(getComputedStyle(hint).fontSize),
          name: parseFloat(getComputedStyle(name).fontSize),
          detail: parseFloat(getComputedStyle(detail).fontSize),
          curationDisplay: getComputedStyle(curation).display,
        });
      </script>`);
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${directory}/profile`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      expect(match).not.toBeNull();
      const result = JSON.parse(match![1]!) as { gap: number; hint: number; name: number; detail: number; curationDisplay: string };
      // sp-4 = 16px: a hint no longer sits as close to the next label as to its own input.
      expect(result.gap).toBe(16);
      // Hints are secondary (fs-xs = 12px), not the same size as a field label.
      expect(result.hint).toBe(12);
      // The custom-provider row matches the rest of the Settings list (fs-md = 14px), not body 16px.
      expect(result.name).toBe(14);
      expect(result.detail).toBe(12);
      expect(result.curationDisplay).toBe("grid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

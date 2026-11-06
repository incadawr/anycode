import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @vitest-environment jsdom
/**
 * Mounted regression gate for the subscription key link (jsdom — see
 * WelcomeScreen.test.ts's docstring for why this lives in its own file):
 * pick GLM, manually move the form's Provider select to OpenAI, then click
 * the GLM tile again. The re-pick is a fresh seed — the form must come back
 * ON the GLM template, not keep showing OpenAI while the "Get a GLM Coding
 * Plan key" link revives above it. The bare subscription state no-ops on an
 * identical re-pick, so the form's mount key carries a pick nonce: without it
 * the reset pick bookkeeping describes a form that was never remounted and
 * the link and the form disagree (exactly what this test pins).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import { cloneDefaults } from "../../../settings/schema.js";
import { useSettingsStore } from "../settings-store.js";
import { WelcomeScreen } from "./WelcomeScreen.js";
import type { SettingsSnapshot } from "../../../shared/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

const originalSettingsState = useSettingsStore.getState();

function snapshot(): SettingsSnapshot {
  return {
    settings: cloneDefaults(),
    secrets: [],
    providerReady: false,
    envOverrides: [],
    readOnly: false,
    catalog: getBuiltinCatalog().providers.map(entry => ({ id: entry.id, name: entry.name, authKind: entry.auth.kind, models: entry.models, defaultTransport: entry.defaultTransport, supportedTransports: entry.supportedTransports, ...(entry.brand ? { brand: entry.brand } : {}), ...(entry.modeLabel ? { modeLabel: entry.modeLabel } : {}) })),
  };
}

beforeEach(() => {
  // jsdom implements <dialog> but not its modal methods (ConsentDialog).
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
  // Only reached on custom-provider interactions; nothing here clicks those.
  Object.defineProperty(window, "anycode", {
    configurable: true,
    value: { customProvider: { create: vi.fn(), update: vi.fn(async () => ({ ok: true as const, reason: null })), fetchModels: vi.fn() } },
  });
  useSettingsStore.setState({ snapshot: snapshot(), notice: null });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  useSettingsStore.setState(originalSettingsState);
  vi.restoreAllMocks();
});

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(WelcomeScreen, {}));
  });
}

/** The GLM subscription tile on the welcome card. */
function glmTile(): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>(".welcome-subscription")].find(
    (tile) => tile.textContent?.includes("GLM Coding Plan"),
  )!;
}

/** The embedded form's Provider select (first select in the setup area). */
function providerSelect(): HTMLSelectElement {
  return container.querySelector<HTMLSelectElement>(".welcome-setup select")!;
}

function keyLink(): HTMLElement | null {
  return container.querySelector(".welcome-subscription-key");
}

async function pickProvider(value: string): Promise<void> {
  const select = providerSelect();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("subscription re-pick keeps the key link and the form on the same provider", () => {
  it("opens a single Go form with the Kimi default and no automatic transport selector", async () => {
    await mount();
    const go = [...container.querySelectorAll<HTMLButtonElement>(".welcome-subscription")].filter(tile => tile.textContent?.includes("OpenCode Go"));
    expect(go).toHaveLength(1);
    await act(async () => go[0]!.click());
    expect(providerSelect().value).toBe("opencode");
    expect(container.querySelector<HTMLInputElement>("input[list=welcome-model-suggestions]")?.value).toBe("kimi-k3");
    expect(providerSelect().querySelector("option[value=opencode-openai]")).toBeNull();
    expect(container.querySelector(".connection-drawer-advanced")?.textContent).not.toContain("Transport");
    await pickProvider("openai");
    expect(keyLink()).toBeNull();
    await act(async () => go[0]!.click());
    expect(providerSelect().value).toBe("opencode");
    expect(keyLink()?.textContent).toContain("OpenCode Go");
  });
  it("re-seeds the form to the picked template instead of reviving the link over another provider", async () => {
    await mount();

    // Pick GLM: the form opens seeded with the GLM template and its key link.
    await act(async () => glmTile().click());
    expect(keyLink()?.textContent).toContain("Get a GLM Coding Plan key");
    expect(providerSelect().value).toBe("z-ai");

    // Manually move the form to OpenAI: the link must follow it off.
    await pickProvider("openai");
    expect(providerSelect().value).toBe("openai");
    expect(keyLink()).toBeNull();

    // Click GLM again: a fresh seed — the form must come back on GLM, with
    // the link describing the form actually shown (never link-over-OpenAI).
    await act(async () => glmTile().click());
    expect(keyLink()?.textContent).toContain("Get a GLM Coding Plan key");
    expect(providerSelect().value).toBe("z-ai");
  });
});


it("lays out the actual connection buttons in order without clipping", async () => {
  await mount();
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(".welcome-paths button")];
  expect(buttons.map(b => b.querySelector("strong")?.textContent)).toEqual([
    "GLM Coding Plan", "MiniMax M Plan", "Kimi (kimi.com)", "OpenCode Go",
    "API key or local model", "ChatGPT / Codex", "Claude Code",
  ]);
  expect(buttons.filter(b => b.hasAttribute("data-welcome-path")).map(b => b.dataset.welcomePath)).toEqual(["api", "codex", "claude"]);
  const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome)) throw new Error("Chrome is required for welcome layout verification");
  const dir = mkdtempSync(resolve(tmpdir(), "welcome-layout-"));
  try {
    const css = ["tokens.css", "accents.css", "ui/ui.css", "app.css", "settings.css"].map(f => readFileSync(resolve(import.meta.dirname, "..", f), "utf8")).join("\n");
    const file = resolve(dir, "index.html");
    writeFileSync(file, `<!doctype html><style>${css} body { margin:0 } .welcome-screen { height:100vh }</style>${container.innerHTML}<pre id="header-result"></pre><pre id="result"></pre><script>const logo=document.querySelector('.welcome-mark').getBoundingClientRect(), name=document.querySelector('.welcome-wordmark').getBoundingClientRect(), dots=document.querySelector('.welcome-ramp').getBoundingClientRect(); document.querySelector('#header-result').textContent=JSON.stringify({logoRight:logo.right,logoCenter:logo.y+logo.height/2,nameLeft:name.left,nameCenter:name.y+name.height/2,dotsTop:dots.y,logoBottom:logo.bottom}); const b=[...document.querySelectorAll('.welcome-paths button')]; document.querySelector('#result').textContent=JSON.stringify(b.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth}}));</script>`);
    for (const width of [720, 360]) {
      const run = spawnSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", `--user-data-dir=${dir}/profile`, `--window-size=${width},900`, "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 30000 });
      expect(run.status, run.stderr).toBe(0);
      const header = JSON.parse(run.stdout.match(/<pre id="header-result">([^<]+)<\/pre>/)![1]!) as {logoRight:number; logoCenter:number; nameLeft:number; nameCenter:number; dotsTop:number; logoBottom:number};
      expect(header.nameLeft).toBeGreaterThan(header.logoRight);
      expect(header.nameCenter).toBeCloseTo(header.logoCenter, 0);
      expect(header.dotsTop).toBeGreaterThanOrEqual(header.logoBottom);
      const rows = JSON.parse(run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)![1]!) as Array<{x:number;y:number;right:number;bottom:number;scroll:number;client:number}>;
      for (const [i, a] of rows.entries()) {
        expect(a.scroll).toBeLessThanOrEqual(a.client + 1);
        for (const b of rows.slice(i + 1)) expect(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1).toBe(true);
      }
      if (width === 720) {
        expect(rows[0]!.y).toBe(rows[2]!.y);
        expect(rows[3]!.y).toBe(rows[4]!.y);
        expect(rows[5]!.y).toBe(rows[6]!.y);
        expect(rows[2]!.bottom).toBeLessThanOrEqual(rows[3]!.y);
        expect(rows[4]!.bottom).toBeLessThanOrEqual(rows[5]!.y);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @vitest-environment jsdom
/** Mounted first-run navigation, draft retention and focus regression checks. */
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

function keyInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(".connection-drawer-create-key")!;
}
async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.click());
}
async function change(): Promise<void> {
  await click([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "← Change")!);
}
async function typeKey(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyInput(), value);
    keyInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("focuses the Codex path on first launch", async () => {
  await mount();
  expect(document.activeElement).toBe(container.querySelector('[data-welcome-path="codex"]'));
});

describe("compact subscription navigation", () => {
  it("opens the Go summary and default model with a separately labelled Refresh action", async () => {
    await mount();
    const go = [...container.querySelectorAll<HTMLButtonElement>(".welcome-subscription")].filter(tile => tile.textContent?.includes("OpenCode Go"));
    expect(go).toHaveLength(1);
    await click(go[0]!);
    expect(container.querySelector(".welcome-selected-subscription strong")?.textContent).toBe("OpenCode Go");
    expect(container.querySelector<HTMLAnchorElement>(".welcome-key-link")?.href).toBe("https://opencode.ai/console");
    const model = container.querySelector<HTMLInputElement>("input[list=welcome-model-suggestions]")!;
    expect(model.value).toBe("kimi-k3");
    expect([...model.labels!].map(label => label.textContent).join()).toBe("Model");
    expect(container.querySelector(".connection-drawer-model-line button")?.closest("label")).toBeNull();
    expect(container.querySelector(".connection-drawer-identity")).toBeNull();
    expect(container.querySelector(".connection-drawer-advanced")?.textContent).not.toContain("Transport");
  });

  it("labels the API key without including the key-console link", async () => {
    await mount();
    await click(glmTile());
    expect([...keyInput().labels!].map(label => label.textContent).join()).toBe("API key");
    expect(container.querySelector(".welcome-key-link")?.closest("label")).toBeNull();
  });

  it("keeps a same-subscription draft and clears it when picking another subscription", async () => {
    await mount();
    await click(glmTile());
    expect(document.activeElement).toBe(keyInput());
    await typeKey("draft-key-only");
    const originalInput = keyInput();
    await change();
    expect(document.activeElement).toBe(glmTile());
    await click(glmTile());
    expect(keyInput()).toBe(originalInput);
    expect(keyInput().value).toBe("draft-key-only");
    await change();
    await click([...container.querySelectorAll<HTMLButtonElement>(".welcome-subscription")].find(tile => tile.textContent?.includes("MiniMax M Plan"))!);
    expect(keyInput()).not.toBe(originalInput);
    expect(keyInput().value).toBe("");
    expect(container.querySelector(".welcome-selected-subscription strong")?.textContent).toBe("MiniMax M Plan");
  });

  for (const action of ["saved connection", "add provider"] as const) {
    it(`shows the ${action} form after leaving subscription selection`, async () => {
      const state = snapshot();
      state.settings.provider.connections = [{ id: "work-glm", providerId: "z-ai", label: "Work GLM", model: "glm-5.3" }];
      useSettingsStore.setState({ snapshot: state });
      await mount();
      await click(glmTile());
      await change();
      await click(container.querySelector<HTMLButtonElement>(action === "saved connection" ? ".welcome-connection-row" : ".welcome-connections-add")!);
      expect(container.querySelector<HTMLElement>(".welcome-setup")?.hidden).toBe(false);
      expect(container.querySelector(".welcome-selected-subscription")).toBeNull();
      if (action === "saved connection") {
        expect(container.querySelector<HTMLInputElement>('.welcome-setup input[placeholder="e.g. Work, Personal"]')?.value).toBe("Work GLM");
      } else {
        expect(container.querySelector<HTMLSelectElement>(".welcome-setup select")?.value).toBe("");
      }
    });
  }
});


async function buttonNamed(name: string): Promise<void> {
  await click([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === name)!);
}
async function typeModel(value: string): Promise<void> {
  const model = container.querySelector<HTMLInputElement>("input[list=welcome-model-suggestions]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(model, value);
    model.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function toggleAdvanced(): Promise<void> {
  await act(async () => container.querySelector<HTMLElement>(".connection-drawer-advanced summary")!.click());
}
async function pickKimi(): Promise<void> {
  await mount();
  await click([...container.querySelectorAll<HTMLButtonElement>(".welcome-subscription")].find(tile => tile.textContent?.includes("Kimi (kimi.com)"))!);
}

it.each(["current model", "another model", "fallback", "output field"] as const)("reveals and focuses invalid pricing from closed Advanced: %s", async scope => {
  const create = vi.fn<typeof originalSettingsState.connectionCreate>().mockRejectedValue(new Error("Unexpected create"));
  useSettingsStore.setState({ connectionCreate: create });
  await pickKimi();
  await toggleAdvanced();
  if (scope === "fallback") {
    const billing = container.querySelector<HTMLSelectElement>('select[aria-label="Billing mode"]')!;
    await act(async () => { billing.value = "rates"; billing.dispatchEvent(new Event("change", { bubbles: true })); });
  } else {
    await buttonNamed("Set price");
    if (scope === "another model") await typeModel("k3");
    if (scope === "output field") {
      for (const [field, value] of [["Input", "1"], ["Cached input", "0"]]) {
        const input = container.querySelector<HTMLInputElement>(`input[aria-label="k3.1-pro ${field}"]`)!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
    }
  }
  await toggleAdvanced();
  expect(container.querySelector<HTMLDetailsElement>(".connection-drawer-advanced")?.open).toBe(false);
  await typeKey("sk-local-validation-only");
  await buttonNamed("Connect");
  expect(create).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLDetailsElement>(".connection-drawer-advanced")?.open).toBe(true);
  const owner = scope === "fallback" ? "Connection fallback" : "k3.1-pro";
  if (scope !== "fallback") {
    expect(container.querySelector<HTMLInputElement>("input[list=welcome-model-suggestions]")?.value).toBe(owner);
    expect(container.querySelector(".connection-drawer-price-card strong")?.textContent).toBe(owner);
  }
  const field = scope === "output field" ? "Output" : "Input";
  const invalid = container.querySelector<HTMLInputElement>(`input[aria-label="${owner} ${field}"]`)!;
  expect(invalid).not.toBeNull();
  expect(document.activeElement).toBe(invalid);
  expect(container.querySelector(".settings-error")?.textContent ?? container.textContent).toContain(owner);
});

it("does not infer subscription billing from a model returned by Refresh", async () => {
  await pickKimi();
  const remoteId = "new-remote-fixture-model";
  const fetchModels = vi.fn().mockResolvedValue({ ok: true, models: [{ id: remoteId }] });
  window.anycode.customProvider.fetchModels = fetchModels;
  await typeKey("sk-local-refresh-only");
  await buttonNamed("↻ Refresh");
  expect(fetchModels).toHaveBeenCalledOnce();
  await typeModel(remoteId);
  await toggleAdvanced();
  expect(container.querySelector(".connection-drawer-price-card")?.textContent).toContain("Price unknown");
  expect(container.querySelector(".connection-drawer-price-card")?.textContent).not.toContain("By subscription");
});


const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

it.skipIf(!existsSync(chrome))("lays out the actual connection buttons in order without clipping", async () => {
  await mount();
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(".welcome-paths button")];
  expect(buttons.map(b => b.querySelector("strong")?.textContent)).toEqual([
    "GLM Coding Plan", "MiniMax M Plan", "Kimi (kimi.com)", "OpenCode Go",
    "API key or local model", "ChatGPT / Codex", "Claude Code",
  ]);
  expect(buttons.slice(0, 4).every(b => b.getAttribute("aria-describedby") === "welcome-subscription-description")).toBe(true);
  expect(container.querySelector("#welcome-subscription-description")?.textContent).toBe("Connect a coding subscription");
  expect(buttons.filter(b => b.hasAttribute("data-welcome-path")).map(b => b.dataset.welcomePath)).toEqual(["api", "codex", "claude"]);
  const dir = mkdtempSync(resolve(tmpdir(), "welcome-layout-"));
  try {
    const css = ["tokens.css", "accents.css", "ui/ui.css", "app.css", "settings.css"].map(f => readFileSync(resolve(import.meta.dirname, "..", f), "utf8")).join("\n");
    const file = resolve(dir, "index.html");
    writeFileSync(file, `<!doctype html><style>${css} body { margin:0 } .welcome-screen { height:100vh }</style>${container.innerHTML}<pre id="header-result"></pre><pre id="result"></pre><script>const logo=document.querySelector('.welcome-mark').getBoundingClientRect(), name=document.querySelector('.welcome-wordmark').getBoundingClientRect(), dots=document.querySelector('.welcome-ramp').getBoundingClientRect(); document.querySelector('#header-result').textContent=JSON.stringify({logoRight:logo.right,logoCenter:logo.y+logo.height/2,nameLeft:name.left,nameCenter:name.y+name.height/2,dotsTop:dots.y,logoBottom:logo.bottom}); const b=[...document.querySelectorAll('.welcome-paths button')]; document.querySelector('#result').textContent=JSON.stringify(b.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth}}));</script>`);
    for (const width of [720]) {
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

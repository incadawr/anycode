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

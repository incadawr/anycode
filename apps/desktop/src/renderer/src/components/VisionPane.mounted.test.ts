import { act, createElement } from "react";
import { createStore } from "zustand/vanilla";
import { expect, it } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
import { readFile } from "node:fs/promises";
import { parseOpenCodeGoSnapshot } from "@anycode/core/model-route";
import type { SettingsStoreApi } from "../settings-store.js";
// @ts-expect-error jsdom has no bundled declarations in this workspace.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, Event: dom.window.Event });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { VisionPane } = await import("./VisionPane.js");

it("shows the automatic Go window from static policy and refreshed snapshot", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../../../../packages/core/src/provider/__fixtures__/opencode-go-models.json", import.meta.url), "utf8"));
  fixture.data.find((row: { id: string }) => row.id === "gpt-6-luna").limit.context = 222000;
  const parsed = parseOpenCodeGoSnapshot(fixture, "2026-11-05T00:00:00Z");
  if (!parsed.ok) throw new Error("invalid Go fixture");
  for (const [model, snapshot, expected] of [["grok-4.7", undefined, 500000], ["gpt-6-luna", undefined, 1050000], ["gpt-6-luna", parsed.snapshot, 222000]] as const) {
    const settings = cloneDefaults();
    settings.provider.connections = [{ id: "go", providerId: "opencode", models: [model], modelRoutes: snapshot, modelCapabilities: { [model]: { contextWindow: 12345 } } }];
    settings.recognizer = { connectionId: "go", modelId: model };
    const store = createStore(() => ({ snapshot: { settings, readOnly: false, catalog: [{ id: "opencode", name: "OpenCode Go", authKind: "api_key", models: [] }] } })) as unknown as SettingsStoreApi;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(VisionPane, { store })));
      expect(container.textContent).toContain(`${expected.toLocaleString()} tokens (catalog)`);
    } finally { await act(async () => root.unmount()); container.remove(); }
  }
});

it("shows a saved window in read-only mode while allowing a probe", async () => {
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "vision", providerId: "custom", models: ["v"], modelOverrides: { v: { contextWindowTokens: 32000 } } }];
  settings.recognizer = { connectionId: "vision", modelId: "v" };
  const store = createStore(() => ({ snapshot: { settings, readOnly: true, catalog: [] } })) as unknown as SettingsStoreApi;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(VisionPane, { store })));
    const input = container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    expect(input.value).toBe("32000");
    expect(input.disabled).toBe(true);
    expect(container.textContent).toContain(`${(32000).toLocaleString()} tokens (override)`);
    expect(container.querySelector<HTMLButtonElement>(".vision-pane-save-button")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".vision-pane-probe-button")?.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("disables OAuth choices and displays the proxy warning with the selected model window", async () => {
  const settings = cloneDefaults();
  settings.provider.activeConnectionId = "primary";
  settings.provider.connections = [
    { id: "primary", providerId: "p", proxyRef: "direct" },
    { id: "vision", providerId: "p", models: ["v"], proxyRef: "proxy-1", modelOverrides: { v: { contextWindowTokens: 48000 } } },
    { id: "oauth", providerId: "oauth" },
  ];
  settings.recognizer = { connectionId: "vision", modelId: "v" };
  const catalog = [{ id: "p", name: "Provider", authKind: "api_key", models: [] }, { id: "oauth", name: "OAuth", authKind: "oauth", models: [] }];
  const store = createStore(() => ({ snapshot: { settings, readOnly: false, catalog } })) as unknown as SettingsStoreApi;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(VisionPane, { store })));
    const option = container.querySelector<HTMLOptionElement>('option[value="oauth"]')!;
    expect(option.disabled).toBe(true);
    expect(container.textContent).toContain("signs in with OAuth");
    expect(container.textContent).toContain("ambient proxy");
    expect(container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value).toBe("48000");
    expect(container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps a draft on its model while another model shows its own saved window", async () => {
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "c", providerId: "custom", models: ["a", "b"], modelOverrides: { a: { contextWindowTokens: 32000 }, b: { contextWindowTokens: 64000 } } }];
  settings.recognizer = { connectionId: "c", modelId: "a" };
  const store = createStore(() => ({ snapshot: { settings, readOnly: false, catalog: [] } })) as unknown as SettingsStoreApi;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(VisionPane, { store })));
    const field = () => container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    const select = container.querySelector<HTMLSelectElement>(".vision-pane-model-select")!;
    expect(field().value).toBe("32000");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), "48000"); field().dispatchEvent(new Event("input", { bubbles: true })); });
    expect(field().value).toBe("48000");
    await act(async () => { select.value = "model:1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(field().value).toBe("64000");
    await act(async () => { select.value = "model:0"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(field().value).toBe("48000");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

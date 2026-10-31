import { act, createElement } from "react";
import { createStore } from "zustand/vanilla";
import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCustomProviderCreate, handleCustomProviderFetchModels } from "../../../main/provider-ipc.js";
import { handleConnectionCreate } from "../../../main/settings-ipc.js";
import { buildHostEnv } from "../../../main/host-env.js";
import { loadSettings } from "../../../settings/files.js";
import { parseImageInputModelOverride, resolveImageInput } from "@anycode/core";
import { cloneDefaults } from "../../../settings/schema.js";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
// The test runs a Node-backed DOM so it can exercise the real persistence handlers.
// @ts-expect-error jsdom has no bundled type declarations in this workspace.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {url:"http://localhost"});
Object.assign(globalThis, {window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, HTMLInputElement:dom.window.HTMLInputElement, HTMLSelectElement:dom.window.HTMLSelectElement, Event:dom.window.Event});
const { createRoot } = await import("react-dom/client");
const { ConnectionDrawerFields } = await import("./ConnectionDrawer.js");
import type { SettingsStoreApi } from "../settings-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows and clears a saved vocabulary without a reasoning support flag", async () => {
  const connection = { id:"c", providerId:"custom:test", model:"a", modelOverrides:{a:{effortLevels:["low", "high"] as ("low" | "high")[]}} };
  const snapshot = { settings: cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog:[] };
  const update = vi.fn().mockResolvedValue({ok:true, snapshot});
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, connectionUpdate:update, load:vi.fn()})) as unknown as SettingsStoreApi;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"edit", editConnection:connection, catalog:[], connections:[connection], secrets:[], readOnly:false, store})));
    expect(container.querySelector<HTMLDetailsElement>("details.connection-drawer-advanced")?.open).toBe(true);
    const support = container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning support"]')!;
    expect(support.value).toBe("on");
    const fields = [...container.querySelectorAll("fieldset")].find(f => f.textContent?.includes("Supported effort levels"))!;
    const checks = [...fields.querySelectorAll("input")];
    expect(checks.filter(c => c.checked).map(c => c.parentElement?.textContent?.trim())).toEqual(["low", "high"]);
    await act(async () => { support.value = "auto"; support.dispatchEvent(new Event("change", {bubbles:true})); });
    const save = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!;
    await act(async () => { save.click(); });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id:"c", model:"a", effortLevels:"" }));
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("keeps support and persists it when the last standalone level is unchecked", async () => {
  const connection = { id:"c", providerId:"custom:test", model:"a", modelOverrides:{a:{effortLevels:["low"] as ("low")[]}} };
  const snapshot = { settings: cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog:[] };
  const update = vi.fn().mockResolvedValue({ok:true, snapshot});
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, connectionUpdate:update, load:vi.fn()})) as unknown as SettingsStoreApi;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"edit", editConnection:connection, catalog:[], connections:[connection], secrets:[], readOnly:false, store})));
    const field = [...container.querySelectorAll("fieldset")].find(f => f.textContent?.includes("Supported effort levels"))!;
    const low = [...field.querySelectorAll("input")].find(c => c.checked)!;
    await act(async () => low.click());
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning support"]')!.value).toBe("on");
    expect(container.contains(field)).toBe(true);
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({id:"c", model:"a", reasoningSupported:true, effortLevels:""}));
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it.each(["on", "off"] as const)("creates and reloads image input %s through the custom endpoint form", async (setting) => {
  const dir = mkdtempSync(join(tmpdir(), "drawer-create-"));
  const path = join(dir, "settings.json");
  const vault = {setSecret:async () => ({ok:true as const}), clearSecret:async () => {}, getSecretValue:async () => undefined, probeSecret:async () => ({state:"unset" as const}), statuses:async () => []};
  const providerDeps = {vault, settingsPath:path, genId:() => "custom:fixture"};
  const snapshot = {settings:cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog:[]};
  const create = vi.fn((request: unknown) => handleConnectionCreate({vault, settingsPath:path, bootEnv:{}, catalogIds:["custom:fixture"], isCustom:() => true, genConnectionId:() => "conn-fixture"}, request));
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, connectionCreate:create, load:vi.fn()})) as unknown as SettingsStoreApi;
  const bridge = {create:(request: unknown) => handleCustomProviderCreate(providerDeps, request), fetchModels:(request: unknown) => handleCustomProviderFetchModels(providerDeps, request)};
  const catalog = [{id:"custom", name:"Custom endpoint", authKind:"api_key" as const, models:[], needsBaseUrl:true, isCustom:true}];
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const changeInput = async (input: HTMLInputElement, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", {bubbles:true})); });
  };
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"add", catalog, connections:[], secrets:[], readOnly:false, store, customProvider:bridge as never})));
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { provider.value="custom"; provider.dispatchEvent(new Event("change", {bubbles:true})); });
    await changeInput(container.querySelector('input[placeholder="e.g. LM Studio"]')!, "Fixture");
    await changeInput(container.querySelector('input[placeholder="http://localhost:1234/v1"]')!, "http://127.0.0.1:1234/v1");
    await changeInput(container.querySelector('input[placeholder="Enter a model ID"]')!, "vision");
    const noAuth = [...container.querySelectorAll("input[type=checkbox]")].find(x => x.parentElement?.textContent?.includes("doesn't need")) as HTMLInputElement;
    await act(async () => noAuth.click());
    // By its own label: several Advanced selects (usage policy included) offer
    // on/off options, so matching on the option set alone picks the wrong one.
    const imageField = [...container.querySelectorAll("label.settings-field")].find(l => l.textContent?.includes("Image input"))!;
    const image = imageField.querySelector("select")!;
    await act(async () => {image.value=setting; image.dispatchEvent(new Event("change", {bubbles:true}));});
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Create connection")!.click(); });
    await act(async () => { await vi.waitFor(() => expect(create).toHaveBeenCalledOnce()); await vi.waitFor(async () => expect((await loadSettings(path)).settings.provider.connections[0]?.models).toContain("vision")); });
    const loaded = (await loadSettings(path)).settings;
    expect(loaded.provider.connections[0]).toMatchObject({imageInputOverride:setting, imageInputModel:"vision"});
    const env = await buildHostEnv({bootEnv:{}, settings:loaded, getSecret:async () => undefined});
    const override = parseImageInputModelOverride(env.ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE);
    expect(override).toEqual({override:setting, model:"vision"});
    expect(resolveImageInput("vision", undefined, override?.model === "vision" ? override.override : undefined)).toBe(setting === "on");
  } finally { await act(async () => root.unmount()); container.remove(); rmSync(dir, {recursive:true, force:true}); }
});

// ── The custom-connection drawer right after Create: what actually lands in
// settings.json when the form is filled the way a user fills it, and what the
// dialog title shows. Runs the REAL persistence handlers (same rig as the
// image-input test above) so the answer is about the code, not a mock. ──

function createScenarioRig() {
  const dir = mkdtempSync(join(tmpdir(), "drawer-acceptance-"));
  const path = join(dir, "settings.json");
  const vault = {setSecret:async () => ({ok:true as const}), clearSecret:async () => {}, getSecretValue:async () => undefined, probeSecret:async () => ({state:"unset" as const}), statuses:async () => []};
  const providerDeps = {vault, settingsPath:path, genId:() => "custom:fixture"};
  const snapshot = {settings:cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog:[]};
  const create = vi.fn((request: unknown) => handleConnectionCreate({vault, settingsPath:path, bootEnv:{}, catalogIds:["custom:fixture"], isCustom:() => true, genConnectionId:() => "conn-fixture"}, request));
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, connectionCreate:create, load:vi.fn()})) as unknown as SettingsStoreApi;
  const bridge = {create:(request: unknown) => handleCustomProviderCreate(providerDeps, request), fetchModels:(request: unknown) => handleCustomProviderFetchModels(providerDeps, request)};
  const catalog = [{id:"custom", name:"Custom endpoint", authKind:"api_key" as const, models:[], needsBaseUrl:true, isCustom:true}];
  return { path, create, store, bridge, catalog, cleanup: () => rmSync(dir, {recursive:true, force:true}) };
}

async function mountAddDrawer(rig: ReturnType<typeof createScenarioRig>) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"add", catalog:rig.catalog as never, connections:[], secrets:[], readOnly:false, store:rig.store, customProvider:rig.bridge as never})));
  return { container, root };
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", {bubbles:true})); });
}

async function pickCustomTemplate(container: HTMLElement) {
  const provider = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { provider.value = "custom"; provider.dispatchEvent(new Event("change", {bubbles:true})); });
}

async function clickCreate(container: HTMLElement) {
  await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Create connection")!.click(); });
}

it("persists the record's name and base URL, and the entered model, on the custom create", async () => {
  const rig = createScenarioRig();
  const { container, root } = await mountAddDrawer(rig);
  try {
    await pickCustomTemplate(container);
    await typeInto(container.querySelector('input[placeholder="e.g. LM Studio"]')!, "Int D Conn");
    await typeInto(container.querySelector('input[placeholder="http://localhost:1234/v1"]')!, "http://127.0.0.1:1234/v1");
    await typeInto(container.querySelector('input[placeholder="Enter a model ID"]')!, "gpt-x");
    const noAuth = [...container.querySelectorAll("input[type=checkbox]")].find(x => x.parentElement?.textContent?.includes("doesn't need")) as HTMLInputElement;
    await act(async () => noAuth.click());
    await clickCreate(container);
    await act(async () => { await vi.waitFor(() => expect(rig.create).toHaveBeenCalledOnce()); });
    const settings = (await loadSettings(rig.path)).settings;
    // The RECORD carries the name and base URL typed into their own fields.
    expect(settings.provider.custom?.[0]).toMatchObject({name:"Int D Conn", baseUrl:"http://127.0.0.1:1234/v1"});
    // A custom-record connection's baseUrl lives on the record, not the connection.
    expect(rig.create).toHaveBeenCalledWith(expect.objectContaining({providerId:"custom:fixture", model:"gpt-x"}));
    await act(async () => { await vi.waitFor(async () => expect((await loadSettings(rig.path)).settings.provider.connections[0]).toMatchObject({providerId:"custom:fixture", model:"gpt-x"})); });
  } finally { await act(async () => root.unmount()); container.remove(); rig.cleanup(); }
});

it("reports the connection it created so the dialog header stops saying Add, and creates no connection when the base URL is blank", async () => {
  const rig = createScenarioRig();
  const { container, root } = await mountAddDrawer(rig);
  let reported: string | undefined;
  try {
    // Re-render through the dialog-style prop so the created-id report is observable.
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"add", catalog:rig.catalog as never, connections:[], secrets:[], readOnly:false, store:rig.store, customProvider:rig.bridge as never, onConnectionCreated:(id) => { reported = id; }})));
    await pickCustomTemplate(container);
    await typeInto(container.querySelector('input[placeholder="e.g. LM Studio"]')!, "Int D Conn");
    // Base URL deliberately LEFT BLANK: buildCustomProviderCreateRequest refuses,
    // no record and no connection are written.
    const noAuth = [...container.querySelectorAll("input[type=checkbox]")].find(x => x.parentElement?.textContent?.includes("doesn't need")) as HTMLInputElement;
    await act(async () => noAuth.click());
    await clickCreate(container);
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Enter a name and base URL")); });
    expect(rig.create).not.toHaveBeenCalled();
    expect((await loadSettings(rig.path)).settings.provider.custom).toBeUndefined();
    // Now complete the base URL and create: the id IS reported (what the dialog
    // title keys on) and the record persists its base URL.
    await typeInto(container.querySelector('input[placeholder="http://localhost:1234/v1"]')!, "http://127.0.0.1:9/v1");
    await typeInto(container.querySelector('input[placeholder="Enter a model ID"]')!, "m1");
    await clickCreate(container);
    await act(async () => { await vi.waitFor(() => expect(reported).toBe("conn-fixture")); });
    expect((await loadSettings(rig.path)).settings.provider.custom?.[0]).toMatchObject({baseUrl:"http://127.0.0.1:9/v1"});
  } finally { await act(async () => root.unmount()); container.remove(); rig.cleanup(); }
});

// ── Drawer polish: the Advanced section's vertical rhythm and rate-input
// styling, an explicit save confirmation, and a save no longer reordering the
// offered models ──

const CATALOG = [{ id:"glm", name:"GLM", authKind:"api_key" as const, models:[{id:"glm-5.3"},{id:"glm-5.2"}] }];

function catalogRig(connection: Record<string, unknown>) {
  const snapshot = { settings: cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog: CATALOG };
  const update = vi.fn().mockResolvedValue({ok:true, snapshot});
  const load = vi.fn().mockResolvedValue(undefined);
  const fetchModels = vi.fn().mockResolvedValue({ok:true, models:[]});
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, connectionUpdate:update, load})) as unknown as SettingsStoreApi;
  return { snapshot, update, load, fetchModels, store, customProvider:{fetchModels} as never };
}

async function mountEdit(connection: Record<string, unknown>, rig: ReturnType<typeof catalogRig>) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ConnectionDrawerFields, {
    mode:"edit", editConnection:connection as never, catalog: CATALOG as never, connections:[connection] as never,
    secrets:[], readOnly:false, store:rig.store, customProvider:rig.customProvider,
  })));
  return { container, root };
}

it("keeps the Advanced fields in a gapped column and gives the rate inputs the drawer's own styling", async () => {
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3" };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig);
  try {
    const advanced = container.querySelector<HTMLDetailsElement>("details.connection-drawer-advanced")!;
    // The spacing contract lives on the inner body: a grid ON the <details>
    // element no longer spaces its slotted contents in Chromium.
    expect(advanced.querySelector(":scope > .connection-drawer-advanced-body")).not.toBeNull();
    // The session-scope hint sits under Pricing.
    expect(advanced.textContent).toContain("a session that is already open keeps the rates it started with");
    const pricing = [...container.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "rates"))!;
    await act(async () => { pricing.value = "rates"; pricing.dispatchEvent(new Event("change", {bubbles:true})); });
    const rateInputs = [...container.querySelectorAll<HTMLInputElement>(".connection-drawer-rate-grid input[type=number]")];
    expect(rateInputs).toHaveLength(4);
    for (const input of rateInputs) {
      expect(input.classList.contains("settings-field-input")).toBe(true);
    }
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("confirms a successful save instead of finishing silently", async () => {
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3" };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig);
  try {
    expect(container.querySelector(".connection-drawer-saved")).toBeNull();
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.update).toHaveBeenCalledOnce();
    expect(container.querySelector(".connection-drawer-saved")?.textContent?.trim()).toBe("Saved");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});

it("does not append a catalog-offered model to the connection's own list", async () => {
  // The connection list is read before the catalog by every picker, so
  // persisting a catalog id moved that chip to the front on the first Save.
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3" };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig);
  try {
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.update).toHaveBeenCalledOnce();
    expect(rig.fetchModels).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("still appends a model the catalog does not offer, so a manual id stays durable", async () => {
  const connection = { id:"c1", providerId:"glm", model:"manual-x" };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig);
  try {
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.fetchModels).toHaveBeenCalledWith({ connectionId:"c1", addModels:["manual-x"] });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

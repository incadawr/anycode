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
import { resolveImageInput } from "@anycode/core";
import { modelOverrideFor } from "../../../shared/model-overrides.js";
import { cloneDefaults } from "../../../settings/schema.js";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
// The test runs a Node-backed DOM so it can exercise the real persistence handlers.
// @ts-expect-error jsdom has no bundled type declarations in this workspace.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {url:"http://localhost"});
Object.assign(globalThis, {window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, HTMLInputElement:dom.window.HTMLInputElement, HTMLSelectElement:dom.window.HTMLSelectElement, Event:dom.window.Event, requestAnimationFrame:(callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame:(id: ReturnType<typeof setTimeout>) => clearTimeout(id)});
const { createRoot } = await import("react-dom/client");
const { ConnectionDrawer, ConnectionDrawerFields } = await import("./ConnectionDrawer.js");
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
    const connection = loaded.provider.connections[0]!;
    expect(connection).toMatchObject({modelOverrides:{vision:{imageInput:setting}}});
    expect(connection).not.toHaveProperty("imageInputOverride");
    expect(connection).not.toHaveProperty("imageInputModel");
    // The per-model choice lives in the settings map the host reads; nothing is
    // stamped into the fork's environment any more.
    const env = await buildHostEnv({bootEnv:{}, settings:loaded, getSecret:async () => undefined});
    expect(env.ANYCODE_IMAGE_INPUT_MODEL_OVERRIDE).toBeUndefined();
    expect(resolveImageInput("vision", undefined, modelOverrideFor(connection, "vision")?.imageInput)).toBe(setting === "on");
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

it("requires a model before creating a custom connection", async () => {
  const rig = createScenarioRig();
  const { container, root } = await mountAddDrawer(rig);
  try {
    await pickCustomTemplate(container);
    await typeInto(container.querySelector('input[placeholder="e.g. LM Studio"]')!, "Local");
    await typeInto(container.querySelector('input[placeholder="http://localhost:1234/v1"]')!, "http://127.0.0.1:1234/v1");
    const noAuth = [...container.querySelectorAll("input[type=checkbox]")].find(x => x.parentElement?.textContent?.includes("doesn't need")) as HTMLInputElement;
    await act(async () => noAuth.click());
    const button = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Create connection")!;
    expect(button.disabled).toBe(true);
    await clickCreate(container);
    expect(rig.create).not.toHaveBeenCalled();
    expect((await loadSettings(rig.path)).settings.provider.custom).toBeUndefined();
    await typeInto(container.querySelector('input[placeholder="Enter a model ID"]')!, "m1");
    expect(button.disabled).toBe(false);
    await clickCreate(container);
    await act(async () => { await vi.waitFor(() => expect(rig.create).toHaveBeenCalledWith(expect.objectContaining({model:"m1"}))); });
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
    await typeInto(container.querySelector('input[placeholder="Enter a model ID"]')!, "m1");
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
    await clickCreate(container);
    await act(async () => { await vi.waitFor(() => expect(reported).toBe("conn-fixture")); });
    expect((await loadSettings(rig.path)).settings.provider.custom?.[0]).toMatchObject({baseUrl:"http://127.0.0.1:9/v1"});
  } finally { await act(async () => root.unmount()); container.remove(); rig.cleanup(); }
});

// ── Reasoning replay (the per-connection thinking-replay override) ──

function replayField(container: HTMLElement): HTMLSelectElement | undefined {
  return [...container.querySelectorAll("label.settings-field")]
    .find(l => l.textContent?.includes("Reasoning replay"))
    ?.querySelector("select") ?? undefined;
}

it("shows the reasoning-replay select on a custom-record connection and persists Off as a real false", async () => {
  const connection = { id:"c", providerId:"custom:test", model:"a", preserveReasoning:true };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig);
  try {
    // Saved On opens On.
    const replay = replayField(container)!;
    expect(replay.value).toBe("on");
    await act(async () => { replay.value = "off"; replay.dispatchEvent(new Event("change", {bubbles:true})); });
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    // `false` is a MEANING — it must reach the payload, not be dropped as falsy.
    await act(async () => { await vi.waitFor(() => expect(rig.update).toHaveBeenCalledWith(expect.objectContaining({ id:"c", preserveReasoning:false }))); });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("hides the reasoning-replay select for a catalog provider and clears with Automatic", async () => {
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3" };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig);
  try {
    // Catalog entries keep their own policy — the override has nothing to do.
    expect(replayField(container)).toBeUndefined();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("hides the reasoning-replay select on a custom record whose base URL lands on a flagless catalog entry", async () => {
  // The record's endpoint IS api.openai.com — the host resolves providerName
  // "OpenAI" by base URL and core's replay gate returns undefined BEFORE it
  // reads the connection override, so On would be silently inert: no select.
  const connection = { id:"c2", providerId:"custom:fixture", model:"gpt-x" };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig, [
    { id:"openai", name:"OpenAI", authKind:"api_key", models:[], catalogBaseUrl:"https://api.openai.com/v1" },
    { id:"custom:fixture", name:"OpenAI mirror", authKind:"api_key", models:[], catalogBaseUrl:"https://api.openai.com/v1/" },
  ]);
  try {
    expect(replayField(container)).toBeUndefined();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps the reasoning-replay select when the base-URL-matched catalog entry carries the flag", async () => {
  // A matched entry WITH preserveReasoning keeps the override meaningful in
  // the opt-out direction (explicit false disables replay), so it stays shown.
  const connection = { id:"c3", providerId:"custom:fixture", model:"glm-5.3" };
  const rig = catalogRig(connection);
  const { container, root } = await mountEdit(connection, rig, [
    { id:"z-ai", name:"Z.AI (GLM)", authKind:"api_key", models:[], catalogBaseUrl:"https://api.z.ai/api/anthropic", preserveReasoning:true },
    { id:"custom:fixture", name:"GLM mirror", authKind:"api_key", models:[], catalogBaseUrl:"https://api.z.ai/api/anthropic" },
  ]);
  try {
    expect(replayField(container)).toBeDefined();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each(["on", "off", "auto"] as const)("persists reasoning replay %s through the custom-endpoint create", async (setting) => {
  const rig = createScenarioRig();
  const { container, root } = await mountAddDrawer(rig);
  try {
    await pickCustomTemplate(container);
    await typeInto(container.querySelector('input[placeholder="e.g. LM Studio"]')!, "Replay Fixture");
    await typeInto(container.querySelector('input[placeholder="http://localhost:1234/v1"]')!, "http://127.0.0.1:9/v1");
    await typeInto(container.querySelector('input[placeholder="Enter a model ID"]')!, "m1");
    const noAuth = [...container.querySelectorAll("input[type=checkbox]")].find(x => x.parentElement?.textContent?.includes("doesn't need")) as HTMLInputElement;
    await act(async () => noAuth.click());
    const replay = replayField(container)!;
    await act(async () => { replay.value = setting; replay.dispatchEvent(new Event("change", {bubbles:true})); });
    await clickCreate(container);
    await act(async () => { await vi.waitFor(() => expect(rig.create).toHaveBeenCalledOnce()); });
    // The mock's resolution can beat the async settings write — poll the
    // persisted file like the neighbour create test above instead of a
    // single read (was an observed CI flake).
    if (setting === "auto") {
      // Automatic is the ABSENT key, never false (create has no "" sentinel).
      await act(async () => { await vi.waitFor(async () => expect("preserveReasoning" in ((await loadSettings(rig.path)).settings.provider.connections[0] ?? {})).toBe(false)); });
    } else {
      await act(async () => { await vi.waitFor(async () => expect((await loadSettings(rig.path)).settings.provider.connections[0]?.preserveReasoning).toBe(setting === "on")); });
    }
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

async function mountEdit(connection: Record<string, unknown>, rig: ReturnType<typeof catalogRig>, catalog: readonly unknown[] = CATALOG) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ConnectionDrawerFields, {
    mode:"edit", editConnection:connection as never, catalog: catalog as never, connections:[connection] as never,
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
    expect(container.querySelector('[aria-label*="a session that is already open"]')).not.toBeNull();
    const pricing = [...container.querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "rates"))!;
    await act(async () => { pricing.value = "rates"; pricing.dispatchEvent(new Event("change", {bubbles:true})); });
    const rateInputs = [...container.querySelectorAll<HTMLInputElement>('input[aria-label^="Connection fallback "][type=number]')];
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

it.each([
  ["vendor/glm-5.3-fp8", "GLM-5.3", "1.4", "0.26", "1.4", "4.4"],
  ["vendor/glm-5.3-flash-fp8", "GLM-5.3 Flash", "0.15", "0.03", "0.15", "0.5"],
])("shows all reference rates for %s and saves the opt-out", async (model, name, input, cached, write, output) => {
  const connection = { id:"c", providerId:"custom:test", model };
  const snapshot = { settings: cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog:[] };
  const update = vi.fn().mockResolvedValue({ok:true, snapshot});
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, connectionUpdate:update, load:vi.fn()})) as unknown as SettingsStoreApi;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"edit", editConnection:connection, catalog:[], connections:[connection], secrets:[], readOnly:false, store})));
    expect(container.textContent).toContain(`Recognized as ${name}`);
    expect(container.textContent).toContain(`Catalog reference for ${name}: input $${input}, cached input $${cached}, cache write $${write}, output $${output} per million tokens.`);
    const check = [...container.querySelectorAll("input[type=checkbox]")].find(c => c.parentElement?.textContent?.includes("Recognized as")) as HTMLInputElement;
    await act(async () => check.click());
    expect(container.textContent).not.toContain(`Catalog reference for ${name}`);
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({id:"c", catalogMatchDisabled:true}));
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("uses endpoint effort levels and saves an explicit reasoning denial", async () => {
  const model = "vendor/glm-5.3-fp8";
  const connection = { id:"c", providerId:"custom:test", model, modelCapabilities:{ [model]: { reasoning:true, effortLevels:["low", "high"] } } };
  const snapshot = { settings: cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog:[] };
  const update = vi.fn().mockResolvedValue({ok:true, snapshot});
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, connectionUpdate:update, load:vi.fn()})) as unknown as SettingsStoreApi;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"edit", editConnection:connection, catalog:[], connections:[connection], secrets:[], readOnly:false, store})));
    const effort = container.querySelector('select[aria-label="Reasoning effort"]') as HTMLSelectElement;
    expect([...effort.options].map(o => o.value)).toEqual(["", "low", "high"]);
    const support = container.querySelector('select[aria-label="Reasoning support"]') as HTMLSelectElement;
    await act(async () => { support.value = "off"; support.dispatchEvent(new Event("change", {bubbles:true})); });
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({reasoningSupported:false}));
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("keeps manually selected models and shows a safe error when fetch IPC rejects", async () => {
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3", authOptional:true, modelsFetchedAt:"2026-01-01", visibleModels:["glm-5.3"] };
  const rig = catalogRig(connection);
  rig.fetchModels.mockRejectedValue(new Error("sensitive fixture detail"));
  const { container, root } = await mountEdit(connection, rig);
  try {
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Fetch models")!.click(); });
    const manual = container.querySelector<HTMLInputElement>('input[aria-label="Manual model ID"]')!;
    await typeInto(manual, "manual-choice");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Add")!.click(); });
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Refresh")!.click(); });
    expect(rig.fetchModels).toHaveBeenCalled();
    expect(container.textContent).toContain("Your model selections are kept");
    expect(container.textContent).not.toContain("sensitive fixture detail");
    const choice = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(x => x.parentElement?.textContent?.includes("manual-choice"));
    expect(choice?.checked).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});


async function mountDrawer(connection: Record<string, unknown>, rig: ReturnType<typeof catalogRig>, onClose: () => void) {
  const proto = dom.window.HTMLDialogElement.prototype;
  proto.showModal = function () { this.setAttribute("open", ""); };
  proto.close = function () { this.removeAttribute("open"); };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ConnectionDrawer, {open:true, mode:"edit", editConnection:connection as never, catalog:CATALOG as never, connections:[connection] as never, secrets:[], readOnly:false, store:rig.store, customProvider:rig.customProvider, onClose})));
  return {container, root};
}

it("uses a secondary Cancel and protects unsaved changes for Cancel, Escape, and Close", async () => {
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3" };
  const rig = catalogRig(connection), onClose = vi.fn();
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    expect([...container.querySelectorAll("button")].filter(b => b.classList.contains("ak-btn--primary")).map(b => b.textContent?.trim())).toEqual(["Save"]);
    await typeInto(container.querySelector('input[placeholder="e.g. Work, Personal"]')!, "changed");
    const cancel = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Cancel")!;
    await act(async () => { cancel.focus(); cancel.click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard unsaved changes?");
    expect(document.activeElement?.textContent).toBe("Keep editing");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Keep editing")!.click(); });
    expect(document.activeElement).toBe(cancel);
    expect((container.querySelector('input[placeholder="e.g. Work, Personal"]') as HTMLInputElement).value).toBe("changed");
    await act(async () => { container.querySelector("dialog")!.dispatchEvent(new Event("cancel", {bubbles:false, cancelable:true})); });
    expect(container.textContent).toContain("Discard unsaved changes?");
    await act(async () => { container.querySelector("dialog")!.dispatchEvent(new Event("cancel", {bubbles:false, cancelable:true})); });
    expect(container.textContent).not.toContain("Discard unsaved changes?");
    expect(document.activeElement).toBe(cancel);
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Discard changes")!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("clears the unsaved warning after Save succeeds but not after a failed Save", async () => {
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3" };
  const rig = catalogRig(connection), onClose = vi.fn();
  rig.update.mockResolvedValueOnce({ok:false, reason:"io_error"});
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await typeInto(container.querySelector('input[placeholder="e.g. Work, Personal"]')!, "changed");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(container.textContent).toContain("Discard unsaved changes?");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Keep editing")!.click(); });
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("asks for a provider before asking for a model in the empty form", async () => {
  const rig = catalogRig({});
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"add", catalog:CATALOG as never, connections:[], secrets:[], readOnly:false, store:rig.store})));
    expect(container.textContent).toContain("Choose a provider to continue.");
    expect(container.textContent).not.toContain("Enter a model ID to continue.");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps newer edits dirty if they are made while Save is in flight", async () => {
  const connection = { id:"c1", providerId:"glm", model:"glm-5.3" };
  const rig = catalogRig(connection), onClose = vi.fn();
  let finish!: (value: unknown) => void;
  rig.update.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    const label = container.querySelector<HTMLInputElement>('input[placeholder="e.g. Work, Personal"]')!;
    await typeInto(label, "first");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled).toBe(true);
    await typeInto(label, "newer");
    await act(async () => { finish({ok:true, snapshot:rig.snapshot}); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard unsaved changes?");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("shows a stored key as set without displaying or rewriting it on a metadata save", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3"};
  const rig = catalogRig(connection);
  const setSecret = vi.fn();
  rig.store.setState({setSecret} as never);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"edit", editConnection:connection as never, catalog:CATALOG as never, connections:[connection] as never, secrets:[{key:"provider.connection.c1.apiKey", set:true, source:"vault", tier:"secure"}] as never, readOnly:false, store:rig.store, customProvider:rig.customProvider})));
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(password.value).toBe("");
    expect(container.textContent).toContain("Replace key (never displayed once saved)");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.update).toHaveBeenCalledOnce();
    expect(setSecret).not.toHaveBeenCalled();
    expect(password.value).toBe("");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not allow saving behind a pending discard confirmation", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3"};
  const rig = catalogRig(connection), onClose = vi.fn();
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await typeInto(container.querySelector('input[placeholder="e.g. Work, Personal"]')!, "changed");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Cancel")!.click(); });
    expect(container.querySelector("[inert]")).not.toBeNull();
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.update).not.toHaveBeenCalled();
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Discard changes")!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps the form dirty and does not report Saved while key storage consent is pending or declined", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3"};
  const rig = catalogRig(connection), onClose = vi.fn();
  const setSecret = vi.fn().mockResolvedValue({ok:false, reason:"weak_storage_needs_consent"});
  rig.store.setState({setSecret} as never);
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await typeInto(container.querySelector('input[type="password"]')!, "fixture-key");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(setSecret).toHaveBeenCalledOnce();
    expect(container.querySelector(".connection-drawer-saved")).toBeNull();
    expect(container.textContent).toContain("awaiting storage consent");
    // Simulate dismissal of the separate consent UI without accepting storage.
    await act(async () => { rig.store.setState({pendingConsent:null, secretConsentResolution:{key:"provider.connection.c1.apiKey", ok:false}} as never); });
    expect(container.textContent).toContain("The API key was not saved");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard unsaved changes?");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("does not mark a dismissed model picker draft as a saved-form change", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3", modelsFetchedAt:"2026-01-01", visibleModels:["glm-5.3"]};
  const rig = catalogRig(connection), onClose = vi.fn();
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await act(async () => { container.querySelector<HTMLButtonElement>(".connection-drawer-model-open")!.click(); });
    const checkbox = [...container.querySelectorAll<HTMLInputElement>('.connection-drawer-popup-row input[type="checkbox"]')].find(input => !input.checked)!;
    await act(async () => checkbox.click());
    await act(async () => { container.querySelector('[aria-label="Filter models"]')!.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true})); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Discard unsaved changes?");
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("clears the warning only after a pending key retry actually succeeds", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3"};
  const rig = catalogRig(connection), onClose = vi.fn();
  const setSecret = vi.fn().mockResolvedValue({ok:false, reason:"weak_storage_needs_consent"});
  rig.store.setState({setSecret, secretConsentResolution:null} as never);
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await typeInto(container.querySelector('input[type="password"]')!, "fixture-key");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(container.textContent).toContain("awaiting storage consent");
    await act(async () => { rig.store.setState({secretConsentResolution:{key:"provider.connection.c1.apiKey", ok:true}} as never); });
    expect(container.textContent).not.toContain("awaiting storage consent");
    expect(container.querySelector(".connection-drawer-saved")?.textContent).toContain("Saved");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each([true, false])("keeps a metadata failure visible when pending key consent resolves %s", async accepted => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3"};
  const rig = catalogRig(connection), onClose = vi.fn();
  rig.update.mockResolvedValueOnce({ok:false, reason:"io_error"});
  const setSecret = vi.fn().mockResolvedValue({ok:false, reason:"weak_storage_needs_consent"});
  rig.store.setState({setSecret, secretConsentResolution:null} as never);
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await typeInto(container.querySelector('input[type="password"]')!, "fixture-key");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(container.textContent).toContain("changes couldn't be saved");
    await act(async () => { rig.store.setState({secretConsentResolution:{key:"provider.connection.c1.apiKey", ok:accepted}} as never); });
    expect(container.textContent).toContain("changes couldn't be saved");
    if (!accepted) expect(container.textContent).toContain("API key was not saved");
    expect(container.querySelector(".connection-drawer-saved")).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard unsaved changes?");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("prevents Cancel and Escape from declining consent while the key is being saved", async () => {
  const { ConsentDialog } = await import("./ConsentDialog.js");
  const proto = dom.window.HTMLDialogElement.prototype;
  proto.showModal = function () { this.setAttribute("open", ""); };
  proto.close = function () { this.removeAttribute("open"); };
  const onDecline = vi.fn(), onAccept = vi.fn();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConsentDialog, {open:true, busy:true, onAccept, onDecline})));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.every(button => button.disabled)).toBe(true);
    expect(container.textContent).toContain("Saving…");
    await act(async () => { container.querySelector("dialog")!.dispatchEvent(new Event("cancel", {cancelable:true})); });
    expect(onDecline).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("removes a resolved consent notice but keeps later form edits dirty", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3"};
  const rig = catalogRig(connection), onClose = vi.fn();
  const setSecret = vi.fn().mockResolvedValue({ok:false, reason:"weak_storage_needs_consent"});
  rig.store.setState({setSecret, secretConsentResolution:null} as never);
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await typeInto(container.querySelector('input[type="password"]')!, "fixture-key");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    await typeInto(container.querySelector('input[placeholder="e.g. Work, Personal"]')!, "later edit");
    await act(async () => { rig.store.setState({secretConsentResolution:{key:"provider.connection.c1.apiKey", ok:true}} as never); });
    expect(container.textContent).not.toContain("awaiting storage consent");
    expect(container.querySelector(".connection-drawer-saved")).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard unsaved changes?");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each([true, false])("handles OpenRouter consent %s while model refresh is still in flight", async accepted => {
  const catalog = [{id:"openrouter", name:"OpenRouter", authKind:"api_key" as const, models:[{id:"fixture-model"}]}];
  const snapshot = {settings:cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true, catalog};
  const create = vi.fn().mockResolvedValue({ok:true, createdConnectionId:"conn-fixture", snapshot});
  const setSecret = vi.fn().mockResolvedValue({ok:false, reason:"weak_storage_needs_consent"});
  let finishFetch!: (value:unknown) => void;
  const fetchModels = vi.fn(() => new Promise(resolve => {finishFetch = resolve;}));
  const store = createStore(() => ({snapshot, oauthPendingProviderId:null, secretConsentResolution:null, connectionCreate:create, setSecret, load:vi.fn()})) as unknown as SettingsStoreApi;
  const onClose = vi.fn();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawer, {open:true, mode:"add", catalog:catalog as never, connections:[], secrets:[], readOnly:false, store, customProvider:{fetchModels} as never, onClose})));
    const provider = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {provider.value="openrouter"; provider.dispatchEvent(new Event("change", {bubbles:true}));});
    await typeInto(container.querySelector('input[type="password"]')!, "fixture-key");
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Create connection")!.click(); });
    expect(fetchModels).toHaveBeenCalledOnce();
    await act(async () => { store.setState({secretConsentResolution:{key:"provider.connection.conn-fixture.apiKey", ok:accepted}} as never); });
    await act(async () => { finishFetch({ok:false, reason:"network_error"}); });
    expect(container.textContent).not.toContain("awaiting storage consent");
    if (accepted) expect(container.querySelector(".connection-drawer-saved")).not.toBeNull();
    else expect(container.textContent).toContain("The API key was not saved");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(); });
    if (accepted) expect(onClose).toHaveBeenCalledOnce();
    else { expect(onClose).not.toHaveBeenCalled(); expect(container.textContent).toContain("Discard unsaved changes?"); }
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("preserves a newer model choice made while an earlier Save is pending", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3", modelsFetchedAt:"2026-01-01", visibleModels:["glm-5.3"]};
  const rig = catalogRig(connection), onClose = vi.fn();
  let finish!: (value: unknown) => void;
  rig.update.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.update).toHaveBeenCalledOnce();
    await act(async () => { container.querySelector<HTMLButtonElement>(".connection-drawer-model-open")!.click(); });
    const newDefault = container.querySelector<HTMLButtonElement>('[aria-label="Set glm-5.2 as default"]')!;
    await act(async () => newDefault.click());
    await act(async () => { container.querySelector<HTMLButtonElement>(".connection-drawer-model-done")!.click(); });
    await act(async () => { finish({ok:true, snapshot:rig.snapshot}); });
    expect(container.querySelector('[data-model-id="glm-5.2"]')?.textContent).toContain("default");
    expect(container.querySelector(".connection-drawer-saved")).toBeNull();
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.update).toHaveBeenCalledTimes(2);
    expect(rig.update.mock.calls[1]![0]).toMatchObject({model:"glm-5.2", visibleModels:["glm-5.3", "glm-5.2"]});
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps a fetched model receipt chosen during an earlier Save", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3", authOptional:true, modelsFetchedAt:"2026-01-01", visibleModels:["glm-5.3"]};
  const rig = catalogRig(connection), onClose = vi.fn();
  let finish!: (value: unknown) => void;
  rig.update.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  rig.fetchModels.mockResolvedValue({ok:true, models:[{id:"remote-model"}], source:{guard:"fixture-guard", targetUrl:"http://127.0.0.1/v1/models", baseUrl:"", transport:""}});
  const {container, root} = await mountDrawer(connection, rig, onClose);
  try {
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".connection-drawer-model-open")!.click(); });
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Refresh")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Set remote-model as default"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".connection-drawer-model-done")!.click(); });
    await act(async () => { finish({ok:true, snapshot:rig.snapshot}); });
    await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Save")!.click(); });
    expect(rig.update.mock.calls[1]![0]).toMatchObject({model:"remote-model", fetchedModels:{guard:"fixture-guard", models:[{id:"remote-model"}]}});
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("previews models and reports key and list outcomes in the add form", async () => {
  const rig = catalogRig({});
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ConnectionDrawerFields, {mode:"add", catalog:CATALOG as never, connections:[], secrets:[], readOnly:false, store:rig.store, customProvider:rig.customProvider})));
    const select = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => { select.value = "glm"; select.dispatchEvent(new Event("change", {bubbles:true})); });
    await typeInto(container.querySelector<HTMLInputElement>('input[type="password"]')!, "fixture-key");
    const button = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Fetch models")!;
    rig.fetchModels.mockResolvedValueOnce({ok:true, models:[{id:"remote"}]});
    await act(async () => button.click());
    expect(rig.fetchModels).toHaveBeenCalledWith(expect.objectContaining({draft:true, catalogProviderId:"glm", baseUrl:expect.any(String)}));
    expect(container.textContent).toContain("Key accepted. 1 model available.");
    expect(container.querySelector('option[value="remote"]')).not.toBeNull();
    rig.fetchModels.mockResolvedValueOnce({ok:false, reason:"empty_models"});
    await act(async () => button.click());
    expect(container.textContent).toContain("Key accepted. Model list unavailable.");
    rig.fetchModels.mockResolvedValueOnce({ok:false, reason:"models_not_supported"});
    await act(async () => button.click());
    expect(container.textContent).toContain("The key could not be checked.");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("selects and clears only filtered models and requires a selection", async () => {
  const connection = {id:"c1", providerId:"glm", model:"glm-5.3", modelsFetchedAt:"2026-01-01", visibleModels:["glm-5.3", "glm-5.2"]};
  const rig = catalogRig(connection);
  const {container, root} = await mountEdit(connection, rig);
  const click = async (label: string) => act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!.click(); });
  try {
    await click("Fetch models");
    await typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Filter models"]')!, "5.2");
    await click("Clear all");
    expect(container.textContent).toContain("1 selected");
    await click("Select all");
    expect(container.textContent).toContain("2 selected");
    await typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Filter models"]')!, "");
    await click("Clear all");
    expect(container.querySelector<HTMLButtonElement>(".connection-drawer-model-done")!.disabled).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

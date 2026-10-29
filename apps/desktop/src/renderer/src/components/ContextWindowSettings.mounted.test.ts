// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
import type { ProviderConnection, SettingsSnapshot } from "../../../shared/settings.js";
import ContextWindowSettings from "./ContextWindowSettings.js";

const bridge = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../settings-store.js", () => ({
  useSettingsStore: (select: (state: {connectionUpdate: typeof bridge.update}) => unknown) => select({connectionUpdate: bridge.update}),
}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const connection: ProviderConnection = {
  id: "conn-test", providerId: "custom:test", model: "a", imageInputOverride: "on", imageInputModel: "a",
  modelOverrides: {a:{contextWindowTokens:128000, reasoningEffort:"max"}, b:{reasoningEffort:"low"}},
};
const snapshot: SettingsSnapshot = {settings:cloneDefaults(), readOnly:false, secrets:[], envOverrides:[], providerReady:true};

beforeEach(() => {
  bridge.update.mockReset().mockResolvedValue({ok:true, snapshot});
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable:true, value() { this.open = true; }});
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function mount(readOnly = false) {
  const onClose = vi.fn();
  root = createRoot(container);
  await act(async () => root!.render(createElement(ContextWindowSettings, {snapshot:{...snapshot, readOnly}, connection, model:"b", onClose})));
  return {onClose, input:container.querySelector<HTMLInputElement>("input")!, form:container.querySelector("form")!};
}
async function enter(input: HTMLInputElement, raw: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, raw);
    input.dispatchEvent(new Event("input", {bubbles:true}));
  });
}
async function submit(form: HTMLFormElement) {
  await act(async () => { form.dispatchEvent(new Event("submit", {bubbles:true, cancelable:true})); });
}

describe("session context window shortcut", () => {
  it("focuses the selected model's window and saves only its targeted patch", async () => {
    const {onClose, input, form} = await mount();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(container.querySelector("select")).toBeNull();
    await enter(input, "96000");
    await submit(form);
    expect(bridge.update).toHaveBeenCalledExactlyOnceWith({id:"conn-test", modelOverrideModel:"b", contextWindowTokens:96000});
    expect(onClose).toHaveBeenCalledOnce();
    expect(connection.model).toBe("a");
    expect(connection.imageInputOverride).toBe("on");
  });

  it("rejects an invalid window and respects read-only settings", async () => {
    const {input, form} = await mount();
    await enter(input, "1023");
    await submit(form);
    expect(bridge.update).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("1024");
    await act(async () => root!.render(createElement(ContextWindowSettings, {snapshot:{...snapshot, readOnly:true}, connection, model:"b", onClose:vi.fn()})));
    await enter(input, "96000");
    await submit(form);
    expect(bridge.update).not.toHaveBeenCalled();
  });
});

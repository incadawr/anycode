// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { expect, it, vi } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
import { ConnectionDrawerFields } from "./ConnectionDrawer.js";
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

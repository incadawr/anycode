// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SettingsPatch, SettingsSnapshot } from "../../../shared/settings.js";
import { cloneDefaults } from "../../../settings/schema.js";
import { createSettingsStore } from "../settings-store.js";
import { tabRegistry } from "../tab-registry.js";
import { SettingsScreen } from "./SettingsScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("experimentalToggleWritesUserPatch", async () => {
  let snapshot: SettingsSnapshot = {
    settings: cloneDefaults(), secrets: [], providerReady: false, envOverrides: [], readOnly: false,
  };
  const set = vi.fn(async (patch: SettingsPatch) => {
    snapshot = { ...snapshot, settings: { ...snapshot.settings, tools: { codeMode: patch.tools?.codeMode } } };
    return { ok: true as const, snapshot };
  });
  vi.stubGlobal("anycode", { settings: { get: async () => snapshot, set }, updates: { onUpdateStatus: () => () => {} } });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const store = createSettingsStore();
  await store.getState().load();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SettingsScreen, { store, initialPane: "experimental" })));
    const toggle = container.querySelector<HTMLButtonElement>('#settings-pane-experimental button[role="switch"]')!;
    expect(toggle.type).toBe("button");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("the next time a Native session launches");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      // jsdom does not synthesize the click for a focused native button.
      expect(toggle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))).toBe(true);
      expect(toggle.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }))).toBe(true);
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(set.mock.calls).toEqual([[{ tools: { codeMode: true } }], [{ tools: { codeMode: false } }]]);
    expect(send).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    send.mockRestore();
    vi.unstubAllGlobals();
  }
});

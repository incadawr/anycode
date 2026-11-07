// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { cloneDefaults } from "../../settings/schema.js";
import { createSettingsStore } from "./settings-store.js";
import { KeyboardShortcutsPane } from "./components/KeyboardShortcutsPane.js";
import { realShortcutsPaneDom } from "./automation.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.stubGlobal("CSS", { escape: (value: string) => value });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("drives add and reset on the rendered shortcuts panel", async () => {
  const store = createSettingsStore();
  const settings = cloneDefaults();
  settings.keybindings = { overrides: [{ action: "session.new", bindings: ["mod+shift+n"] }] };
  const setPatch = vi.fn().mockResolvedValue(undefined);
  store.setState({ snapshot: { settings, readOnly: false } as never, setPatch });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const dom = realShortcutsPaneDom();
  try {
    await act(async () => root.render(createElement(KeyboardShortcutsPane, { store })));
    expect(dom.rows().find((row) => row.action === "session.new")?.overridden).toBe(true);
    await act(async () => { expect(dom.clickAdd("session.new")).toBe(true); });
    expect(dom.rows().find((row) => row.action === "session.new")?.recording).toBe(true);
    await act(async () => { expect(dom.clickReset("session.new")).toBe(true); });
    expect(setPatch).toHaveBeenCalledWith({ keybindings: { overrides: [] } });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("lists Switch branch as a configurable shortcut", async () => {
  const store = createSettingsStore();
  store.setState({ snapshot: { settings: cloneDefaults(), readOnly: false } as never });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(KeyboardShortcutsPane, { store })));
    expect(realShortcutsPaneDom().rows().map(row => row.action)).toContain("branch.switch");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AccentPicker } from "./AccentPicker.js";
import { ACCENT_KEY, applyAccent, bindAccentStorageSync, type Accent } from "../accent.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("offers named radios, roving focus, selection checkmark and wrapped keyboard navigation", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const changed = vi.fn();
  applyAccent("current");
  function Harness() { return createElement(AccentPicker, {onChange: (a: Accent) => { changed(a); applyAccent(a); }}); }
  const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  function check(value: string) {
    expect(radios()).toHaveLength(6); expect(radios().filter(b => b.getAttribute("aria-checked") === "true")).toHaveLength(1);
    for (const b of radios()) { expect(b.getAttribute("aria-label")).toBeTruthy(); expect(b.tabIndex).toBe(b.dataset.accent === value ? 0 : -1); }
    expect(radios().find(b => b.dataset.accent === value)?.textContent).toContain("✓");
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Accent color"); check("current");
    radios()[0]!.focus();
    for (const [key, expected] of [["ArrowLeft","ember"],["ArrowRight","current"],["ArrowDown","blue"],["ArrowUp","current"],["End","ember"],["Home","current"]] as const) {
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles:true, cancelable:true})));
      check(expected); expect((document.activeElement as HTMLElement).dataset.accent).toBe(expected); expect(changed).toHaveBeenLastCalledWith(expected);
    }
    await act(async () => radios().find(button => button.dataset.accent === "teal")!.click()); expect(changed).toHaveBeenLastCalledWith("teal"); check("teal");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("follows external applyAccent and storage sync while mounted", async () => {
  applyAccent("current");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), onChange = vi.fn();
  const unbind = bindAccentStorageSync(window);
  const check = (accent: string) => {
    const checked = container.querySelectorAll('[aria-checked="true"]');
    expect(checked).toHaveLength(1);
    expect((checked[0] as HTMLElement).dataset.accent).toBe(accent);
    expect(checked[0]?.textContent).toContain("✓");
    expect((checked[0] as HTMLElement).tabIndex).toBe(0);
  };
  try {
    await act(async () => root.render(createElement(AccentPicker, { onChange })));
    check("current");
    await act(async () => applyAccent("gold")); check("gold");
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: ACCENT_KEY, newValue: "teal" }))); check("teal");
    await act(async () => applyAccent("current")); check("current");
    expect(onChange).not.toHaveBeenCalled();
  } finally { unbind(); await act(async () => root.unmount()); container.remove(); applyAccent("current"); }
});

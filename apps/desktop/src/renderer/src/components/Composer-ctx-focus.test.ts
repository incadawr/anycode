// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { tabRegistry } from "../tab-registry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("context popover interaction", () => {
  it("delays closing across the pointer gap and preserves trigger focus", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
    vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore();
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "s", contextUsage: { estimatedTokens: 25, budgetTokens: 100, source: "provider" } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))));
      const area = container.querySelector<HTMLElement>(".ctx-popover-root")!;
      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context window usage"]')!;
      const dialog = () => container.querySelector('[role="dialog"][aria-label="Context window breakdown"]');
      const mouse = (type: string) => area.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      act(() => mouse("mouseover"));
      expect(dialog()).toBeNull();
      act(() => vi.advanceTimersByTime(150));
      expect(dialog()).not.toBeNull();
      act(() => { mouse("mouseout"); vi.advanceTimersByTime(100); trigger.focus(); vi.advanceTimersByTime(300); });
      expect(document.activeElement).toBe(trigger);
      expect(dialog()).not.toBeNull();
      act(() => trigger.blur());
      act(() => { mouse("mouseover"); vi.advanceTimersByTime(150); mouse("mouseout"); });
      const inner = dialog() as HTMLElement;
      inner.tabIndex = 0;
      act(() => { vi.advanceTimersByTime(100); inner.focus(); vi.advanceTimersByTime(300); });
      expect(document.activeElement).toBe(inner);
      expect(dialog()).not.toBeNull();
      act(() => inner.blur());
      act(() => { mouse("mouseover"); vi.advanceTimersByTime(150); mouse("mouseout"); vi.advanceTimersByTime(200); });
      expect(dialog()).not.toBeNull();
      act(() => { mouse("mouseover"); vi.advanceTimersByTime(500); });
      expect(dialog()).not.toBeNull();
      act(() => { mouse("mouseout"); vi.advanceTimersByTime(300); });
      expect(dialog()).toBeNull();
      act(() => trigger.focus());
      expect(dialog()).not.toBeNull();
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      act(() => dialog()!.querySelector(".ctx-popover-header")!.dispatchEvent(down));
      expect(down.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(trigger);
      expect(dialog()).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

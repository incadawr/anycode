// @vitest-environment jsdom
/**
 * UI audit v0.0.49 §C2: the LIVE composer is what keeps the toast stack off the
 * stop/send controls. This pins the wiring through the real component — the
 * card publishes `--composer-clearance` on the document, republishes from the
 * card's current top edge when the viewport changes, and takes the property
 * back when it unmounts (so the start screen's corner fallback is not left
 * lifted by a value measured for a card that is gone).
 *
 * jsdom performs no layout, so the test stubs `getBoundingClientRect` to give
 * the composer a real box — the same numbers a browser would report.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { tabRegistry } from "../tab-registry.js";
import { COMPOSER_CLEARANCE_VAR, composerClearancePx } from "../composer-clearance.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rect = (top: number, height = 110): DOMRect =>
  ({ x: 0, y: top, top, left: 0, right: 700, bottom: top + height, width: 700, height, toJSON: () => ({}) }) as DOMRect;

/** Composer top edge the stub reports; the test moves it to simulate a growing draft. */
let composerTop = 600;
const realRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return this.classList.contains("composer") ? rect(composerTop) : rect(0, 0);
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = realRect;
});

const published = (): string => document.documentElement.style.getPropertyValue(COMPOSER_CLEARANCE_VAR);

describe("composer clearance (UI audit v0.0.49 C2)", () => {
  it("publishes the card's clearance and removes it on unmount", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
    const store = createDesktopStore();
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    store.getState().applyHostMessage({
      type: "host_ready",
      workspace: "/w",
      mode: "build",
      model: "m",
      sessionId: "s",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))),
      );
      expect(container.querySelector(".composer")).not.toBeNull();
      expect(published()).toBe(`${composerClearancePx(600, 800)}px`);

      // The draft grows: the card's top edge rises, and a viewport change (the
      // resize the observer/listener reacts to) republishes the new value.
      composerTop = 460;
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(published()).toBe(`${composerClearancePx(460, 800)}px`);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      send.mockRestore();
    }
    // Unmounted: no stale offset is left behind for a screen with no composer.
    expect(published()).toBe("");
  });
});

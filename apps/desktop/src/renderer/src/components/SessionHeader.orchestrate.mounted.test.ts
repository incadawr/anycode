/**
 * The session header's Orchestrate badge, through the REAL SessionHeader: the
 * tab's orchestration state has to be readable in the header, not only inside
 * the mode menu (UI/UX audit D6: "nothing in the tab marks it as orchestrated").
 */
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHeader } from "./SessionHeader.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { useTabsStore } from "../tabs-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalTabsState = useTabsStore.getState();

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  useTabsStore.setState(originalTabsState, true);
});

function stubBridge(): void {
  Object.defineProperty(window, "anycode", {
    configurable: true,
    value: {
      browserAccess: {
        get: vi.fn(async () => ({ ok: true, tabs: [] })),
        onChanged: vi.fn(() => () => {}),
      },
    },
  });
}

describe("SessionHeader — orchestrate badge", () => {
  it("shows Orchestrate only while the tab's orchestrate flag is on", async () => {
    stubBridge();
    useTabsStore.setState({
      tabs: [{ tabId: "tab-1", title: "Fix the parser", terminalOpen: false, tasksPanelOpen: false } as never],
      activeTabId: "tab-1",
    });
    const store = createDesktopStore();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(TabContext.Provider, { value: { tabId: "tab-1", store } }, createElement(SessionHeader, { sidebarCollapsed: true, onToggleSidebar: () => {}, onToast: () => {} })),
        );
      });
      expect(container.querySelector('[data-testid="session-header-orchestrate"]')).toBeNull();

      await act(async () => {
        store.getState().applyHostMessage({ type: "orchestrate_changed", enabled: true });
      });
      const badge = container.querySelector('[data-testid="session-header-orchestrate"]');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe("Orchestrate");

      await act(async () => {
        store.getState().applyHostMessage({ type: "orchestrate_changed", enabled: false });
      });
      expect(container.querySelector('[data-testid="session-header-orchestrate"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

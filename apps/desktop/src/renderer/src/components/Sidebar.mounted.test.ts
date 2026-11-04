// @vitest-environment jsdom
/**
 * Mounted regression gate (jsdom): the sidebar's "Opening…" placeholder row is
 * a DISABLED button, and focus() on a disabled button is a no-op — arrow
 * navigation that steps onto it used to strand the list (repeated ArrowDown /
 * ArrowUp never moved focus off the starting row). The row list the R9
 * navigation walks must exclude disabled rows, so the arrows jump straight
 * across the placeholder.
 *
 * Rows A, B (opening), C in one project: ArrowDown on A must focus C, ArrowUp
 * on C must focus A — never the inert placeholder between them.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { SessionSummary } from "../../../shared/tabs.js";
import { usePendingResumes } from "../pending-resumes.js";
import { useTabsStore } from "../tabs-store.js";
import { Sidebar } from "./Sidebar.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(id: string): SessionSummary {
  return { id, workspace: "/w", title: id, model: "m", mode: "build", createdAt: 0, updatedAt: 0 };
}

// The Sidebar fetches the session index through the preload bridge at mount.
(window as unknown as { anycode: unknown }).anycode = {
  listSessions: () => Promise.resolve([session("sA"), session("sB"), session("sC")]),
};

afterEach(() => {
  usePendingResumes.setState({ marks: new Map(), armBaselines: new Map() });
  useTabsStore.setState({ tabs: [] });
  delete (window as unknown as { anycode?: unknown }).anycode;
});

it("arrow navigation skips the disabled Opening… placeholder: ArrowDown from A lands on C, ArrowUp from C back on A", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  // Session B is mid-resume: its marker is armed (no representing tab yet), so
  // its history row renders as the disabled opening placeholder between A and C.
  usePendingResumes.setState({ marks: new Map([["sB", null]]) });
  const noop = (): void => {};
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          tabs: [],
          activeTabId: null,
          onSelectTab: noop,
          onCloseTab: noop,
          onTabCreated: noop,
          onFocusTab: noop,
          onOpenSettings: noop,
          collapsed: false,
          onToggleCollapsed: noop,
        }),
      ),
    );
    // Flush the session-index fetch so all three history rows are mounted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".sidebar-row"));
    const titleOf = (button: HTMLButtonElement) => button.querySelector(".sidebar-row-title")?.textContent;
    const rowOf = (title: string) => rows().find((button) => titleOf(button) === title)!;
    expect(rows().map(titleOf)).toEqual(["sA", "sB", "sC"]);
    expect(rowOf("sB").disabled).toBe(true);

    rowOf("sA").focus();
    await act(async () =>
      rowOf("sA").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })),
    );
    expect(document.activeElement).toBe(rowOf("sC"));
    await act(async () =>
      rowOf("sC").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })),
    );
    expect(document.activeElement).toBe(rowOf("sA"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

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
import { afterEach, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../../shared/tabs.js";
import { usePendingResumes } from "../pending-resumes.js";
import { useTabsStore } from "../tabs-store.js";
import { useTabStatusStore } from "../tab-status-store.js";
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
  useTabStatusStore.setState({ statuses: new Map() });
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
          onRenameRequest: noop,
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

it("renames open rows by double click and history rows by F2 without resuming", async () => {
  const rename = vi.fn(); const createTab = vi.fn();
  (window as unknown as { anycode: unknown }).anycode = { listSessions: async () => [session("history")], createTab };
  const store = useTabsStore.getState(); store.addTab({ tabId: "t", workspace: "/w" });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const noop = () => {};
  try {
    await act(async () => root.render(createElement(Sidebar, { tabs: useTabsStore.getState().tabs, activeTabId: "t", onRenameRequest: rename, onSelectTab: noop, onCloseTab: noop, onTabCreated: noop, onFocusTab: noop, onOpenSettings: noop, collapsed: false, onToggleCollapsed: noop })));
    const open = container.querySelector<HTMLButtonElement>(".sidebar-row-open")!;
    const history = container.querySelector<HTMLButtonElement>(".sidebar-row-resumable")!;
    await act(async () => open.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await act(async () => history.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })));
    const menuButton = container.querySelector<HTMLButtonElement>('[aria-label="Actions for history"]')!;
    await act(async () => menuButton.click());
    const renameItem = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(renameItem.textContent).toBe("Rename…");
    await act(async () => renameItem.click());
    expect(rename.mock.calls.map(call => call[0].kind)).toEqual(["open", "resumable", "resumable"]);
    expect(createTab).not.toHaveBeenCalled();
    createTab.mockResolvedValue({ ok: false, reason: "cancelled" });
    await act(async () => history.click());
    expect(createTab).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

async function mountWithStatus(backgroundAgents: number, backgroundTasks = 0): Promise<{ container: HTMLElement; cleanup: () => Promise<void> }> {
  (window as unknown as { anycode: unknown }).anycode = { listSessions: async () => [session("history")] };
  useTabsStore.getState().addTab({ tabId: "t", workspace: "/w" });
  useTabStatusStore.setState({
    statuses: new Map([["t", { running: true, needsApproval: false, attention: false, backgroundAgents, backgroundTasks }]]),
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const noop = () => {};
  await act(async () => root.render(createElement(Sidebar, { tabs: useTabsStore.getState().tabs, activeTabId: "t", onRenameRequest: noop, onSelectTab: noop, onCloseTab: noop, onTabCreated: noop, onFocusTab: noop, onOpenSettings: noop, collapsed: false, onToggleCollapsed: noop })));
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

it("shows the background agents badge on an open row, before the spinner, with the count in the label", async () => {
  const { container, cleanup } = await mountWithStatus(2);
  try {
    const row = container.querySelector<HTMLButtonElement>(".sidebar-row-open")!;
    const badge = row.querySelector(".sidebar-row-bg-agents")!;
    expect(badge.textContent).toBe("2");
    const spinner = row.querySelector(".sidebar-row-spinner")!;
    expect(badge.compareDocumentPosition(spinner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.getAttribute("aria-label")).toBe("Untitled task, running, 2 background agents");
    const resumable = container.querySelector(".sidebar-row-resumable");
    expect(resumable).not.toBeNull();
    expect(resumable!.querySelector(".sidebar-row-bg-agents")).toBeNull();
  } finally { await cleanup(); }
});

it("shows no badge when there are no background agents", async () => {
  const { container, cleanup } = await mountWithStatus(0);
  try {
    expect(container.querySelector(".sidebar-row-bg-agents")).toBeNull();
  } finally { await cleanup(); }
});

it("shows only the terminal group for a tasks-only row", async () => {
  const { container, cleanup } = await mountWithStatus(0, 1);
  try {
    const row = container.querySelector<HTMLButtonElement>(".sidebar-row-open")!;
    expect(row.querySelector(".sidebar-row-bg-agents")).not.toBeNull();
    expect(row.querySelector(".sidebar-row-bg-agents-robot")).toBeNull();
    expect(row.querySelector(".sidebar-row-bg-agents-prompt")).not.toBeNull();
    expect(row.querySelector(".sidebar-row-bg-agents")!.textContent).toBe("1");
    expect(row.getAttribute("aria-label")).toBe("Untitled task, running, 1 background task");
  } finally { await cleanup(); }
});

it("shows only the robot group for an agents-only row", async () => {
  const { container, cleanup } = await mountWithStatus(2, 0);
  try {
    const row = container.querySelector<HTMLButtonElement>(".sidebar-row-open")!;
    expect(row.querySelector(".sidebar-row-bg-agents-robot")).not.toBeNull();
    expect(row.querySelector(".sidebar-row-bg-agents-prompt")).toBeNull();
  } finally { await cleanup(); }
});

it("shows both groups inside one pill with one ring", async () => {
  const { container, cleanup } = await mountWithStatus(2, 1);
  try {
    const row = container.querySelector<HTMLButtonElement>(".sidebar-row-open")!;
    expect(row.querySelectorAll(".sidebar-row-bg-agents")).toHaveLength(1);
    expect(row.querySelectorAll(".sidebar-row-bg-agents-ring")).toHaveLength(1);
    expect(row.querySelectorAll(".sidebar-row-bg-agents-group")).toHaveLength(2);
    expect(row.querySelector(".sidebar-row-bg-agents-robot")).not.toBeNull();
    expect(row.querySelector(".sidebar-row-bg-agents-prompt")).not.toBeNull();
    expect(row.querySelector(".sidebar-row-bg-agents")!.textContent).toBe("21");
    expect(row.getAttribute("aria-label")).toBe("Untitled task, running, 2 background agents, 1 background task");
  } finally { await cleanup(); }
});

it("shows no pill with neither agents nor tasks", async () => {
  const { container, cleanup } = await mountWithStatus(0, 0);
  try {
    expect(container.querySelector(".sidebar-row-bg-agents")).toBeNull();
  } finally { await cleanup(); }
});

it("gives the pill a plain-words tooltip for agents-only, tasks-only and both", async () => {
  for (const [agents, tasks, title] of [
    [3, 0, "3 background agents"],
    [0, 1, "1 background task"],
    [2, 1, "2 background agents · 1 background task"],
  ] as const) {
    const { container, cleanup } = await mountWithStatus(agents, tasks);
    try {
      expect(container.querySelector(".sidebar-row-bg-agents")!.getAttribute("title")).toBe(title);
    } finally { await cleanup(); }
  }
});

it("draws the tasks group with the frameless prompt icon, not the framed terminal", async () => {
  const { container, cleanup } = await mountWithStatus(0, 1);
  try {
    const group = container.querySelector(".sidebar-row-bg-agents-group")!;
    const icon = group.querySelector(".sidebar-row-bg-agents-prompt")!;
    expect(icon).not.toBeNull();
    expect(icon.querySelector("rect")).toBeNull();
    expect(group.querySelector(".sidebar-row-bg-agents-terminal")).toBeNull();
  } finally { await cleanup(); }
});

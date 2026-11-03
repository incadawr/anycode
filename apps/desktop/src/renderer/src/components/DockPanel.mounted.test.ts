// @vitest-environment jsdom
/**
 * GitHub #31 regression gate (mounted, jsdom): the dock resize handle must
 * be a DIRECT child of the `.session-content-split-open` grid — the 8px
 * column `computeSessionContentColumns` reserves for it — NOT a child of the
 * dock <aside>. When the handle lived inside the column-flex `.dock-panel`
 * it rendered a full-width 0px-tall strip: the separator existed in the DOM
 * and `beginDockResize` was wired, but there was no hit area to grab, so the
 * dock could not be resized at all.
 *
 * Mounts the REAL `ActiveTabBody` (App.tsx) — the component that owns the
 * grid — with a desktop store (BackgroundAgents.mounted.test.ts pattern),
 * opens a `git` dock tab through the same store path a real git-panel open
 * takes, and drives the handle's pointer events through the store writes +
 * persistence the drag performs.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveTabBody, SessionSurface } from "../App.js";
import { createDesktopStore } from "../store.js";
import { tabRegistry } from "../tab-registry.js";
import type { DesktopStoreApi } from "../tab-registry.js";
import { TabContext } from "../tab-context.js";
import { childLayoutStore } from "../child-layout.js";
import { useDockStore } from "../dock/dock-store.js";
import { DOCK_SPLIT_MIN_PX, DOCK_WIDTH_STORAGE_KEY, DOCK_WIDTH_MAX, DOCK_WIDTH_MIN, dockMinWidth } from "../dock/dock-layout.js";
import { usePreviewStore } from "../preview/preview-store.js";
import { Markdown } from "./Markdown.js";
import { DockPanel } from "./DockPanel.js";
import { ModeMenu, FOCUS_MODE_MENU_EVENT } from "./ModeMenu.js";
import { isOverlayOpen } from "../preview/overlay-flag.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The renderer reads the preload bridge off `window.anycode` at render time
// (SessionHeader's browser-access chip, ModelPill's session list, Composer's
// skills list, the preview hydration pull, …). jsdom has no preload, and
// ActiveTabBody mounts the whole chat shell — so instead of enumerating every
// bridge facet, satisfy them all with ONE recursive proxy: every property is
// itself callable and resolves to the same proxy. `.then` chains therefore
// never run their callbacks (fine — no assertion depends on bridge data),
// and unsubscribers (`onChanged` → `off()`) are callable too.
const anyBridge: unknown = new Proxy(function () {}, {
  get: (_target, prop) => {
    if (prop === Symbol.toPrimitive || prop === "toString") {
      return () => "[preload-stub]";
    }
    return anyBridge;
  },
  apply: () => anyBridge,
});
(window as { anycode?: unknown }).anycode = anyBridge;

// jsdom has no ResizeObserver; ActiveTabBody's available-width tracker
// needs one (observe → no-op is fine: the test's width comes from the
// store, never from a measurement).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;

describe("dock resize handle placement (GitHub #31)", () => {
  let store: DesktopStoreApi;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The dock store singleton is global across tests in this file — reset
    // the triple App.tsx reads (owner-scoped tabs) and the persisted width
    // so one test's dock state never leaks into the next mount.
    useDockStore.getState().mergeSplit();
    useDockStore.setState({ tabs: [], activeTabId: null, ownerTabId: null, hidden: false });
    useDockStore.setState({ width: 640 });
    localStorage.clear();
    // jsdom's getBoundingClientRect is always 0x0 and its window is 1024px —
    // pin BOTH to a wide window BEFORE mounting so the available-width
    // tracker (initial state + measure effect + drag clamp) sees 1600px and
    // the drag expectations below are deterministic.
    window.innerWidth = 1600;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1600, height: 900, top: 0, left: 0, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    store = createDesktopStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    usePreviewStore.setState({ byTab: {} });
    container.remove();
    document.body.className = "";
    vi.restoreAllMocks();
  });

  async function mountBody(): Promise<void> {
    await act(async () =>
      root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(ActiveTabBody, { tabId: "tab", sidebarCollapsed: false, onToggleSidebar: () => {}, onToast: () => {} }))),
    );
  }

  /** Opens the subagents dock tab: layout B's child view, then Split (the
      same reducer chain the breadcrumb's "Split" button drives). */
  async function openDockTab(): Promise<void> {
    await act(async () => {
      childLayoutStore.getState().open("tab", "row-1");
      childLayoutStore.getState().enterSplit("tab");
    });
  }

  it("refreshes repository status when Review becomes visible again", async () => {
    vi.useFakeTimers();
    const status = { head: { branch: "main", detached: false, sha: "abc1234", ahead: 0, behind: 0 }, staged: [], unstaged: [], untracked: [] as string[], dirtyCount: 0, filesTruncated: false };
    let files: string[] = [];
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation((_tab, message) => {
      if (message.type !== "git_command") return;
      if (message.command.op === "refresh") store.getState().applyHostMessage({ type: "git_status", status: { ...status, untracked: files, dirtyCount: files.length } });
      store.getState().applyHostMessage({ type: "git_result", requestId: message.requestId, outcome: { ok: true, kind: "unit" } });
    });
    try {
      await mountBody();
      await act(async () => {
        store.getState().gitSetPanelOpen(true);
        useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
        usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "md", previews: [{ previewId: "md", tabId: "tab", url: "file:///doc.md", sourcePath: "/doc.md", title: "doc.md", status: "ready", container: "panel", viewKind: "dom-md" }] });
      });
      await act(async () => { useDockStore.getState().focus("git"); vi.advanceTimersByTime(150); });
      await act(async () => vi.advanceTimersByTime(150));
      expect(container.textContent).toContain("No untracked files.");
      await act(async () => useDockStore.getState().focus("preview:md"));
      files = ["new-file.txt"];
      await act(async () => useDockStore.getState().focus("git"));
      await act(async () => vi.advanceTimersByTime(150));
      expect(container.textContent).toContain("new-file.txt");
      expect(send).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the separator as a direct child of the grid, before the dock aside — never inside it", async () => {
    await mountBody();
    await openDockTab();

    const grid = container.querySelector(".session-content-split-open");
    expect(grid).not.toBeNull();
    const dock = container.querySelector(".dock-panel");
    expect(dock).not.toBeNull();
    // The regression: the handle must not live inside the column-flex dock
    // (a 0px-tall strip there has no hit area).
    expect(dock!.querySelector(".review-resize-handle")).toBeNull();
    const handle = grid!.querySelector(":scope > .review-resize-handle") as HTMLElement | null;
    expect(handle).not.toBeNull();
    // It occupies the reserved 8px grid column: grid child #2 of 3, with the
    // dock <aside> the last.
    const children = Array.from(grid!.children);
    expect(children.indexOf(handle!)).toBe(children.length - 2);
    expect(children[children.length - 1]).toBe(dock);
    expect(handle!.getAttribute("role")).toBe("separator");
  });

  /** jsdom has no PointerEvent constructor — a MouseEvent dispatched under
      the pointer event types carries the clientX/pointerId the handlers
      read (0 for plain MouseEvents). */
  function pointerEvent(type: string, x: number, pointerId = 0): MouseEvent & { pointerId: number } {
    return Object.assign(new MouseEvent(type, { clientX: x, bubbles: true }), { pointerId });
  }

  it("dragging the separator changes the width (clamped) and persists anycode.dock.width on release", async () => {
    await mountBody();
    await openDockTab();

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    // 640 → drag 120px left → 760, persisted on pointerup.
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    expect(useDockStore.getState().width).toBe(640); // live during the drag
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 680)));
    expect(useDockStore.getState().width).toBe(760);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 680)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe("760");

    // Beyond the max: clamped to DOCK_WIDTH_MAX, never 2000.
    handle.dispatchEvent(pointerEvent("pointerdown", 680));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", -1320)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MAX);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", -1320)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_WIDTH_MAX));

    // Below the min: clamped to DOCK_WIDTH_MIN.
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 2400)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MIN);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 2400)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_WIDTH_MIN));
  });

  it("pointercancel ends the drag, and a foreign pointer's moves never resize", async () => {
    await mountBody();
    await openDockTab();

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    // The drag starts with pointer 1.
    handle.dispatchEvent(pointerEvent("pointerdown", 900, 1));
    expect(useDockStore.getState().width).toBe(640);
    // A SECOND pointer's moves (pointer 2) must be ignored entirely.
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 100, 2)));
    expect(useDockStore.getState().width).toBe(640);
    // The initiating pointer resizes.
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 700, 1)));
    expect(useDockStore.getState().width).toBe(840);
    // A FOREIGN pointer's release/cancel must NOT end the drag (it once
    // burned the once-listeners, persisted the width mid-drag and left the
    // initiating pointer dead)…
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 100, 2)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBeNull();
    await act(async () => window.dispatchEvent(pointerEvent("pointercancel", 100, 2)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBeNull();
    // …the initiating pointer still resizes afterwards…
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 600, 1)));
    expect(useDockStore.getState().width).toBe(940);
    // …and ITS pointerup ends the drag and persists.
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 600, 1)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe("940");
    // …so later moves — from ANY pointer — no longer resize.
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 200, 1)));
    expect(useDockStore.getState().width).toBe(940);
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 200, 2)));
    expect(useDockStore.getState().width).toBe(940);
  });

  it("pointercancel from the INITIATING pointer ends the drag and persists", async () => {
    await mountBody();
    await openDockTab();

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    handle.dispatchEvent(pointerEvent("pointerdown", 900, 1));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 700, 1)));
    expect(useDockStore.getState().width).toBe(840);
    await act(async () => window.dispatchEvent(pointerEvent("pointercancel", 700, 1)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe("840");
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 200, 1)));
    expect(useDockStore.getState().width).toBe(840);
  });

  it("with a pane pinned (split), the drag floor leaves the active pane visible — never DOCK_WIDTH_MIN", async () => {
    await mountBody();
    await openDockTab();

    // Pin a second pane (the dock store's splitRight — the split button's path).
    // A 1600px window is past the 1076px canSplit gate, so the pin sticks.
    await act(async () => {
      useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
      useDockStore.getState().splitRight("git", true);
    });
    expect(useDockStore.getState().splitTabId).toBe("git");

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    // Drag far right: with the pane pinned the dock may not shrink under
    // DOCK_WIDTH_MIN + DOCK_SPLIT_MIN_PX (the pinned 320px pane is an
    // absolute overlay of the dock body — at the plain min it would cover
    // the active pane entirely).
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 2400)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MIN + DOCK_SPLIT_MIN_PX);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 2400)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_WIDTH_MIN + DOCK_SPLIT_MIN_PX));

    // Unpinning restores the plain floor (the original single-pane min).
    await act(async () => useDockStore.getState().mergeSplit());
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 2400)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MIN);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 2400)));
  });

  // Audit C10: the per-tab split affordance must read as an icon, not as a
  // stray divider glyph sitting between the title and the close button.
  it("renders the split affordance as an icon with no text glyph (C10)", async () => {
    await mountBody();
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));

    const split = container.querySelector(".dock-tab-split");
    expect(split).not.toBeNull();
    expect(split!.querySelector("svg")).not.toBeNull();
    expect(split!.textContent).toBe("");
  });

  // Audit C11: the background-tasks and terminal header toggles must not share
  // one glyph — they were indistinguishable without their tooltips.
  it("gives the background-tasks and terminal toggles distinct glyphs (C11)", async () => {
    await mountBody();

    const tasks = container.querySelector('[aria-label="Toggle background tasks"]');
    const terminal = container.querySelector('[aria-label="Toggle terminal"]');
    expect(tasks).not.toBeNull();
    expect(terminal).not.toBeNull();
    expect(tasks!.querySelector("svg")).not.toBeNull();
    expect(tasks!.innerHTML).not.toBe(terminal!.innerHTML);
  });

  it.each(["button", "shortcut"])("closes Review using the %s", async (method) => {
    await mountBody();
    await act(async () => {
      store.getState().gitSetPanelOpen(true);
      useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
    });
    await act(async () => {
      if (method === "button") container.querySelector<HTMLButtonElement>('[aria-label="Close Review"]')!.click();
      else container.querySelector<HTMLElement>(".dock-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }));
    });
    expect(store.getState().git.panelOpen).toBe(false);
  });

  it("preserves Markdown view mode and scroll when switching dock tabs", async () => {
    await mountBody();
    await act(async () => {
      usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "md", previews: [{ previewId: "md", tabId: "tab", url: "file:///doc.md", sourcePath: "/doc.md", title: "doc.md", status: "ready", container: "panel", viewKind: "dom-md" }] });
    });
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
    await act(async () => useDockStore.getState().focus("preview:md"));
    const source = container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!;
    await act(async () => source.click());
    const body = container.querySelector<HTMLElement>(".md-preview-view-body")!;
    body.scrollTop = 120;
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => useDockStore.getState().focus("preview:md"));
    expect(container.querySelector('[aria-label="Source"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
    expect(body.scrollTop).toBe(120);
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => useDockStore.getState().splitRight("preview:md", true));
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
    await act(async () => useDockStore.getState().focus("preview:md"));
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
  });

  it("updates a preview tab title without changing focus", async () => {
    await mountBody();
    const preview = { previewId: "web", tabId: "tab", url: "http://localhost/", title: "First", status: "ready" as const, container: "panel" as const, viewKind: "web" as const };
    await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "web", previews: [preview] }));
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
    await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "web", previews: [{ ...preview, title: "Second" }] }));
    expect(container.querySelector('[data-tab-id="preview:web"] .dock-tab-title')?.textContent).toBe("Second");
    expect(useDockStore.getState().activeTabId).toBe("git");
  });

  it("focuses an existing preview when its artifact link is clicked", async () => {
    const preview = vi.fn().mockResolvedValue({ ok: true, value: { previewId: "md" } });
    const artifacts = new Proxy({ preview }, { get(target, key) { return Reflect.get(target, key) ?? anyBridge; } });
    (window as { anycode?: unknown }).anycode = new Proxy(anyBridge as object, { get(target, key) { return key === "artifacts" ? artifacts : Reflect.get(target, key); } });
    try {
      useDockStore.setState({ ownerTabId: "tab", tabs: [{ id: "preview:md", kind: "preview", title: "doc.md" }, { id: "git", kind: "git", title: "Review" }], activeTabId: "git" });
      await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Markdown, { text: "[doc](/doc.md)" }))));
      await act(async () => container.querySelector<HTMLAnchorElement>("a.md-link")!.click());
      expect(preview).toHaveBeenCalledWith("tab", "/doc.md");
      expect(useDockStore.getState().activeTabId).toBe("preview:md");
    } finally {
      (window as { anycode?: unknown }).anycode = anyBridge;
    }
  });

  it("clears the hidden subagent menu and ignores its shortcut", async () => {
    const menu = () => createElement(ModeMenu, { mode: "build", disabled: false, onChange: () => {} });
    const child = createDesktopStore();
    child.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", sessionId: "child", mode: "build", model: "m1" });
    const surface = createElement(TabContext.Provider, { value: { tabId: "child", store: child } }, createElement(SessionSurface, { tabId: "child", onToast: () => {} }));
    useDockStore.setState({ ownerTabId: "tab", tabs: [{ id: "subagents", kind: "subagents", title: "Subagents" }, { id: "git", kind: "git", title: "Review" }], activeTabId: "subagents" });
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } },
      menu(), createElement(DockPanel, { mode: "column", width: 640, canSplitNow: true, splitTabId: null, onToast: () => {}, subagents: { rows: [{ spawnToolCallId: "child", badge: "running", card: { agentType: "worker", description: "", model: null, engine: null, turns: 0, toolCalls: 0, lastTool: null, activity: [], activityDropped: 0, final: null } }], expandedId: "child", surface } }))));
    await act(async () => window.dispatchEvent(new Event(FOCUS_MODE_MENU_EVENT)));
    expect(container.querySelectorAll(".mode-menu-popover")).toHaveLength(2);
    expect(isOverlayOpen()).toBe(true);
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => container.querySelector<HTMLElement>(".mode-menu-popover")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(isOverlayOpen()).toBe(false);
    await act(async () => window.dispatchEvent(new Event(FOCUS_MODE_MENU_EVENT)));
    expect(container.querySelectorAll(".mode-menu-popover")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLElement>(".mode-menu-popover")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(isOverlayOpen()).toBe(false);
  });

  it("selects the right neighbour when the active preview closes", async () => {
    const select = vi.fn().mockResolvedValue({ ok: true });
    const previewPanel = new Proxy({ select, close: vi.fn().mockResolvedValue({ ok: true }) }, { get(target, key) { return Reflect.get(target, key) ?? anyBridge; } });
    (window as { anycode?: unknown }).anycode = new Proxy(anyBridge as object, { get(target, key) { return key === "previewPanel" ? previewPanel : Reflect.get(target, key); } });
    try {
      await mountBody();
      const previews = ["a", "b", "c"].map((id) => ({ previewId: id, tabId: "tab", url: `http://localhost/${id}`, title: id, status: "ready" as const, container: "panel" as const, viewKind: "web" as const }));
      await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "b", previews }));
      await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
      await act(async () => useDockStore.getState().focus("preview:b"));
      const order = useDockStore.getState().tabs.map(tab => tab.id);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close b"]')!.click());
      expect(useDockStore.getState().activeTabId).toBe("preview:b");
      expect(useDockStore.getState().tabs.map(tab => tab.id)).toEqual(order);
      await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "a", previews: [previews[0]!, previews[2]!] }));
      expect(useDockStore.getState().activeTabId).toBe("preview:c");
      expect(select).toHaveBeenCalledWith("tab", "c");
    } finally {
      (window as { anycode?: unknown }).anycode = anyBridge;
    }
  });
});

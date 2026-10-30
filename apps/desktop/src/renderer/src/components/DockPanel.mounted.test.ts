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
import { ActiveTabBody } from "../App.js";
import { createDesktopStore } from "../store.js";
import type { DesktopStoreApi } from "../tab-registry.js";
import { TabContext } from "../tab-context.js";
import { childLayoutStore } from "../child-layout.js";
import { useDockStore } from "../dock/dock-store.js";
import { DOCK_SPLIT_MIN_PX, DOCK_WIDTH_STORAGE_KEY, DOCK_WIDTH_MAX, DOCK_WIDTH_MIN, dockMinWidth } from "../dock/dock-layout.js";

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

    // Pin a second pane (the dock store's splitRight — the ⫿ button's path).
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
});

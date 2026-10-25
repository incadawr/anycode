/**
 * Dock store tests (Taskana 4703) — jsdom-free (App.test.ts header
 * precedent): a Map-backed storage shim stands in for localStorage, so
 * `setWidth`'s persistence is asserted against real writes, not a DOM.
 */
import { describe, expect, it } from "vitest";
import { DOCK_WIDTH_STORAGE_KEY } from "./dock-layout.js";
import { createDockStore, EMPTY_DOCK_VIEW, selectDockOpen, selectDockOpenFor, selectDockView } from "./dock-store.js";
import type { DockStorage } from "./dock-layout.js";

function memoryStorage(entries: Record<string, string> = {}): DockStorage & { written: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  const shim: DockStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
  return Object.assign(shim, { written: map });
}

const TAB_MD = { id: "preview:md", kind: "preview" as const, title: "doc.md" };
const TAB_GIT = { id: "git", kind: "git" as const, title: "Review" };

describe("dock store", () => {
  it("opens tabs append+focus; an existing tab is re-focused, not duplicated", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    expect(store.getState().tabs).toEqual([TAB_MD]);
    expect(store.getState().activeTabId).toBe("preview:md");
    store.getState().open(TAB_GIT);
    expect(store.getState().activeTabId).toBe("git");
    store.getState().open(TAB_MD);
    expect(store.getState().tabs.map((t) => t.id)).toEqual(["preview:md", "git"]);
    expect(store.getState().activeTabId).toBe("preview:md");
  });

  it("close picks the neighbor only when the ACTIVE tab was closed", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    store.getState().open(TAB_MD); // re-focus the first tab; active = preview:md, git stays open
    store.getState().close(TAB_MD.id);
    expect(store.getState().activeTabId).toBe("git");
    expect(store.getState().tabs.map((t) => t.id)).toEqual(["git"]);
    store.getState().close(TAB_MD.id); // not present → no-op
    expect(store.getState().tabs.map((t) => t.id)).toEqual(["git"]);
  });

  it("focus only works for an open tab", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().focus("git");
    expect(store.getState().activeTabId).toBe("preview:md");
    store.getState().focus("git".length > 0 ? "preview:md" : "");
    expect(store.getState().activeTabId).toBe("preview:md");
  });

  it("toggleHidden flips and selectDockOpen requires tabs AND not hidden", () => {
    const store = createDockStore(memoryStorage());
    expect(selectDockOpen(store.getState())).toBe(false); // no tabs yet
    store.getState().open(TAB_MD);
    expect(selectDockOpen(store.getState())).toBe(true);
    store.getState().toggleHidden();
    expect(selectDockOpen(store.getState())).toBe(false);
    expect(store.getState().hidden).toBe(true); // hidden is state, not tab removal
    store.getState().toggleHidden();
    expect(selectDockOpen(store.getState())).toBe(true);
  });

  it("setWidth persists under anycode.dock.width", () => {
    const storage = memoryStorage();
    const store = createDockStore(storage);
    store.getState().setWidth(512);
    expect(storage.written.get(DOCK_WIDTH_STORAGE_KEY)).toBe("512");
    expect(store.getState().width).toBe(512);
  });

  it("the initial width seeds from the legacy preview key when the dock key is absent", () => {
    const store = createDockStore(memoryStorage({ "anycode.preview.width": "700" }));
    expect(store.getState().width).toBe(700);
  });

  // ── Stage 2 (§3): split/merge/auto-merge ──

  it("splitRight pins an open tab when allowed; mergeSplit unpins", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().splitRight(TAB_MD.id, true);
    expect(store.getState().splitTabId).toBe("preview:md");
    store.getState().mergeSplit();
    expect(store.getState().splitTabId).toBe(null);
  });

  it("splitRight refuses when not allowed (window too narrow) — a no-op, never a broken split", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().splitRight(TAB_MD.id, false);
    expect(store.getState().splitTabId).toBe(null);
  });

  it("splitRight refuses an unknown tab id", () => {
    const store = createDockStore(memoryStorage());
    store.getState().splitRight("preview:ghost", true);
    expect(store.getState().splitTabId).toBe(null);
  });

  it("closing the pinned tab unpins it (never leaves a dangling splitTabId)", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    store.getState().splitRight(TAB_MD.id, true);
    store.getState().close(TAB_MD.id);
    expect(store.getState().splitTabId).toBe(null);
    expect(store.getState().tabs.map((t) => t.id)).toEqual(["git"]);
  });

  it("openBackground appends without stealing focus from the active tab", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_GIT);
    store.getState().openBackground(TAB_MD);
    expect(store.getState().tabs.map((t) => t.id)).toEqual(["git", "preview:md"]);
    expect(store.getState().activeTabId).toBe("git");
  });

  it("focusing the pinned tab unpins it (primary and split never show the same tab)", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    store.getState().splitRight("preview:md", true);
    store.getState().focus("preview:md");
    expect(store.getState().activeTabId).toBe("preview:md");
    expect(store.getState().splitTabId).toBe(null);
  });

  it("neighbour focus after closing the primary never lands on the pinned tab", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    store.getState().focus("preview:md");
    store.getState().splitRight("git", true);
    store.getState().close("preview:md");
    expect(store.getState().activeTabId).toBe("git");
    expect(store.getState().splitTabId).toBe(null);
  });

  it("re-opening (focusing) the pinned tab unpins it", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    store.getState().focus("preview:md");
    store.getState().splitRight("git", true);
    store.getState().open(TAB_GIT);
    expect(store.getState().activeTabId).toBe("git");
    expect(store.getState().splitTabId).toBe(null);
  });

  // ── Taskana 4738: conversation-tab ownership (adopt/selectDockView) ──

  it("selectDockView returns the real triple for the owner and EMPTY_DOCK_VIEW for everyone else", () => {
    const store = createDockStore(memoryStorage());
    store.getState().adopt("A");
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    // Owner reads the live triple...
    const view = selectDockView(store.getState(), "A");
    expect(view.tabs).toEqual([TAB_MD, TAB_GIT]);
    expect(view.activeTabId).toBe("git");
    expect(view.splitTabId).toBe(null);
    // ...and the SAME frozen reference for every non-owner, stably (zustand
    // selectors must not allocate per call — repeated reads are `===`).
    expect(selectDockView(store.getState(), "B")).toBe(EMPTY_DOCK_VIEW);
    expect(selectDockView(store.getState(), "B")).toBe(EMPTY_DOCK_VIEW);
    expect(selectDockView(store.getState(), "B").tabs).toEqual([]);
    expect(Object.isFrozen(EMPTY_DOCK_VIEW)).toBe(true);
    expect(Object.isFrozen(EMPTY_DOCK_VIEW.tabs)).toBe(true);
    expect(EMPTY_DOCK_VIEW.tabs).toEqual([]);
    expect(EMPTY_DOCK_VIEW.activeTabId).toBe(null);
    expect(EMPTY_DOCK_VIEW.splitTabId).toBe(null);
  });

  it("selectDockView gates with ownerTabId null too (a fresh boot owns nothing)", () => {
    const store = createDockStore(memoryStorage());
    store.getState().open(TAB_MD); // pre-adopt state, as automation.ts sets directly
    expect(store.getState().ownerTabId).toBe(null);
    expect(selectDockView(store.getState(), "A")).toBe(EMPTY_DOCK_VIEW);
  });

  it("THE regression: a tab switch never observes the previous tab's items — before OR after adopt", () => {
    const store = createDockStore(memoryStorage());
    store.getState().adopt("A");
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    // Switch to tab B. BEFORE adopt("B") runs (the first render of B), the
    // selector must already hide A's items...
    const before = store.getState();
    expect(selectDockView(before, "B").tabs).toEqual([]);
    expect(selectDockOpenFor(before, "B")).toBe(false);
    expect(selectDockOpenFor(before, "A")).toBe(true);
    // ...and adopt("B") then synchronously resets the owned triple.
    store.getState().adopt("B");
    const after = store.getState();
    expect(after.ownerTabId).toBe("B");
    expect(after.tabs).toEqual([]);
    expect(after.activeTabId).toBe(null);
    expect(after.splitTabId).toBe(null);
    expect(selectDockView(after, "B").tabs).toEqual([]);
    // A's items are gone from the store, never observable through B's view.
    expect(after.tabs.some((tab) => tab.id === "preview:md" || tab.id === "git")).toBe(false);
    expect(selectDockOpenFor(after, "B")).toBe(false);
  });

  it("adopt with the same id is a no-op: state object identity unchanged, tabs kept", () => {
    const store = createDockStore(memoryStorage());
    store.getState().adopt("A");
    store.getState().open(TAB_MD);
    const before = store.getState();
    store.getState().adopt("A");
    expect(store.getState()).toBe(before);
    expect(store.getState().tabs).toEqual([TAB_MD]);
  });

  it("adopt clears a pinned splitTabId but keeps width and hidden", () => {
    const storage = memoryStorage();
    const store = createDockStore(storage);
    store.getState().adopt("A");
    store.getState().open(TAB_MD);
    store.getState().open(TAB_GIT);
    store.getState().splitRight(TAB_MD.id, true);
    store.getState().toggleHidden();
    store.getState().setWidth(512);
    store.getState().adopt("B");
    expect(store.getState().splitTabId).toBe(null);
    expect(store.getState().tabs).toEqual([]);
    expect(store.getState().width).toBe(512);
    expect(storage.written.get(DOCK_WIDTH_STORAGE_KEY)).toBe("512");
    expect(store.getState().hidden).toBe(true); // the hide toggle is global, not per-owner
  });

  it("adopt does not touch the per-tab sources: reopening a tab re-derives cleanly", () => {
    const store = createDockStore(memoryStorage());
    store.getState().adopt("A");
    store.getState().open(TAB_MD);
    store.getState().adopt("B");
    // B owns an empty dock; A comes back and its derivation effects re-open.
    store.getState().adopt("A");
    store.getState().open(TAB_MD);
    expect(selectDockView(store.getState(), "A").tabs).toEqual([TAB_MD]);
    expect(selectDockOpenFor(store.getState(), "A")).toBe(true);
  });
});

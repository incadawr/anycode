/**
 * Dock store tests (Taskana 4703) — jsdom-free (App.test.ts header
 * precedent): a Map-backed storage shim stands in for localStorage, so
 * `setWidth`'s persistence is asserted against real writes, not a DOM.
 */
import { describe, expect, it } from "vitest";
import { DOCK_WIDTH_STORAGE_KEY } from "./dock-layout.js";
import { createDockStore, selectDockOpen } from "./dock-store.js";
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
});

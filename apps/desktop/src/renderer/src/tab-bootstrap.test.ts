import { describe, expect, it, vi } from "vitest";
import { createTabsStore } from "./tabs-store.js";
import { createTabRegistry } from "./tab-registry.js";
import { startTabBootstrap } from "./tab-bootstrap.js";
import type { TabBootstrap } from "../../shared/tabs.js";

const tabs = [{ tabId: "a", workspace: "/a" }, { tabId: "b", workspace: "/b" }];
function setup() {
  const store = createTabsStore(null);
  const registry = createTabRegistry(store);
  let resolve!: (snapshot: TabBootstrap) => void;
  const tabBootstrap = () => new Promise<TabBootstrap>((done) => { resolve = done; });
  const selectTab = vi.fn();
  const stop = startTabBootstrap({ tabBootstrap, selectTab }, store, registry);
  const port = () => ({ postMessage() {}, onmessage: null }) as unknown as MessagePort;
  return { store, registry, resolve, selectTab, stop, port };
}

describe("tab bootstrap", () => {
  it.each(["before", "after"])("restores a non-first tab when ports arrive %s the snapshot", async (order) => {
    const f = setup();
    if (order === "before") for (const tab of [...tabs].reverse()) f.registry.registerPort(tab.tabId, tab.workspace, f.port());
    f.resolve({ tabs, activeTabId: "b" });
    await Promise.resolve();
    if (order === "after") for (const tab of [...tabs].reverse()) f.registry.registerPort(tab.tabId, tab.workspace, f.port());
    expect(f.store.getState().activeTabId).toBe("b");
    expect(f.store.getState().tabs).toHaveLength(2);
    expect(f.selectTab).toHaveBeenLastCalledWith("b");
    f.stop();
  });

  it("respects a selection made while the snapshot is pending", async () => {
    const f = setup();
    for (const tab of tabs) f.registry.registerPort(tab.tabId, tab.workspace, f.port());
    f.store.getState().setActiveTab("a");
    f.resolve({ tabs, activeTabId: "b" });
    await Promise.resolve();
    expect(f.store.getState().activeTabId).toBe("a");
    expect(f.selectTab).toHaveBeenLastCalledWith("a");
    f.stop();
  });

  it("falls back when the selected tab closes while the snapshot is pending", async () => {
    const f = setup();
    f.registry.disposeTab("b");
    f.resolve({ tabs, activeTabId: "b" });
    await Promise.resolve();
    expect(f.store.getState().activeTabId).toBe("a");
    expect(f.store.getState().tabs.map((tab) => tab.tabId)).toEqual(["a"]);
    f.stop();
  });

  it("removes a bootstrap tab closed before its port arrives", async () => {
    const f = setup();
    f.resolve({ tabs, activeTabId: "b" });
    await Promise.resolve();
    f.registry.disposeTab("b");
    expect(f.store.getState().activeTabId).toBe("a");
    expect(f.store.getState().tabs.map((tab) => tab.tabId)).toEqual(["a"]);
    f.stop();
  });
});

/**
 * tabs-store tests (design phase-2.md §2.4/§4.3): the tab-list bookkeeping
 * that TabBar and tab-registry.ts build on — first-tab auto-activation,
 * idempotent addTab, active-tab reassignment on close, and the per-tab
 * setters (sessionId/title/hostExited) touching only their own row.
 */
import { describe, expect, it } from "vitest";
import { createTabsStore, HIDDEN_WORKSPACES_KEY, type StorageLike } from "./tabs-store.js";

describe("availableEngines (TASK.41, design/slice-codex-fixes-cut.md §2(g)/§5.5)", () => {
  it("defaults to ['core'] before any fetch — Core never depends on external diagnosis", () => {
    const store = createTabsStore();
    expect(store.getState().availableEngines).toEqual(["core"]);
  });

  it("setAvailableEngines replaces the list wholesale", () => {
    const store = createTabsStore();
    store.getState().setAvailableEngines(["core", "codex"]);
    expect(store.getState().availableEngines).toEqual(["core", "codex"]);
    store.getState().setAvailableEngines(["core"]);
    expect(store.getState().availableEngines).toEqual(["core"]);
  });
});

describe("tabs-store", () => {
  it("the first tab registered becomes active automatically; later tabs don't steal focus", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    expect(store.getState().activeTabId).toBe("a");

    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });
    expect(store.getState().activeTabId).toBe("a");
    expect(store.getState().tabs.map((t) => t.tabId)).toEqual(["a", "b"]);
  });

  it("addTab is idempotent for an already-known tabId", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "a", workspace: "/ws/a-different" });
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.workspace).toBe("/ws/a");
  });

  it("removeTab reassigns activeTabId to a neighbor when the active tab closes", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });
    store.getState().addTab({ tabId: "c", workspace: "/ws/c" });
    store.getState().setActiveTab("b");

    store.getState().removeTab("b");

    expect(store.getState().tabs.map((t) => t.tabId)).toEqual(["a", "c"]);
    // "b" was at index 1; its neighbor at the same index after removal is "c".
    expect(store.getState().activeTabId).toBe("c");
  });

  it("removeTab leaves activeTabId untouched when a non-active tab closes", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });
    store.getState().setActiveTab("a");

    store.getState().removeTab("b");
    expect(store.getState().activeTabId).toBe("a");
  });

  it("removeTab on the last tab leaves activeTabId null", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().removeTab("a");
    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeTabId).toBeNull();
  });

  it("setActiveTab is a no-op for an unknown tabId", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().setActiveTab("ghost");
    expect(store.getState().activeTabId).toBe("a");
  });

  it("setSessionId/setTitle/setHostExited touch only their own tab", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });

    store.getState().setSessionId("a", "sess-a");
    store.getState().setTitle("a", "My session");
    store.getState().setHostExited("a", true);

    const [a, b] = store.getState().tabs;
    expect(a).toMatchObject({ tabId: "a", sessionId: "sess-a", title: "My session", hostExited: true });
    expect(b).toMatchObject({ tabId: "b", sessionId: null, hostExited: false });
    expect(b?.title).toBeUndefined();
  });

  it("terminalOpen defaults to false — the terminal panel never opens itself (design slice-2.4-cut.md §4: lazy spawn)", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    expect(store.getState().tabs[0]?.terminalOpen).toBe(false);
  });

  it("lspPanelOpen defaults to false — the LSP drawer is user-opened chrome state", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    expect(store.getState().tabs[0]?.lspPanelOpen).toBe(false);
  });

  it("hooksPanelOpen defaults to false — the hooks drawer is user-opened chrome state", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    expect(store.getState().tabs[0]?.hooksPanelOpen).toBe(false);
  });

  it("timelinePanelOpen defaults to false — the checkpoint timeline drawer is user-opened chrome state (slice P7.26/R2)", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    expect(store.getState().tabs[0]?.timelinePanelOpen).toBe(false);
  });

  it("setTerminalOpen flips only its own tab's flag", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });

    store.getState().setTerminalOpen("a", true);

    const [a, b] = store.getState().tabs;
    expect(a?.terminalOpen).toBe(true);
    expect(b?.terminalOpen).toBe(false);

    store.getState().setTerminalOpen("a", false);
    expect(store.getState().tabs[0]?.terminalOpen).toBe(false);
  });

  it("setLspPanelOpen flips only its own tab's flag", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });

    store.getState().setLspPanelOpen("b", true);

    const [a, b] = store.getState().tabs;
    expect(a?.lspPanelOpen).toBe(false);
    expect(b?.lspPanelOpen).toBe(true);
  });

  it("setHooksPanelOpen flips only its own tab's flag", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });

    store.getState().setHooksPanelOpen("a", true);

    const [a, b] = store.getState().tabs;
    expect(a?.hooksPanelOpen).toBe(true);
    expect(b?.hooksPanelOpen).toBe(false);
  });

  it("opening one right drawer closes the others on the same tab", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });

    store.getState().setLspPanelOpen("a", true);
    expect(store.getState().tabs[0]?.lspPanelOpen).toBe(true);

    store.getState().setHooksPanelOpen("a", true);
    expect(store.getState().tabs[0]?.hooksPanelOpen).toBe(true);
    expect(store.getState().tabs[0]?.lspPanelOpen).toBe(false);

    store.getState().setLspPanelOpen("a", true);
    expect(store.getState().tabs[0]?.lspPanelOpen).toBe(true);
    expect(store.getState().tabs[0]?.hooksPanelOpen).toBe(false);

    store.getState().setHooksPanelOpen("a", true);
    expect(store.getState().tabs[0]?.hooksPanelOpen).toBe(true);
    expect(store.getState().tabs[0]?.lspPanelOpen).toBe(false);
  });

  it("setTimelinePanelOpen flips only its own tab's flag (slice P7.26/R2)", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().addTab({ tabId: "b", workspace: "/ws/b" });

    store.getState().setTimelinePanelOpen("b", true);

    const [a, b] = store.getState().tabs;
    expect(a?.timelinePanelOpen).toBe(false);
    expect(b?.timelinePanelOpen).toBe(true);
  });

  it("the timeline drawer joins the same one-of-three group as LSP/hooks (slice P7.26/R2)", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });

    store.getState().setLspPanelOpen("a", true);
    store.getState().setTimelinePanelOpen("a", true);
    expect(store.getState().tabs[0]?.timelinePanelOpen).toBe(true);
    expect(store.getState().tabs[0]?.lspPanelOpen).toBe(false);

    store.getState().setHooksPanelOpen("a", true);
    expect(store.getState().tabs[0]?.hooksPanelOpen).toBe(true);
    expect(store.getState().tabs[0]?.timelinePanelOpen).toBe(false);

    store.getState().setTimelinePanelOpen("a", true);
    expect(store.getState().tabs[0]?.timelinePanelOpen).toBe(true);
    expect(store.getState().tabs[0]?.hooksPanelOpen).toBe(false);
  });
});

/**

 * test can assert whether/what the store persisted; seeded via the constructor
 * to exercise the fail-soft read path.
 */
class FakeStorage implements StorageLike {
  readonly writes: { key: string; value: string }[] = [];
  private readonly store: Record<string, string>;
  constructor(seed: Record<string, string> = {}) {
    this.store = { ...seed };
  }
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key]! : null;
  }
  setItem(key: string, value: string): void {
    this.writes.push({ key, value });
    this.store[key] = value;
  }
}

/** A storage stub whose getItem returns a fixed raw string (for fail-soft parse tests). */
function storageReturning(raw: string | null): StorageLike {
  return { getItem: () => raw, setItem: () => undefined };
}

describe("tabs-store draft slot (slice P7.12, §4.1)", () => {
  it("openDraft() with no workspace creates an empty draft and activates it", () => {
    const store = createTabsStore();
    store.getState().openDraft();
    expect(store.getState().draft).toEqual({ workspace: null, prompt: "", engine: "core", model: null, mode: "build" });
    expect(store.getState().draftActive).toBe(true);
  });

  it("openDraft(workspace) seeds the workspace", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    expect(store.getState().draft).toEqual({ workspace: "/ws/a", prompt: "", engine: "core", model: null, mode: "build" });
  });

  it("re-opening an existing draft preserves its prompt/workspace (focus, not reset)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftPrompt("hello");
    store.getState().discardDraft(); // sanity: discard clears
    expect(store.getState().draft).toBeNull();

    store.getState().openDraft("/ws/a");
    store.getState().setDraftPrompt("hello");
    store.getState().openDraft(); // re-focus, no workspace arg
    expect(store.getState().draft).toEqual({ workspace: "/ws/a", prompt: "hello", engine: "core", model: null, mode: "build" });
    expect(store.getState().draftActive).toBe(true);
  });

  it("openDraft(workspace) on an existing draft overwrites the workspace but keeps the prompt", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftPrompt("hello");
    store.getState().openDraft("/ws/b");
    expect(store.getState().draft).toEqual({ workspace: "/ws/b", prompt: "hello", engine: "core", model: null, mode: "build" });
  });

  it("draft mutators are no-ops while draft is null", () => {
    const store = createTabsStore();
    store.getState().setDraftWorkspace("/ws/a");
    store.getState().setDraftPrompt("hi");
    store.getState().setDraftModel("gpt-5");
    store.getState().setDraftEngine("codex");
    expect(store.getState().draft).toBeNull();
  });

  it("setDraftEngine changes only the parked new-session choice", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftPrompt("hello");
    store.getState().setDraftEngine("codex");
    expect(store.getState().draft).toEqual({ workspace: "/ws/a", prompt: "hello", engine: "codex", model: null, mode: "build" });
  });

  it("setDraftModel sets and clears the draft's model pick, leaving workspace/prompt untouched", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftPrompt("hello");

    store.getState().setDraftModel("claude-opus-4");
    expect(store.getState().draft).toEqual({ workspace: "/ws/a", prompt: "hello", engine: "core", model: "claude-opus-4", mode: "build" });

    store.getState().setDraftModel(null);
    expect(store.getState().draft).toEqual({ workspace: "/ws/a", prompt: "hello", engine: "core", model: null, mode: "build" });
  });

  it("setDraftMode preserves the other draft fields and survives re-opening the draft", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftPrompt("make a plan");

    store.getState().setDraftMode("plan");
    store.getState().openDraft();

    expect(store.getState().draft).toEqual({ workspace: "/ws/a", prompt: "make a plan", engine: "core", model: null, mode: "plan" });
  });

  it("re-opening an existing draft preserves its model pick (focus, not reset)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftModel("gpt-5");
    store.getState().openDraft(); // re-focus, no workspace arg
    expect(store.getState().draft).toEqual({ workspace: "/ws/a", prompt: "", engine: "core", model: "gpt-5", mode: "build" });
  });

  it("setDraftEnginePreset sets the draft's preset pick, absent until then (W3 join)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    expect(store.getState().draft?.enginePreset).toBeUndefined();

    store.getState().setDraftEnginePreset("workspace");
    expect(store.getState().draft).toEqual({
      workspace: "/ws/a",
      prompt: "",
      engine: "core",
      model: null,
      mode: "build",
      enginePreset: "workspace",
    });
  });

  it("re-opening an existing draft preserves its preset pick (focus, not reset)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftEnginePreset("read-only");
    store.getState().openDraft(); // re-focus, no workspace arg
    expect(store.getState().draft?.enginePreset).toBe("read-only");
  });

  it("setDraftEnginePreset is a no-op while draft is null", () => {
    const store = createTabsStore();
    store.getState().setDraftEnginePreset("workspace");
    expect(store.getState().draft).toBeNull();
  });

  it("setDraftCodexProfileId sets the draft's Codex profile pick, absent until then (codex-profiles W3-F)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    expect(store.getState().draft?.codexProfileId).toBeUndefined();

    store.getState().setDraftCodexProfileId("work");
    expect(store.getState().draft).toEqual({
      workspace: "/ws/a",
      prompt: "",
      engine: "core",
      model: null,
      mode: "build",
      codexProfileId: "work",
    });
  });

  it("re-opening an existing draft preserves its Codex profile pick (focus, not reset)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftCodexProfileId("personal");
    store.getState().openDraft(); // re-focus, no workspace arg
    expect(store.getState().draft?.codexProfileId).toBe("personal");
  });

  it("setDraftCodexProfileId is a no-op while draft is null", () => {
    const store = createTabsStore();
    store.getState().setDraftCodexProfileId("work");
    expect(store.getState().draft).toBeNull();
  });

  it("setDraftCodexProfileId(undefined) clears a stale pick back to the system pseudo-profile (R3-2 facet i)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setDraftCodexProfileId("work");
    expect(store.getState().draft?.codexProfileId).toBe("work");

    store.getState().setDraftCodexProfileId(undefined);
    expect(store.getState().draft?.codexProfileId).toBeUndefined();
  });

  it("discardDraft clears both draft and draftActive", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().discardDraft();
    expect(store.getState().draft).toBeNull();
    expect(store.getState().draftActive).toBe(false);
  });

  it("setActiveTab clears draftActive but leaves the draft parked (not destroyed)", () => {
    const store = createTabsStore();
    store.getState().addTab({ tabId: "a", workspace: "/ws/a" });
    store.getState().openDraft("/ws/b");
    store.getState().setDraftPrompt("hello");
    expect(store.getState().draftActive).toBe(true);

    store.getState().setActiveTab("a");

    expect(store.getState().draftActive).toBe(false);
    expect(store.getState().draft).toEqual({ workspace: "/ws/b", prompt: "hello", engine: "core", model: null, mode: "build" });
  });

  it("setActiveTab for an unknown tabId leaves draftActive untouched (defensive no-op)", () => {
    const store = createTabsStore();
    store.getState().openDraft("/ws/a");
    store.getState().setActiveTab("ghost");
    expect(store.getState().draftActive).toBe(true);
  });
});

describe("tabs-store hidden workspaces", () => {
  it("initializes hiddenWorkspaces to [] under the node default (no localStorage) via a zero-arg factory", () => {
    const store = createTabsStore();
    expect(store.getState().hiddenWorkspaces).toEqual([]);
  });

  it("hideWorkspace refuses (returns false, no state change, no persist) while an open tab lives in that workspace", () => {
    const storage = new FakeStorage();
    const store = createTabsStore(storage);
    store.getState().addTab({ tabId: "t1", workspace: "/ws/live" });

    expect(store.getState().hideWorkspace("/ws/live")).toBe(false);
    expect(store.getState().hiddenWorkspaces).toEqual([]);
    expect(storage.writes).toHaveLength(0);
  });

  it("hideWorkspace succeeds for a workspace with no open tab, updating state and persisting", () => {
    const storage = new FakeStorage();
    const store = createTabsStore(storage);

    expect(store.getState().hideWorkspace("/ws/gone")).toBe(true);
    expect(store.getState().hiddenWorkspaces).toEqual(["/ws/gone"]);
    expect(storage.writes).toEqual([{ key: HIDDEN_WORKSPACES_KEY, value: JSON.stringify(["/ws/gone"]) }]);
  });

  it("hideWorkspace is idempotent — a second hide returns true without duplicating the entry", () => {
    const storage = new FakeStorage();
    const store = createTabsStore(storage);

    expect(store.getState().hideWorkspace("/ws/x")).toBe(true);
    expect(store.getState().hideWorkspace("/ws/x")).toBe(true);
    expect(store.getState().hiddenWorkspaces).toEqual(["/ws/x"]);
    // The redundant hide writes nothing (state already advanced).
    expect(storage.writes).toHaveLength(1);
  });

  it("reads a well-formed persisted array on construction", () => {
    const store = createTabsStore(new FakeStorage({ [HIDDEN_WORKSPACES_KEY]: JSON.stringify(["/a", "/b"]) }));
    expect(store.getState().hiddenWorkspaces).toEqual(["/a", "/b"]);
  });

  it.each([
    ["corrupt JSON", "{"],
    ["a non-array JSON value", "42"],
    ["an array of non-strings (entries filtered out)", "[1,2]"],
  ])("fails soft to [] for %s in storage", (_label, raw) => {
    const store = createTabsStore(storageReturning(raw));
    expect(store.getState().hiddenWorkspaces).toEqual([]);
  });

  it("filters non-string entries but keeps the string ones from a mixed array", () => {
    const store = createTabsStore(storageReturning(JSON.stringify(["/keep", 7, null, "/also"])));
    expect(store.getState().hiddenWorkspaces).toEqual(["/keep", "/also"]);
  });

  it("fails soft to [] when getItem throws", () => {
    const store = createTabsStore({
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => undefined,
    });
    expect(store.getState().hiddenWorkspaces).toEqual([]);
  });

  it("hideWorkspace still returns true (in-memory state advanced) when setItem throws", () => {
    const store = createTabsStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    expect(() => store.getState().hideWorkspace("/ws/y")).not.toThrow();
    expect(store.getState().hideWorkspace("/ws/z")).toBe(true);
    expect(store.getState().hiddenWorkspaces).toEqual(["/ws/y", "/ws/z"]);
  });

  it("addTab self-heals: opening a tab in a hidden workspace prunes it from the set and persists (R4)", () => {
    const storage = new FakeStorage({ [HIDDEN_WORKSPACES_KEY]: JSON.stringify(["/ws/hidden", "/ws/other"]) });
    const store = createTabsStore(storage);
    expect(store.getState().hiddenWorkspaces).toEqual(["/ws/hidden", "/ws/other"]);

    store.getState().addTab({ tabId: "t1", workspace: "/ws/hidden" });

    expect(store.getState().hiddenWorkspaces).toEqual(["/ws/other"]);
    expect(storage.writes).toEqual([{ key: HIDDEN_WORKSPACES_KEY, value: JSON.stringify(["/ws/other"]) }]);
  });

  it("addTab in a non-hidden workspace leaves the hidden set (and storage) untouched", () => {
    const storage = new FakeStorage({ [HIDDEN_WORKSPACES_KEY]: JSON.stringify(["/ws/hidden"]) });
    const store = createTabsStore(storage);

    store.getState().addTab({ tabId: "t1", workspace: "/ws/fresh" });

    expect(store.getState().hiddenWorkspaces).toEqual(["/ws/hidden"]);
    expect(storage.writes).toHaveLength(0);
  });

  it("removeTab never touches the hidden set", () => {
    const store = createTabsStore(new FakeStorage({ [HIDDEN_WORKSPACES_KEY]: JSON.stringify(["/ws/hidden"]) }));
    store.getState().addTab({ tabId: "t1", workspace: "/ws/fresh" });
    store.getState().addTab({ tabId: "t2", workspace: "/ws/fresh2" });

    store.getState().removeTab("t1");

    expect(store.getState().hiddenWorkspaces).toEqual(["/ws/hidden"]);
  });
});

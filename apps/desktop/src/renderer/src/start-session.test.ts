/**
 * Unit tests for `submitStartDraft` (slice P7.12 §4.3): guards (no draft / no
 * workspace / empty prompt), the ok-path call ordering
 * (addTab -> setActive -> queueInitialPrompt -> discardDraft), and that a
 * refusal leaves the draft untouched for retry (§3-D8).
 */
import { describe, expect, it, vi } from "vitest";
import { submitStartDraft, type StartSubmitDeps } from "./start-session.js";
import { createTabsStore } from "./tabs-store.js";
import type { CreateTabResult } from "../../shared/tabs.js";

function makeDeps(createTabResult: CreateTabResult, order: string[] = []) {
  const tabsStore = createTabsStore();
  const createTab = vi.fn(async () => {
    order.push("createTab");
    return createTabResult;
  });
  const queueInitialPrompt = vi.fn((tabId: string, text: string) => {
    order.push("queueInitialPrompt");
    void tabId;
    void text;
  });
  const deps: StartSubmitDeps = {
    createTab,
    registry: { queueInitialPrompt },
    tabsStore,
  };
  return { deps, tabsStore, createTab, queueInitialPrompt, order };
}

describe("submitStartDraft — guards (§4.3)", () => {
  it("no draft -> {ok:false}, createTab never called", async () => {
    const { deps, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws" });
    const res = await submitStartDraft(deps);
    expect(res).toEqual({ ok: false, message: "No draft to submit." });
    expect(createTab).not.toHaveBeenCalled();
  });

  it("draft with workspace===null -> {ok:false}, createTab never called", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws" });
    tabsStore.getState().openDraft();
    tabsStore.getState().setDraftPrompt("hello");

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: false, message: "Choose a project first." });
    expect(createTab).not.toHaveBeenCalled();
    expect(tabsStore.getState().draft).toEqual({ workspace: null, prompt: "hello", engine: "core", model: null, mode: "build" });
  });

  it("empty/whitespace-only prompt -> {ok:false}, createTab never called", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("   ");

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: false, message: "Type a message to send." });
    expect(createTab).not.toHaveBeenCalled();
  });
});

describe("submitStartDraft — ok path (§4.3)", () => {
  it("calls createTab with { kind: 'new', workspace }", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a" });
  });

  it("W3 join: forwards the draft's Codex model + preset picks as engineModel/enginePreset, but still withholds AnyCode's own first-turn model/mode setup (Codex owns those natively)", async () => {
    const { deps, tabsStore, createTab, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftModel("gpt-5.6-mini");
    tabsStore.getState().setDraftEnginePreset("workspace");
    tabsStore.getState().setDraftMode("plan");
    tabsStore.getState().setDraftEngine("codex");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({
      kind: "new",
      workspace: "/ws/a",
      engine: "codex",
      engineModel: "gpt-5.6-mini",
      enginePreset: "workspace",
    });
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello");
  });

  it("codex-profiles W3-F: forwards the draft's Codex profile pick as codexProfileId", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftEngine("codex");
    tabsStore.getState().setDraftCodexProfileId("work");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({
      kind: "new",
      workspace: "/ws/a",
      engine: "codex",
      codexProfileId: "work",
    });
  });

  it("a Codex draft with no explicit profile pick omits codexProfileId from createTab (system pseudo-profile default)", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftEngine("codex");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a", engine: "codex" });
  });

  it("R3-2 facet ii: switching a draft codex->core after picking a profile never forwards the stale codexProfileId to the Core create request", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftEngine("codex");
    tabsStore.getState().setDraftCodexProfileId("work");
    tabsStore.getState().setDraftEngine("core");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a" });
  });

  it("a Codex draft with no explicit model/preset pick omits both from createTab, letting the host apply its own defaults", async () => {
    const { deps, tabsStore, createTab, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftEngine("codex");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a", engine: "codex" });
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello");
  });

  it("ordering: addTab -> setActive -> queueInitialPrompt -> discardDraft, returns {ok:true, tabId}", async () => {
    const order: string[] = [];
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" }, order);
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello there");
    const realAddTab = tabsStore.getState().addTab;
    const addTabSpy = vi.spyOn(tabsStore.getState(), "addTab").mockImplementation((tab) => {
      order.push("addTab");
      realAddTab(tab);
    });
    const realSetActiveTab = tabsStore.getState().setActiveTab;
    const setActiveSpy = vi.spyOn(tabsStore.getState(), "setActiveTab").mockImplementation((tabId) => {
      order.push("setActive");
      realSetActiveTab(tabId);
    });

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: true, tabId: "t1" });
    expect(order).toEqual(["createTab", "addTab", "setActive", "queueInitialPrompt"]);
    // No model was picked on the draft (defaults null) -> forwarded as undefined (slice F5#1b, D3).
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello there", undefined, "build");
    expect(tabsStore.getState().draft).toBeNull();
    expect(tabsStore.getState().draftActive).toBe(false);

    addTabSpy.mockRestore();
    setActiveSpy.mockRestore();
  });

  it("forwards a picked draft model to queueInitialPrompt as its third argument (slice F5#1b, D3)", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello there");
    tabsStore.getState().setDraftModel("gpt-5");

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello there", "gpt-5", "build");
  });

  it("forwards the selected start-screen mode for first-turn setup", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("make a plan");
    tabsStore.getState().setDraftMode("plan");

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "make a plan", undefined, "plan");
  });

  it("addTab is idempotent against the port-delivery race — a pre-existing tabId is a harmless no-op", async () => {
    const { deps, tabsStore } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().addTab({ tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hi");

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: true, tabId: "t1" });
    expect(tabsStore.getState().tabs).toHaveLength(1);
    expect(tabsStore.getState().activeTabId).toBe("t1");
  });
});

describe("submitStartDraft — refusal keeps the draft (§3-D8)", () => {
  it("max_tabs -> {ok:false, message}, draft (and prompt) intact, no queue/discard", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: false, reason: "max_tabs" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("keep me");

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: false, message: expect.any(String) });
    expect(tabsStore.getState().draft).toEqual({ workspace: "/ws/a", prompt: "keep me", engine: "core", model: null, mode: "build" });
    expect(tabsStore.getState().draftActive).toBe(true);
    expect(queueInitialPrompt).not.toHaveBeenCalled();
  });

  it("not_ready -> {ok:false}, draft intact", async () => {
    const { deps, tabsStore } = makeDeps({ ok: false, reason: "not_ready" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("keep me");

    const res = await submitStartDraft(deps);

    expect(res.ok).toBe(false);
    expect(tabsStore.getState().draft).toEqual({ workspace: "/ws/a", prompt: "keep me", engine: "core", model: null, mode: "build" });
  });

  it("already_open -> focuses the existing tab via setActiveTab, draft intact, {ok:false}", async () => {
    const { deps, tabsStore } = makeDeps({ ok: false, reason: "already_open", focusTabId: "existing" });
    tabsStore.getState().addTab({ tabId: "existing", workspace: "/ws/a" });
    tabsStore.getState().addTab({ tabId: "other", workspace: "/ws/b" });
    tabsStore.getState().setActiveTab("other");
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("keep me");

    const res = await submitStartDraft(deps);

    expect(res.ok).toBe(false);
    expect(tabsStore.getState().activeTabId).toBe("existing");
    expect(tabsStore.getState().draft).toEqual({ workspace: "/ws/a", prompt: "keep me", engine: "core", model: null, mode: "build" });
  });

  it("a rejected createTab IPC call -> {ok:false, message}, not a thrown rejection; draft intact, queue never called (codex P7.12 review fix)", async () => {
    const tabsStore = createTabsStore();
    const createTab = vi.fn(() => Promise.reject(new Error("IPC channel closed")));
    const queueInitialPrompt = vi.fn();
    const deps: StartSubmitDeps = {
      createTab,
      registry: { queueInitialPrompt },
      tabsStore,
    };
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("keep me");

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: false, message: expect.any(String) });
    expect(tabsStore.getState().draft).toEqual({ workspace: "/ws/a", prompt: "keep me", engine: "core", model: null, mode: "build" });
    expect(tabsStore.getState().draftActive).toBe(true);
    expect(queueInitialPrompt).not.toHaveBeenCalled();
  });
});

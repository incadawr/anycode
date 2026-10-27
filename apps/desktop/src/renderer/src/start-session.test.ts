/**
 * Unit tests for `submitStartDraft` (slice P7.12 §4.3): guards (no draft / no
 * workspace / empty prompt), the ok-path call ordering
 * (addTab -> setActive -> queueInitialPrompt -> discardDraft), and that a
 * refusal leaves the draft untouched for retry (§3-D8).
 */
import { describe, expect, it, vi } from "vitest";
import { submitStartDraft, type StartSubmitDeps } from "./start-session.js";
import { createTabsStore } from "./tabs-store.js";
import { resolveCodexDraftModel } from "./codex-draft-model.js";
import { createSettingsStore, useSettingsStore } from "./settings-store.js";
import { cloneDefaults } from "../../settings/schema.js";
import { guardedSubmit, selectStartModelRow } from "./components/StartScreen.js";
import type { CreateTabResult } from "../../shared/tabs.js";
import type { SettingsSnapshot } from "../../shared/settings.js";

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

describe("start-screen submission of bare commands", () => {
  it.each(["core", "claude", "codex"] as const)("refuses a first compact draft for %s without creating or queueing", async (engine) => {
    const { deps, tabsStore, createTab, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftEngine(engine);
    tabsStore.getState().setDraftPrompt("/compact ");
    const onToast = vi.fn();
    await guardedSubmit({ canSend: true, guard: { current: false }, setSubmitting: vi.fn(), submit: () => submitStartDraft(deps), onToast });
    expect(onToast).toHaveBeenCalledWith("shell_error", "Wait for this session to connect before running a command.");
    expect(createTab).not.toHaveBeenCalled();
    expect(queueInitialPrompt).not.toHaveBeenCalled();
    expect(tabsStore.getState().draft?.prompt).toBe("/compact ");
  });
});

describe("submitStartDraft — Orchestrate (start screen)", () => {
  it("first-run role gate: an orchestrating send with no roles refuses before createTab, and leaves the draft untouched", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    const rolesConfigured = vi.fn(() => false);
    deps.rolesConfigured = rolesConfigured;
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("refactor");
    tabsStore.getState().setDraftOrchestrate(true);

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: false, message: "Set up orchestration roles first." });
    expect(createTab).not.toHaveBeenCalled();
    expect(rolesConfigured).toHaveBeenCalledWith("/ws/a");
    expect(tabsStore.getState().draft?.prompt).toBe("refactor");
    expect(tabsStore.getState().draft?.orchestrate).toBe(true);
  });

  it("uses the draft project profile for the real first-run gate", async () => {
    const original = useSettingsStore.getState().snapshot;
    const settings = cloneDefaults();
    settings.roleProfiles = {
      profiles: [{ id: "project", name: "Project", roles: { planner: { primary: { model: "project-model" } } } }],
      activeId: "missing", projects: [{ projectRoot: "/ws/a", profileId: "project" }],
    };
    useSettingsStore.setState({ snapshot: { settings, secrets: [], providerReady: true, envOverrides: [], readOnly: false } });
    try {
      const configured = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
      configured.tabsStore.getState().openDraft("/ws/a");
      configured.tabsStore.getState().setDraftPrompt("refactor");
      configured.tabsStore.getState().setDraftOrchestrate(true);
      expect((await submitStartDraft(configured.deps)).ok).toBe(true);
      const unconfigured = makeDeps({ ok: true, tabId: "t2", workspace: "/ws/b" });
      unconfigured.tabsStore.getState().openDraft("/ws/b");
      unconfigured.tabsStore.getState().setDraftPrompt("refactor");
      unconfigured.tabsStore.getState().setDraftOrchestrate(true);
      expect(await submitStartDraft(unconfigured.deps)).toEqual({ ok: false, message: "Set up orchestration roles first." });
    } finally { useSettingsStore.setState({ snapshot: original }); }
  });

  it("with roles configured, an orchestrating core send forwards orchestrate=true as queueInitialPrompt's last argument", async () => {
    const { deps, tabsStore, createTab, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    deps.rolesConfigured = () => true;
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("refactor");
    tabsStore.getState().setDraftOrchestrate(true);

    const res = await submitStartDraft(deps);

    expect(res.ok).toBe(true);
    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a" });
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "refactor", undefined, "build", undefined, undefined, undefined, true);
  });

  it("/orchestrate <task> sends only the task as the first message, with orchestrate on (no toggle needed)", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    deps.rolesConfigured = () => true;
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("/orchestrate map the modules");

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "map the modules", undefined, "build", undefined, undefined, undefined, true);
  });

  it("a bare /orchestrate is refused with a task prompt, never created", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    deps.rolesConfigured = () => true;
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("/orchestrate");

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: false, message: "Type a task after /orchestrate." });
    expect(createTab).not.toHaveBeenCalled();
  });

  it("a Codex draft never orchestrates: the flag is ignored and the /orchestrate token is sent literally", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    deps.rolesConfigured = () => false;
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("/orchestrate hi");
    tabsStore.getState().setDraftOrchestrate(true);
    tabsStore.getState().setCodexModels([{ id: "gpt-5.6-sol" }]);
    tabsStore.getState().setDraftEngine("codex");

    const res = await submitStartDraft(deps);

    expect(res.ok).toBe(true);
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "/orchestrate hi", undefined, undefined, undefined, undefined);
  });
});

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
    tabsStore.getState().setCodexModels([{ id: "gpt-5.6-mini" }, { id: "gpt-5.6-terra" }]);
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
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello", undefined, undefined, undefined, undefined);
  });

  it("codex-profiles W3-F: forwards the draft's Codex profile pick as codexProfileId", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setCodexModels([{ id: "gpt-5.6-sol" }]);
    tabsStore.getState().setDraftEngine("codex");
    tabsStore.getState().setDraftCodexProfileId("work");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({
      kind: "new",
      workspace: "/ws/a",
      engine: "codex",
      engineModel: "gpt-5.6-sol",
      codexProfileId: "work",
    });
  });

  it("a Codex draft with no explicit profile pick omits codexProfileId from createTab (system pseudo-profile default)", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setCodexModels([{ id: "gpt-5.6-sol" }]);
    tabsStore.getState().setDraftEngine("codex");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a", engine: "codex", engineModel: "gpt-5.6-sol" });
  });

  it("TASK.106 cut-1 stage A: forwards a Core draft's cross-connection pick as connectionId", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftConnectionId("conn-x");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a", connectionId: "conn-x" });
  });

  it("a Core draft with no explicit connection pick omits connectionId from createTab (active-connection default)", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a" });
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

  it("a Codex draft with no explicit model/preset pick sends the catalog's first entry (TASK.241: displayed default == sent), preset omitted for the host default", async () => {
    const { deps, tabsStore, createTab, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setCodexModels([{ id: "gpt-5.6-mini" }]);
    tabsStore.getState().setDraftEngine("codex");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a", engine: "codex", engineModel: "gpt-5.6-mini" });
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello", undefined, undefined, undefined, undefined);
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
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello there", undefined, "build", undefined, undefined, undefined, false);
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

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello there", "gpt-5", "build", undefined, undefined, undefined, false);
  });

  it("forwards the selected start-screen mode for first-turn setup", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("make a plan");
    tabsStore.getState().setDraftMode("plan");

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "make a plan", undefined, "plan", undefined, undefined, undefined, false);
  });

  it("TASK.81: forwards the draft's image attachments to queueInitialPrompt for a Core draft", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    const image = { name: "a.png", sizeBytes: 10, attachment: { mediaType: "image/png" as const, data: "AA==" } };
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("look at this");
    tabsStore.getState().setDraftImages([image]);

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "look at this", undefined, "build", undefined, [image], undefined, false);
  });

  it("TASK.81: forwards the draft's image attachments to queueInitialPrompt for a Codex draft", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    const image = { name: "a.png", sizeBytes: 10, attachment: { mediaType: "image/png" as const, data: "AA==" } };
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("look at this");
    tabsStore.getState().setCodexModels([{ id: "gpt-5.6-mini" }]);
    tabsStore.getState().setDraftEngine("codex");
    tabsStore.getState().setDraftImages([image]);

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "look at this", undefined, undefined, undefined, [image]);
  });

  it("TASK.81: forwards the draft's engine-effort pick to queueInitialPrompt for a Codex draft (never as part of the CreateTabRequest payload — set_engine_effort has no spawn-time channel)", async () => {
    const { deps, tabsStore, createTab, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setCodexModels([{ id: "gpt-5.6-mini" }]);
    tabsStore.getState().setDraftEngine("codex");
    tabsStore.getState().setDraftEngineEffort("high");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a", engine: "codex", engineModel: "gpt-5.6-mini" });
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello", undefined, undefined, "high", undefined);
  });

  it("TASK.131: a Codex effort pick never leaks into a Core session — the engine switch drops it", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftEngine("codex");
    tabsStore.getState().setDraftEngineEffort("high");
    tabsStore.getState().setDraftEngine("core");

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello", undefined, "build", undefined, undefined, undefined, false);
  });

  it("TASK.131: a Core draft's own effort pick rides as queueInitialPrompt's reasoning-effort argument (core speaks set_reasoning_effort, not set_engine_effort)", async () => {
    const { deps, tabsStore, queueInitialPrompt } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftModel("glm-5.2");
    tabsStore.getState().setDraftEngineEffort("max");

    await submitStartDraft(deps);

    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "hello", "glm-5.2", "build", undefined, undefined, "max", false);
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

describe("TASK.106 cut-1 — DoD item 3: settings.provider.activeConnectionId invariant", () => {
  function fakeSettingsSnapshot(): SettingsSnapshot {
    return {
      settings: {
        version: 2,
        provider: {
          activeConnectionId: "conn-active",
          connections: [
            { id: "conn-active", providerId: "anthropic" },
            { id: "conn-other", providerId: "kimi" },
          ],
        },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      },
      secrets: [{ key: "provider.apiKey", set: false, source: "none", tier: "unavailable" }],
      providerReady: false,
      envOverrides: [],
      readOnly: false,
    };
  }

  it("a cross-connection model pick + submit leaves the global settings store's activeConnectionId untouched — the pin lives only on the draft, never written back to settings", async () => {
    // An isolated settings-store instance, seeded directly (no bridge call —
    // this test never mutates it through `setPatch`/`connectionUpdate`; it
    // only ever READS it back at the end, to prove nothing else did either).
    const settingsStore = createSettingsStore();
    settingsStore.setState({ snapshot: fakeSettingsSnapshot() });

    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");

    // Cross-connection pick — StartScreen's own grouped-popover row click
    // handler (`selectStartModelRow`, StartScreen.tsx), picking a model that
    // belongs to a DIFFERENT connection than the (fake) active one.
    selectStartModelRow("conn-other", "kimi-k2", { tabsStore });
    expect(tabsStore.getState().draft?.connectionId).toBe("conn-other");

    await submitStartDraft(deps);

    // DoD item 2 (already covered elsewhere, re-asserted here for context):
    // the pin rode all the way to createTab.
    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a", connectionId: "conn-other" });
    // DoD item 3: the global default connection never moved.
    expect(settingsStore.getState().snapshot?.settings.provider.activeConnectionId).toBe("conn-active");
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

describe("submitStartDraft — TASK.241 codex draft-model agreement", () => {
  const CODEX_CATALOG = [{ id: "gpt-5.6-sol" }, { id: "luna" }] as const;

  it("TASK.241: null draft + ready catalog sends the SAME first entry the chip displays", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setCodexModels([...CODEX_CATALOG]);
    tabsStore.getState().setDraftEngine("codex");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "new", engine: "codex", engineModel: "gpt-5.6-sol" }),
    );
    expect(resolveCodexDraftModel(null, [...CODEX_CATALOG])).toBe("gpt-5.6-sol");
  });

  it("TASK.241: an explicit Sol pick present in the catalog is forwarded verbatim", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setCodexModels([...CODEX_CATALOG]);
    tabsStore.getState().setDraftModel("gpt-5.6-sol");
    tabsStore.getState().setDraftEngine("codex");

    await submitStartDraft(deps);

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "new", engine: "codex", engineModel: "gpt-5.6-sol" }),
    );
  });

  it("TASK.241: a STALE draft.model is visibly refused — createTab never called, pick preserved, message names the id", async () => {
    const { deps, tabsStore, createTab } = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    tabsStore.getState().openDraft("/ws/a");
    tabsStore.getState().setDraftPrompt("hello");
    tabsStore.getState().setDraftModel("claude-opus");
    tabsStore.getState().setCodexModels([...CODEX_CATALOG]);
    tabsStore.getState().setDraftEngine("codex");

    const res = await submitStartDraft(deps);

    expect(res).toEqual({ ok: false, message: expect.stringContaining("claude-opus") });
    expect(createTab).not.toHaveBeenCalled();
    expect(tabsStore.getState().draft?.model).toBe("claude-opus");
  });

  it("TASK.241: an empty/unloaded catalog refuses instead of silently launching the server default — for BOTH a null model and an explicit pick", async () => {
    const nullModel = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    nullModel.tabsStore.getState().openDraft("/ws/a");
    nullModel.tabsStore.getState().setDraftPrompt("hello");
    nullModel.tabsStore.getState().setDraftEngine("codex");
    const nullModelRes = await submitStartDraft(nullModel.deps);
    expect(nullModelRes).toEqual({ ok: false, message: expect.any(String) });
    expect(nullModel.createTab).not.toHaveBeenCalled();

    const explicit = makeDeps({ ok: true, tabId: "t2", workspace: "/ws/a" });
    explicit.tabsStore.getState().openDraft("/ws/a");
    explicit.tabsStore.getState().setDraftPrompt("hello");
    explicit.tabsStore.getState().setDraftModel("gpt-5.6-sol");
    explicit.tabsStore.getState().setDraftEngine("codex");
    const explicitRes = await submitStartDraft(explicit.deps);
    expect(explicitRes).toEqual({ ok: false, message: expect.any(String) });
    expect(explicit.createTab).not.toHaveBeenCalled();
  });

  it("TASK.241: the claude lane is unchanged — forwards draft.model raw when set, omits when null (no catalog consulted)", async () => {
    const set = makeDeps({ ok: true, tabId: "t1", workspace: "/ws/a" });
    set.tabsStore.getState().openDraft("/ws/a");
    set.tabsStore.getState().setDraftPrompt("hello");
    set.tabsStore.getState().setDraftModel("opus[1m]");
    set.tabsStore.getState().setDraftEngine("claude");
    await submitStartDraft(set.deps);
    expect(set.createTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "new", engine: "claude", engineModel: "opus[1m]" }),
    );

    const unset = makeDeps({ ok: true, tabId: "t2", workspace: "/ws/a" });
    unset.tabsStore.getState().openDraft("/ws/a");
    unset.tabsStore.getState().setDraftPrompt("hello");
    unset.tabsStore.getState().setDraftEngine("claude");
    await submitStartDraft(unset.deps);
    const req = (unset.createTab.mock.calls as unknown as [Record<string, unknown>[]])[0]![0]!;
    expect(req.engineModel).toBeUndefined();
  });
});

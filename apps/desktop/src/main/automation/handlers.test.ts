/**
 * Handler unit tests (design/phase-2-smoke-channel.md §4, task S3 criterion):
 * every command is exercised over fakes with zero Electron — a spy
 * `callFacade`, a fake `ManagerLike`, and a fake `app`. Covers the facade
 * caller's envelope unwrapping (ok/unavailable/error/eval-reject), the wait
 * predicate + poller (match and timeout), the sanctioned new-tab main path,
 * and that each thin command forwards the right method/args to the facade.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildFacadeExpr,
  closeTab,
  createTabNew,
  FacadeThrewError,
  FacadeUnavailableError,
  getState,
  gitCommand,
  gitConfirmAccept,
  gitConfirmCancel,
  gitPanel,
  gitStageConfirm,
  gitView,
  health,
  makeFacadeCaller,
  matchesUntil,
  projectHide,
  projectNewSession,
  quit,
  respondPermission,
  screenshot,
  selectTab,
  sendPrompt,
  setMode,
  stop,
  tryAgain,
  transcriptScrollState,
  transcriptScrollTo,
  todoPanelState,
  startScreenState,
  startScreenOpen,
  startScreenSetWorkspace,
  startScreenSetPrompt,
  startScreenSetModel,
  startScreenSetEngine,
  startScreenToggleProjectMenu,
  startScreenSubmit,
  queuePrompt,
  queueEdit,
  queueDelete,
  queueResume,
  queueClear,
  modelPillState,
  modelPillPick,
  agentCardState,
  agentCardExpand,
  settingsState,
  settingsOpen,
  settingsClose,
  settingsSelectPane,
  settingsPermissionAdd,
  settingsPermissionRemove,
  mcpPaneState,
  mcpToggle,
  mcpImportOpen,
  mcpImportApply,
  skillsPaneState,
  skillsToggle,
  skillsDelete,
  skillsImportOpen,
  skillsImportApply,
  subagentsPaneState,
  subagentsOpenEditor,
  subagentsEditorSet,
  subagentsEditorPreview,
  subagentsEditorSave,
  subagentsDelete,
  lspPanelState,
  lspPanelToggle,
  hooksPanelState,
  hooksPanelToggle,
  checkpointPanelState,
  rewindState,
  checkpointRewind,
  waitFor,
  type AutomationWindow,
  type HandlerDeps,
  type ManagerLike,
} from "./handlers.js";
import type { CreateTabResult, TabHost, TabSummary } from "../tabs.js";

function fakeManager(overrides: Partial<ManagerLike> = {}): ManagerLike {
  return {
    createTab: vi.fn(
      (params): CreateTabResult => ({
        ok: true,
        tab: {
          tabId: "tab-new",
          workspace: params.workspace,
          sessionId: params.sessionId,
          proc: null,
          spawnedAt: 0,
          rapidRespawns: 0,
          state: "running",
          initialResume: params.resume,
        } as TabHost,
      }),
    ),
    deliverTabPort: vi.fn(),
    listTabs: vi.fn((): ReadonlyArray<TabSummary> => []),
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    callFacade: vi.fn(async () => ({ ok: true })),
    getWindow: vi.fn(() => null),
    manager: fakeManager(),
    app: { quit: vi.fn(), getVersion: vi.fn(() => "9.9.9") },
    ...overrides,
  };
}

/** A fake AutomationWindow whose executeJavaScript returns a canned value. */
function fakeWindow(executeJavaScript: (code: string) => Promise<unknown>, destroyed = false): AutomationWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      executeJavaScript: vi.fn(executeJavaScript),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("PNGDATA") })),
    },
  };
}

describe("makeFacadeCaller — envelope unwrapping", () => {
  it("returns the value on an ok envelope", async () => {
    const win = fakeWindow(async () => ({ __facade: "ok", value: { hello: "world" } }));
    const caller = makeFacadeCaller(() => win);
    await expect(caller("snapshot", [])).resolves.toEqual({ hello: "world" });
  });

  it("throws FacadeUnavailableError when the facade is not installed", async () => {
    const win = fakeWindow(async () => ({ __facade: "unavailable" }));
    const caller = makeFacadeCaller(() => win);
    await expect(caller("snapshot", [])).rejects.toBeInstanceOf(FacadeUnavailableError);
  });

  it("throws FacadeUnavailableError when there is no window", async () => {
    const caller = makeFacadeCaller(() => null);
    await expect(caller("snapshot", [])).rejects.toBeInstanceOf(FacadeUnavailableError);
  });

  it("throws FacadeUnavailableError when the eval itself rejects (dead page)", async () => {
    const win = fakeWindow(async () => {
      throw new Error("page gone");
    });
    const caller = makeFacadeCaller(() => win);
    await expect(caller("snapshot", [])).rejects.toBeInstanceOf(FacadeUnavailableError);
  });

  it("throws FacadeThrewError when the facade method threw", async () => {
    const win = fakeWindow(async () => ({ __facade: "error", message: "boom" }));
    const caller = makeFacadeCaller(() => win);
    await expect(caller("sendPrompt", ["t", "x"])).rejects.toBeInstanceOf(FacadeThrewError);
  });

  it("builds an expression that names the method and embeds the args as JSON", () => {
    const expr = buildFacadeExpr("respondPermission", ["tab-a", "allow"]);
    expect(expr).toContain('window.__anycodeAutomation');
    expect(expr).toContain('"respondPermission"');
    expect(expr).toContain('["tab-a","allow"]');
  });
});

describe("thin facade commands forward method + args", () => {
  it("sendPrompt -> callFacade('sendPrompt', [tabId, text])", async () => {
    const deps = fakeDeps();
    await sendPrompt(deps, "tab-a", "hello");
    expect(deps.callFacade).toHaveBeenCalledWith("sendPrompt", ["tab-a", "hello"]);
  });

  it("tryAgain -> callFacade('tryAgain', [tabId]) (TASK.33 W8)", async () => {
    const deps = fakeDeps();
    await tryAgain(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("tryAgain", ["tab-a"]);
  });

  it("respondPermission omits requestId when undefined (facade defaults to pending)", async () => {
    const deps = fakeDeps();
    await respondPermission(deps, "tab-a", "allow", undefined);
    expect(deps.callFacade).toHaveBeenCalledWith("respondPermission", ["tab-a", "allow"]);
  });

  it("respondPermission passes requestId through when present", async () => {
    const deps = fakeDeps();
    await respondPermission(deps, "tab-a", "deny", "req-7");
    expect(deps.callFacade).toHaveBeenCalledWith("respondPermission", ["tab-a", "deny", "req-7"]);
  });

  it("setMode / stop / selectTab / closeTab forward correctly", async () => {
    const deps = fakeDeps();
    await setMode(deps, "tab-a", "plan");
    await stop(deps, "tab-a");
    await selectTab(deps, "tab-a");
    await closeTab(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("setMode", ["tab-a", "plan"]);
    expect(deps.callFacade).toHaveBeenCalledWith("stop", ["tab-a"]);
    expect(deps.callFacade).toHaveBeenCalledWith("selectTab", ["tab-a"]);
    expect(deps.callFacade).toHaveBeenCalledWith("closeTab", ["tab-a"]);
  });
});

describe("git thin facade commands forward method + args (slice-5.8-R8-cut.md §2.2)", () => {
  it("gitCommand -> callFacade('gitCommand', [tabId, command])", async () => {
    const deps = fakeDeps();
    const command = { op: "refresh" };
    await gitCommand(deps, "tab-a", command);
    expect(deps.callFacade).toHaveBeenCalledWith("gitCommand", ["tab-a", command]);
  });

  it("gitStageConfirm -> callFacade('gitStageConfirm', [tabId, intent])", async () => {
    const deps = fakeDeps();
    const intent = { op: "discard", paths: ["a.txt"] };
    await gitStageConfirm(deps, "tab-a", intent);
    expect(deps.callFacade).toHaveBeenCalledWith("gitStageConfirm", ["tab-a", intent]);
  });

  it("gitConfirmAccept -> callFacade('gitConfirm', [tabId])", async () => {
    const deps = fakeDeps();
    await gitConfirmAccept(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("gitConfirm", ["tab-a"]);
  });

  it("gitConfirmCancel -> callFacade('gitCancelConfirm', [tabId])", async () => {
    const deps = fakeDeps();
    await gitConfirmCancel(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("gitCancelConfirm", ["tab-a"]);
  });

  it("gitPanel -> callFacade('gitSetPanelOpen', [tabId, open])", async () => {
    const deps = fakeDeps();
    await gitPanel(deps, "tab-a", true);
    expect(deps.callFacade).toHaveBeenCalledWith("gitSetPanelOpen", ["tab-a", true]);
  });

  it("gitView -> callFacade('gitSetView', [tabId, view])", async () => {
    const deps = fakeDeps();
    await gitView(deps, "tab-a", "history");
    expect(deps.callFacade).toHaveBeenCalledWith("gitSetView", ["tab-a", "history"]);
  });
});

describe("project thin facade commands forward method + args (design/slice-GUI-P1-cut.md §2F.5)", () => {
  it("projectNewSession -> callFacade('projectNewSession', [workspace])", async () => {
    const deps = fakeDeps();
    await projectNewSession(deps, "/tmp/ws-b");
    expect(deps.callFacade).toHaveBeenCalledWith("projectNewSession", ["/tmp/ws-b"]);
  });

  it("projectHide -> callFacade('projectHide', [workspace])", async () => {
    const deps = fakeDeps();
    await projectHide(deps, "/tmp/ws-b");
    expect(deps.callFacade).toHaveBeenCalledWith("projectHide", ["/tmp/ws-b"]);
  });
});

describe("transcript-scroll thin facade commands forward method + args (design/slice-P7.3-cut.md §3.3)", () => {
  it("transcriptScrollState -> callFacade('transcriptScrollState', [tabId])", async () => {
    const deps = fakeDeps();
    await transcriptScrollState(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("transcriptScrollState", ["tab-a"]);
  });

  it("transcriptScrollTo -> callFacade('transcriptScrollTo', [tabId, to])", async () => {
    const deps = fakeDeps();
    await transcriptScrollTo(deps, "tab-a", "top");
    expect(deps.callFacade).toHaveBeenCalledWith("transcriptScrollTo", ["tab-a", "top"]);
  });
});

describe("todo-panel thin facade command forwards method + args (design/slice-P7.11-cut.md §3 W2)", () => {
  it("todoPanelState -> callFacade('todoPanelState', [tabId])", async () => {
    const deps = fakeDeps();
    await todoPanelState(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("todoPanelState", ["tab-a"]);
  });
});

describe("agent-card thin facade commands forward method + args (design/slice-P7.18-cut.md §4 W4)", () => {
  it("agentCardState -> callFacade('agentCardState', [tabId, toolCallId])", async () => {
    const deps = fakeDeps();
    await agentCardState(deps, "tab-a", "call-1");
    expect(deps.callFacade).toHaveBeenCalledWith("agentCardState", ["tab-a", "call-1"]);
  });

  it("agentCardExpand -> callFacade('agentCardExpand', [tabId, toolCallId])", async () => {
    const deps = fakeDeps();
    await agentCardExpand(deps, "tab-a", "call-1");
    expect(deps.callFacade).toHaveBeenCalledWith("agentCardExpand", ["tab-a", "call-1"]);
  });
});

describe("model-pill thin facade commands forward method + args (design/slice-P7.15-cut.md §2.6 W4)", () => {
  it("modelPillState -> callFacade('modelPillState', [tabId])", async () => {
    const deps = fakeDeps();
    await modelPillState(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("modelPillState", ["tab-a"]);
  });

  it('modelPillPick({kind:"open"}) -> callFacade(\'modelPillPick\', [tabId, {kind:"open"}])', async () => {
    const deps = fakeDeps();
    await modelPillPick(deps, "tab-a", { kind: "open" });
    expect(deps.callFacade).toHaveBeenCalledWith("modelPillPick", ["tab-a", { kind: "open" }]);
  });

  it('modelPillPick({kind:"model",value}) -> callFacade(\'modelPillPick\', [tabId, {kind:"model",value}])', async () => {
    const deps = fakeDeps();
    await modelPillPick(deps, "tab-a", { kind: "model", value: "glm-4.6" });
    expect(deps.callFacade).toHaveBeenCalledWith("modelPillPick", ["tab-a", { kind: "model", value: "glm-4.6" }]);
  });

  it('modelPillPick({kind:"effort",value}) -> callFacade(\'modelPillPick\', [tabId, {kind:"effort",value}])', async () => {
    const deps = fakeDeps();
    await modelPillPick(deps, "tab-a", { kind: "effort", value: "high" });
    expect(deps.callFacade).toHaveBeenCalledWith("modelPillPick", ["tab-a", { kind: "effort", value: "high" }]);
  });
});

describe("settings thin facade commands forward method + args (design/slice-P7.16-cut.md §5 W4)", () => {
  it("settingsState -> callFacade('settingsState', [])", async () => {
    const deps = fakeDeps();
    await settingsState(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("settingsState", []);
  });

  it("settingsOpen -> callFacade('settingsOpen', [])", async () => {
    const deps = fakeDeps();
    await settingsOpen(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("settingsOpen", []);
  });

  it("settingsClose -> callFacade('settingsClose', [])", async () => {
    const deps = fakeDeps();
    await settingsClose(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("settingsClose", []);
  });

  it("settingsSelectPane -> callFacade('settingsSelectPane', [paneId])", async () => {
    const deps = fakeDeps();
    await settingsSelectPane(deps, "permissions");
    expect(deps.callFacade).toHaveBeenCalledWith("settingsSelectPane", ["permissions"]);
  });

  it("settingsPermissionAdd with a pattern -> callFacade('settingsPermissionAdd', [{toolName, pattern}])", async () => {
    const deps = fakeDeps();
    await settingsPermissionAdd(deps, "Bash", "node *");
    expect(deps.callFacade).toHaveBeenCalledWith("settingsPermissionAdd", [{ toolName: "Bash", pattern: "node *" }]);
  });

  it("settingsPermissionAdd with no pattern -> callFacade('settingsPermissionAdd', [{toolName, pattern:undefined}])", async () => {
    const deps = fakeDeps();
    await settingsPermissionAdd(deps, "WebFetch", undefined);
    expect(deps.callFacade).toHaveBeenCalledWith("settingsPermissionAdd", [{ toolName: "WebFetch", pattern: undefined }]);
  });

  it("settingsPermissionRemove with a pattern -> callFacade('settingsPermissionRemove', [{toolName, pattern}])", async () => {
    const deps = fakeDeps();
    await settingsPermissionRemove(deps, "Bash", "git *");
    expect(deps.callFacade).toHaveBeenCalledWith("settingsPermissionRemove", [{ toolName: "Bash", pattern: "git *" }]);
  });

  it("settingsPermissionRemove with no pattern -> callFacade('settingsPermissionRemove', [{toolName, pattern:undefined}])", async () => {
    const deps = fakeDeps();
    await settingsPermissionRemove(deps, "Edit", undefined);
    expect(deps.callFacade).toHaveBeenCalledWith("settingsPermissionRemove", [{ toolName: "Edit", pattern: undefined }]);
  });
});

describe("MCP pane thin facade commands forward method + args (design/slice-P7.19-cut.md §4 W4)", () => {
  it("mcpPaneState -> callFacade('mcpPaneState', [])", async () => {
    const deps = fakeDeps();
    await mcpPaneState(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("mcpPaneState", []);
  });

  it("mcpToggle -> callFacade('mcpToggle', [name])", async () => {
    const deps = fakeDeps();
    await mcpToggle(deps, "my-server");
    expect(deps.callFacade).toHaveBeenCalledWith("mcpToggle", ["my-server"]);
  });

  it("mcpImportOpen -> callFacade('mcpImportOpen', [])", async () => {
    const deps = fakeDeps();
    await mcpImportOpen(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("mcpImportOpen", []);
  });

  it("mcpImportApply -> callFacade('mcpImportApply', [args])", async () => {
    const deps = fakeDeps();
    await mcpImportApply(deps, { consent: true, names: ["a", "b"] });
    expect(deps.callFacade).toHaveBeenCalledWith("mcpImportApply", [{ consent: true, names: ["a", "b"] }]);
  });

  it("mcpImportApply with no names -> callFacade('mcpImportApply', [{consent, names:undefined}])", async () => {
    const deps = fakeDeps();
    await mcpImportApply(deps, { consent: false, names: undefined });
    expect(deps.callFacade).toHaveBeenCalledWith("mcpImportApply", [{ consent: false, names: undefined }]);
  });
});

describe("Skills pane thin facade commands forward method + args (design/slice-P7.20-cut.md §5 W4)", () => {
  it("skillsPaneState -> callFacade('skillsPaneState', [])", async () => {
    const deps = fakeDeps();
    await skillsPaneState(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("skillsPaneState", []);
  });

  it("skillsToggle -> callFacade('skillsToggle', [name])", async () => {
    const deps = fakeDeps();
    await skillsToggle(deps, "alpha");
    expect(deps.callFacade).toHaveBeenCalledWith("skillsToggle", ["alpha"]);
  });

  it("skillsDelete -> callFacade('skillsDelete', [name])", async () => {
    const deps = fakeDeps();
    await skillsDelete(deps, "alpha");
    expect(deps.callFacade).toHaveBeenCalledWith("skillsDelete", ["alpha"]);
  });

  it("skillsImportOpen -> callFacade('skillsImportOpen', [])", async () => {
    const deps = fakeDeps();
    await skillsImportOpen(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("skillsImportOpen", []);
  });

  it("skillsImportApply -> callFacade('skillsImportApply', [args])", async () => {
    const deps = fakeDeps();
    await skillsImportApply(deps, { scope: "project", ids: ["a", "b"] });
    expect(deps.callFacade).toHaveBeenCalledWith("skillsImportApply", [{ scope: "project", ids: ["a", "b"] }]);
  });

  it("skillsImportApply with no ids -> callFacade('skillsImportApply', [{scope, ids:undefined}])", async () => {
    const deps = fakeDeps();
    await skillsImportApply(deps, { scope: "user", ids: undefined });
    expect(deps.callFacade).toHaveBeenCalledWith("skillsImportApply", [{ scope: "user", ids: undefined }]);
  });
});

describe("Subagents pane thin facade commands forward method + args (design/slice-P7.21-cut.md §4 W4)", () => {
  it("subagentsPaneState -> callFacade('subagentsPaneState', [])", async () => {
    const deps = fakeDeps();
    await subagentsPaneState(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("subagentsPaneState", []);
  });

  it("subagentsOpenEditor with no name -> callFacade('subagentsOpenEditor', [])", async () => {
    const deps = fakeDeps();
    await subagentsOpenEditor(deps, undefined);
    expect(deps.callFacade).toHaveBeenCalledWith("subagentsOpenEditor", []);
  });

  it("subagentsOpenEditor with a name -> callFacade('subagentsOpenEditor', [name])", async () => {
    const deps = fakeDeps();
    await subagentsOpenEditor(deps, "researcher");
    expect(deps.callFacade).toHaveBeenCalledWith("subagentsOpenEditor", ["researcher"]);
  });

  it("subagentsEditorSet -> callFacade('subagentsEditorSet', [args])", async () => {
    const deps = fakeDeps();
    const args = { name: "summarizer", description: "Summarizes code.", tools: ["Read"], body: "prompt" };
    await subagentsEditorSet(deps, args);
    expect(deps.callFacade).toHaveBeenCalledWith("subagentsEditorSet", [args]);
  });

  it("subagentsEditorPreview -> callFacade('subagentsEditorPreview', [])", async () => {
    const deps = fakeDeps();
    await subagentsEditorPreview(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("subagentsEditorPreview", []);
  });

  it("subagentsEditorSave -> callFacade('subagentsEditorSave', [])", async () => {
    const deps = fakeDeps();
    await subagentsEditorSave(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("subagentsEditorSave", []);
  });

  it("subagentsDelete -> callFacade('subagentsDelete', [name])", async () => {
    const deps = fakeDeps();
    await subagentsDelete(deps, "summarizer");
    expect(deps.callFacade).toHaveBeenCalledWith("subagentsDelete", ["summarizer"]);
  });
});

describe("start-screen thin facade commands forward method + args (design/slice-P7.12-cut.md §5 W2)", () => {
  it("startScreenState -> callFacade('startScreenState', [])", async () => {
    const deps = fakeDeps();
    await startScreenState(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenState", []);
  });

  it("startScreenOpen with no workspace -> callFacade('startScreenOpen', [])", async () => {
    const deps = fakeDeps();
    await startScreenOpen(deps, undefined);
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenOpen", []);
  });

  it("startScreenOpen with a workspace -> callFacade('startScreenOpen', [workspace])", async () => {
    const deps = fakeDeps();
    await startScreenOpen(deps, "/tmp/ws-c");
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenOpen", ["/tmp/ws-c"]);
  });

  it("startScreenSetWorkspace -> callFacade('startScreenSetWorkspace', [workspace])", async () => {
    const deps = fakeDeps();
    await startScreenSetWorkspace(deps, "/tmp/ws-c");
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenSetWorkspace", ["/tmp/ws-c"]);
  });

  it("startScreenSetPrompt -> callFacade('startScreenSetPrompt', [text])", async () => {
    const deps = fakeDeps();
    await startScreenSetPrompt(deps, "hello");
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenSetPrompt", ["hello"]);
  });

  it("startScreenSubmit -> callFacade('startScreenSubmit', [])", async () => {
    const deps = fakeDeps();
    await startScreenSubmit(deps);
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenSubmit", []);
  });

  it("startScreenSetModel with a model id -> callFacade('startScreenSetModel', [model])", async () => {
    const deps = fakeDeps();
    await startScreenSetModel(deps, "claude-opus-4");
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenSetModel", ["claude-opus-4"]);
  });

  it("startScreenSetModel with null -> callFacade('startScreenSetModel', [null])", async () => {
    const deps = fakeDeps();
    await startScreenSetModel(deps, null);
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenSetModel", [null]);
  });

  it("startScreenSetEngine -> callFacade('startScreenSetEngine', [engineId]) (codex-fixes TASK.42, cut §3.7)", async () => {
    const deps = fakeDeps();
    await startScreenSetEngine(deps, "codex");
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenSetEngine", ["codex"]);
  });

  it("startScreenToggleProjectMenu(true) -> callFacade('startScreenToggleProjectMenu', [true])", async () => {
    const deps = fakeDeps();
    await startScreenToggleProjectMenu(deps, true);
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenToggleProjectMenu", [true]);
  });

  it("startScreenToggleProjectMenu(false) -> callFacade('startScreenToggleProjectMenu', [false])", async () => {
    const deps = fakeDeps();
    await startScreenToggleProjectMenu(deps, false);
    expect(deps.callFacade).toHaveBeenCalledWith("startScreenToggleProjectMenu", [false]);
  });
});

describe("prompt-queue thin facade commands forward method + args (design/slice-P7.14-cut.md §5 W3)", () => {
  it("queuePrompt -> callFacade('queuePrompt', [tabId, text])", async () => {
    const deps = fakeDeps();
    await queuePrompt(deps, "tab-a", "hello");
    expect(deps.callFacade).toHaveBeenCalledWith("queuePrompt", ["tab-a", "hello"]);
  });

  it("queueEdit -> callFacade('queueEdit', [tabId, id, text])", async () => {
    const deps = fakeDeps();
    await queueEdit(deps, "tab-a", "prompt-1", "edited");
    expect(deps.callFacade).toHaveBeenCalledWith("queueEdit", ["tab-a", "prompt-1", "edited"]);
  });

  it("queueDelete -> callFacade('queueDelete', [tabId, id])", async () => {
    const deps = fakeDeps();
    await queueDelete(deps, "tab-a", "prompt-1");
    expect(deps.callFacade).toHaveBeenCalledWith("queueDelete", ["tab-a", "prompt-1"]);
  });

  it("queueResume -> callFacade('queueResume', [tabId])", async () => {
    const deps = fakeDeps();
    await queueResume(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("queueResume", ["tab-a"]);
  });

  it("queueClear -> callFacade('queueClear', [tabId])", async () => {
    const deps = fakeDeps();
    await queueClear(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("queueClear", ["tab-a"]);
  });
});

describe("LSP / Hooks panel thin facade commands forward method + args (design/slice-P7.25-cut.md §3 W3)", () => {
  it("lspPanelState -> callFacade('lspPanelState', [tabId])", async () => {
    const deps = fakeDeps();
    await lspPanelState(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("lspPanelState", ["tab-a"]);
  });

  it("lspPanelToggle -> callFacade('lspPanelToggle', [tabId])", async () => {
    const deps = fakeDeps();
    await lspPanelToggle(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("lspPanelToggle", ["tab-a"]);
  });

  it("hooksPanelState -> callFacade('hooksPanelState', [tabId])", async () => {
    const deps = fakeDeps();
    await hooksPanelState(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("hooksPanelState", ["tab-a"]);
  });

  it("hooksPanelToggle -> callFacade('hooksPanelToggle', [tabId])", async () => {
    const deps = fakeDeps();
    await hooksPanelToggle(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("hooksPanelToggle", ["tab-a"]);
  });
});

describe("Checkpoint timeline / rewind thin facade commands forward method + args (design slice-P7.26-R2-ratification.md §1 W3)", () => {
  it("checkpointPanelState -> callFacade('checkpointPanelState', [tabId])", async () => {
    const deps = fakeDeps();
    await checkpointPanelState(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("checkpointPanelState", ["tab-a"]);
  });

  it("rewindState -> callFacade('rewindState', [tabId])", async () => {
    const deps = fakeDeps();
    await rewindState(deps, "tab-a");
    expect(deps.callFacade).toHaveBeenCalledWith("rewindState", ["tab-a"]);
  });

  it("checkpointRewind -> callFacade('checkpointRewind', [tabId, args])", async () => {
    const deps = fakeDeps();
    await checkpointRewind(deps, "tab-a", { checkpointId: "cp-1", scope: "both" });
    expect(deps.callFacade).toHaveBeenCalledWith("checkpointRewind", ["tab-a", { checkpointId: "cp-1", scope: "both" }]);
  });

  it("checkpointRewind forwards an index-based resolution the same way", async () => {
    const deps = fakeDeps();
    await checkpointRewind(deps, "tab-a", { index: 0, scope: "files" });
    expect(deps.callFacade).toHaveBeenCalledWith("checkpointRewind", ["tab-a", { index: 0, scope: "files" }]);
  });
});

describe("health / getState / screenshot", () => {
  it("health reports pid, version, and tab count", () => {
    const manager = fakeManager({
      listTabs: () => [
        { tabId: "t1", workspace: "/a", sessionId: "s1", state: "running", pid: 111 },
        { tabId: "t2", workspace: "/b", sessionId: "s2", state: "running", pid: 222 },
      ],
    });
    const result = health(fakeDeps({ manager }));
    expect(result.ok).toBe(true);
    expect(result.version).toBe("9.9.9");
    expect(result.tabs).toBe(2);
    expect(result.pid).toBe(process.pid);
  });

  it("getState puts the renderer snapshot beside the main-plane tab list", async () => {
    const snapshot = { tabs: [], activeTabId: null, states: {} };
    const tabs: TabSummary[] = [{ tabId: "t1", workspace: "/a", sessionId: "s1", state: "running", pid: 111 }];
    const deps = fakeDeps({
      callFacade: vi.fn(async () => snapshot),
      manager: fakeManager({ listTabs: () => tabs }),
    });
    const result = await getState(deps, undefined);
    expect(result.snapshot).toBe(snapshot);
    expect(result.tabs).toEqual(tabs);
    expect(deps.callFacade).toHaveBeenCalledWith("snapshot", []);
  });

  it("getState forwards the tail when given", async () => {
    const deps = fakeDeps({ callFacade: vi.fn(async () => ({})) });
    await getState(deps, 50);
    expect(deps.callFacade).toHaveBeenCalledWith("snapshot", [50]);
  });

  it("screenshot base64-encodes capturePage's PNG", async () => {
    const win = fakeWindow(async () => ({ __facade: "ok" }));
    const result = await screenshot(fakeDeps({ getWindow: () => win }));
    expect(result.png).toBe(Buffer.from("PNGDATA").toString("base64"));
  });

  it("screenshot throws FacadeUnavailableError when there is no window", async () => {
    await expect(screenshot(fakeDeps({ getWindow: () => null }))).rejects.toBeInstanceOf(FacadeUnavailableError);
  });
});

describe("createTabNew — sanctioned dialog bypass", () => {
  it("passes the workspace to manager.createTab, delivers the port, returns tabId/sessionId", () => {
    const manager = fakeManager();
    const deps = fakeDeps({ manager });
    const result = createTabNew(deps, "/tmp/ws-2");
    expect(manager.createTab).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/ws-2", resume: false }),
    );
    expect(manager.deliverTabPort).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, tabId: "tab-new", sessionId: expect.any(String), workspace: "/tmp/ws-2" });
  });

  it("surfaces manager refusal (max_tabs) without delivering a port", () => {
    const manager = fakeManager({ createTab: vi.fn((): CreateTabResult => ({ ok: false, reason: "max_tabs" })) });
    const deps = fakeDeps({ manager });
    const result = createTabNew(deps, "/tmp/ws-2");
    expect(result).toEqual({ ok: false, reason: "max_tabs" });
    expect(manager.deliverTabPort).not.toHaveBeenCalled();
  });
});

describe("quit", () => {
  it("calls app.quit and returns ok", () => {
    const deps = fakeDeps();
    expect(quit(deps)).toEqual({ ok: true });
    expect(deps.app.quit).toHaveBeenCalledTimes(1);
  });
});

describe("matchesUntil predicate (§4.3)", () => {
  const base = {
    connection: "ready",
    turn: { status: "idle" },
    permission: null,
    transcript: [
      { kind: "user_text", text: "make hello.txt" },
      { kind: "tool_call", modelText: "writing the file now" },
    ],
  };

  it("undefined state never matches", () => {
    expect(matchesUntil(undefined, { connection: "ready" })).toBe(false);
  });

  it("matches when every provided key holds", () => {
    expect(matchesUntil(base, { connection: "ready", turnStatus: "idle", permissionPending: false })).toBe(true);
  });

  it("fails a single mismatched key", () => {
    expect(matchesUntil(base, { connection: "host_exited" })).toBe(false);
    expect(matchesUntil(base, { turnStatus: "running" })).toBe(false);
    expect(matchesUntil(base, { permissionPending: true })).toBe(false);
  });

  it("transcriptIncludes searches text blocks AND tool modelText", () => {
    expect(matchesUntil(base, { transcriptIncludes: "hello.txt" })).toBe(true);
    expect(matchesUntil(base, { transcriptIncludes: "writing the file" })).toBe(true);
    expect(matchesUntil(base, { transcriptIncludes: "not present" })).toBe(false);
  });

  it("gitStatusKnown matches state.git.statusKnown", () => {
    const withGit = { ...base, git: { statusKnown: true, pending: {} } };
    expect(matchesUntil(withGit, { gitStatusKnown: true })).toBe(true);
    expect(matchesUntil(withGit, { gitStatusKnown: false })).toBe(false);
  });

  it("gitPendingEmpty matches whether state.git.pending is empty", () => {
    const idle = { ...base, git: { statusKnown: true, pending: {} } };
    const busy = { ...base, git: { statusKnown: true, pending: { refresh: { kind: "refresh", label: "refresh" } } } };
    expect(matchesUntil(idle, { gitPendingEmpty: true })).toBe(true);
    expect(matchesUntil(busy, { gitPendingEmpty: true })).toBe(false);
    expect(matchesUntil(busy, { gitPendingEmpty: false })).toBe(true);
  });

  it("absence of the git slice reads as gitStatusKnown=false / gitPendingEmpty=true (pre-R8 snapshot)", () => {
    expect(matchesUntil(base, { gitStatusKnown: false })).toBe(true);
    expect(matchesUntil(base, { gitStatusKnown: true })).toBe(false);
    expect(matchesUntil(base, { gitPendingEmpty: true })).toBe(true);
    expect(matchesUntil(base, { gitPendingEmpty: false })).toBe(false);
  });
});

describe("waitFor poller (§4.3)", () => {
  it("returns matched:true with the final state once the predicate holds", async () => {
    let call = 0;
    const callFacade = vi.fn(async () => {
      call += 1;
      // Not ready for the first two polls; ready on the third.
      const connection = call >= 3 ? "ready" : "awaiting_host_ready";
      return { states: { "tab-a": { connection, turn: { status: "idle" }, permission: null, transcript: [] } } };
    });
    const deps = fakeDeps({ callFacade, now: () => 0, sleep: async () => {}, pollMs: 0 });

    const result = await waitFor(deps, "tab-a", { connection: "ready" }, 60_000);
    expect(result.matched).toBe(true);
    expect(call).toBe(3);
    expect(result.state).toEqual({ connection: "ready", turn: { status: "idle" }, permission: null, transcript: [] });
  });

  it("returns matched:false with the final snapshot on timeout", async () => {
    let t = 0;
    const callFacade = vi.fn(async () => ({
      states: { "tab-a": { connection: "awaiting_host_ready", turn: { status: "idle" }, permission: null, transcript: [] } },
    }));
    const deps = fakeDeps({
      callFacade,
      now: () => t,
      sleep: async () => {
        t += 100;
      },
      pollMs: 0,
    });

    const result = await waitFor(deps, "tab-a", { connection: "ready" }, 250);
    expect(result.matched).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(result.state).toEqual({
      connection: "awaiting_host_ready",
      turn: { status: "idle" },
      permission: null,
      transcript: [],
    });
  });

  it("caps the timeout at 300000ms", async () => {
    // A huge requested timeout must not extend past the cap. We assert indirectly:
    // with now() jumping past 300000 on the first sleep, a non-matching poll gives up.
    let t = 0;
    const deps = fakeDeps({
      callFacade: vi.fn(async () => ({
        states: { "tab-a": { connection: "awaiting_host_ready", turn: { status: "idle" }, permission: null, transcript: [] } },
      })),
      now: () => t,
      sleep: async () => {
        t += 300_001;
      },
      pollMs: 0,
    });
    const result = await waitFor(deps, "tab-a", { connection: "ready" }, 10_000_000);
    expect(result.matched).toBe(false);
  });
});

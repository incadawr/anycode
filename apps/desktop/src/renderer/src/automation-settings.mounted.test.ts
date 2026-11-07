// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAutomationFacade, realMcpPaneDom, realSkillsPaneDom, realSubagentsPaneDom, realProviderPaneDom, realSettingsDom, realVisionPaneDom, realCodexPaneDom, type AnycodeBridge } from "./automation.js";
import { McpFormDialog, McpImportDialog, McpRowItem, McpServersPane, blankMcpFormFields, type McpConfigBridge } from "./components/McpServersPane.js";
import { SkillImportDialog, SkillRowItem, SkillsPane, type SkillsBridge } from "./components/SkillsPane.js";
import { ENGINE_BUILTIN_SKILLS } from "../../shared/engine-skills.js";
import { ScopeDropdown } from "./components/ScopeSwitcher.js";
import { USER_SCOPE, scopeRefFor, type ScopeSelection } from "./components/scope-model.js";
import type { ScopeWorkspaceEntry } from "../../shared/scope-workspaces.js";
import { SubagentsPane } from "./components/SubagentsPane.js";
import { createStore } from "zustand/vanilla";
import { cloneDefaults } from "../../settings/schema.js";
import { PermissionsEditor } from "./components/PermissionsEditor.js";
import { VisionPane } from "./components/VisionPane.js";
import { ConnectionDrawerFields } from "./components/ConnectionDrawer.js";
import { CodexEnginePane } from "./components/CodexEnginePane.js";
import { ConnectionTile, connectionSecretKey } from "./components/ConnectionTile.js";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("CSS", { escape: (v: string) => v });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
const noop = () => {};
let cleanup = async () => {};
afterEach(async () => { await cleanup(); cleanup = async () => {}; });
async function mount(element: React.ReactNode) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => { await act(async () => root.unmount()); container.remove(); };
  await act(async () => root.render(element));
  return { container, render: async (node: React.ReactNode) => act(async () => root.render(node)) };
}

it("drives the MCP switch and form against kit controls", async () => {
  const toggle = vi.fn(), submit = vi.fn();
  const entry = {name:"srv", source:"user", enabled:true, transport:"stdio", commandLine:"node", envKeys:[], shadowed:false} as const;
  const row = {entry, status:undefined, dotKind:"neutral", detail:"ready"} as const;
  function Form() { const [fields,setFields] = useState(blankMcpFormFields("user")); return createElement(McpFormDialog,{mode:"add",fields,error:null,scopeMode:"user",onChange:setFields,onCancel:noop,onSubmit:submit}); }
  await mount(createElement("section", {className:"mcp-pane"}, createElement("ul",null,createElement(McpRowItem,{row:row as never,confirmDelete:false,onToggle:toggle,onEdit:noop,onRequestDelete:noop,onCancelDelete:noop,onConfirmDelete:noop})),createElement(Form)));
  const dom = realMcpPaneDom();
  await act(async () => { expect(dom.clickRowToggle("srv")).toBe(true); });
  expect(toggle).toHaveBeenCalledOnce();
  await act(async () => { expect(dom.setFormText("Name","demo")).toBe(true); });
  await act(async () => { expect(dom.setFormText("Command","node")).toBe(true); });
  await act(async () => { expect(dom.setFormText("Arguments (one per line)","index.js")).toBe(true); });
  expect(dom.formTextValue("Name")).toBe("demo");
  await act(async () => { expect(dom.clickFormSubmit()).toBe(true); });
  expect(submit).toHaveBeenCalledOnce();
});

it("drives both rendered import apply buttons and the skills delete confirmation", async () => {
  const mcpApply = vi.fn(), skillApply = vi.fn(), deleted = vi.fn(), requested = vi.fn();
  const skill = {name:"demo",sourceKind:"user",enabled:true,description:"test"} as const;
  const mcp = createElement(McpImportDialog,{scan:{candidates:[{id:"one",harness:"claude",sourcePath:"config",name:"browser",transport:"stdio",commandLine:"node",envKeys:[],hasSecrets:false,alreadyConfigured:false}],problems:[]},selection:{one:true},consent:true,scopeMode:"user",results:null,onToggleRow:noop,onConsentChange:noop,onApply:mcpApply,onClose:noop});
  const skills = createElement(SkillImportDialog,{scan:{candidates:[{id:"one",harness:"claude",sourceDir:"skills/browser",name:"browser",description:"Browser",compatible:true,needsConversion:false,conversionNotes:[],alreadyPresent:false}],problems:[]},selection:{one:true},scopeMode:"user",results:null,onToggleRow:noop,onApply:skillApply,onClose:noop});
  const row = (confirmDelete:boolean) => createElement("section",{className:"skills-pane"},createElement("ul",null,createElement(SkillRowItem,{row:skill as never,confirmDelete,onToggle:noop,onReveal:noop,onRequestDelete:requested,onCancelDelete:noop,onConfirmDelete:deleted})));
  const view = await mount(createElement("div",null,mcp,skills,row(false)));
  const mcpDom=realMcpPaneDom(), skillDom=realSkillsPaneDom();
  await act(async () => { expect(mcpDom.clickApplyButton()).toBe(true); expect(skillDom.clickApplyButton()).toBe(true); expect(skillDom.clickRowDelete("demo")).toBe(true); });
  expect(mcpApply).toHaveBeenCalledOnce(); expect(skillApply).toHaveBeenCalledOnce(); expect(requested).toHaveBeenCalledOnce();
  await view.render(createElement("div",null,mcp,skills,row(true)));
  await act(async () => { expect(skillDom.clickRowConfirmDelete("demo")).toBe(true); });
  expect(deleted).toHaveBeenCalledOnce();
});

it("creates a subagent and saves edited fields through the real pane", async () => {
  const snapshot = {rows:[],problems:[],workspace:"/tmp"};
  const create = vi.fn().mockResolvedValue({ok:true,snapshot});
  const bridge = {list:vi.fn().mockResolvedValue(snapshot),create};
  await mount(createElement(SubagentsPane,{bridge:bridge as never}));
  const dom=realSubagentsPaneDom();
  await act(async () => dom.clickCreateButton());
  expect(dom.editorOpen()).toBe(true);
  await act(async () => { expect(dom.setName("demo")).toBe(true); });
  await act(async () => { expect(dom.setDescription("Description")).toBe(true); });
  await act(async () => { expect(dom.setBody("Prompt")).toBe(true); });
  expect(dom.fieldValues()).toMatchObject({name:"demo",description:"Description",body:"Prompt"});
  await act(async () => { expect(dom.clickSave()).toBe(true); });
  expect(create).toHaveBeenCalledOnce();
});

it("confirms deletion using the real connection tile", async () => {
  const deleted=vi.fn();
  const props={connection:{id:"c",providerId:"openai",model:"m"},displayName:"Example",selected:false,checking:false,readOnly:false,tabIndex:0,onSelect:noop,onEdit:noop,onReplaceKey:noop,onCheck:noop,onDelete:deleted,onKeyDownRoving:noop};
  await mount(createElement("div",{className:"connection-grid"},createElement(ConnectionTile,props as never)));
  const dom=realProviderPaneDom();
  await act(async () => { expect(dom.clickMenuTrigger("c")).toBe(true); });
  await act(async () => { expect(dom.clickMenuItem("c",3)).toBe(true); });
  await act(async () => { expect(dom.clickConfirmDelete("c")).toBe(true); });
  expect(deleted).toHaveBeenCalledOnce();
});

it("finds the MCP confirmation button rendered by the row", async () => {
  const confirm=vi.fn();
  const row={entry:{name:"srv",source:"user",enabled:true,transport:"stdio",commandLine:"node",envKeys:[],shadowed:false},status:undefined,dotKind:"neutral",detail:"ready"};
  const {container}=await mount(createElement("ul",null,createElement(McpRowItem,{row:row as never,confirmDelete:true,onToggle:noop,onEdit:noop,onRequestDelete:noop,onCancelDelete:noop,onConfirmDelete:confirm})));
  const button=container.querySelector<HTMLButtonElement>(".mcp-confirm-row .ak-btn--danger");
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(confirm).toHaveBeenCalledOnce();
});

it("adds a permission through the settings adapter", async () => {
  const addRule=vi.fn().mockResolvedValue({ok:true});
  const store=createStore(() => ({snapshot:{settings:cloneDefaults(),readOnly:false},addRule}));
  await mount(createElement("div",{className:"settings-screen"},createElement(PermissionsEditor,{store:store as never})));
  const dom=realSettingsDom();
  await act(async () => { expect(dom.fillPermissionTool("Bash")).toBe(true); dom.fillPermissionPattern("git status"); });
  expect(dom.canSubmitPermissionAdd()).toBe(true);
  await act(async () => dom.clickPermissionAdd());
  expect(addRule).toHaveBeenCalledWith({toolName:"Bash",pattern:"git status"});
});

it("reads a successful vision probe from the actual banner", async () => {
  const settings=cloneDefaults();
  settings.provider.connections=[{id:"c",providerId:"openai",model:"m"}];
  settings.recognizer={connectionId:"c",modelId:"m"};
  const store=createStore(() => ({snapshot:{settings,readOnly:false,catalog:[]}}));
  const probe=vi.fn().mockResolvedValue({ok:true,text:"image described"});
  Object.defineProperty(window,"anycode",{configurable:true,value:{settings:{recognizerProbe:probe}}});
  await mount(createElement(VisionPane,{store:store as never}));
  const dom=realVisionPaneDom();
  expect(dom.enabled()).toBe(true);
  await act(async () => { expect(dom.clickProbe()).toBe(true); });
  expect(probe).toHaveBeenCalledOnce();
  expect(dom.probeResultText()).toEqual({ok:true,text:"image described"});
});

it("drives clear key and primary save in a rendered connection drawer", async () => {
  const settings=cloneDefaults();
  const connection={id:"c",providerId:"openai",model:"m"};
  const catalog=[{id:"openai",name:"OpenAI",authKind:"api_key",models:[]}];
  const clear=vi.fn().mockResolvedValue({ok:true}); const update=vi.fn().mockResolvedValue({ok:true});
  const store=createStore(() => ({snapshot:{settings,readOnly:false,catalog,envOverrides:[]},oauthPendingProviderId:null,secretConsentResolution:null,connectionUpdate:update,clearSecret:clear,load:vi.fn()}));
  const secrets=[{key:connectionSecretKey("c","api_key"),set:true,source:"vault"}];
  await mount(createElement("div",{className:"welcome-screen"},createElement(ConnectionDrawerFields,{mode:"edit",editConnection:connection,catalog,connections:[connection],secrets,readOnly:false,store} as never)));
  const dom=realProviderPaneDom();
  expect(dom.drawer()?.clearKeyEnabled).toBe(true);
  await act(async () => { expect(dom.clickDrawerClearKey()).toBe(true); });
  await act(async () => { expect(dom.clickDrawerPrimary()).toBe(true); });
  expect(clear).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledOnce();
});

it("fails explicitly when an OAuth sign-in button is absent", async () => {
  const settings=cloneDefaults(); const connection={id:"c",providerId:"oauth",model:"m"};
  const catalog=[{id:"oauth",name:"OAuth",authKind:"oauth",models:[]}];
  const store=createStore(() => ({snapshot:{settings,readOnly:false,catalog,envOverrides:[]},oauthPendingProviderId:"oauth",secretConsentResolution:null}));
  await mount(createElement("div",{className:"welcome-screen"},createElement(ConnectionDrawerFields,{mode:"edit",editConnection:connection,catalog,connections:[connection],secrets:[],readOnly:false,store} as never)));
  expect(realProviderPaneDom().drawer()?.oauthSignInUnavailable).toBe(true);
  expect(realProviderPaneDom().clickDrawerSaveKey()).toBe(false);
});

it("finds the Codex install button in the rendered pane", async () => {
  const install=vi.fn().mockResolvedValue({ok:false,reason:"cancelled"});
  const bridge={listProfiles:vi.fn().mockResolvedValue({profiles:[],activeProfileId:"system"}),recheck:vi.fn().mockResolvedValue({report:{status:"not_installed"},binaryPath:null,source:null,checkedAt:"2026-01-01"}),supportStatus:vi.fn().mockResolvedValue({supportedRange:">=0.1.0",recommended:"0.144.3",riskAcceptedVersions:[]}),install};
  Object.defineProperty(window,"anycode",{configurable:true,value:{onEnginesChanged:() => noop}});
  await mount(createElement("div",{id:"settings-pane-codex"},createElement(CodexEnginePane,{bridge:bridge as never})));
  const dom=realCodexPaneDom();
  expect(dom.installButton()).toEqual({label:"Install Codex 0.144.3",disabled:false});
  await act(async () => { expect(dom.clickInstall()).toBe(true); });
  expect(install).toHaveBeenCalledWith("0.144.3");
});

 it("finds sign out on a rendered OAuth connection", async () => {
  const settings=cloneDefaults(); const connection={id:"c",providerId:"oauth",model:"m"};
  const catalog=[{id:"oauth",name:"OAuth",authKind:"oauth",models:[]}];
  const store=createStore(() => ({snapshot:{settings,readOnly:false,catalog,envOverrides:[]},oauthPendingProviderId:null,secretConsentResolution:null}));
  const secrets=[{key:connectionSecretKey("c","oauth"),set:true,source:"vault"}];
  await mount(createElement("div",{className:"welcome-screen"},createElement(ConnectionDrawerFields,{mode:"edit",editConnection:connection,catalog,connections:[connection],secrets,readOnly:false,store} as never)));
  expect(realProviderPaneDom().drawer()?.clearKeyEnabled).toBe(true);
});

// ── facade over the REAL Settings scope bar + panes ──────────────────────────
// SettingsScreen's exact wiring, reduced to the parts the scope drives: the
// one ScopeDropdown above the pane, whose `scopeRefFor` resolution becomes the
// pane's `tabId` — the panes' write target (`scopeMode`). The facade runs with
// its REAL DOM accessors (no DI): skillsImportApply/mcpAddServer must drive the
// rendered ScopeSwitcher itself, since neither pane carries in-dialog scope
// radios anymore.

function scopeHarness(props: { entries: ScopeWorkspaceEntry[]; skillsBridge?: SkillsBridge; mcpBridge?: McpConfigBridge }) {
  const [selection, setSelection] = useState<ScopeSelection>(USER_SCOPE);
  // SettingsScreen's real lifecycle: scopeEntries starts EMPTY and fills only
  // after the scopeBridge.list() round-trip lands, and every menu open
  // refetches (the onOpen prop). A scope:"project" drive issued right after
  // the pane mounts must therefore wait out the list landing — and refuse
  // only once it is genuinely empty — never against the pre-load frame.
  const [entries, setEntries] = useState<ScopeWorkspaceEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refetch = () => {
    void Promise.resolve().then(() => {
      setEntries(props.entries);
      setLoaded(true);
    });
  };
  const ref = scopeRefFor(selection, entries);
  return createElement(
    "div",
    { className: "settings-screen" },
    createElement(ScopeDropdown, { selection, entries, loading: !loaded, onOpen: refetch, onSelect: setSelection }),
    props.skillsBridge
      ? createElement(SkillsPane, { tabId: ref, bridge: props.skillsBridge as never })
      : createElement(McpServersPane, { servers: [], tabId: ref, bridge: props.mcpBridge as never }),
  );
}

const wsEntry = (id: string, tabIds: string[] = []): ScopeWorkspaceEntry => ({ id, name: "alpha", displayPath: "~/work/alpha", exists: true, tabIds });

/** The same list source the real bar renders from (`window.anycode.scopeWorkspaces.list`) — what `scope:"project"` resolves the ACTIVE tab's option against. */
function stubScopeList(entries: ScopeWorkspaceEntry[]): void {
  (window as unknown as { anycode: { scopeWorkspaces: unknown } }).anycode.scopeWorkspaces = {
    list: vi.fn(async () => ({ ok: true as const, workspaces: entries })),
  };
}

// McpServersPane renders <McpSecretsBlock /> unconditionally; its default
// bridge reads `window.anycode.mcpSecrets`, which only exists in the real
// app shell — stub the three calls these tests never touch.
beforeEach(() => {
  (window as unknown as { anycode: unknown }).anycode = {
    mcpSecrets: {
      list: vi.fn(async () => ({ ok: true as const, names: [] })),
      set: vi.fn(async () => ({ ok: true as const, names: [] })),
      delete: vi.fn(async () => ({ ok: true as const, names: [] })),
    },
  };
});

function mountedFacade(tabs: Array<{ tabId: string; workspace: string }> = [], activeTabId?: string): ReturnType<typeof createAutomationFacade> {
  const tabsStore = createTabsStore();
  const registry = createTabRegistry(tabsStore);
  for (const tab of tabs) tabsStore.getState().addTab(tab);
  if (activeTabId !== undefined) tabsStore.getState().setActiveTab(activeTabId);
  return createAutomationFacade(registry, tabsStore, {
    createTab: vi.fn(),
    closeTab: vi.fn(),
    listSessions: vi.fn(async () => []),
  } as unknown as AnycodeBridge);
}

it("skillsImportApply drives the rendered ScopeSwitcher to the requested workspace BEFORE Apply — the import lands there, not in the stale personal catalog", async () => {
  const snapshot = { rows: [], problems: [] };
  const importApply = vi.fn(async (_req: unknown) => ({
    ok: true as const,
    results: [{ id: "one", name: "browser", applied: true, suffixed: false, converted: false, notes: [] }],
    snapshot,
  }));
  const bridge = {
    list: vi.fn(async () => snapshot),
    setEnabled: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    reveal: vi.fn(),
    importScan: vi.fn(async () => ({
      candidates: [{ id: "one", harness: "claude", sourceDir: "skills/browser", name: "browser", description: "Browser", compatible: true, needsConversion: false, conversionNotes: [], alreadyPresent: false }],
      problems: [],
    })),
    importApply,
  };
  const entries = [wsEntry("ws_1", ["tab-a"])];
  await mount(createElement(scopeHarness, { entries, skillsBridge: bridge as never }));
  stubScopeList(entries);
  const facade = mountedFacade([{ tabId: "tab-a", workspace: "/ws/a" }]);
  // The facade methods run UNWRAPPED: they poll the real DOM until React's
  // (unact-ed) commits land, and awaiting them inside `act` deadlocks the
  // act flush loop in this environment.
  await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: true });
  // The bar still reads the user scope here — the apply must pick the workspace through the REAL switcher first.
  expect(realSkillsPaneDom().importOpen()).toBe(true);
  await expect(facade.skillsImportApply({ scope: "project" })).resolves.toEqual({ ok: true });
  expect(importApply).toHaveBeenCalledTimes(1);
  expect(importApply.mock.calls[0]![0]).toEqual({ tabId: "ws_1", scope: "project", ids: ["one"] });
});

it("skillsImportApply scope:project targets the ACTIVE tab's workspace — even when the active tab is NOT the first open tab", async () => {
  // tab-a opened first (its workspace lists first in the menu), tab-b ACTIVE:
  // a first-rendered-option pick would silently land the import in ws_a's
  // catalog instead of the folder the user is looking at.
  const snapshot = { rows: [], problems: [] };
  const importApply = vi.fn(async (_req: unknown) => ({
    ok: true as const,
    results: [{ id: "one", name: "browser", applied: true, suffixed: false, converted: false, notes: [] }],
    snapshot,
  }));
  const bridge = {
    list: vi.fn(async () => snapshot),
    setEnabled: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    reveal: vi.fn(),
    importScan: vi.fn(async () => ({
      candidates: [{ id: "one", harness: "claude", sourceDir: "skills/browser", name: "browser", description: "Browser", compatible: true, needsConversion: false, conversionNotes: [], alreadyPresent: false }],
      problems: [],
    })),
    importApply,
  };
  const entries = [wsEntry("ws_a", ["tab-a"]), wsEntry("ws_b", ["tab-b"])];
  await mount(createElement(scopeHarness, { entries, skillsBridge: bridge as never }));
  stubScopeList(entries);
  const facade = mountedFacade([{ tabId: "tab-a", workspace: "/ws/a" }, { tabId: "tab-b", workspace: "/ws/b" }], "tab-b");
  await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: true });
  await expect(facade.skillsImportApply({ scope: "project" })).resolves.toEqual({ ok: true });
  expect(importApply).toHaveBeenCalledTimes(1);
  expect(importApply.mock.calls[0]![0]).toEqual({ tabId: "ws_b", scope: "project", ids: ["one"] });
});

it("skillsImportApply refuses with scope_unavailable when no workspace exists to pick — the import never fires into the wrong catalog", async () => {
  const snapshot = { rows: [], problems: [] };
  const importApply = vi.fn(async (_req: unknown) => ({ ok: true as const, results: [], snapshot }));
  const bridge = {
    list: vi.fn(async () => snapshot),
    setEnabled: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    reveal: vi.fn(),
    importScan: vi.fn(async () => ({
      candidates: [{ id: "one", harness: "claude", sourceDir: "skills/browser", name: "browser", description: "Browser", compatible: true, needsConversion: false, conversionNotes: [], alreadyPresent: false }],
      problems: [],
    })),
    importApply,
  };
  await mount(createElement(scopeHarness, { entries: [], skillsBridge: bridge as never }));
  stubScopeList([]);
  const facade = mountedFacade([{ tabId: "tab-a", workspace: "/ws/a" }]);
  await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: true });
  await expect(facade.skillsImportApply({ scope: "project" })).resolves.toEqual({ ok: false, reason: "scope_unavailable" });
  expect(importApply).not.toHaveBeenCalled();
  // The refusal must not leave the scope dropdown hanging open.
  expect(document.querySelector("[data-scope-trigger]")?.getAttribute("aria-expanded")).toBe("false");
});

it("skillsImportApply refuses with scope_unavailable when the active tab's folder is not among the RENDERED options — the opened menu is closed again, no Apply", async () => {
  // The list the facade consults maps the active tab to ws_ghost, but the
  // bar's rendered menu only ever shows ws_1 (a list/render race): the pick
  // must fail against the RENDERED options and close the menu — never fall
  // back to the first rendered workspace.
  const snapshot = { rows: [], problems: [] };
  const importApply = vi.fn(async (_req: unknown) => ({ ok: true as const, results: [], snapshot }));
  const bridge = {
    list: vi.fn(async () => snapshot),
    setEnabled: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    reveal: vi.fn(),
    importScan: vi.fn(async () => ({
      candidates: [{ id: "one", harness: "claude", sourceDir: "skills/browser", name: "browser", description: "Browser", compatible: true, needsConversion: false, conversionNotes: [], alreadyPresent: false }],
      problems: [],
    })),
    importApply,
  };
  await mount(createElement(scopeHarness, { entries: [wsEntry("ws_1", ["tab-a"])], skillsBridge: bridge as never }));
  stubScopeList([wsEntry("ws_ghost", ["tab-a"])]);
  const facade = mountedFacade([{ tabId: "tab-a", workspace: "/ws/a" }]);
  await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: true });
  await expect(facade.skillsImportApply({ scope: "project" })).resolves.toEqual({ ok: false, reason: "scope_unavailable" });
  expect(importApply).not.toHaveBeenCalled();
  expect(document.querySelector("[data-scope-trigger]")?.getAttribute("aria-expanded")).toBe("false");
});

it("mcpAddServer drives the rendered ScopeSwitcher BEFORE the form opens — the real form seeds and submits the requested scope", async () => {
  const snapshot = { entries: [], problems: [], projectAvailable: true };
  const upsert = vi.fn(async (_req: unknown) => ({ ok: true as const, snapshot }));
  const bridge = { get: vi.fn(async () => snapshot), upsert, delete: vi.fn(), setEnabled: vi.fn(), promoteCompat: vi.fn(), importScan: vi.fn(), importApply: vi.fn() };
  const entries = [wsEntry("ws_1", ["tab-a"])];
  await mount(createElement(scopeHarness, { entries, mcpBridge: bridge as never }));
  stubScopeList(entries);
  const facade = mountedFacade([{ tabId: "tab-a", workspace: "/ws/a" }]);
  await expect(facade.mcpAddServer({ name: "srv", command: "node", scope: "project" })).resolves.toEqual({ ok: true });
  expect(upsert).toHaveBeenCalledTimes(1);
  expect(upsert.mock.calls[0]![0]).toMatchObject({ tabId: "ws_1", scope: "project", name: "srv" });
});

it("mcpAddServer refuses with scope_unavailable when no workspace exists to pick — the form never even opens", async () => {
  const snapshot = { entries: [], problems: [], projectAvailable: true };
  const upsert = vi.fn(async (_req: unknown) => ({ ok: true as const, snapshot }));
  const bridge = { get: vi.fn(async () => snapshot), upsert, delete: vi.fn(), setEnabled: vi.fn(), promoteCompat: vi.fn(), importScan: vi.fn(), importApply: vi.fn() };
  await mount(createElement(scopeHarness, { entries: [], mcpBridge: bridge as never }));
  stubScopeList([]);
  const facade = mountedFacade([{ tabId: "tab-a", workspace: "/ws/a" }]);
  await expect(facade.mcpAddServer({ name: "srv", command: "node", scope: "project" })).resolves.toEqual({ ok: false, reason: "scope_unavailable" });
  expect(realMcpPaneDom().formOpen()).toBe(false);
  expect(upsert).not.toHaveBeenCalled();
  // The refusal must not leave the scope dropdown hanging open.
  expect(document.querySelector("[data-scope-trigger]")?.getAttribute("aria-expanded")).toBe("false");
});

it("exposes distinct builtin automation rows, filters file sections and reports config write errors", async () => {
  const snapshot = { rows: [{ name: "anycode-setup", sourceKind: "user", enabled: true, description: "Override" }], problems: [],
    builtins: ENGINE_BUILTIN_SKILLS.map(({ id }) => ({ id, userDisabled: false, projectDisabled: false })) };
  const bridge = { list: vi.fn().mockResolvedValue(snapshot), setEnabled: vi.fn().mockResolvedValue({ ok: false, reason: "io_error" }) };
  const view = await mount(createElement(SkillsPane, { bridge: bridge as never }));
  const dom = realSkillsPaneDom();
  expect(dom.rows()).toHaveLength(4);
  expect(dom.rows().filter(row => row.sourceKind === "builtin")).toEqual(ENGINE_BUILTIN_SKILLS.map(({ id }) => ({
    name: `builtin:${id}`, sourceKind: "builtin", enabled: true, hasToggle: true,
  })));
  expect(dom.rowExists("anycode-setup")).toBe(true);
  await act(async () => { expect(dom.clickRowToggle("builtin:anycode-setup")).toBe(true); });
  expect(bridge.setEnabled).toHaveBeenCalledWith({ tabId: undefined, builtinId: "anycode-setup", scope: "user", enabled: false });
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(".anycode/config.json");
  const select = view.container.querySelector<HTMLSelectElement>('[aria-label="Filter by source"]')!;
  await act(async () => { select.value = "builtin"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(dom.rows()).toHaveLength(3);
  expect(view.container.textContent).not.toMatch(/Workspace and personal skills|No workspace or personal skills yet/);
});

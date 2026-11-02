// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { realMcpPaneDom, realSkillsPaneDom, realSubagentsPaneDom, realProviderPaneDom, realSettingsDom, realVisionPaneDom, realCodexPaneDom } from "./automation.js";
import { McpFormDialog, McpImportDialog, McpRowItem, blankMcpFormFields } from "./components/McpServersPane.js";
import { SkillImportDialog, SkillRowItem } from "./components/SkillsPane.js";
import { SubagentsPane } from "./components/SubagentsPane.js";
import { createStore } from "zustand/vanilla";
import { cloneDefaults } from "../../settings/schema.js";
import { PermissionsEditor } from "./components/PermissionsEditor.js";
import { VisionPane } from "./components/VisionPane.js";
import { ConnectionDrawerFields } from "./components/ConnectionDrawer.js";
import { CodexEnginePane } from "./components/CodexEnginePane.js";
import { ConnectionTile, connectionSecretKey } from "./components/ConnectionTile.js";

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

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Measured by rawControlLines on the UI track when the component kit landed.
const BASELINE: Record<string, number> = {
  "App.tsx": 9,
  "components/AccentPicker.tsx": 1,
  "components/AgentMessageStack.tsx": 1,
  "components/BackgroundAgents.tsx": 2,
  "components/BackgroundTasksPanel.tsx": 3,
  "components/BinaryTrustDialog.tsx": 3,
  "components/BrowserAccessDefaultSection.tsx": 1,
  "components/BrowserAccessRow.tsx": 1,
  "components/ChildPermissionModal.tsx": 2,
  "components/ChildReportBlock.tsx": 1,
  "components/ChildSplitPane.tsx": 2,
  "components/ClaudeEnginePane.tsx": 9,
  "components/CodexEnginePane.tsx": 36,
  "components/CodexRolloutImportDialog.tsx": 6,
  "components/CommandPalette.tsx": 2,
  "components/CompactionCard.tsx": 2,
  "components/Composer.tsx": 17,
  "components/ConfirmDialog.tsx": 3,
  "components/ConnectionDrawer.tsx": 45,
  "components/ConnectionTile.tsx": 10,
  "components/ConsentDialog.tsx": 3,
  "components/ContextWindowSettings.tsx": 4,
  "components/DiagnosticsExportSection.tsx": 5,
  "components/DiffView.tsx": 3,
  "components/DockPanel.tsx": 4,
  "components/EngineControls.tsx": 9,
  "components/EnvironmentMenu.tsx": 11,
  "components/GitConfirmDialog.tsx": 3,
  "components/GitPanel.tsx": 23,
  "components/HooksPanel.tsx": 1,
  "components/ImageViewer.tsx": 4,
  "components/KeyboardShortcutsPane.tsx": 6,
  "components/LanguageServersPane.tsx": 13,
  "components/LspPanel.tsx": 3,
  "components/Markdown.tsx": 8,
  "components/MarkdownPreviewView.tsx": 6,
  "components/McpServersPane.tsx": 39,
  "components/MessageList.tsx": 9,
  "components/ModeMenu.tsx": 4,
  "components/ModelPill.tsx": 2,
  "components/NoticeToast.tsx": 1,
  "components/PermissionModal.tsx": 7,
  "components/PermissionsEditor.tsx": 11,
  "components/PluginInstallSheet.tsx": 10,
  "components/PluginsPane.tsx": 18,
  "components/PreviewPanel.tsx": 2,
  "components/ProfilePane.tsx": 8,
  "components/PromptQueue.tsx": 12,
  "components/ProxyProfilesPane.tsx": 3,
  "components/ProxyRefPicker.tsx": 2,
  "components/ProxySection.tsx": 14,
  "components/ReasoningBlock.tsx": 1,
  "components/RolePickerDialog.tsx": 12,
  "components/RolesPane.tsx": 16,
  "components/ScopeSwitcher.tsx": 2,
  "components/SessionAccessRow.tsx": 3,
  "components/SessionHeader.tsx": 7,
  "components/SessionsApiPane.tsx": 12,
  "components/SettingsScreen.tsx": 36,
  "components/Sidebar.tsx": 21,
  "components/SkillsPane.tsx": 23,
  "components/StartScreen.tsx": 19,
  "components/SubagentsPane.tsx": 24,
  "components/TerminalPanel.tsx": 3,
  "components/TodoPanel.tsx": 3,
  "components/ToolCallCard.tsx": 8,
  "components/ToolCallStack.tsx": 1,
  "components/TranscriptMinimap.tsx": 4,
  "components/TrustedBinariesSection.tsx": 1,
  "components/TrustedFoldersSection.tsx": 1,
  "components/VisionPane.tsx": 7,
  "components/WelcomeScreen.tsx": 4,
  "components/WindowControls.tsx": 3,
  "components/WorkspaceTrustDialog.tsx": 4,
  "components/model-drill-menu.tsx": 6
};
function files(dir: string): string[] {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);
}
function rawControlLines(source: string): number[] {
  // Preserve quoted strings and line numbers while masking JS/CSS comments.
  const clean=source.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g,
    token=>token.startsWith("/*")||token.startsWith("//")?token.replace(/[^\n\r]/g," "):token);
  // Count native controls plus explicit menu roots, independently of formatting.
  return [...clean.matchAll(/<\s*(?:button|input|select|textarea|dialog)\b|\brole\s*=\s*["']menu["']/g)]
    .map(match=>clean.slice(0,match.index).split("\n").length);
}
it("counts native controls and menus, ignoring comments and tag-name prefixes",()=>{
  expect(rawControlLines('/* <button role="menu" */\n// <input\n<buttonish /> <Input /> <button /> <input /> <select /> <textarea /> <dialog /> <div role="menu" />')).toEqual([3,3,3,3,3,3]);
});
it("ratchets raw controls outside ui per file",()=>{
  const root=fileURLToPath(new URL("./",import.meta.url));
  const actual=new Map(files(root).filter(path=>path.endsWith(".tsx")&&!path.startsWith(join(root,"ui")+sep)&&!path.includes(".test."))
    .map(path=>[relative(root,path).replaceAll("\\","/"),rawControlLines(readFileSync(path,"utf8"))]));
  const errors:string[]=[];
  for(const path of new Set([...Object.keys(BASELINE),...actual.keys()])) {
    const lines=actual.get(path)??[],baseline=BASELINE[path]??0;
    if(lines.length>baseline) errors.push(`${path}: baseline ${baseline}, actual ${lines.length}; raw control lines: ${lines.join(", ")}`);
    if(lines.length<baseline) errors.push(`${path}: baseline ${baseline}, actual ${lines.length}; затяни храповик: обнови базу (tighten the ratchet: update BASELINE)`);
  }
  expect(errors,errors.join("\n")).toEqual([]);
});

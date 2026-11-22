import { expect, it } from "vitest";
import ts from "typescript";
import { baselineDiff, cssDeclarations, readRenderer, rendererFiles } from "./guard-utils.test-utils.js";

// Overlays (menus, dialogs, popovers, anchored panels) belong to the UI kit
// (ui/). This guard scans the whole renderer outside ui/ - App.tsx, components
// and shared CSS - for the signals of a hand-made overlay:
//   JSX/TS:  role="menu|dialog|alertdialog" in any literal form (role="menu",
//            role={"menu"}, role={`menu`}, role={x ? "menu" : undefined}),
//            aria-modal, native <dialog>, the popover attribute, createPortal.
//   CSS and inline styles: position: fixed; position: absolute together with
//            z-index (declarations of one selector are merged across rules).
// Static analysis cannot prove a block is an overlay, so there are two lists:
//   LEGACY_BASELINE  - existing hand-made overlays awaiting migration to the kit.
//                      Shrink-only: new entries fail, fixed entries must be removed.
//   LAYOUT_EXCEPTIONS - documented non-overlay layout (window chrome, split
//                      panes, resize handles) with a one-line reason each. May
//                      be extended when a reviewer agrees the element is layout.
// Entry format: "file | selector-or-component | signal" (no line numbers).
// Both lists fail on stale entries.

const LEGACY_BASELINE: string[] = [
  "app.css | .account-budget-floating | position: absolute + z-index",
  "app.css | .claude-task-details | position: absolute + z-index",
  "app.css | .ctx-popover | position: fixed",
  "app.css | .dock-panel-drawer | position: absolute + z-index",
  "app.css | .environment-menu | position: absolute + z-index",
  "app.css | .lsp-panel | position: absolute + z-index",
  "app.css | .mode-menu-popover | position: fixed",
  "app.css | .model-pill-popover | position: fixed",
  "app.css | .notice-stack | position: fixed",
  "app.css | .notice-toast | position: fixed",
  "app.css | .previews-menu | position: absolute + z-index",
  "app.css | .session-extensions-panel | position: fixed",
  "app.css | .sidebar-project-menu | position: fixed",
  "app.css | .slash-menu | position: absolute + z-index",
  "app.css | .start-model-menu | position: absolute + z-index",
  "app.css | .start-project-hint | position: absolute + z-index",
  "app.css | .start-project-menu | position: absolute + z-index",
  "components/BinaryTrustDialog.tsx | BinaryTrustDialog | <dialog>",
  "components/CodexRolloutImportDialog.tsx | CodexRolloutImportDialog | <dialog>",
  "components/CommandPalette.tsx | CommandPalette | <dialog>",
  "components/Composer.tsx | CtxPopover | role=dialog",
  "components/ConfirmDialog.tsx | ConfirmDialog | <dialog>",
  "components/ConnectionDrawer.tsx | ConnectionDrawer | <dialog>",
  "components/ConnectionDrawer.tsx | ConnectionDrawer | aria-modal",
  "components/ConnectionDrawer.tsx | ConnectionDrawer | role=alertdialog",
  "components/ConnectionTile.tsx | ConnectionTile | role=menu",
  "components/ConnectionTile.tsx | ConnectionTile | role=menu",
  "components/ConsentDialog.tsx | ConsentDialog | <dialog>",
  "components/ContextWindowSettings.tsx | ContextWindowSettings | <dialog>",
  "components/EngineControls.tsx | EngineModelMenu | role=menu",
  "components/EngineControls.tsx | EngineModelMenu | role=menu",
  "components/EngineControls.tsx | EnginePresetMenu | role=menu",
  "components/EngineSwitchPicker.tsx | EngineSwitchPicker | createPortal",
  "components/EngineSwitchPicker.tsx | EngineSwitchPicker | inline position: fixed",
  "components/EngineSwitchPicker.tsx | EngineSwitchPicker | role=dialog",
  "components/EnvironmentMenu.tsx | EnvironmentMenu | aria-modal",
  "components/EnvironmentMenu.tsx | EnvironmentMenu | role=dialog",
  "components/GitConfirmDialog.tsx | GitConfirmDialog | <dialog>",
  "components/ImageViewer.tsx | ImageViewer | <dialog>",
  "components/McpServersPane.tsx | McpFormDialog | <dialog>",
  "components/McpServersPane.tsx | McpImportDialog | <dialog>",
  "components/ModeMenu.tsx | ModeMenu | role=menu",
  "components/ModelPill.tsx | ModelPill | role=menu",
  "components/PermissionModal.tsx | PermissionModal | <dialog>",
  "components/PluginInstallSheet.tsx | PluginInstallDialog | <dialog>",
  "components/RolePickerDialog.tsx | RolePickerDialog | <dialog>",
  "components/RolesPane.tsx | RolesPane | role=menu",
  "components/SessionExtensionsMenu.tsx | SessionExtensionsMenu | aria-modal",
  "components/SessionExtensionsMenu.tsx | SessionExtensionsMenu | createPortal",
  "components/SessionExtensionsMenu.tsx | SessionExtensionsMenu | role=dialog",
  "components/SessionHeader.tsx | SessionHeader | role=menu",
  "components/SettingsScreen.tsx | SettingsDialog | <dialog>",
  "components/SettingsScreen.tsx | SetupFiles | role=dialog",
  "components/Sidebar.tsx | Sidebar | inline position: fixed",
  "components/Sidebar.tsx | Sidebar | role=menu",
  "components/Sidebar.tsx | Sidebar | role=menu",
  "components/SkillsPane.tsx | SkillCreateDialog | <dialog>",
  "components/SkillsPane.tsx | SkillImportDialog | <dialog>",
  "components/StartScreen.tsx | StartScreen | role=menu",
  "components/StartScreen.tsx | StartScreen | role=menu",
  "components/SubagentsPane.tsx | SubagentEditorDialog | <dialog>",
  "components/TaskRenameDialog.tsx | TaskRenameDialog | <dialog>",
  "components/WorkspaceTrustDialog.tsx | WorkspaceTrustDialog | <dialog>",
  "components/model-drill-menu.tsx | ModelDrillMenu | role=menu",
  "settings.css | .accent-swatch-tooltip | position: absolute + z-index",
  "settings.css | .connection-drawer-model-popup | position: absolute + z-index",
  "settings.css | .connection-tile-menu-popover | position: absolute + z-index",
  "settings.css | .roles-menu-items | position: absolute + z-index",
  "settings.css | .scope-dropdown-menu | position: absolute + z-index",
  "settings.css | .update-banner | position: fixed",
];

const LAYOUT_EXCEPTIONS: Record<string, string> = {
  "app.css | .window-controls | position: fixed": "Window chrome pinned to the viewport corner; not an overlay.",
  "app.css | .welcome-titlebar | position: fixed": "Draggable titlebar strip of the welcome screen; window chrome, not an overlay.",
  "app.css | .dock-split-pane | position: absolute + z-index": "Pane stacking inside the dock split layout; layout, not an overlay.",
  "terminal.css | .terminal-panel-resize | position: absolute + z-index": "Resize handle on the terminal panel edge; layout, not an overlay.",
};

const OVERLAY_ROLES = /^(?:menu|dialog|alertdialog)$/i;

function contextName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur)) && cur.name) return cur.name.text;
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
  }
  return "<module>";
}

function stringLiterals(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function propertyName(node: ts.PropertyAssignment): string | undefined {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
}

export function codeEntries(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const add = (node: ts.Node, signal: string): void => { out.push(`${path} | ${contextName(node)} | ${signal}`); };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName) && node.tagName.text === "dialog") add(node, "<dialog>");
    }
    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(file);
      if (name === "role" && node.initializer && stringLiterals(node.initializer).some(text => OVERLAY_ROLES.test(text.trim()))) {
        add(node, `role=${stringLiterals(node.initializer).filter(text => OVERLAY_ROLES.test(text.trim())).join("|")}`);
      }
      if (name === "aria-modal") add(node, "aria-modal");
      if (name === "popover") add(node, "popover attribute");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (called === "createPortal") add(node, "createPortal");
    }
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map<string, ts.PropertyAssignment>();
      for (const prop of node.properties) if (ts.isPropertyAssignment(prop)) { const n = propertyName(prop); if (n) props.set(n, prop); }
      const position = props.get("position");
      const value = position && ts.isStringLiteralLike(position.initializer) ? position.initializer.text.trim() : "";
      if (value === "fixed") add(node, "inline position: fixed");
      if (value === "absolute" && props.has("zIndex")) add(node, "inline position: absolute + z-index");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

export function cssEntries(path: string, source: string): string[] {
  const merged = new Map<string, Map<string, string>>();
  for (const decl of cssDeclarations(source)) {
    if (/^@(?:-\w+-)?keyframes\b/.test(decl.context)) continue;
    const props = merged.get(decl.context) ?? new Map<string, string>();
    props.set(decl.property, decl.value.toLowerCase());
    merged.set(decl.context, props);
  }
  const out: string[] = [];
  for (const [context, props] of merged) {
    const position = props.get("position");
    if (position === "fixed") out.push(`${path} | ${context} | position: fixed`);
    else if (position === "absolute" && props.has("z-index")) out.push(`${path} | ${context} | position: absolute + z-index`);
  }
  return out;
}

export function collectEntries(): string[] {
  const outsideKit = (path: string): boolean => !path.startsWith("ui/");
  return [
    ...rendererFiles(/\.tsx?$/).filter(outsideKit).flatMap(path => codeEntries(path, readRenderer(path))),
    ...rendererFiles(/\.css$/).filter(outsideKit).flatMap(path => cssEntries(path, readRenderer(path))),
  ].sort();
}

it("detects overlay signals in every literal form", () => {
  const source = [
    'const A = () => <div role="menu" />;',
    'const B = () => <div role={"dialog"} />;',
    'const C = () => <div role={`alertdialog`} aria-modal="true" />;',
    'const D = (x: boolean) => <div role={x ? "menu" : undefined} />;',
    'const E = () => <dialog popover="auto" />;',
    'const F = () => createPortal(<i />, document.body) && ReactDOM.createPortal(<i />, document.body);',
    'const G = () => <i role="button" style={{ position: "fixed" }} />;',
    'const H = () => <i style={{ position: "absolute", zIndex: 3 }} />;',
    'const I = () => <i style={{ position: "absolute" }} />;',
  ].join("\n");
  expect(codeEntries("x.tsx", source)).toEqual([
    "x.tsx | A | role=menu",
    "x.tsx | B | role=dialog",
    "x.tsx | C | role=alertdialog",
    "x.tsx | C | aria-modal",
    "x.tsx | D | role=menu",
    "x.tsx | E | <dialog>",
    "x.tsx | E | popover attribute",
    "x.tsx | F | createPortal",
    "x.tsx | F | createPortal",
    "x.tsx | G | inline position: fixed",
    "x.tsx | H | inline position: absolute + z-index",
  ]);
});

it("merges CSS declarations of one selector and ignores keyframes", () => {
  const css = ".a{position:absolute} .b{position:absolute;z-index:1} .a{z-index:2} .c{position:fixed} @media (x){.d{position:absolute;top:0}} @keyframes k{to{position:fixed}}";
  expect(cssEntries("x.css", css)).toEqual([
    "x.css | .a | position: absolute + z-index",
    "x.css | .b | position: absolute + z-index",
    "x.css | .c | position: fixed",
  ]);
});

it("keeps the two lists disjoint and every layout exception justified", () => {
  for (const [entry, reason] of Object.entries(LAYOUT_EXCEPTIONS)) {
    expect(reason.trim().length, `exception needs a reason: ${entry}`).toBeGreaterThan(8);
    expect(LEGACY_BASELINE, `in both lists: ${entry}`).not.toContain(entry);
  }
});

it("has no new overlay signals outside ui/, and no stale entries in either list", () => {
  const actual = collectEntries();
  const exceptionKeys = Object.keys(LAYOUT_EXCEPTIONS);
  const { added, stale } = baselineDiff(actual, [...LEGACY_BASELINE, ...exceptionKeys]);
  const staleLegacy = stale.filter(entry => LEGACY_BASELINE.includes(entry));
  const staleExceptions = stale.filter(entry => exceptionKeys.includes(entry));
  expect({ added, staleLegacy, staleExceptions }, [
    ...added.map(entry => `new overlay signal (use the UI kit, or document a layout exception): ${entry}`),
    ...staleLegacy.map(entry => `stale LEGACY_BASELINE entry (migrated; remove it): ${entry}`),
    ...staleExceptions.map(entry => `stale LAYOUT_EXCEPTIONS entry (remove it): ${entry}`),
  ].join("\n")).toEqual({ added: [], staleLegacy: [], staleExceptions: [] });
});

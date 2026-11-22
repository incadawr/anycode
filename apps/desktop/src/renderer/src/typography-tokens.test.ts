import { expect, it } from "vitest";
import ts from "typescript";
import { baselineDiff, cssDeclarations, readRenderer, rendererFiles } from "./guard-utils.test-utils.js";

// Typography must come from the tokens in tokens.css (--fs-*, --lh-*). This guard
// covers font-size, line-height and the font shorthand in all renderer CSS
// (the UI kit included) and inline fontSize/lineHeight in TSX.
//
// BASELINE lists legacy violations as "file | selector-or-component | property | value"
// (no line numbers). New violations fail; entries that no longer occur also
// fail, so the baseline can only shrink. Never add entries to admit new UI.
// A permanent exception does not belong here: fix the value or use a token.

/** Typography tokens, read from tokens.css so the set cannot drift. */
const TOKENS = (() => {
  const names = [...readRenderer("tokens.css").matchAll(/(^|[;{\s])(--(?:fs|lh)-[a-z0-9]+)\s*:/gm)].map(match => match[2]!);
  return new Set(names);
})();

/** Keyword values that carry no size of their own. */
const KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "normal"]);

const BASELINE: string[] = [
  "app.css | .child-split-badge | line-height | 1",
  "app.css | .connection-icon | font-size | 8.5px",
  "app.css | .connection-icon | line-height | 1",
  "app.css | .connection-icon-input-row .connection-icon | font-size | 10.5px",
  "app.css | .engine-identity | line-height | 1",
  "app.css | .environment-menu-diagnostics-preview | line-height | 1.45",
  "app.css | .environment-menu-row | line-height | 1.4",
  "app.css | .environment-menu-row-with-error > .environment-menu-row-error | line-height | 1.35",
  "app.css | .lsp-setup-example | font-size | var(--fs-xs, var(--fs-sm))",
  "app.css | .md-code-inline | font-size | 0.93em",
  "app.css | .md-preview-mode-btn | font | 500 var(--fs-xs)/1 var(--font-ui)",
  "app.css | .permission-modal-tool | font-size | 0.95em",
  "app.css | .permission-risk-plaque | line-height | 1.45",
  "app.css | .role-picker-entry-offline | line-height | 1.4",
  "app.css | .role-picker-preset-note | line-height | 1.4",
  "app.css | .role-picker-role-override | line-height | 1.4",
  "app.css | .row-help-tooltip | line-height | 1.4",
  "app.css | .session-extensions-details button.session-extensions-manage | font-size | 11px",
  "app.css | .session-extensions-source | font-size | 11px",
  "app.css | .session-extensions-status | line-height | 1.5",
  "app.css | .session-extensions-trigger, .session-extensions-panel | font-size | 12px",
  "app.css | .session-header-title-wrap | line-height | 1.25",
  "app.css | .sessions-api-step-title | line-height | 1.5rem",
  "app.css | .sidebar-project-menu-item-note | line-height | 1.3",
  "app.css | .sidebar-row-agent, .session-header-agent | line-height | 1.2",
  "app.css | .sidebar-row-worktree | line-height | 1.2",
  "app.css | .speed-toggle-mult | line-height | 1",
  "app.css | .start-model-note | line-height | 1.35",
  "app.css | .todo-panel-stale | font-size | 0.85em",
  "app.css | .working-hint kbd | font-size | 0.95em",
  "settings.css | .codex-profile-default | line-height | 1.5",
  "settings.css | .connection-drawer-band::before | line-height | 1.4",
  "settings.css | .connection-drawer-help | line-height | 1",
  "settings.css | .connection-quota | font-size | 12px",
  "settings.css | .connection-tile .go-quota | font-size | 12px",
  "settings.css | .consent-dialog-body code | font-size | 0.93em",
  "settings.css | .lsp-install-command | font-size | 11px",
  "settings.css | .lsp-pane-notices | font-size | 12px",
  "settings.css | .lsp-scope-title | font-size | 12px",
  "settings.css | .welcome-wordmark | font-size | calc(var(--fs-xl) * 1.6)",
  "tool-cards.css | .workflow-map-label | font-size | 11px",
  "transcript-follow.css | .jump-to-latest | font-size | 1rem",
  "transcript-follow.css | .jump-to-latest | line-height | 1",
  "ui/ui.css | .ak-anchored__body | line-height | 1.4",
  "ui/ui.css | .ak-badge | line-height | 1",
  "ui/ui.css | .ak-banner | line-height | 1.45",
  "ui/ui.css | .ak-btn | line-height | 1",
  "ui/ui.css | .ak-chip | line-height | 1",
  "ui/ui.css | .ak-control | line-height | 1.2",
  "ui/ui.css | .ak-empty__desc | line-height | 1.5",
  "ui/ui.css | .ak-empty__title | line-height | 1.4",
  "ui/ui.css | .ak-field__hint | line-height | 1.45",
  "ui/ui.css | .ak-field__label | line-height | 1.3",
  "ui/ui.css | .ak-popover__row | line-height | 1",
  "ui/ui.css | .ak-seg__item | line-height | 1",
  "ui/ui.css | .ak-toast | line-height | 1.4",
  "ui/ui.css | .ak-toolcard__head | line-height | 1",
];

const PROPERTIES = new Set(["font-size", "line-height", "font"]);

function tokenOnly(value: string): boolean {
  const match = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
  return !!match && TOKENS.has(match[1]!);
}

export function typographyValueAllowed(property: string, value: string): boolean {
  const v = value.trim();
  if (KEYWORDS.has(v.toLowerCase())) return true;
  if (property !== "font") return tokenOnly(v);
  // Shorthand: needs a size token, and nothing numeric outside var().
  const vars = [...v.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)].map(match => match[1]!);
  if (!vars.some(name => name.startsWith("--fs-")) || !vars.every(name => TOKENS.has(name) || /^--(?:font-(?:ui|mono)|w-[a-z0-9]+)$/.test(name))) return false;
  const rest = v.replace(/var\([^)]*\)/gi, " ").replace(/\//g, " ").trim();
  return rest === "" || /^(?:(?:italic|oblique|normal|bold|bolder|lighter|[1-9]00)\s*)+$/i.test(rest);
}

export function cssEntries(path: string, source: string): string[] {
  return cssDeclarations(source)
    .filter(decl => PROPERTIES.has(decl.property) && !typographyValueAllowed(decl.property, decl.value))
    .map(decl => `${path} | ${decl.context} | ${decl.property} | ${decl.value}`);
}

function contextName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur)) && cur.name) return cur.name.text;
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
  }
  return "<module>";
}

export function inlineEntries(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const name = node.name.text;
      if (name === "fontSize" || name === "lineHeight") {
        const init = node.initializer;
        const literal = ts.isStringLiteralLike(init) ? init.text : undefined;
        const prop = name === "fontSize" ? "font-size" : "line-height";
        if (literal === undefined || !typographyValueAllowed(prop, literal)) {
          out.push(`${path} | ${contextName(node)} | ${name} | ${init.getText(file).replace(/\s+/g, " ")}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

export function collectEntries(): string[] {
  return [
    ...rendererFiles(/\.css$/).flatMap(path => cssEntries(path, readRenderer(path))),
    ...rendererFiles(/\.tsx$/).flatMap(path => inlineEntries(path, readRenderer(path))),
  ].sort();
}

it("reads the typography token set from tokens.css", () => {
  expect([...TOKENS].sort()).toEqual(expect.arrayContaining(["--fs-sm", "--fs-md", "--lh-body", "--lh-tight"]));
  expect(TOKENS.has("--font-ui")).toBe(false);
});

it("accepts typography tokens and keywords and rejects everything else", () => {
  expect(typographyValueAllowed("font-size", "var(--fs-sm)")).toBe(true);
  expect(typographyValueAllowed("line-height", "var(--lh-body)")).toBe(true);
  expect(typographyValueAllowed("font-size", "inherit")).toBe(true);
  expect(typographyValueAllowed("line-height", "normal")).toBe(true);
  expect(typographyValueAllowed("font-size", "var(--anything)")).toBe(false);
  expect(typographyValueAllowed("font-size", "var(--bg)")).toBe(false);
  expect(typographyValueAllowed("font-size", "var(--fs-sm, 13px)")).toBe(false);
  expect(typographyValueAllowed("font-size", "13px")).toBe(false);
  expect(typographyValueAllowed("line-height", "1.4")).toBe(false);
  expect(typographyValueAllowed("font-size", "calc(var(--fs-sm) * 2)")).toBe(false);
  expect(typographyValueAllowed("font", "12px/1.4 sans-serif")).toBe(false);
  expect(typographyValueAllowed("font", "var(--fs-sm) / var(--lh-tight) var(--font-ui)")).toBe(true);
  expect(typographyValueAllowed("font", "600 var(--fs-sm) var(--font-mono)")).toBe(true);
  expect(typographyValueAllowed("font", "inherit")).toBe(true);
});

it("finds violations in CSS (nested at-rules included) and inline TSX styles", () => {
  expect(cssEntries("x.css", "@media (a) { .a { font-size: 12px; line-height: var(--lh-body) } } .b{font:12px x}")).toEqual([
    "x.css | @media (a) > .a | font-size | 12px",
    "x.css | .b | font | 12px x",
  ]);
  expect(inlineEntries("x.tsx", 'const C = () => <i style={{ fontSize: 12, lineHeight: "var(--lh-body)", fontSize: "var(--fs-xs)" }} />;')).toEqual([
    "x.tsx | C | fontSize | 12",
  ]);
});

it("has no typography outside tokens beyond the named baseline, and no stale baseline entries", () => {
  const { added, stale } = baselineDiff(collectEntries(), BASELINE);
  expect({ added, stale }, [
    ...added.map(entry => `new violation (use a --fs-*/--lh-* token): ${entry}`),
    ...stale.map(entry => `stale baseline entry (fixed; remove it): ${entry}`),
  ].join("\n")).toEqual({ added: [], stale: [] });
});

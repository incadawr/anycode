import { expect, it } from "vitest";
import ts from "typescript";
import {
  baselineDiff, contextName, createResolver, cssDeclarations, embeddedCss, flattenObject, parseSource, readBaselineJson, readRenderer, rendererFiles,
  unwrap, type Resolver,
} from "./guard-utils.test-utils.js";

// Overlays (menus, dialogs, popovers, anchored panels) belong to the UI kit
// (ui/). This guard scans the whole renderer outside ui/ - App.tsx, components,
// hooks and shared CSS - for the signals of a hand-made overlay:
//   TS/TSX (AST): role "menu|dialog|alertdialog" in any literal form
//            (role="menu", role={"menu"}, role={`menu`}, a same-file const,
//            either branch of a conditional, a literal object spread
//            {...{ role: "dialog" }}); a role that is not a compile-time string
//            is reported as role=<dynamic>; aria-modal; native <dialog>; the
//            popover attribute; createPortal (also aliased imports).
//   CSS, CSS strings/<style> text and inline style objects: position: fixed;
//            position: absolute together with z-index; position set through
//            var()/an expression (reported as "dynamic"). Selector lists are
//            split and the declarations of one selector are merged within its
//            at-rule; the cascade is not modeled, any dangerous declaration counts.
// Static analysis cannot prove an element is an overlay, so there are two lists
// (overlay-baseline.json):
//   legacy     - existing hand-made overlays awaiting migration to the kit.
//                Shrink-only: new entries fail, fixed entries must be removed,
//                and CI checks the list is a subset of the target branch's.
//   exceptions - documented layout (window chrome, split panes, resize handles)
//                with a one-line reason each. May be extended when a reviewer
//                agrees the element is layout, never for an overlay.
// Entry format: "file | component | <tag.class#id> | signal" for JSX,
// "file | component | signal" for other script code and
// "file | selector | signal" for CSS (no line numbers).
//
// Not detectable (review responsibility, see docs/development/ui.md): a new
// element reusing an already baselined class, position and z-index split over
// different classes, values built at runtime, props spread from variables, and
// aliasing through destructuring.

interface OverlayBaseline { legacy: string[]; exceptions: Record<string, string> }
const BASELINE = readBaselineJson<OverlayBaseline>("overlay-baseline.json");
const LEGACY_BASELINE = BASELINE.legacy;
const LAYOUT_EXCEPTIONS = BASELINE.exceptions;

const OVERLAY_ROLES = /^(?:menu|dialog|alertdialog)$/i;
const DYNAMIC = "<dynamic>";

/** Possible compile-time string values of an expression; DYNAMIC marks anything not known. */
function possibleValues(expr: ts.Expression, resolver: Resolver): string[] {
  const e = unwrap(expr);
  const known = resolver.string(e);
  if (known !== undefined) return [known];
  if (ts.isConditionalExpression(e)) return [...possibleValues(e.whenTrue, resolver), ...possibleValues(e.whenFalse, resolver)];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return possibleValues(e.right, resolver);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...possibleValues(e.left, resolver), ...possibleValues(e.right, resolver)];
  }
  if ((ts.isIdentifier(e) && e.text === "undefined") || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.TrueKeyword) return [];
  return [DYNAMIC];
}

function staticText(node: ts.Node | undefined): string {
  if (!node) return "";
  const parts: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) parts.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) parts.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** "<tag.class#id>" built from static parts only, so replacing one element by another in the same component changes the key. */
function elementId(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  let cls = "", id = "";
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue;
    if (attr.name.text === "className" || attr.name.text === "class") cls = staticText(attr.initializer) || "?";
    if (attr.name.text === "id") id = staticText(attr.initializer) || "?";
  }
  return `<${el.tagName.getText()}${cls ? "." + cls.split(" ").join(".") : ""}${id ? "#" + id : ""}>`;
}

function inStyleContext(obj: ts.ObjectLiteralExpression): ts.JsxOpeningElement | ts.JsxSelfClosingElement | "object" | undefined {
  let cur: ts.Node = obj;
  while (cur.parent && (ts.isParenthesizedExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isSatisfiesExpression(cur.parent) || ts.isConditionalExpression(cur.parent) || ts.isBinaryExpression(cur.parent))) cur = cur.parent;
  const parent = cur.parent;
  if (parent && ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent) && ts.isIdentifier(parent.parent.name) && parent.parent.name.text === "style") {
    const el = parent.parent.parent.parent;
    return ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el) ? el : "object";
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && parent.name.text === "style") return "object";
  return undefined;
}

export function codeEntries(path: string, source: string): string[] {
  const file = parseSource(path, source);
  const resolver = createResolver(file);
  const portalNames = new Set(["createPortal"]);
  const out: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const spec of statement.importClause.namedBindings.elements) if ((spec.propertyName ?? spec.name).text === "createPortal") portalNames.add(spec.name.text);
    }
  }
  const add = (node: ts.Node, signal: string, el?: ts.JsxOpeningElement | ts.JsxSelfClosingElement | "object"): void => {
    out.push(el && el !== "object" ? `${path} | ${contextName(node)} | ${elementId(el)} | ${signal}` : `${path} | ${contextName(node)} | ${signal}`);
  };
  const checkAttribute = (name: string, values: string[] | "present", node: ts.Node, el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void => {
    if (name === "role" && values !== "present") {
      const hits = [...new Set(values.filter(v => v === DYNAMIC || OVERLAY_ROLES.test(v.trim())).map(v => v.trim()))];
      for (const hit of hits) add(node, `role=${hit === DYNAMIC ? DYNAMIC : hit.toLowerCase()}`, el);
    }
    if (name === "aria-modal") add(node, "aria-modal", el);
    if (name === "popover") add(node, "popover attribute", el);
  };
  const checkObject = (obj: ts.ObjectLiteralExpression): void => {
    if (ts.isSpreadAssignment(obj.parent)) return; // reported through its outer literal
    const style = inStyleContext(obj);
    const props = flattenObject(obj, resolver);
    const position = props.get("position");
    if (!position) return;
    const values = possibleValues(position, resolver).map(v => v.trim());
    const target = style === undefined ? undefined : style;
    if (values.includes("fixed")) add(obj, "inline position: fixed", target);
    if (style !== undefined && values.includes(DYNAMIC)) add(obj, "inline position: dynamic", target);
    if (values.includes("absolute") && (props.has("zIndex") || props.has("z-index"))) add(obj, "inline position: absolute + z-index", target);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName) && node.tagName.text === "dialog") add(node, "<dialog>", node);
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr)) {
          const name = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText(file);
          const init = attr.initializer;
          if (name === "style" && init && ts.isJsxExpression(init) && init.expression && ts.isIdentifier(unwrap(init.expression))) {
            // A style object held in a const: the definition reports fixed/absolute; the use reports a dynamic position.
            const held = resolver.object(init.expression);
            const position = held && flattenObject(held, resolver).get("position");
            if (position && possibleValues(position, resolver).includes(DYNAMIC)) add(attr, "inline position: dynamic", node);
          }
          if (!init) checkAttribute(name, name === "role" ? [] : "present", attr, node);
          else if (ts.isStringLiteralLike(init)) checkAttribute(name, [init.text], attr, node);
          else if (ts.isJsxExpression(init) && init.expression) checkAttribute(name, name === "role" ? possibleValues(init.expression, resolver) : "present", attr, node);
        } else if (ts.isJsxSpreadAttribute(attr)) {
          const obj = resolver.object(attr.expression);
          if (obj) for (const [name, value] of flattenObject(obj, resolver)) checkAttribute(name, name === "role" ? possibleValues(value, resolver) : "present", attr, node);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const called = ts.isIdentifier(callee) ? (portalNames.has(callee.text) ? "createPortal" : callee.text)
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : "";
      if (called === "createPortal") add(node, "createPortal");
    }
    if (ts.isObjectLiteralExpression(node)) checkObject(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const { css, context } of embeddedCss(file)) out.push(...cssEntries(path, css, `css-string in ${context} :: `));
  return out;
}

export function cssEntries(path: string, source: string, prefix = ""): string[] {
  // Per at-rule and individual selector: every declared value of each property.
  const merged = new Map<string, Map<string, string[]>>();
  for (const decl of cssDeclarations(source)) {
    if (/(?:^|> )@(?:-\w+-)?keyframes\b/.test(decl.context)) continue;
    for (const selector of decl.selectors) {
      const key = decl.parent ? `${decl.parent} > ${selector}` : selector;
      const props = merged.get(key) ?? new Map<string, string[]>();
      props.set(decl.property, [...(props.get(decl.property) ?? []), decl.value.toLowerCase()]);
      merged.set(key, props);
    }
  }
  const out: string[] = [];
  for (const [context, props] of merged) {
    const positions = props.get("position") ?? [];
    const name = `${path} | ${prefix}${context}`;
    if (positions.includes("fixed")) out.push(`${name} | position: fixed`);
    if (positions.some(v => /var\(|calc\(|env\(|attr\(/.test(v))) out.push(`${name} | position: dynamic`);
    if (positions.includes("absolute") && props.has("z-index")) out.push(`${name} | position: absolute + z-index`);
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
    "x.tsx | A | <div> | role=menu",
    "x.tsx | B | <div> | role=dialog",
    "x.tsx | C | <div> | role=alertdialog",
    "x.tsx | C | <div> | aria-modal",
    "x.tsx | D | <div> | role=menu",
    "x.tsx | E | <dialog> | <dialog>",
    "x.tsx | E | <dialog> | popover attribute",
    "x.tsx | F | createPortal",
    "x.tsx | F | createPortal",
    "x.tsx | G | <i> | inline position: fixed",
    "x.tsx | H | <i> | inline position: absolute + z-index",
  ]);
});

it("resolves same-file constants, literal spreads, plain templates and aliases (review bypasses)", () => {
  const source = [
    'import { createPortal as portal } from "react-dom";',
    'const role = "dialog"; const POS = "fixed";',
    'const A = () => <div role={role} />;',
    'const B = () => <div {...{ role: "dialog", "aria-modal": true }} />;',
    'const C = () => <div role={`menu`} style={{ position: `fixed` }} />;',
    'const D = () => portal(<i />, document.body);',
    'const E = () => <i style={{ ...{ position: "absolute" }, zIndex: 5 }} />;',
    'const F = () => <i style={{ position: POS }} />;',
    'const SHARED = { position: "absolute" } as const; const G = () => <i style={{ ...SHARED, zIndex: 1 }} />;',
  ].join("\n");
  expect(codeEntries("x.tsx", source)).toEqual([
    "x.tsx | A | <div> | role=dialog",
    "x.tsx | B | <div> | role=dialog",
    "x.tsx | B | <div> | aria-modal",
    "x.tsx | C | <div> | role=menu",
    "x.tsx | C | <div> | inline position: fixed",
    "x.tsx | D | createPortal",
    "x.tsx | E | <i> | inline position: absolute + z-index",
    "x.tsx | F | <i> | inline position: fixed",
    "x.tsx | G | <i> | inline position: absolute + z-index",
  ]);
});

it("reports dynamic role and style position instead of passing them silently", () => {
  const source = [
    'const A = (p: { r: string }) => <div role={p.r} />;',
    'const B = (p: { r: string }) => <div role={`m${p.r}`} />;',
    'const C = (p: { s: string }) => <i style={{ position: p.s }} />;',
    'const D = (p: { s: string }) => <i role="presentation" aria-hidden={p.s} />;',
    'const E = () => ({ position: someCall() });',
  ].join("\n");
  expect(codeEntries("x.tsx", source)).toEqual([
    "x.tsx | A | <div> | role=<dynamic>",
    "x.tsx | B | <div> | role=<dynamic>",
    "x.tsx | C | <i> | inline position: dynamic",
  ]);
});

it("keys JSX entries by the element's static class and id, not just the component", () => {
  const a = codeEntries("x.tsx", 'const C = () => <div className="old-menu" role="menu" />;');
  const b = codeEntries("x.tsx", 'const C = () => <div className="new-menu" id="n" role="menu" />;');
  expect(a).toEqual(["x.tsx | C | <div.old-menu> | role=menu"]);
  expect(b).toEqual(["x.tsx | C | <div.new-menu#n> | role=menu"]);
  expect(baselineDiff(b, a).added).toEqual(b);
});

it("does not resolve names declared more than once in a file (review bypass: shadowed const)", () => {
  const source = [
    'const role = "button";',
    'function C() { const role = "dialog"; return <div role={role} />; }',
  ].join("\n");
  expect(codeEntries("x.tsx", source)).toEqual(["x.tsx | C | <div> | role=<dynamic>"]);
  expect(codeEntries("x.tsx", 'const a = "fixed"; const D = (a: string) => <i style={{ position: a }} />;')).toEqual(["x.tsx | D | <i> | inline position: dynamic"]);
});

it("resolves static interpolations in CSS templates and marks unknown ones dynamic (review bypass)", () => {
  expect(codeEntries("x.ts", 'const css = `.a{position:${"fixed"}}`;')).toEqual(["x.ts | css-string in css :: .a | position: fixed"]);
  expect(codeEntries("x.ts", 'const P = "fixed"; const css = `.a{position:${P}}`;')).toEqual(["x.ts | css-string in css :: .a | position: fixed"]);
  expect(codeEntries("x.ts", "const css = (p: string) => `.a{position:${p}}`;")).toEqual(["x.ts | css-string in css :: .a | position: dynamic"]);
  expect(codeEntries("x.ts", 'const css = ".a{position:" + "fixed" + "}";')).toEqual(["x.ts | css-string in css :: .a | position: fixed"]);
});

it("handles static computed keys and style objects held in consts (review bypasses)", () => {
  expect(codeEntries("x.tsx", 'const A = () => <i style={{ ["position"]: "fixed" }} />;')).toEqual(["x.tsx | A | <i> | inline position: fixed"]);
  expect(codeEntries("x.tsx", 'const K = "position"; const B = () => <i style={{ [K]: "absolute", ["zIndex"]: 2 }} />;')).toEqual(["x.tsx | B | <i> | inline position: absolute + z-index"]);
  expect(codeEntries("x.tsx", "const style = { position: getPosition() }; const C = () => <div style={style} />;")).toEqual(["x.tsx | C | <div> | inline position: dynamic"]);
});

it("checks CSS embedded in strings and <style> text", () => {
  expect(codeEntries("x.tsx", "const css = `.a { position: fixed }`; const D = () => <style>{`.b{position:absolute;z-index:1}`}</style>;")).toEqual([
    "x.tsx | css-string in css :: .a | position: fixed",
    "x.tsx | css-string in D :: .b | position: absolute + z-index",
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

it("splits selector lists, keeps dangerous declarations whatever overrides them, and flags var() positions (review bypasses)", () => {
  expect(cssEntries("x.css", ".a,.b{position:absolute}.a{z-index:2}")).toEqual(["x.css | .a | position: absolute + z-index"]);
  expect(cssEntries("x.css", ".a{position:fixed!important}.a{position:relative}")).toEqual(["x.css | .a | position: fixed"]);
  expect(cssEntries("x.css", ".a{position:var(--p)}")).toEqual(["x.css | .a | position: dynamic"]);
  expect(cssEntries("x.css", '.a{content:"\\""}.b{position:fixed}')).toEqual(["x.css | .b | position: fixed"]);
  expect(cssEntries("x.css", "@media (x){.a,.b{position:fixed}}")).toEqual(["x.css | @media (x) > .a | position: fixed", "x.css | @media (x) > .b | position: fixed"]);
});

it("keeps the two lists disjoint and every layout exception justified", () => {
  for (const [entry, reason] of Object.entries(LAYOUT_EXCEPTIONS)) {
    expect(reason.trim().length, `exception needs a reason: ${entry}`).toBeGreaterThan(8);
    expect(LEGACY_BASELINE, `in both lists: ${entry}`).not.toContain(entry);
  }
});

// Parses the whole renderer tree: ~2 s alone, past the 5 s default on a loaded CI runner.
it("has no new overlay signals outside ui/, and no stale entries in either list", () => {
  const actual = collectEntries();
  const exceptionKeys = Object.keys(LAYOUT_EXCEPTIONS);
  const { added, stale } = baselineDiff(actual, [...LEGACY_BASELINE, ...exceptionKeys]);
  const staleLegacy = stale.filter(entry => LEGACY_BASELINE.includes(entry));
  const staleExceptions = stale.filter(entry => exceptionKeys.includes(entry));
  expect({ added, staleLegacy, staleExceptions }, [
    ...added.map(entry => `new overlay signal (use the UI kit, or document a layout exception): ${entry}`),
    ...staleLegacy.map(entry => `stale legacy entry (migrated; remove it): ${entry}`),
    ...staleExceptions.map(entry => `stale layout exception (remove it): ${entry}`),
  ].join("\n")).toEqual({ added: [], staleLegacy: [], staleExceptions: [] });
}, 60_000);

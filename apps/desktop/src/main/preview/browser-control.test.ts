import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BrowserController,
  STALE_REF_MESSAGE,
  checkInteractionPolicy,
  type BrowserControlContext,
} from "./browser-control.js";
import { fakeCdp, type FakeCdp } from "./fake-cdp.js";
import type { PreviewControlRequest } from "../../shared/preview.js";

interface TestNode {
  nodeId: string;
  role: string;
  name?: string;
  backendDOMNodeId?: number;
  childIds?: string[];
  ignored?: boolean;
  value?: string;
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

function axTree(nodes: TestNode[]) {
  return {
    nodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      ignored: node.ignored ?? false,
      role: { value: node.role },
      name: { value: node.name ?? "" },
      ...(node.value !== undefined ? { value: { value: node.value } } : {}),
      properties: node.properties ?? [],
      childIds: node.childIds ?? [],
      ...(node.backendDOMNodeId !== undefined ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
    })),
  };
}

const quad = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

function setup(options: { url?: string; cdp?: FakeCdp; clickSettleMs?: number; console?: Array<{ level: "log" | "warn" | "error" | "pageerror"; message: string; at: string }>; dropped?: number } = {}) {
  const cdp = options.cdp ?? fakeCdp();
  const state = { epoch: 0, url: options.url ?? "http://localhost:3000/" };
  const controller = new BrowserController({ clickSettleMs: options.clickSettleMs ?? 1, navigationWaitMs: 5, waitPollMs: 1 });
  const ctx: BrowserControlContext = {
    cdp,
    previewId: "preview-1",
    currentUrl: () => state.url,
    navEpoch: () => state.epoch,
    settle: async () => "ready",
    reload: async () => {},
    goToOffset: async () => {},
    navigationHistory: () => ({ entries: [], index: 0 }),
    isNavigationAllowed: async () => true,
    console: () => ({ entries: options.console ?? [], dropped: options.dropped ?? 0 }),
    signal: new AbortController().signal,
  };
  const run = (request: PreviewControlRequest) => controller.run(request, ctx);
  return { cdp, state, controller, ctx, run };
}

function basicPage(): TestNode[] {
  return [
    { nodeId: "1", role: "RootWebArea", childIds: ["2", "3", "4"] },
    { nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 11, childIds: ["5"] },
    { nodeId: "5", role: "StaticText", name: "Save" },
    { nodeId: "3", role: "textbox", name: "Email", value: "a@b.c", backendDOMNodeId: 12 },
    { nodeId: "4", role: "heading", name: "Title", backendDOMNodeId: 13, properties: [{ name: "level", value: { value: 1 } }] },
  ];
}

const describeAs = (attributes: string[]) => (params?: object) => {
  const p = params as { backendNodeId?: number } | undefined;
  return p?.backendNodeId === 12 ? { node: { attributes } } : { node: { attributes: [] } };
};

describe("BrowserController snapshot", () => {
  // Test 9
  it("renders roles, names and values, mints monotonic refs, and an old ref after a second snapshot is stale", async () => {
    const { cdp, run, state } = setup();
    cdp.respond("Accessibility.getFullAXTree", axTree(basicPage()));
    cdp.respond("DOM.describeNode", describeAs(["type", "email"]));
    const first = await run({ action: "snapshot" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.text).toContain('[e1] button "Save"');
    expect(first.value.text).toContain('[e2] textbox "Email" value="a@b.c"');
    expect(first.value.text).toContain('[e3] heading "Title" level=1');
    expect(first.value.text).not.toContain('"Save" [e');
    expect(first.value.refs).toBe(3);

    const second = await run({ action: "snapshot" });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.text).toContain('[e4] button "Save"');
    }

    const stale = await run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(stale).toEqual({ ok: false, error: STALE_REF_MESSAGE("e1"), errorKind: "stale_ref" });
    expect(state.epoch).toBe(0);
  });

  // Test 10
  it("hides password values (type=password and AX protected) and never emits the value", async () => {
    const { cdp, run } = setup();
    cdp.respond("Accessibility.getFullAXTree", axTree([
      { nodeId: "1", role: "RootWebArea", childIds: ["2", "3"] },
      { nodeId: "2", role: "textbox", name: "Password", value: "hunter2", backendDOMNodeId: 12 },
      {
        nodeId: "3",
        role: "textbox",
        name: "Secret",
        value: "s3cret-value",
        backendDOMNodeId: 14,
        properties: [{ name: "protected", value: { value: true } }],
      },
    ]));
    cdp.respond("DOM.describeNode", describeAs(["type", "password"]));
    const result = await run({ action: "snapshot" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain('textbox "Password" [password, value hidden]');
    expect(result.value.text).toContain('textbox "Secret" [password, value hidden]');
    expect(result.value.text).not.toContain("hunter2");
    expect(result.value.text).not.toContain("s3cret-value");
  });

  // Test 11
  it("caps a 5 000-node tree at 1 500 nodes, respects maxChars, and says so", async () => {
    const { cdp, run } = setup();
    const nodes: TestNode[] = [{ nodeId: "root", role: "RootWebArea", childIds: [] }];
    for (let i = 0; i < 5000; i += 1) {
      nodes[0]!.childIds!.push(`n${i}`);
      nodes.push({ nodeId: `n${i}`, role: "button", name: `b${i}`, backendDOMNodeId: 1000 + i });
    }
    cdp.respond("Accessibility.getFullAXTree", axTree(nodes));
    const result = await run({ action: "snapshot", maxChars: 60000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refs).toBe(1500);
    expect(result.value.truncated).toBe(true);
    expect(result.value.text).toContain("... truncated: 3500 more nodes");

    const byDefault = await run({ action: "snapshot" });
    expect(byDefault.ok).toBe(true);
    if (byDefault.ok) {
      expect(byDefault.value.refs).toBeLessThan(1500);
      expect(byDefault.value.text.length).toBeLessThanOrEqual(30_000 + 200);
    }

    const small = await run({ action: "snapshot", maxChars: 1000 });
    expect(small.ok).toBe(true);
    if (small.ok) {
      expect(small.value.truncated).toBe(true);
      expect(small.value.text.length).toBeLessThanOrEqual(1000 + 200);
    }
  });

  // Test 12
  it("omits ignored and generic nodes and keeps an iframe as a leaf line", async () => {
    const { cdp, run } = setup();
    cdp.respond("Accessibility.getFullAXTree", axTree([
      { nodeId: "1", role: "RootWebArea", childIds: ["2", "3", "4"] },
      { nodeId: "2", role: "generic", childIds: ["5"] },
      { nodeId: "5", role: "button", name: "Hidden", ignored: true, backendDOMNodeId: 20 },
      { nodeId: "3", role: "iframe", name: "Ad", backendDOMNodeId: 21, childIds: ["6"] },
      { nodeId: "6", role: "button", name: "Inside frame", backendDOMNodeId: 22 },
      { nodeId: "4", role: "generic", childIds: ["7"] },
      { nodeId: "7", role: "InlineTextBox", name: "loose text" },
    ]));
    const result = await run({ action: "snapshot" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain('iframe "Ad"');
    expect(result.value.text).not.toContain("Hidden");
    expect(result.value.text).not.toContain("Inside frame");
    expect(result.value.text).not.toContain("loose text");
  });

  // Test 13
  it("refs resolved from an open shadow-root tree click the element the AX tree named", async () => {
    const { cdp, run } = setup();
    cdp.respond("Accessibility.getFullAXTree", axTree([
      { nodeId: "1", role: "RootWebArea", childIds: ["2"] },
      { nodeId: "2", role: "button", name: "In shadow", backendDOMNodeId: 77 },
    ]));
    cdp.respond("DOM.getBoxModel", { model: { content: quad(10, 20, 40, 20) } });
    await run({ action: "snapshot" });
    const click = await run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(click.ok).toBe(true);
    expect(cdp.calls.find((c) => c.method === "DOM.scrollIntoViewIfNeeded")?.params).toEqual({ backendNodeId: 77 });
  });

  it("ref minting ignores nodes without a backend id so no ref ever points nowhere", async () => {
    const { cdp, run } = setup();
    cdp.respond("Accessibility.getFullAXTree", axTree([
      { nodeId: "1", role: "RootWebArea", childIds: ["2"] },
      { nodeId: "2", role: "link", name: "No backend" },
    ]));
    const result = await run({ action: "snapshot" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain('link "No backend"');
      expect(result.value.text).not.toContain("[e");
    }
  });
});

describe("BrowserController click", () => {
  const clickableTree = () => axTree([
    { nodeId: "1", role: "RootWebArea", childIds: ["2"] },
    { nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 11 },
  ]);

  // Test 14
  it("scrolls into view, reads the box, then sends move/press/release at the centre; double click uses clickCount 2", async () => {
    const { cdp, run } = setup();
    cdp.respond("Accessibility.getFullAXTree", clickableTree());
    cdp.respond("DOM.getBoxModel", { model: { content: quad(100, 200, 50, 30) } });
    await run({ action: "snapshot" });
    const result = await run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(result.ok).toBe(true);
    expect(cdp.methods().slice(-5)).toEqual([
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    const mouse = cdp.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params as Record<string, unknown>);
    expect(mouse.map((m) => m.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse[1]).toMatchObject({ x: 125, y: 215, clickCount: 1 });

    const dbl = setup({ cdp: fakeCdp() });
    dbl.cdp.respond("Accessibility.getFullAXTree", clickableTree());
    dbl.cdp.respond("DOM.getBoxModel", { model: { content: quad(100, 200, 50, 30) } });
    await dbl.run({ action: "snapshot" });
    await dbl.run({ action: "click", target: { ref: "e1" }, doubleClick: true, button: "left" });
    const dblMouse = dbl.cdp.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params as Record<string, unknown>);
    expect(dblMouse[1]).toMatchObject({ clickCount: 2 });
    expect(dblMouse[2]).toMatchObject({ clickCount: 2 });
  });

  // Test 15
  it("selector: zero matches and many matches are invalid_input (no click sent); one match clicks", async () => {
    const none = setup();
    none.cdp.respond("DOM.getDocument", { root: { nodeId: 1 } });
    none.cdp.respond("DOM.querySelectorAll", { nodeIds: [] });
    const zero = await none.run({ action: "click", target: { selector: "#gone" }, doubleClick: false, button: "left" });
    expect(zero).toMatchObject({ ok: false, errorKind: "invalid_input", error: "selector matched nothing" });
    expect(none.cdp.methods()).not.toContain("Input.dispatchMouseEvent");

    const many = setup();
    many.cdp.respond("DOM.getDocument", { root: { nodeId: 1 } });
    many.cdp.respond("DOM.querySelectorAll", { nodeIds: [4, 5] });
    const twoMatches = await many.run({ action: "click", target: { selector: ".btn" }, doubleClick: false, button: "left" });
    expect(twoMatches).toMatchObject({ ok: false, errorKind: "invalid_input" });
    expect(twoMatches.ok ? "" : twoMatches.error).toContain("selector matched 2 elements");
    expect(many.cdp.methods()).not.toContain("Input.dispatchMouseEvent");

    const one = setup();
    one.cdp.respond("DOM.getDocument", { root: { nodeId: 1 } });
    one.cdp.respond("DOM.querySelectorAll", { nodeIds: [9] });
    one.cdp.respond("DOM.describeNode", { node: { backendNodeId: 42 } });
    one.cdp.respond("DOM.getBoxModel", { model: { content: quad(0, 0, 10, 10) } });
    const single = await one.run({ action: "click", target: { selector: "#ok" }, doubleClick: false, button: "left" });
    expect(single.ok).toBe(true);
    expect(one.cdp.methods()).toContain("Input.dispatchMouseEvent");
  });

  // Test 16
  it("a zero-area element is invalid_input 'not visible'; a failing box read means a hidden panel (unavailable)", async () => {
    const zero = setup();
    zero.cdp.respond("Accessibility.getFullAXTree", clickableTree());
    zero.cdp.respond("DOM.getBoxModel", { model: { content: quad(5, 5, 0, 0) } });
    await zero.run({ action: "snapshot" });
    const invisible = await zero.run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(invisible).toMatchObject({ ok: false, errorKind: "invalid_input", error: "element is not visible" });

    const hidden = setup();
    hidden.cdp.respond("Accessibility.getFullAXTree", clickableTree());
    hidden.cdp.respond("DOM.getBoxModel", new Error("Could not compute box model"));
    await hidden.run({ action: "snapshot" });
    const panel = await hidden.run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(panel).toMatchObject({ ok: false, errorKind: "unavailable" });
    expect(panel.ok ? "" : panel.error).toContain("preview is not visible; open the preview panel");
  });

  // Test 17
  it("a navigation during the click reports navigated with the new url; an epoch bump between snapshot and click is stale with no mouse event", async () => {
    const during = setup({ clickSettleMs: 1 });
    during.cdp.respond("Accessibility.getFullAXTree", clickableTree());
    during.cdp.respond("DOM.getBoxModel", { model: { content: quad(0, 0, 10, 10) } });
    await during.run({ action: "snapshot" });
    during.cdp.respond("Input.dispatchMouseEvent", (params?: object) => {
      if ((params as { type?: string } | undefined)?.type === "mouseReleased") {
        during.state.epoch += 1;
        during.state.url = "http://localhost:3000/next";
      }
      return {};
    });
    const navigated = await during.run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(navigated.ok).toBe(true);
    if (navigated.ok) {
      expect(navigated.value.navigated).toBe(true);
      expect(navigated.value.text).toContain("page navigated to http://localhost:3000/next");
    }

    const between = setup();
    between.cdp.respond("Accessibility.getFullAXTree", clickableTree());
    between.cdp.respond("DOM.getBoxModel", { model: { content: quad(0, 0, 10, 10) } });
    await between.run({ action: "snapshot" });
    between.state.epoch += 1;
    const stale = await between.run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(stale).toMatchObject({ ok: false, errorKind: "stale_ref" });
    expect(between.cdp.methods()).not.toContain("Input.dispatchMouseEvent");
  });

  // Test 18
  it("a CDP 'Could not find node with given id' during the box read is the exact stale_ref message", async () => {
    const { cdp, run } = setup();
    cdp.respond("Accessibility.getFullAXTree", clickableTree());
    cdp.respond("DOM.scrollIntoViewIfNeeded", new Error("Could not find node with given id"));
    await run({ action: "snapshot" });
    const result = await run({ action: "click", target: { ref: "e1" }, doubleClick: false, button: "left" });
    expect(result).toEqual({ ok: false, error: STALE_REF_MESSAGE("e1"), errorKind: "stale_ref" });
  });
});

describe("BrowserController type", () => {
  function typeSetup(field: { tag?: string; type?: string; editable?: boolean; readOnly?: boolean; disabled?: boolean; label?: string }) {
    const { cdp, run, ...rest } = setup();
    cdp.respond("Accessibility.getFullAXTree", axTree([
      { nodeId: "1", role: "RootWebArea", childIds: ["2"] },
      { nodeId: "2", role: "textbox", name: "Field", backendDOMNodeId: 31 },
    ]));
    cdp.respond("DOM.getBoxModel", { model: { content: quad(0, 0, 10, 10) } });
    cdp.respond("DOM.resolveNode", { object: { objectId: "obj-1" } });
    cdp.respond("Runtime.callFunctionOn", (params?: object) => {
      const fn = (params as { functionDeclaration?: string } | undefined)?.functionDeclaration ?? "";
      if (fn.includes("tagName")) {
        return {
          result: {
            value: {
              tag: field.tag ?? "input",
              type: field.type ?? "text",
              editable: field.editable ?? false,
              readOnly: field.readOnly ?? false,
              disabled: field.disabled ?? false,
              label: field.label ?? "Name",
            },
          },
        };
      }
      return { result: { value: true } };
    });
    return { cdp, run, ...rest };
  }

  // Test 19
  it("focuses, selects all, inserts text; clear:false skips the select; submit sends Enter down/up", async () => {
    const { cdp, run } = typeSetup({});
    await run({ action: "snapshot" });
    const result = await run({ action: "type", target: { ref: "e1" }, text: "Ada", clear: true, submit: true });
    expect(result.ok).toBe(true);
    const methods = cdp.methods();
    expect(methods).toContain("DOM.focus");
    expect(methods.indexOf("Runtime.callFunctionOn")).toBeGreaterThan(-1);
    expect(cdp.calls.find((c) => c.method === "Input.insertText")?.params).toEqual({ text: "Ada" });
    const keys = cdp.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => (c.params as { type: string }).type);
    expect(keys).toEqual(["keyDown", "keyUp"]);
    if (result.ok) {
      expect(result.value.text).toContain('typed "Ada"');
    }

    const noClear = typeSetup({});
    await noClear.run({ action: "snapshot" });
    const beforeCalls = noClear.cdp.calls.length;
    await noClear.run({ action: "type", target: { ref: "e1" }, text: "x", clear: false, submit: false });
    const later = noClear.cdp.calls.slice(beforeCalls).map((c) => c.method);
    expect(later.filter((m) => m === "Runtime.callFunctionOn")).toHaveLength(1);
  });

  it("echoes at most 80 characters and reports only the length for a token-like field", async () => {
    const long = typeSetup({});
    await long.run({ action: "snapshot" });
    const text = "x".repeat(100);
    const result = await long.run({ action: "type", target: { ref: "e1" }, text, clear: true, submit: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain(`typed "${"x".repeat(80)}"`);
      expect(result.value.text).not.toContain("x".repeat(81));
    }

    const token = typeSetup({ label: "Access token" });
    await token.run({ action: "snapshot" });
    const masked = await token.run({ action: "type", target: { ref: "e1" }, text: "abcd1234", clear: true, submit: false });
    expect(masked.ok).toBe(true);
    if (masked.ok) {
      expect(masked.value.text).toContain("typed 8 chars");
      expect(masked.value.text).not.toContain("abcd1234");
    }
  });

  // Test 20
  it("refuses password and file fields, read-only, disabled and non-editable targets; text over 10 000 chars is invalid_input", async () => {
    const pw = typeSetup({ type: "password" });
    await pw.run({ action: "snapshot" });
    const passwordResult = await pw.run({ action: "type", target: { ref: "e1" }, text: "secret", clear: true, submit: false });
    expect(passwordResult).toMatchObject({ ok: false, errorKind: "not_allowed" });
    expect(pw.cdp.methods()).not.toContain("Input.insertText");

    const file = typeSetup({ type: "file" });
    await file.run({ action: "snapshot" });
    expect(await file.run({ action: "type", target: { ref: "e1" }, text: "a", clear: true, submit: false })).toMatchObject({
      errorKind: "not_allowed",
    });

    const ro = typeSetup({ readOnly: true });
    await ro.run({ action: "snapshot" });
    expect(await ro.run({ action: "type", target: { ref: "e1" }, text: "a", clear: true, submit: false })).toMatchObject({
      errorKind: "invalid_input",
    });

    const dis = typeSetup({ disabled: true });
    await dis.run({ action: "snapshot" });
    expect(await dis.run({ action: "type", target: { ref: "e1" }, text: "a", clear: true, submit: false })).toMatchObject({
      errorKind: "invalid_input",
    });

    const div = typeSetup({ tag: "div", editable: false });
    await div.run({ action: "snapshot" });
    expect(await div.run({ action: "type", target: { ref: "e1" }, text: "a", clear: true, submit: false })).toMatchObject({
      errorKind: "invalid_input",
    });

    const big = typeSetup({});
    await big.run({ action: "snapshot" });
    expect(
      await big.run({ action: "type", target: { ref: "e1" }, text: "y".repeat(10_001), clear: true, submit: false }),
    ).toMatchObject({ errorKind: "invalid_input" });
  });
});

describe("BrowserController waitFor", () => {
  // Test 21
  it("text appearing after several polls is ok; a timeout names what was awaited; gone inverts; abort is cancelled", async () => {
    const polls = setup();
    let count = 0;
    polls.cdp.respond("Runtime.evaluate", () => {
      count += 1;
      return { result: { value: count >= 3 } };
    });
    const found = await polls.run({ action: "waitFor", text: "Saved ok", timeoutMs: 5000 });
    expect(found.ok).toBe(true);
    expect(count).toBeGreaterThanOrEqual(3);

    const timeout = setup();
    timeout.cdp.respond("Runtime.evaluate", { result: { value: false } });
    const missed = await timeout.run({ action: "waitFor", text: "Never", timeoutMs: 10 });
    expect(missed).toMatchObject({ ok: false, errorKind: "timeout" });
    expect(missed.ok ? "" : missed.error).toContain('text "Never"');

    const gone = setup();
    gone.cdp.respond("Runtime.evaluate", { result: { value: false } });
    expect(await gone.run({ action: "waitFor", text: "Spinner", gone: true, timeoutMs: 10 })).toMatchObject({ ok: true });

    const aborted = setup();
    aborted.cdp.respond("Runtime.evaluate", { result: { value: false } });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await aborted.controller.run(
      { action: "waitFor", text: "x", timeoutMs: 5000 },
      { ...aborted.ctx, signal: controller.signal },
    );
    expect(cancelled).toMatchObject({ ok: false, errorKind: "cancelled" });
  });

  it("refuses a waitFor with neither text nor selector", async () => {
    const { run } = setup();
    expect(await run({ action: "waitFor", timeoutMs: 10 })).toMatchObject({ ok: false, errorKind: "invalid_input" });
  });
});

describe("BrowserController history navigation", () => {
  // Test 22 (history part)
  it("back with no entry is invalid_input; back to a disallowed origin is not_allowed; reload calls reload", async () => {
    const { controller, ctx } = setup();
    const none = await controller.run({ action: "navigate", to: { history: "back" } }, { ...ctx, navigationHistory: () => ({ entries: [{ url: "http://localhost:3000/", title: "" }], index: 0 }) });
    expect(none).toMatchObject({ ok: false, errorKind: "invalid_input" });

    const disallowed = await controller.run(
      { action: "navigate", to: { history: "back" } },
      {
        ...ctx,
        navigationHistory: () => ({
          entries: [{ url: "https://evil.example/", title: "" }, { url: "http://localhost:3000/", title: "" }],
          index: 1,
        }),
        isNavigationAllowed: async () => false,
      },
    );
    expect(disallowed).toMatchObject({ ok: false, errorKind: "not_allowed", error: "history target is not an allowed origin" });

    let reloaded = 0;
    const reload = await controller.run({ action: "navigate", to: { history: "reload" } }, { ...ctx, reload: async () => { reloaded += 1; } });
    expect(reload.ok).toBe(true);
    expect(reloaded).toBe(1);
  });
});

describe("checkInteractionPolicy matrix", () => {
  // Test 23
  it.each([
    ["click", "localhost", false, "http://localhost:3000/", true],
    ["click", "file", false, "file:///repo/index.html", true],
    ["type", "localhost", false, "http://localhost:3000/", true],
    ["snapshot", "remote", false, "https://example.org/", true],
    ["waitFor", "remote", false, "https://example.org/", true],
    ["navigate", "remote", false, "https://example.org/", true],
    ["click", "remote", true, "https://example.org/", true],
    ["click", "remote", false, "https://example.org/", false],
    ["type", "remote", false, "https://example.org/", false],
    ["eval", "localhost", false, "http://localhost:3000/", false],
    ["eval", "localhost", true, "http://localhost:3000/", true],
    ["click", "dom-md", true, "file:///x.md", false],
    ["click", "unknown", true, "about:blank", false],
  ] as const)("%s on %s (allowRemote=%s) allowed=%s", (action, kind, allowRemote, url, allowed) => {
    const result = checkInteractionPolicy(action, kind, allowRemote, url);
    expect(result.allow).toBe(allowed);
  });

  it("a remote click without approval returns not_allowed with the exact retry message", () => {
    const result = checkInteractionPolicy("click", "remote", false, "https://example.org/a");
    expect(result).toEqual({
      allow: false,
      errorKind: "not_allowed",
      error: "this preview shows a remote origin (https://example.org); the call needs the user's approval. Retry with remote:true so the user is asked.",
    });
  });

  it("dom-md is invalid_input, not a permission problem", () => {
    expect(checkInteractionPolicy("snapshot", "dom-md", false, "file:///x.md")).toMatchObject({
      allow: false,
      errorKind: "invalid_input",
    });
  });

  it("full access allows any interaction on a remote origin without approval", () => {
    expect(checkInteractionPolicy("click", "remote", false, "https://example.org/", true).allow).toBe(true);
  });
});

describe("driver source guard", () => {
  // Test 26
  it("never uses the Network or Storage CDP domains or cookie helpers", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "browser-control.ts"), "utf8");
    for (const forbidden of ["Network.getCookies", "Network.enable", "Storage.", "getAllCookies"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("BrowserController console (Taskana 4759, Phase B)", () => {
  const entry = (level: "log" | "warn" | "error" | "pageerror", message: string, index = 0) => ({
    level,
    message,
    at: `2026-10-25T12:34:${String(index % 60).padStart(2, "0")}.000Z`,
  });

  // Test 24
  it("default tail 50, max 200, levels filter, includes 'blocked by security policy' entries, empty ring => (no console output)", async () => {
    const many = Array.from({ length: 300 }, (_, i) => entry("log", `line ${i}`, i));
    const { run } = setup({ console: many, dropped: 4 });
    const defaults = await run({ action: "console" });
    expect(defaults.ok).toBe(true);
    if (defaults.ok) {
      const lines = defaults.value.text.split("\n");
      expect(lines.filter((l) => l.startsWith("[log]"))).toHaveLength(50);
      expect(lines[0]).toMatch(/^\[log\] 12:34:\d\d line 250$/);
      expect(defaults.value.text).toContain("(4 earlier console entries dropped)");
    }
    const capped = await run({ action: "console", tail: 500 });
    if (capped.ok) {
      expect(capped.value.text.split("\n").filter((l) => l.startsWith("[log]"))).toHaveLength(200);
    }

    const mixed = setup({
      console: [
        entry("log", "hello", 0),
        entry("error", "boom", 1),
        entry("pageerror", "uncaught", 2),
        entry("warn", "blocked by security policy: script https://cdn.example/x.js", 3),
      ],
    });
    const onlyErrors = await mixed.run({ action: "console", levels: ["error", "pageerror"] });
    expect(onlyErrors.ok && onlyErrors.value.text).toBe("[error] 12:34:01 boom\n[pageerror] 12:34:02 uncaught");
    const blocked = await mixed.run({ action: "console", levels: ["warn"] });
    expect(blocked.ok && blocked.value.text).toContain("blocked by security policy");

    const empty = setup({});
    expect(await empty.run({ action: "console" })).toEqual({
      ok: true,
      value: { previewId: "preview-1", url: "http://localhost:3000/", text: "(no console output)" },
    });
  });

  // Test 25
  it("eval: result is JSON, capped at 20 000 chars; a page exception is an 'error:' answer; blocklisted tokens are refused before any send; a hung script is a timeout", async () => {
    const plain = setup();
    plain.cdp.respond("Runtime.evaluate", { result: { value: { a: 1, b: "two" } } });
    const json = await plain.run({ action: "eval", expression: "({a:1,b:'two'})" });
    expect(json.ok && json.value.text).toBe('{"a":1,"b":"two"}');
    const sent = plain.cdp.calls.find((c) => c.method === "Runtime.evaluate")?.params as Record<string, unknown>;
    expect(sent).toMatchObject({ returnByValue: true, awaitPromise: true, userGesture: false, timeout: 5000 });

    const big = setup();
    big.cdp.respond("Runtime.evaluate", { result: { value: "z".repeat(25_000) } });
    const capped = await big.run({ action: "eval", expression: "'z'.repeat(25000)" });
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(capped.value.text.length).toBeLessThan(20_100);
      expect(capped.value.text).toContain("(result truncated)");
    }

    const thrower = setup();
    thrower.cdp.respond("Runtime.evaluate", {
      exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined" } },
    });
    const threw = await thrower.run({ action: "eval", expression: "nope" });
    expect(threw).toEqual({
      ok: true,
      value: {
        previewId: "preview-1",
        url: "http://localhost:3000/",
        text: "error: ReferenceError: nope is not defined",
      },
    });

    for (const token of ["document.cookie", "DOCUMENT.COOKIE", "localStorage.getItem('t')", "SESSIONSTORAGE", "indexedDB.open('x')", "cookieStore.getAll()", "navigator.Credentials.get()"]) {
      const blocked = setup();
      const result = await blocked.run({ action: "eval", expression: token });
      expect(result).toMatchObject({ ok: false, errorKind: "not_allowed" });
      expect(blocked.cdp.methods()).not.toContain("Runtime.evaluate");
    }

    const hung = setup();
    hung.cdp.respond("Runtime.evaluate", new Error("CDP command timed out"));
    expect(await hung.run({ action: "eval", expression: "1+1" })).toMatchObject({ ok: false, errorKind: "timeout" });

    const long = setup();
    expect(await long.run({ action: "eval", expression: "1+".repeat(6000) })).toMatchObject({ ok: false, errorKind: "invalid_input" });
  });
});

describe("BrowserController password typing under Full browser access (Taskana 4759 amendment)", () => {
  it("refuses a password field when the switch is off and types into it when on; the value is never echoed", async () => {
    const build = () => {
      const cdp = fakeCdp();
      cdp.respond("Accessibility.getFullAXTree", axTree([
        { nodeId: "1", role: "RootWebArea", childIds: ["2"] },
        { nodeId: "2", role: "textbox", name: "Password", backendDOMNodeId: 31 },
      ]));
      cdp.respond("DOM.getBoxModel", { model: { content: quad(0, 0, 10, 10) } });
      cdp.respond("DOM.resolveNode", { object: { objectId: "obj-1" } });
      cdp.respond("Runtime.callFunctionOn", (params?: object) => {
        const fn = (params as { functionDeclaration?: string } | undefined)?.functionDeclaration ?? "";
        if (fn.includes("tagName")) {
          return { result: { value: { tag: "input", type: "password", editable: false, readOnly: false, disabled: false, label: "Password" } } };
        }
        return { result: { value: true } };
      });
      const controller = new BrowserController({ clickSettleMs: 1, navigationWaitMs: 5, waitPollMs: 1 });
      const state = { on: false };
      const ctx: BrowserControlContext = {
        cdp,
        previewId: "preview-1",
        currentUrl: () => "http://localhost:3000/",
        navEpoch: () => 0,
        settle: async () => "ready",
        reload: async () => {},
        goToOffset: async () => {},
        navigationHistory: () => ({ entries: [], index: 0 }),
        isNavigationAllowed: async () => true,
        console: () => ({ entries: [], dropped: 0 }),
        fullAccess: () => state.on,
        signal: new AbortController().signal,
      };
      return { cdp, controller, ctx, state };
    };
    const off = build();
    await off.controller.run({ action: "snapshot" }, off.ctx);
    const refused = await off.controller.run({ action: "type", target: { ref: "e1" }, text: "hunter2", clear: true, submit: false }, off.ctx);
    expect(refused).toMatchObject({ ok: false, errorKind: "not_allowed" });
    expect(off.cdp.methods()).not.toContain("Input.insertText");

    const on = build();
    on.state.on = true;
    await on.controller.run({ action: "snapshot" }, on.ctx);
    const typed = await on.controller.run({ action: "type", target: { ref: "e1" }, text: "hunter2", clear: true, submit: false }, on.ctx);
    expect(typed.ok).toBe(true);
    expect(on.cdp.calls.find((c) => c.method === "Input.insertText")?.params).toEqual({ text: "hunter2" });
    if (typed.ok) {
      expect(typed.value.text).not.toContain("hunter2");
      expect(typed.value.text).toContain("typed 7 chars");
    }
  });
});

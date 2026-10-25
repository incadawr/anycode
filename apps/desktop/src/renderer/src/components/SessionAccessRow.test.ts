/**
 * Per-session switch row (Taskana 4747). Node env, no DOM: the initial render (no
 * tab context, state not yet loaded) shows the disabled reason; the wiring to
 * `setSessionAccess(tabId, enabled)` is pinned by the IPC tests.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionAccessRow, commitSessionHandle } from "./SessionAccessRow.js";
import { handleErrorText } from "./sessions-api-model.js";

const neverBridge = {
  get: () => new Promise<never>(() => {}),
  setSessionAccess: () => new Promise<never>(() => {}),
  setSessionHandle: () => new Promise<never>(() => {}),
};

describe("SessionAccessRow (Taskana 4747)", () => {
  it("without a tab it is disabled and says to open a session", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    expect(html).toContain("Sessions API: not shared");
    expect(html).toContain("Open a session to share it.");
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });

  it("the row is labelled as a Sessions API group for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    expect(html).toContain('aria-label="Sessions API"');
  });
});

describe("SessionAccessRow handle field (Taskana 4750b)", () => {
  it("handle input hidden when switch off", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    expect(html).not.toContain('data-environment-action="sessions-api-handle"');
    expect(html).not.toContain("Handle (optional)");
  });

  it("commit sends only the tabId and the trimmed handle (blank = clear)", async () => {
    const calls: unknown[][] = [];
    const bridge = { setSessionHandle: async (...args: unknown[]) => { calls.push(args); return { ok: false as const, reason: "invalid" as const }; } };
    await commitSessionHandle(bridge, "tab-7", "  build-bot  ");
    await commitSessionHandle(bridge, "tab-7", "   ");
    expect(calls).toEqual([["tab-7", "build-bot"], ["tab-7", null]]);
  });

  it("maps invalid and duplicate results to their inline messages", () => {
    expect(handleErrorText("invalid")).toContain("Use lowercase letters");
    expect(handleErrorText("duplicate")).toContain("Another live session");
  });
});

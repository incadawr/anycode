/**
 * Per-session switch row. Node env, no DOM: the initial render (no
 * tab context, state not yet loaded) shows the disabled reason; the wiring to
 * `setSessionAccess(tabId, enabled)` is pinned by the IPC tests.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionAccessRow } from "./SessionAccessRow.js";

const neverBridge = {
  get: () => new Promise<never>(() => {}),
  setSessionAccess: () => new Promise<never>(() => {}),
};

describe("SessionAccessRow", () => {
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

/**
 * Regression for the v0.0.38 blank window: Settings mounts its panes OUTSIDE
 * any <TabContext.Provider>, and the pane used to call useTabStore/useTabSend
 * unconditionally, which throw without a provider — one click on "Language
 * servers" unmounted the whole renderer. Node env, no DOM: rendered with
 * renderToStaticMarkup like BrowserAccessRow.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageServersPane } from "./LanguageServersPane.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";

const never = () => new Promise<never>(() => {});
const neverBridge = { status: never, enable: never, disable: never, customUpsert: never } as never;

describe("LanguageServersPane outside a tab context", () => {
  it("renders without a TabContext provider and hides the live-status section", () => {
    const html = renderToStaticMarkup(createElement(LanguageServersPane, { bridge: neverBridge }));
    expect(html).toContain("Language servers");
    expect(html).not.toContain("Live status");
  });

  it("shows the live-status section when a tab context is provided", () => {
    const store = createDesktopStore();
    const html = renderToStaticMarkup(
      createElement(TabContext.Provider, { value: { tabId: "t1", store } }, createElement(LanguageServersPane, { tabId: "t1", bridge: neverBridge })),
    );
    expect(html).toContain("Live status");
  });
});

describe("LanguageServersPane with an explicit scope-tab store (Settings)", () => {
  it("renders live status from the passed store without an ambient provider", () => {
    const html = renderToStaticMarkup(createElement(LanguageServersPane, { tabId: "t1", tabStore: createDesktopStore(), bridge: neverBridge }));
    expect(html).toContain("Live status");
  });
});

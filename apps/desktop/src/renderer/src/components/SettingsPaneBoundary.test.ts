import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsPaneBoundary } from "./SettingsPaneBoundary.js";

function Boom(): never {
  throw new Error("boom");
}

describe("SettingsPaneBoundary", () => {
  it("passes children through when they render", () => {
    const html = renderToStaticMarkup(createElement(SettingsPaneBoundary, { paneId: "x", children: createElement("p", null, "ok") }));
    expect(html).toBe("<p>ok</p>");
  });

  it("derives the failed state from a render error (the fallback replaces the pane, not the app)", () => {
    expect(SettingsPaneBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new SettingsPaneBoundary({ paneId: "language-servers", children: createElement(Boom) });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toContain('data-settings-pane-error="language-servers"');
    vi.restoreAllMocks();
  });
});

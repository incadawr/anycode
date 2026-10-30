/**
 * "Full browser access" row and chip (Taskana 4759): brief tests 50 and 51. Node env,
 * no DOM: the markup is checked with renderToStaticMarkup, and the confirm/apply/push
 * logic is exercised through the pure helpers the component is built from.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BROWSER_ACCESS_CONFIRM,
  BROWSER_ACCESS_TRUST_DETAIL,
  BrowserAccessRow,
  applyBrowserAccessChange,
  browserAccessChipVisible,
  browserAccessRowModel,
  browserAccessToggleAction,
} from "./BrowserAccessRow.js";

const neverBridge = {
  get: () => new Promise<never>(() => {}),
  set: () => new Promise<never>(() => {}),
  onChanged: () => () => {},
};

describe("BrowserAccessRow (Taskana 4759) — test 50", () => {
  it("shows OFF by default, labelled as its own group with the environment action selector", () => {
    const html = renderToStaticMarkup(createElement(BrowserAccessRow, { bridge: neverBridge }));
    expect(html).toContain('aria-label="Full browser access"');
    expect(html).toContain('data-environment-action="browser-full-access"');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*/);
    expect(html).not.toMatch(/<input[^>]*checked=""/);
  });

  it("uses the shared menu row shape: icon, wrapping detail, control on the right", () => {
    const html = renderToStaticMarkup(createElement(BrowserAccessRow, { bridge: neverBridge }));
    expect(html.indexOf("<svg")).toBeGreaterThan(-1);
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("environment-menu-row-main"));
    expect(html.indexOf("environment-menu-row-main")).toBeLessThan(html.indexOf("environment-menu-actions"));
    expect(html.indexOf("environment-menu-actions")).toBeLessThan(html.indexOf('data-environment-action="browser-full-access"'));
    expect(html).toContain("environment-menu-row-detail-prose");
  });

  it("the trust-pending folder row is disabled with the trust hint", () => {
    const model = browserAccessRowModel({ tabId: "t", fullAccess: false, reason: "trust" }, true);
    expect(model).toEqual({ checked: false, disabled: true, detail: BROWSER_ACCESS_TRUST_DETAIL });
    expect(BROWSER_ACCESS_TRUST_DETAIL).toBe("Trust this folder first");
  });

  it("turning ON asks first (Cancel keeps OFF and sends nothing); turning OFF is immediate", () => {
    expect(browserAccessToggleAction(false, true)).toBe("confirm");
    expect(browserAccessToggleAction(true, false)).toBe("set");
    expect(BROWSER_ACCESS_CONFIRM.title).toBe("Allow full browser access?");
    expect(BROWSER_ACCESS_CONFIRM.confirmLabel).toBe("Allow");
    expect(BROWSER_ACCESS_CONFIRM.body).toContain("cannot read cookies or stored credentials");
  });

  it("a changed push updates only this tab's state", () => {
    const current = { tabId: "tab-1", fullAccess: false };
    expect(applyBrowserAccessChange(current, "tab-1", { tabId: "tab-1", fullAccess: true })).toEqual({ tabId: "tab-1", fullAccess: true });
    expect(applyBrowserAccessChange(current, "tab-1", { tabId: "tab-2", fullAccess: true })).toBe(current);
    expect(applyBrowserAccessChange(undefined, "tab-1", { tabId: "tab-1", fullAccess: false, reason: "trust" })).toEqual({
      tabId: "tab-1",
      fullAccess: false,
      reason: "trust",
    });
  });

  it("without a tab the row is disabled", () => {
    expect(browserAccessRowModel(undefined, false).disabled).toBe(true);
  });
});

describe("browser access chip (Taskana 4759) — test 51", () => {
  it("is visible iff the effective value is ON, and disappears on the push that turns it OFF", () => {
    const on = { tabId: "t", fullAccess: true };
    expect(browserAccessChipVisible(on)).toBe(true);
    const afterPush = applyBrowserAccessChange(on, "t", { tabId: "t", fullAccess: false });
    expect(browserAccessChipVisible(afterPush)).toBe(false);
    expect(browserAccessChipVisible(undefined)).toBe(false);
    expect(browserAccessChipVisible({ tabId: "t", fullAccess: false, reason: "trust" })).toBe(false);
  });
});

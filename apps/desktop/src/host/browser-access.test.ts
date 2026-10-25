/**
 * Host-side "Full browser access" flag (Taskana 4759): brief test 48.
 */
import { describe, expect, it } from "vitest";
import { BROWSER_ACCESS_HOST_MESSAGE_TYPE } from "../shared/browser-access.js";
import { routePreviewMessage } from "./boot.js";
import { browserFullAccessFromEnv, createBrowserAccess } from "./browser-access.js";

describe("host browser access flag (Taskana 4759) — test 48", () => {
  it("the initial value comes from ANYCODE_BROWSER_FULL_ACCESS only when it is exactly \"1\"", () => {
    expect(browserFullAccessFromEnv({ ANYCODE_BROWSER_FULL_ACCESS: "1" })).toBe(true);
    for (const value of ["0", "true", "yes", "", " 1"]) {
      expect(browserFullAccessFromEnv({ ANYCODE_BROWSER_FULL_ACCESS: value })).toBe(false);
    }
    expect(browserFullAccessFromEnv({})).toBe(false);
  });

  it("routePreviewMessage recognizes the browser-access message and calls set", () => {
    const access = createBrowserAccess(false);
    const handled = routePreviewMessage(
      { type: BROWSER_ACCESS_HOST_MESSAGE_TYPE, fullAccess: true },
      { onResponse: () => {}, onBrowserAccess: (value) => access.set(value) },
    );
    expect(handled).toBe(true);
    expect(access.get()).toBe(true);
  });

  it("a malformed browser-access message is recognized but ignored", () => {
    const access = createBrowserAccess(true);
    const calls: boolean[] = [];
    for (const data of [{ type: BROWSER_ACCESS_HOST_MESSAGE_TYPE }, { type: BROWSER_ACCESS_HOST_MESSAGE_TYPE, fullAccess: "yes" }]) {
      routePreviewMessage(data, { onResponse: () => {}, onBrowserAccess: (value) => { calls.push(value); access.set(value); } });
    }
    expect(calls).toEqual([]);
    expect(access.get()).toBe(true);
  });

  it("set is the only writer and coerces a non-boolean to OFF", () => {
    const access = createBrowserAccess(true);
    access.set(false);
    expect(access.get()).toBe(false);
    access.set("1" as unknown as boolean);
    expect(access.get()).toBe(false);
  });
});

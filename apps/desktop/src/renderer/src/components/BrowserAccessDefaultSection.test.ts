/**
 * Settings → Permissions "Full browser access for new sessions" (Taskana 4759): brief
 * test 52. The toggle writes `browser.fullAccessDefault` through the generic settings patch.
 */
import { describe, expect, it } from "vitest";
import { BROWSER_DEFAULT_WARNING, browserDefaultOn, browserDefaultPatch } from "./BrowserAccessDefaultSection.js";

describe("Settings: default full browser access (Taskana 4759) — test 52", () => {
  it("the toggle writes browser.fullAccessDefault through the settings patch (on and off)", () => {
    expect(browserDefaultPatch(true)).toEqual({ browser: { fullAccessDefault: "on" } });
    expect(browserDefaultPatch(false)).toEqual({ browser: { fullAccessDefault: "off" } });
  });

  it("reads on only for an explicit on; absent or unknown reads as off", () => {
    expect(browserDefaultOn({ browser: { fullAccessDefault: "on" } })).toBe(true);
    expect(browserDefaultOn({ browser: { fullAccessDefault: "off" } })).toBe(false);
    expect(browserDefaultOn({})).toBe(false);
    expect(browserDefaultOn(undefined)).toBe(false);
  });

  it("the warning names the agent's reach and the trust exception", () => {
    expect(BROWSER_DEFAULT_WARNING).toContain("without asking");
    expect(BROWSER_DEFAULT_WARNING).toContain("Folders you have not trusted stay off");
  });
});

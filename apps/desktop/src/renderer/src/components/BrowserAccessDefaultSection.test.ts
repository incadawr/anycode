/**
 * Settings → Permissions "Full browser access for new sessions" brief
 * test 52. The toggle writes `browser.fullAccessDefault` through the generic settings patch.
 */
import { describe, expect, it } from "vitest";
import { BROWSER_DEFAULT_WARNING, browserDefaultOn, browserDefaultPatch } from "./BrowserAccessDefaultSection.js";

describe("Settings: default full browser access — test 52", () => {
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

  it("the warning names the agent's reach, the data policy and the trust exception", () => {
    expect(BROWSER_DEFAULT_WARNING).toContain("without asking");
    expect(BROWSER_DEFAULT_WARNING).toContain("can read the shown page's cookies and storage");
    expect(BROWSER_DEFAULT_WARNING).toContain("credentials stay out of reach");
    expect(BROWSER_DEFAULT_WARNING).not.toContain("cannot read");
    expect(BROWSER_DEFAULT_WARNING).toContain("Folders you have not trusted stay off");
  });
});

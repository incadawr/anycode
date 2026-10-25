import { describe, expect, it, vi } from "vitest";
import { RETURN_LABEL, isReturnShortcut, popoutTitle, returnMenuTemplate } from "./popout.js";

describe("popoutTitle (Taskana 4778)", () => {
  it("prefers the page title", () => {
    expect(popoutTitle("Reward FX Lab", "https://x.dev/a.html")).toBe("Reward FX Lab");
  });
  it("falls back to the host for a remote page without a title (or one that equals the URL)", () => {
    expect(popoutTitle("", "https://myriad-dev.incadawr.dev/online/reward-fx-lab.html")).toBe("myriad-dev.incadawr.dev");
    expect(popoutTitle("https://x.dev/a", "https://x.dev/a")).toBe("x.dev");
  });
  it("uses the file name for a file page and a neutral label for nothing", () => {
    expect(popoutTitle("", "file:///tmp/my%20doc/report.html")).toBe("report.html");
    expect(popoutTitle("", "")).toBe("Preview");
  });
});

describe("return affordances (Taskana 4778)", () => {
  it("the menu template has one Return to AnyCode item that calls the handler", () => {
    const onReturn = vi.fn();
    const [item] = returnMenuTemplate(onReturn);
    expect(item!.label).toBe(RETURN_LABEL);
    item!.click();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
  it("only Cmd/Ctrl+Shift+D keyDown is the shortcut", () => {
    const base = { type: "keyDown", key: "d", shift: true, meta: false, control: true };
    expect(isReturnShortcut(base)).toBe(true);
    expect(isReturnShortcut({ ...base, shift: false })).toBe(false);
    expect(isReturnShortcut({ ...base, control: false })).toBe(false);
    expect(isReturnShortcut({ ...base, type: "keyUp" })).toBe(false);
  });
});

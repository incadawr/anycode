import { describe, expect, it } from "vitest";
import { ctxPopoverShouldPreserveFocus } from "./Composer.js";

describe("context popover focus", () => {
  it("preserves focus on non-interactive content while allowing interactive controls", () => {
    expect(ctxPopoverShouldPreserveFocus(false)).toBe(true);
    expect(ctxPopoverShouldPreserveFocus(true)).toBe(false);
  });
});

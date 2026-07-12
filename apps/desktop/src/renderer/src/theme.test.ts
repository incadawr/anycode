/**
 * Pure-logic test for theme.ts's `resolveTheme` (design
 * ui-redesign-direction.md §2.5). `.test.ts`-only, same rationale as every
 * other renderer test in this package: no jsdom in the vitest config, so only
 * the exported pure function — the one carrying the actual truth table — is
 * exercised here. `applyThemePreference`/`useResolvedTheme` (which touch
 * `window`/`document`/`matchMedia`) are not covered by this pure suite.
 */
import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme.js";

describe("resolveTheme (§2.5 truth table)", () => {
  it("resolves system + OS-dark → dark", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("resolves system + OS-light → light", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("passes explicit light through regardless of the OS flag", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("passes explicit dark through regardless of the OS flag", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

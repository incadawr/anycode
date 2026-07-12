/**
 * Pure-logic tests for WindowControls' branching (design/ui-track
 * custom-titlebar §4/§5). Deliberately `.test.ts`, not `.test.tsx`: this
 * package's vitest config runs `environment: "node"` with no jsdom, so the
 * component itself can't be rendered — `maximizeRestoreLabel` and
 * `windowControlMethod` carry all of its branching (maximize↔restore flip,
 * kind→API-method mapping) and are covered directly instead, same discipline
 * as Sidebar.tsx's `buildSidebarGroups`/`formatAge`.
 */
import { describe, expect, it } from "vitest";
import { maximizeRestoreLabel, windowControlMethod } from "./WindowControls.js";

describe("maximizeRestoreLabel", () => {
  it("labels the button 'Maximize' when the window is not maximized", () => {
    expect(maximizeRestoreLabel(false)).toBe("Maximize");
  });

  it("flips to 'Restore' once the window is maximized", () => {
    expect(maximizeRestoreLabel(true)).toBe("Restore");
  });
});

describe("windowControlMethod", () => {
  it("maps 'minimize' to the minimize() method", () => {
    expect(windowControlMethod("minimize")).toBe("minimize");
  });

  it("maps 'maximize' to the toggleMaximize() method (single button, both directions)", () => {
    expect(windowControlMethod("maximize")).toBe("toggleMaximize");
  });

  it("maps 'close' to the close() method", () => {
    expect(windowControlMethod("close")).toBe("close");
  });
});

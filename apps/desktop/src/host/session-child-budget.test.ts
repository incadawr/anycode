import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "@anycode/core";
import { applySessionChildToolBudget, sessionChildCeiling, sessionContextWindow } from "./session-child-budget.js";

describe("session child budgets", () => {
  it("caps the context at boot and after a model change while preserving smaller windows and root settings", () => {
    expect(sessionContextWindow(true, 1_000_000)).toBe(1_000_000);
    expect(sessionContextWindow(true, 200_000, 128_000)).toBe(128_000);
    expect(sessionContextWindow(true, 64_000)).toBe(64_000);
    expect(sessionContextWindow(false, 1_000_000)).toBe(1_000_000);
  });
  it("limits Bash results only in the child registry and disables its extensions", () => {
    const root = createDefaultToolRegistry();
    const child = createDefaultToolRegistry();
    const rootBudget = root.get("Bash")!.metadata.resultBudget?.maxModelBytes;
    applySessionChildToolBudget(false, root);
    applySessionChildToolBudget(true, child);
    for (const name of ["Bash", "BashOutput"]) {
      if (child.get(name)) expect(child.get(name)!.metadata.resultBudget?.maxModelBytes).toBe(10_000);
    }
    expect(root.get("Bash")!.metadata.resultBudget?.maxModelBytes).toBe(rootBudget);
    expect(sessionChildCeiling(true)).toEqual({ enabled: false });
    expect(sessionChildCeiling(false)).toBeUndefined();
  });
});

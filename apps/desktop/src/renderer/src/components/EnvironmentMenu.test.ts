import { describe, expect, it } from "vitest";
import { workspaceLabel } from "./EnvironmentMenu.js";

describe("workspaceLabel", () => {
  it("returns the path unchanged when it fits within maxChars", () => {
    const main = "/Users/incadawr/projects/tools/anycode";
    expect(main.length).toBeLessThanOrEqual(44);
    expect(workspaceLabel(main)).toBe(main);
  });

  it("head-ellipsizes a worktree path, preserving the distinguishing tail", () => {
    const worktree = "/Users/incadawr/projects/tools/anycode/.anycode/worktrees/orch-4108";
    const label = workspaceLabel(worktree);
    expect(label.startsWith("…")).toBe(true);
    expect(label.endsWith("worktrees/orch-4108")).toBe(true);
    expect(label).not.toBe(workspaceLabel("/Users/incadawr/projects/tools/anycode"));
  });

  it("preserves the tail for Windows-style separators", () => {
    const win = "C:\\Users\\someone\\projects\\tools\\proj\\.anycode\\worktrees\\orch-1";
    const label = workspaceLabel(win);
    expect(label.endsWith("proj/.anycode/worktrees/orch-1")).toBe(true);
    expect(label.startsWith("…")).toBe(true);
  });

  it("short/root paths survive untouched", () => {
    expect(workspaceLabel("/solo")).toBe("/solo");
    expect(workspaceLabel("/")).toBe("/");
    expect(workspaceLabel("C:\\")).toBe("C:\\");
    expect(workspaceLabel("")).toBe("");
  });

  it("degrades to an ellipsis + raw tail slice when the tail alone exceeds maxChars (never empty)", () => {
    const huge = `/repo/${"x".repeat(80)}/final-segment-of-great-length`;
    const label = workspaceLabel(huge, 20);
    expect(label.startsWith("…")).toBe(true);
    expect(label.length).toBeGreaterThan(1);
    expect(label.length).toBeLessThanOrEqual(20);
    // The raw-tail degradation still ends with the path's own bytes.
    expect(huge.endsWith(label.slice(1))).toBe(true);
  });
});

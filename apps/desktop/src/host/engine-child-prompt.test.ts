import { describe, expect, it } from "vitest";
import { engineChildPrompt } from "./engine-child-prompt.js";

describe("engine child prompt", () => {
  it("adds delegation guidance only without an Agent bridge", () => {
    const sentence = "Delegation (subagents) is unavailable in this child; do the work with your current tools and report any unmet need to your parent.";
    expect(engineChildPrompt("task", false)).toBe(`${sentence}\n\ntask`);
    expect(engineChildPrompt("task", true)).toBe("task");
  });
});

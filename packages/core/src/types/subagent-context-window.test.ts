import { describe, expect, it } from "vitest";
import { subagentContextWindow } from "./config.js";
describe("subagent context window", () => {
  it("defaults to the model window and applies an upper bound", () => {
    expect(subagentContextWindow(200_000)).toBe(200_000);
    expect(subagentContextWindow(undefined)).toBe(200_000);
    expect(subagentContextWindow(200_000, 100_000)).toBe(100_000);
    expect(subagentContextWindow(64_000, 100_000)).toBe(64_000);
  });
});

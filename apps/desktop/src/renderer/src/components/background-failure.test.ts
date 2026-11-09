import { describe, expect, it } from "vitest";
import { failureLine, failureSummary } from "./background-failure.js";

describe("failureSummary", () => {
  it("takes the last paragraph of a multi-paragraph report and drops the Agent prefix", () => {
    const reason =
      "Worktree unknown: /tmp/wt\nBranch: work/x\nkept for review\n\nAgent: the child session host exited before completing.";
    expect(failureSummary(reason)).toBe("The child session host exited before completing.");
  });

  it("uses a single-line reason as is, capitalised", () => {
    expect(failureSummary("host failed to initialize: timeout")).toBe("Host failed to initialize: timeout");
  });

  it("is empty for a missing or blank reason", () => {
    expect(failureSummary(undefined)).toBe("");
    expect(failureSummary("")).toBe("");
    expect(failureSummary(" \n\n  \n")).toBe("");
  });

  it("removes a leading Agent prefix from a single line and joins a multi-line last paragraph", () => {
    expect(failureSummary("Agent: boom")).toBe("Boom");
    expect(failureSummary("head\n\nline one\nline two")).toBe("Line one line two");
  });
});

describe("failureLine", () => {
  it("keeps a Failed word with the cause, or alone when there is none", () => {
    expect(failureLine("Worktree unknown: /tmp/wt\n\nAgent: the child session host exited before completing.")).toBe(
      "Failed: The child session host exited before completing.",
    );
    expect(failureLine("")).toBe("Failed");
    expect(failureLine(undefined)).toBe("Failed");
  });
});

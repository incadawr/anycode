import { describe, expect, it } from "vitest";
import {
  backgroundElapsed,
  backgroundHeading,
  backgroundProgressText,
  backgroundWaitingText,
} from "./BackgroundAgents.js";

describe("BackgroundAgents helpers", () => {
  it("elapsed shows seconds under the minutes, then hours", () => {
    expect(backgroundElapsed(0, 45_000)).toBe("45s");
    expect(backgroundElapsed(0, 3 * 60_000 + 5_000)).toBe("3m 05s");
    expect(backgroundElapsed(0, 125 * 60_000)).toBe("2h 05m");
    expect(backgroundElapsed(10_000, 0)).toBe("0s");
  });

  it("heading counts the agents", () => {
    expect(backgroundHeading(1)).toBe("1 background agent running");
    expect(backgroundHeading(3)).toBe("3 background agents running");
  });
});

/**
 * GitHub #17 slice E: the strip shows actual counters and the
 * current tool when the child reported them, and nothing at all when it did
 * not — a Codex child that reports no turns must not display "turn 0".
 */
describe("BackgroundAgents progress helpers (GitHub #17 slice E)", () => {
  it("formats only the counters the child actually reported", () => {
    expect(backgroundProgressText({})).toBe("");
    expect(backgroundProgressText({ turns: 3 })).toBe("turn 3");
    expect(backgroundProgressText({ toolCalls: 1 })).toBe("1 tool");
    expect(backgroundProgressText({ toolCalls: 5 })).toBe("5 tools");
    expect(backgroundProgressText({ lastTool: "Write" })).toBe("Write");
    expect(backgroundProgressText({ turns: 2, toolCalls: 2, lastTool: "Bash" })).toBe("turn 2 · 2 tools · Bash");
  });

  it("shows the waiting line only while an ask is pending", () => {
    expect(backgroundWaitingText({})).toBeNull();
    expect(backgroundWaitingText({ waitingForApproval: false })).toBeNull();
    expect(backgroundWaitingText({ waitingForApproval: true })).toBe("Waiting for permission");
  });
});

import { describe, expect, it } from "vitest";
import {
  backgroundElapsed,
  backgroundHeading,
  backgroundProgressText,
  backgroundWaitingText,
  isFailedBackgroundChild,
} from "./BackgroundAgents.js";

describe("BackgroundAgents helpers", () => {
  it("elapsed shows seconds under the minutes, then hours", () => {
    expect(backgroundElapsed(0, 45_000)).toBe("45s");
    expect(backgroundElapsed(0, 3 * 60_000 + 5_000)).toBe("3m 05s");
    expect(backgroundElapsed(0, 125 * 60_000)).toBe("2h 05m");
    expect(backgroundElapsed(10_000, 0)).toBe("0s");
  });

  it("elapsed of a failed row uses its frozen end time, not the clock", () => {
    expect(backgroundElapsed(0, 10 * 60_000, 90_000)).toBe("1m 30s");
    expect(backgroundElapsed(5_000, 0, 1_000)).toBe("0s");
  });

  it("heading covers running-only, failed-only and mixed counts", () => {
    expect(backgroundHeading(0, 1)).toBe("1 background agent failed");
    expect(backgroundHeading(0, 3)).toBe("3 background agents failed");
    expect(backgroundHeading(1, 1)).toBe("1 running · 1 failed");
    expect(backgroundHeading(2, 1)).toBe("2 running · 1 failed");
    expect(backgroundHeading(2, 0)).toBe("2 background agents running");
  });

  it("classifies a row by end time or failure reason, even an empty reason", () => {
    expect(isFailedBackgroundChild({})).toBe(false);
    expect(isFailedBackgroundChild({ endedAt: 5 })).toBe(true);
    expect(isFailedBackgroundChild({ failureReason: "" })).toBe(true);
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

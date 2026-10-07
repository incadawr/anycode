import { describe, expect, it } from "vitest";
import { backgroundElapsed, backgroundHeading } from "./BackgroundAgents.js";

describe("BackgroundAgents helpers", () => {
  it("elapsed is coarse: seconds, then minutes, then hours", () => {
    expect(backgroundElapsed(0, 45_000)).toBe("45s");
    expect(backgroundElapsed(0, 3 * 60_000 + 5_000)).toBe("3m");
    expect(backgroundElapsed(0, 125 * 60_000)).toBe("2h 5m");
    expect(backgroundElapsed(10_000, 0)).toBe("0s");
  });

  it("heading counts the agents", () => {
    expect(backgroundHeading(1)).toBe("1 background agent running");
    expect(backgroundHeading(3)).toBe("3 background agents running");
  });
});

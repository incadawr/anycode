import { describe, expect, it } from "vitest";
import { countRunningBackgroundChildren, isFailedBackgroundChild } from "./background-children.js";

describe("background-children", () => {
  it("counts rows without endedAt/failureReason", () => {
    expect(countRunningBackgroundChildren([])).toBe(0);
    expect(
      countRunningBackgroundChildren([{}, { endedAt: 5 }, { failureReason: "" }, { endedAt: undefined }]),
    ).toBe(2);
  });

  it("flags ended or failed rows", () => {
    expect(isFailedBackgroundChild({})).toBe(false);
    expect(isFailedBackgroundChild({ endedAt: 5 })).toBe(true);
    expect(isFailedBackgroundChild({ failureReason: "" })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  it("counts an empty string as zero", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("charges roughly a third of a token per ASCII character", () => {
    expect(estimateTokens("hello world")).toBe(4); // ceil(11 / 3)
  });

  it("charges CJK characters six times more than ASCII ones", () => {
    // 3 ideographs weigh 2 each => ceil(6/3) = 2, versus ceil(3/3) = 1 for ASCII.
    expect(estimateTokens("日本語")).toBe(2);
    expect(estimateTokens("abc")).toBe(1);
  });

  it("mixes both weights in one string", () => {
    // 3 ideographs (6) + 3 ASCII (3) = 9 / 3 = 3.
    expect(estimateTokens("日本語abc")).toBe(3);
  });

  it("grows with length rather than saturating", () => {
    expect(estimateTokens("x".repeat(30_000))).toBe(10_000);
  });
});

import { describe, expect, it } from "vitest";
import { formatBlockTime } from "./block-time.js";

const now = new Date(2026, 9, 10, 15, 30, 0).getTime();

describe("formatBlockTime", () => {
  it("shows HH:MM for today", () => {
    const r = formatBlockTime(new Date(2026, 9, 10, 9, 41, 7).getTime(), now);
    expect(r?.label).toBe("09:41");
    expect(r?.title).toContain("09:41:07");
  });
  it("adds a short date for yesterday", () => {
    expect(formatBlockTime(new Date(2026, 9, 9, 9, 41).getTime(), now)?.label).toBe("Oct 9, 09:41");
  });
  it("adds the year when it differs", () => {
    expect(formatBlockTime(new Date(2025, 9, 9, 9, 41).getTime(), now)?.label).toBe("Oct 9, 2025, 09:41");
  });
  it("renders nothing for a missing value", () => {
    expect(formatBlockTime(undefined, now)).toBeNull();
    expect(formatBlockTime(null, now)).toBeNull();
    expect(formatBlockTime(Number.NaN, now)).toBeNull();
  });
});

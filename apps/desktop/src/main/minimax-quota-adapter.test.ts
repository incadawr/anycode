import { describe, expect, it } from "vitest";
import { parseMiniMaxQuota } from "./minimax-quota-adapter.js";

describe("MiniMax subscription quota", () => {
  const now = 1_800_000_000_000;
  const response = (row: object) => ({ base_resp: { status_code: 0 }, model_remains: [row] });
  it("uses percentages even when counts are zero", () => {
    expect(parseMiniMaxQuota(response({ current_interval_remaining_percent: 88, current_weekly_remaining_percent: 40, current_interval_total_count: 0, current_interval_usage_count: 0, end_time: now + 60_000, weekly_end_time: now + 120_000 }), now)).toEqual({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now / 1000 + 60 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: now / 1000 + 120 }, primarySource: "minimax-token-plan", sources: ["minimax-token-plan"] });
  });
  it("ignores pay as you go, malformed responses and unusable percentages", () => {
    for (const raw of [null, {}, { base_resp: { status_code: 1004 } }, response({ current_interval_total_count: 0 }), response({ current_interval_remaining_percent: 101 }), response({ current_interval_remaining_percent: -1 }), response({ current_interval_remaining_percent: NaN }), { ...response({ current_interval_remaining_percent: 2 }), model_remains: [{}, {}] }]) expect(parseMiniMaxQuota(raw, now)).toBeNull();
  });
  it("omits implausible reset times", () => {
    expect(parseMiniMaxQuota(response({ current_interval_remaining_percent: 0, end_time: now / 1000 }), now)?.primary).toEqual({ usedPercent: 100, windowDurationMins: 300 });
  });
});

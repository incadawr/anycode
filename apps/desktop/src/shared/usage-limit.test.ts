import { describe, expect, it } from "vitest";
import { parseUsageLimitNotice } from "./usage-limit.js";

describe("parseUsageLimitNotice", () => {
  it("parses the z.ai 1308 quota shape, interpreting the timestamp as Asia/Shanghai (UTC+8)", () => {
    const notice = parseUsageLimitNotice(
      "[1308] Usage limit reached. Your limit will reset at 2026-07-12 19:07:09",
    );
    // 19:07 CST == 11:07 UTC.
    expect(notice).toEqual({ kind: "usage_limit", code: 1308, resetAt: Date.UTC(2026, 6, 12, 11, 7, 9) });
  });

  it("returns null for a non-1308 code or a message without a reset timestamp", () => {
    expect(parseUsageLimitNotice("[1210] bad max_tokens")).toBeNull();
    expect(parseUsageLimitNotice("[1308] Usage limit reached")).toBeNull();
    expect(parseUsageLimitNotice("plain provider failure")).toBeNull();
  });
});

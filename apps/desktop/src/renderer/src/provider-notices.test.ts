import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatUsageLimitReset,
  loadUsageLimitNotices,
  parseUsageLimitNotice,
  saveUsageLimitNotice,
} from "./provider-notices.js";

afterEach(() => vi.unstubAllGlobals());

describe("parseUsageLimitNotice", () => {
  it("recognizes Z.AI 1308 and interprets its timezone-less reset clock as Asia/Shanghai", () => {
    const notice = parseUsageLimitNotice({
      name: "AI_APICallError",
      message: "[1308][Usage limit reached for 5 hour. Your limit will reset at 2026-07-12 19:07:09][trace]",
    });
    expect(notice).toEqual({
      kind: "usage_limit",
      code: 1308,
      resetAt: Date.UTC(2026, 6, 12, 11, 7, 9),
    });
  });

  it("leaves unknown/provider-malformed failures on the generic error path", () => {
    expect(parseUsageLimitNotice({ name: "AI_APICallError", message: "[1210] bad max_tokens" })).toBeNull();
    expect(parseUsageLimitNotice({ name: "AI_APICallError", message: "[1308] Usage limit reached" })).toBeNull();
  });
});

describe("formatUsageLimitReset", () => {
  it("formats a valid local timestamp into a non-empty local-time label", () => {
    expect(formatUsageLimitReset(new Date(2026, 6, 12, 19, 7, 9).getTime())).toBeTruthy();
  });
});

describe("usage-limit local log", () => {
  it("persists a quota notice under its session id without touching agent history", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const notice = { kind: "usage_limit" as const, code: 1308, resetAt: 123_456 };

    saveUsageLimitNotice("session-a", notice);

    expect(loadUsageLimitNotices("session-a")).toEqual([notice]);
    expect(loadUsageLimitNotices("session-b")).toEqual([]);
  });
});

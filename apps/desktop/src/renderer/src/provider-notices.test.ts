import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatUsageLimitReset,
  loadUsageLimitNotices,
  saveUsageLimitNotice,
} from "./provider-notices.js";

afterEach(() => vi.unstubAllGlobals());

// parseUsageLimitNotice moved to shared/usage-limit.ts (host parses the raw
// message at the wire boundary; the renderer reads the numeric notice). Its
// parse coverage lives in shared/usage-limit.test.ts (W7b-FIX #2).

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

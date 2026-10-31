import { describe, expect, it } from "vitest";
import {
  parseCodexUsageLimitNotice,
  parseUsageLimitNotice,
  parseUsageLimitNoticeForEngine,
} from "./usage-limit.js";

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

describe("parseCodexUsageLimitNotice", () => {
  it("recognises the app-server's structured usageLimitExceeded code", () => {
    const notice = parseCodexUsageLimitNotice("turn failed: usageLimitExceeded");
    expect(notice).toEqual({ kind: "usage_limit", code: 429, engine: "codex" });
  });

  it("recognises usage_limit_exceeded and the CLI's human sentence", () => {
    expect(parseCodexUsageLimitNotice("usage_limit_exceeded: 429 Too Many Requests")).toMatchObject({
      kind: "usage_limit",
      engine: "codex",
    });
    expect(parseCodexUsageLimitNotice("You've hit your usage limit. Upgrade to continue.")).toMatchObject({
      kind: "usage_limit",
      engine: "codex",
    });
  });

  it("carries a reset time when the message has one", () => {
    const notice = parseCodexUsageLimitNotice(
      "You've hit your usage limit. Try again at 2026-10-31T09:15:00Z",
    );
    expect(notice).toEqual({
      kind: "usage_limit",
      code: 429,
      engine: "codex",
      resetAt: Date.parse("2026-10-31T09:15:00Z"),
    });
  });

  it("reads the app-server's epoch-seconds reset", () => {
    const notice = parseCodexUsageLimitNotice('usage_limit_exceeded {"resetsAt":1783853597}');
    expect(notice?.resetAt).toBe(1_783_853_597_000);
  });

  it("leaves resetAt absent when there is no time, and returns null for unrelated failures", () => {
    const notice = parseCodexUsageLimitNotice("usage limit exceeded");
    expect(notice).not.toBeNull();
    expect(notice).not.toHaveProperty("resetAt");
    expect(parseCodexUsageLimitNotice("stream disconnected before completion")).toBeNull();
  });
});

describe("parseUsageLimitNoticeForEngine", () => {
  it("recognises the Codex spelling only for the codex engine", () => {
    const message = "usage_limit_exceeded";
    expect(parseUsageLimitNoticeForEngine(message, "codex")).toMatchObject({ engine: "codex" });
    expect(parseUsageLimitNoticeForEngine(message, "claude")).toBeNull();
    expect(parseUsageLimitNoticeForEngine(message, "core")).toBeNull();
    expect(parseUsageLimitNoticeForEngine(message)).toBeNull();
  });

  it("keeps the Z.AI shape engine-agnostic", () => {
    const message = "[1308] Usage limit reached. Your limit will reset at 2026-07-12 19:07:09";
    expect(parseUsageLimitNoticeForEngine(message, "core")).toMatchObject({ code: 1308 });
  });
});

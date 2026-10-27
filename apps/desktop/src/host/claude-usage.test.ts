import { describe, expect, it } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import type { ClaudeResultMessage } from "./engines/claude/protocol.js";
import { claudeNativeChildRecord, claudeNativeChildrenFromHistory, claudeUsageRecord } from "./claude-usage.js";
import { summarizeProviderUsage } from "./session.js";

const result = (usage: Record<string, unknown>, cost = 0.25): ClaudeResultMessage => ({
  type: "result", subtype: "success", is_error: false, num_turns: 1,
  duration_ms: 1, duration_api_ms: 1, total_cost_usd: cost, usage,
});

describe("Claude cost snapshots", () => {
  it("counts cache writes only when present and persists native cost", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "claude", workspace: "/w", model: "m", mode: "build" });
    const row = claudeUsageRecord(result({ input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }), "turn", "m");
    expect(row).toMatchObject({ inputTokens: 30, cachedInputTokens: 20, outputTokens: 5, totalTokens: 35, costUsd: 0.25, priceBasisId: "claude-cli-reported" });
    expect(row.cacheWriteTokens).toBeUndefined();
    await db.recordProviderUsage({ ...row, sessionId: "claude", createdAt: 1 });
    const summary = summarizeProviderUsage(await db.listProviderUsage("claude"));
    expect(summary.totals).toMatchObject({ input: 30, output: 5, total: 35, costUsd: 0.25, unknownSavingsSteps: 1 });
    await db.close();
  });

  it("adds reported writes, but leaves totals unknown for malformed or unreported cache reads", () => {
    expect(claudeUsageRecord(result({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 5 }), "t", "m"))
      .toMatchObject({ inputTokens: 33, cacheWriteTokens: 3, totalTokens: 38 });
    expect(claudeUsageRecord(result({ input_tokens: 10, output_tokens: 5 }), "t", "m").inputTokens).toBeUndefined();
    expect(claudeUsageRecord(result({ input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: -1, output_tokens: 5 }), "t", "m").inputTokens).toBeUndefined();
    expect(claudeUsageRecord(result({}, Number.NaN), "t", "m").costUsd).toBeUndefined();
  });
});

describe("native Claude child history", () => {
  it("recovers identities without inventing costs and deduplicates with live markers", async () => {
    const history = [
      { id: "1", createdAt: 1, message: { role: "assistant" as const, content: [{ type: "tool_call" as const, toolCallId: "a", toolName: "Agent", input: {} }] } },
      { id: "2", createdAt: 2, message: { role: "assistant" as const, content: [{ type: "tool_call" as const, toolCallId: "b", toolName: "Task", input: {} }, { type: "tool_call" as const, toolCallId: "bridge", toolName: "mcp__anycode__agent", input: {} }] } },
      { id: "3", createdAt: 3, message: { role: "assistant" as const, content: [{ type: "tool_call" as const, toolCallId: "a", toolName: "Agent", input: {} }] } },
    ];
    const malformed = [null, {}, { message: { role: "assistant", content: null } }] as unknown as typeof history;
    const records = claudeNativeChildrenFromHistory([...malformed, ...history]);
    expect(records).toEqual([claudeNativeChildRecord("a"), claudeNativeChildRecord("b")]);
    expect(records.every((row) => row.costUsd === undefined)).toBe(true);
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "s", workspace: "/w", model: "m", mode: "build" });
    for (const row of [...records, claudeNativeChildRecord("a")]) await db.recordProviderUsage({ ...row, sessionId: "s", createdAt: 4 });
    expect(await db.listProviderUsage("s")).toHaveLength(2);
    await db.close();
  });
});

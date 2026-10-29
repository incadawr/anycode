import { describe, expect, it } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { summarizeWithChildren } from "./usage-summary.js";

describe("session and child cost rollup", () => {
  it("adds an inline model's recorded price once", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    try {
      await db.createSession({ id: "root", workspace: "/w", model: "a", mode: "build" });
      await db.recordProviderUsage({ sessionId: "root", turnId: "own", step: 1, createdAt: 1, model: "a", costUsd: .003, priceBasisId: "model:a", finishReason: "stop", transportRetries: 0 });
      await db.recordProviderUsage({ sessionId: "root", turnId: "child", step: 1, createdAt: 2, model: "b", subagentId: "child", costUsd: .007, priceBasisId: "model:b", finishReason: "stop", transportRetries: 0 });
      const summary = await summarizeWithChildren(db, "root");
      expect(summary.totals).toMatchObject({ costUsd: .003, subagentCostUsd: .007, subagentCount: 1 });
      expect((summary.totals?.costUsd ?? 0) + (summary.totals?.subagentCostUsd ?? 0)).toBeCloseTo(.01);
    } finally { await db.close(); }
  });
  it("preserves unknown Claude native-child cost without adding it twice", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "root", workspace: "/w", model: "m", mode: "build" });
    await db.recordProviderUsage({ sessionId: "root", turnId: "own", step: 1, createdAt: 1, costUsd: 0.5, finishReason: "result", transportRetries: 0 });
    await db.recordProviderUsage({ sessionId: "root", turnId: "native", step: 1, createdAt: 2, subagentId: "native", priceBasisId: "claude-native-unattributed", finishReason: "unknown", transportRetries: 0 });
    const summary = await summarizeWithChildren(db, "root");
    expect(summary.totals).toMatchObject({ costUsd: 0.5, subagentCount: 1, subagentUnpriced: 1, subagentIncludedInReportedCost: true });
    expect(summary.totals?.subagentCostUsd).toBeUndefined();
    await db.close();
  });

  it("marks a session child with only inline descendant records as unpriced", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "root", workspace: "/w", model: "m", mode: "build" });
    await db.createSession({ id: "child", workspace: "/w", model: "m", mode: "build", parentSessionId: "root", spawnToolCallId: "call" });
    await db.recordProviderUsage({ sessionId: "child", turnId: "inline", step: 1, createdAt: 1, subagentId: "inline", costUsd: 0.5, finishReason: "stop", transportRetries: 0 });
    const summary = await summarizeWithChildren(db, "root");
    expect(summary.totals).toMatchObject({ subagentCount: 2, subagentCostUsd: 0.5, subagentUnpriced: 1 });
    await db.close();
  });

  it("separates inline and durable descendants, subscriptions, and missing history", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "root", workspace: "/w", model: "m", mode: "build" });
    await db.createSession({ id: "child", workspace: "/w", model: "m", mode: "build", parentSessionId: "root", spawnToolCallId: "call" });
    await db.createSession({ id: "empty", workspace: "/w", model: "m", mode: "build", parentSessionId: "child", spawnToolCallId: "call2" });
    const record = (sessionId: string, turnId: string, extra: Record<string, unknown>) => db.recordProviderUsage({ sessionId, turnId, step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0, ...extra });
    await record("root", "own", { costUsd: 1, cacheSavingsUsd: 0.1 });
    await record("root", "inline", { subagentId: "inline", costUsd: 0.3 });
    await record("child", "child-turn", { priceBasisId: "subscription" });
    const summary = await summarizeWithChildren(db, "root");
    expect(summary.steps.map((row) => row.turnId)).toEqual(["own"]);
    expect(summary.totals).toMatchObject({ costUsd: 1, subagentCount: 3, subagentCostUsd: 0.3, subagentUnpriced: 1, subagentSubscription: 1 });
    await db.close();
  });
});

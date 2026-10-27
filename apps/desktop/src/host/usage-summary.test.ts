import { describe, expect, it } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { summarizeWithChildren } from "./usage-summary.js";

describe("session and child cost rollup", () => {
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

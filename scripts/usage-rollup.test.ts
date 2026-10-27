import { describe, expect, it } from "vitest";
import { SqlitePersistenceAdapter } from "../packages/core/src/adapters/node/sqlite-persistence.js";
import { summarizeWithChildren } from "../apps/desktop/src/host/usage-summary.js";
import { formatUsageCostLedger } from "../apps/desktop/src/renderer/src/components/Composer.js";

describe("session cost presentation", () => {
  it("reports unknown parent usage alongside a priced child", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "root", workspace: "/w", model: "m", mode: "build" });
    await db.recordProviderUsage({ sessionId: "root", turnId: "own", step: 1, createdAt: 1, finishReason: "stop", transportRetries: 0 });
    await db.recordProviderUsage({ sessionId: "root", turnId: "child", step: 1, createdAt: 2, subagentId: "child", costUsd: 1, finishReason: "stop", transportRetries: 0 });
    const summary = await summarizeWithChildren(db, "root");
    expect(formatUsageCostLedger(summary.totals, null).total).toContain("≥ $1.0000 · some steps price unknown");
    await db.close();
  });

 });

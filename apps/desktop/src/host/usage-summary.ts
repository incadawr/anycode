import type { SqlitePersistenceAdapter } from "@anycode/core";
import { summarizeProviderUsage } from "./session.js";

export async function summarizeWithChildren(persistence: SqlitePersistenceAdapter, sessionId: string) {
  const rootRows = await persistence.listProviderUsage(sessionId);
  const own = summarizeProviderUsage(rootRows.filter((row) => row.subagentId === undefined));
  const childRows = rootRows.filter((row) => row.subagentId !== undefined);
  const inlineIds = new Set(childRows.map((row) => row.subagentId));
  const pending = await persistence.listChildSessions(sessionId);
  const seen = new Set([sessionId]);
  let emptyChildren = 0;
  while (pending.length > 0) {
    const child = pending.shift()!;
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const rows = await persistence.listProviderUsage(child.id);
    // Inline descendants do not account for the session child's own usage.
    if (!rows.some((row) => row.subagentId === undefined)) emptyChildren++;
    childRows.push(...rows);
    for (const row of rows) if (row.subagentId !== undefined) inlineIds.add(`${child.id}:${row.subagentId}`);
    pending.push(...await persistence.listChildSessions(child.id));
  }
  const count = seen.size - 1 + inlineIds.size;
  if (count > 0) {
    const priced = childRows.filter((row) => row.costUsd !== undefined);
    own.totals ??= { input: 0, output: 0, total: 0, stepsReported: 0, stepsWithCache: 0 };
    own.totals.subagentCount = count;
    if (childRows.some((row) => row.priceBasisId === "claude-native-unattributed")) own.totals.subagentIncludedInReportedCost = true;
    own.totals.subagentSubscription = childRows.filter((row) => row.priceBasisId === "subscription").length;
    own.totals.subagentUnpriced = emptyChildren + childRows.length - priced.length - own.totals.subagentSubscription;
    if (priced.length > 0) {
      own.totals.subagentCostUsd = priced.reduce((sum, row) => sum + row.costUsd!, 0);
      own.totals.priceBasisIds = [...new Set([...(own.totals.priceBasisIds ?? []), ...priced.flatMap((row) => row.priceBasisId === undefined ? [] : [row.priceBasisId])])];
    }
  }
  return own;
}

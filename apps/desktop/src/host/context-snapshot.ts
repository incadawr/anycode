import type { SqlitePersistenceAdapter } from "@anycode/core";

export type ContextReading = { estimatedTokens: number; budgetTokens: number; source: "provider" | "estimate" };
type Snapshot = ContextReading & { engine: string; model: string };

/** Restore only a well-formed reading for the active engine and model. */
export function parseContextSnapshot(json: string | null, engine: string, model: string, budget?: number): ContextReading | undefined {
  if (json === null) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return undefined;
    const s = value as Partial<Snapshot>;
    if (s.engine !== engine || s.model !== model || typeof s.estimatedTokens !== "number" || !Number.isFinite(s.estimatedTokens) || s.estimatedTokens < 0 || typeof s.budgetTokens !== "number" || !Number.isFinite(s.budgetTokens) || s.budgetTokens <= 0 || (s.source !== "provider" && s.source !== "estimate")) return undefined;
    return { estimatedTokens: s.estimatedTokens, budgetTokens: budget ?? s.budgetTokens, source: s.source };
  } catch { return undefined; }
}

export async function contextSnapshotOptions(db: SqlitePersistenceAdapter, id: string, engine: string, model: string, budget?: number, fallback?: ContextReading) {
  let initialContextUsage: ContextReading | undefined;
  try { initialContextUsage = parseContextSnapshot(await db.loadContextUsage(id), engine, model, budget) ?? fallback; }
  catch (error) { console.error("[host] context usage read failed:", error); initialContextUsage = fallback; }
  return {
    ...(initialContextUsage ? { initialContextUsage } : {}),
    saveContextUsage: (snapshot: Snapshot | null) => db.saveContextUsage(id, snapshot === null ? null : JSON.stringify(snapshot)),
  };
}

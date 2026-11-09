import type { SessionActivitySnapshot, SessionActivityState } from "../shared/communication.js";

const states = new Set(["idle", "running", "waiting_approval", "waiting_network", "closing"]);
export function validateActivitySnapshot(value: unknown, expected?: SessionActivityState): SessionActivitySnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.state !== "string" || !states.has(v.state) || (expected && v.state !== expected)) return undefined;
  const result: SessionActivitySnapshot = { state: v.state as SessionActivityState };
  for (const key of ["turnStartedAt", "lastProviderActivityAt"] as const) {
    if (v[key] === null || (typeof v[key] === "number" && Number.isFinite(v[key]))) result[key] = v[key] as number | null;
  }
  if (v.networkWait && typeof v.networkWait === "object") {
    const n = v.networkWait as Record<string, unknown>;
    if ((n.source === "parent" || n.source === "subagent") &&
      (n.startedAt === undefined || (typeof n.startedAt === "number" && Number.isFinite(n.startedAt))) &&
      (n.deadlineAt === undefined || (typeof n.deadlineAt === "number" && Number.isFinite(n.deadlineAt))) &&
      (n.failureCode === undefined || (typeof n.failureCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(n.failureCode)))) {
      result.networkWait = { source: n.source, ...(n.startedAt !== undefined ? { startedAt: n.startedAt as number } : {}), ...(n.deadlineAt !== undefined ? { deadlineAt: n.deadlineAt as number } : {}), ...(n.failureCode !== undefined ? { failureCode: n.failureCode as string } : {}) };
    }
  }
  return result;
}

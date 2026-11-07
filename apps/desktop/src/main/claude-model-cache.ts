import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { ClaudeDoctorReport, ClaudeModelCache } from "../shared/claude-doctor.js";
import type { EngineModelChoice } from "../shared/protocol.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Called only after the binary trust gate succeeds; rechecked after initialize. */
export function claudeCliIdentity(path: string): string | undefined {
  try {
    const resolved = realpathSync(path);
    const stat = statSync(resolved);
    if (!stat.isFile()) return;
    return digest([resolved, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid, stat.gid]);
  } catch { return undefined; }
}
/** Raw account fields remain in main memory; no token or subscription participates. */
export function claudeCatalogKey(account: unknown, cli: string | undefined, version: string): string | undefined {
  if (!cli || !version || !account || typeof account !== "object") return;
  const a = account as Record<string, unknown>;
  const id = typeof a.accountUuid === "string" && a.accountUuid ? a.accountUuid : a.email;
  if (typeof id !== "string" || !id.trim()) return;
  const org = a.organization;
  // Unknown organization shapes cannot safely distinguish account bindings.
  if (org !== undefined && org !== null && typeof org !== "string") return;
  return digest(["claude-catalog-v1", id, org ?? "", cli, version]);
}
export function projectClaudeModels(raw: unknown, clean: (value: string) => string): EngineModelChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap(entry => {
    if (!entry || typeof entry.value !== "string" || !/^[\w.:[\]-]{1,200}$/.test(entry.value)) return [];
    if (clean(entry.value) !== entry.value) return [];
    const name = typeof entry.displayName === "string" ? entry.displayName : entry.value;
    const label = clean(name).slice(0, 256);
    const levels = entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels : [];
    const efforts = [...new Set<string>(levels.filter((v: unknown) =>
      ["low", "medium", "high", "xhigh", "max"].includes(v as string)))];
    return [{ id: entry.value, label, ...(efforts.length ? { efforts } : {}) }];
  });
}
export function selectClaudeCatalog(report: ClaudeDoctorReport, cached?: ClaudeModelCache): EngineModelChoice[] {
  if (report.status !== "ready" || !report.catalogIdentity || !/^[a-f0-9]{64}$/.test(report.catalogIdentity)) return [];
  if (report.models !== undefined) return report.models;
  return cached?.identity === report.catalogIdentity ? cached.models : [];
}

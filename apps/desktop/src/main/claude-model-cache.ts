import { join } from "node:path";
import { CLAUDE_EFFORT_LEVELS } from "../shared/claude-effort.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, statSync } from "node:fs";
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
/** Persist next to settings; missing/corrupt/unwritable profiles fail closed. */
export function loadClaudeCatalogSalt(directory: string): string | undefined {
  const path = join(directory, "claude-catalog.salt");
  try {
    try { writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return; }
    const salt = readFileSync(path, "utf8");
    return /^[a-f0-9]{64}$/.test(salt) ? salt : undefined;
  } catch { return undefined; }
}
/** Raw account fields remain in main memory; email requires a profile HMAC. */
export function claudeCatalogKey(account: unknown, cli: string | undefined, version: string, salt?: string): string | undefined {
  if (!cli || !version || !account || typeof account !== "object") return;
  const a = account as Record<string, unknown>;
  const uuid = typeof a.accountUuid === "string" && a.accountUuid ? a.accountUuid : undefined;
  const id = uuid ?? a.email;
  if (typeof id !== "string" || !id.trim()) return;
  const org = a.organization;
  // Unknown organization shapes cannot safely distinguish account bindings.
  if (org !== undefined && org !== null && typeof org !== "string") return;
  const tier = a.subscriptionType;
  if (tier !== undefined && typeof tier !== "string") return;
  const identity = ["claude-catalog-v2", id, org ?? "", cli, version, tier ?? ""];
  return uuid ? digest(identity) : salt ? createHmac("sha256", salt).update(JSON.stringify(identity)).digest("hex") : undefined;
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
      (CLAUDE_EFFORT_LEVELS as readonly unknown[]).includes(v)))];
    const resolvedId = typeof entry.resolvedModel === "string" && /^[\w.:[\]-]{1,200}$/.test(entry.resolvedModel)
      && clean(entry.resolvedModel) === entry.resolvedModel ? entry.resolvedModel : undefined;
    return [{ id: entry.value, label, ...(resolvedId ? { resolvedId } : {}), ...(efforts.length ? { efforts } : {}) }];
  });
}
export function selectClaudeCatalog(report: ClaudeDoctorReport, cached?: ClaudeModelCache): EngineModelChoice[] {
  if (report.status !== "ready" || !report.catalogIdentity || !/^[a-f0-9]{64}$/.test(report.catalogIdentity)) return [];
  if (report.models !== undefined) return report.models;
  return cached?.identity === report.catalogIdentity ? cached.models : [];
}

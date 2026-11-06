import { createHash } from "node:crypto";
import { runtimeNativeBaseSchema, type RuntimeNativeBase } from "@anycode/core";

/** Stable fingerprints cover resolved inputs without retaining their secrets or paths. */
export function nativeConfigDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input !== null && typeof input === "object"
      ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function claudeMcpDigest(forward?: { claudeJson?: string | null; claudeNames?: readonly string[]; claudeConfigPath?: string | null;
  loaderProblems?: readonly unknown[]; forwardProblems?: readonly unknown[] }): string {
  if (!forward || forward.claudeJson === undefined || !forward.claudeNames || !forward.loaderProblems || !forward.forwardProblems
    || forward.loaderProblems.length || forward.forwardProblems.length) throw new Error("Claude MCP base is incomplete");
  let config: { mcpServers: Record<string, unknown> };
  try { config = JSON.parse(forward.claudeJson ?? '{"mcpServers":{}}'); } catch { throw new Error("Claude MCP base is invalid"); }
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Claude MCP base is invalid");
  const names = Object.keys(servers).sort();
  if (JSON.stringify(names) !== JSON.stringify([...forward.claudeNames].sort()) || (names.length > 0 && !forward.claudeConfigPath)) throw new Error("Claude MCP server set is incomplete");
  return nativeConfigDigest({ servers, names });
}
/** Parsing also returns a detached copy, so a caller cannot mutate the engine's captured base. */
export function checkedNativeBase(value: unknown, engine: "claude" | "codex"): RuntimeNativeBase {
  const base = runtimeNativeBaseSchema.parse(value);
  if (base.engine !== engine) throw new Error("Native base engine mismatch");
  return base;
}

export interface NativeRecovery { nativeBase?: unknown }
/** Unknown/legacy metadata can request OFF recovery, but cannot supply authority. */
export function recoveryNativeBase(recovery: NativeRecovery | undefined, engine: "claude" | "codex"): RuntimeNativeBase | undefined {
  if (!recovery) return undefined;
  try { return checkedNativeBase(recovery.nativeBase, engine); } catch { return undefined; }
}
export function savedNativeRecovery(segment?: { selected: { orchestration?: { enabled: true } }; applied: { orchestration?: { enabled: true; nativeBase?: unknown } } }): NativeRecovery | undefined {
  return segment?.selected.orchestration?.enabled || segment?.applied.orchestration?.enabled
    ? { nativeBase: segment.applied.orchestration?.nativeBase } : undefined;
}

import { z } from "zod";
import type { ToolDefinition } from "../types/tools.js";

export interface ConnectionTarget {
  id: string;
  label?: string;
  providerId: string;
  transport?: string;
  readiness: string;
  models: { id: string; imageInput?: boolean; contextWindow?: number; effortLevels?: string[]; default: boolean }[];
}
export interface ConnectionTargets {
  current: {
    connectionId?: string;
    model?: string;
    engine?: "core" | "claude" | "codex";
    routeKind?: "api_connection" | "native_cli";
    effort?: string;
    provenance?: "selected" | "applied" | "unknown";
  };
  connections: ConnectionTarget[];
}

/** Bound untrusted display text; JSON serialization supplies transport escaping. */
function displayText(value: unknown, limit = 512): string | undefined {
  return typeof value === "string" ? value.slice(0, limit).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ") : undefined;
}

function member<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return values.includes(value as T) ? value as T : undefined;
}

/** Safe at both the host response boundary and the final tool output boundary. */
export function projectConnectionTargets(data: ConnectionTargets): ConnectionTargets {
  const source = data.current;
  const engine = member(source.engine, ["core", "claude", "codex"]);
  const native = engine === "claude" || engine === "codex" || source.routeKind === "native_cli";
  const current: ConnectionTargets["current"] = {
    ...(native ? {} : { connectionId: displayText(source.connectionId) }),
    model: displayText(source.model),
    ...(engine ? { engine } : {}),
    ...(native ? { routeKind: "native_cli" as const } : source.routeKind === "api_connection" ? { routeKind: "api_connection" as const } : {}),
    ...(typeof source.effort === "string" ? { effort: displayText(source.effort, 32) } : {}),
    ...(source.provenance !== undefined ? { provenance: member(source.provenance, ["selected", "applied", "unknown"]) ?? "unknown" } : {}),
  };
  const output: ConnectionTargets = { current, connections: [] };
  // Retain established last-health codes for existing Core/CLI consumers.
  const health = ["ready", "auth_error", "unknown", "needs_credential", "unchecked", "auth_invalid", "forbidden", "rate_limited", "unreachable", "misconfigured"] as const;
  // Leave room for the tool envelope under its 100 KB output limit.
  let remaining = 90000 - new TextEncoder().encode(JSON.stringify(output)).length;
  for (const c of data.connections.slice(0, 64)) {
    const connection: ConnectionTarget = {
      id: displayText(c.id) ?? "", label: displayText(c.label, 256),
      providerId: displayText(c.providerId) ?? "", transport: displayText(c.transport, 64),
      readiness: member(c.readiness, health) ?? "unknown", models: [],
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(connection)).length + 1;
    if (headerBytes > remaining) break;
    remaining -= headerBytes;
    for (const m of c.models.slice(0, 256)) {
      const model: ConnectionTarget["models"][number] = {
        id: displayText(m.id) ?? "",
        imageInput: typeof m.imageInput === "boolean" ? m.imageInput : undefined,
        contextWindow: typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : undefined,
        effortLevels: Array.isArray(m.effortLevels) ? m.effortLevels.slice(0, 16).filter((v): v is string => typeof v === "string").map(v => displayText(v, 32)!) : undefined,
        default: m.default === true,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(model)).length + 1;
      if (bytes > remaining) break;
      remaining -= bytes;
      connection.models.push(model);
    }
    output.connections.push(connection);
  }
  return output;
}

export function createListConnectionsTool(read: () => ConnectionTargets): ToolDefinition<Record<string, never>, ConnectionTargets> {
  return {
    metadata: {
      name: "ListConnections", description: "List provider connections and models available for Agent routing, and this session's current route. Readiness is last observed health and may be unknown or stale.",
      readOnly: true, destructive: false, concurrentSafe: true, riskLevel: "low", sideEffectScope: "none", needsApproval: false,
      timeoutMs: 30_000, maxOutputBytes: 100000,
    },
    inputSchema: z.object({}).strict(),
    handler: async () => {
      try {
        return { ok: true, output: projectConnectionTargets(read()) };
      } catch {
        return { ok: false, error: "ListConnections: connection information is unavailable." };
      }
    },
  };
}

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
  current: { connectionId?: string; model?: string };
  connections: ConnectionTarget[];
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
        const data = read();
        return { ok: true, output: {
          current: { connectionId: data.current.connectionId, model: data.current.model },
          connections: data.connections.map(c => ({
            id: c.id, label: c.label, providerId: c.providerId, transport: c.transport, readiness: c.readiness,
            models: c.models.map(m => ({ id: m.id, imageInput: m.imageInput, contextWindow: m.contextWindow, effortLevels: m.effortLevels, default: m.default })),
          })),
        } };
      } catch {
        return { ok: false, error: "ListConnections: connection information is unavailable." };
      }
    },
  };
}

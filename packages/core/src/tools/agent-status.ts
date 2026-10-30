import { z } from "zod";
import type { ToolDefinition } from "../types/tools.js";
import { inlineChildStatusStore, type ChildStatus } from "../subagents/status.js";

export const agentStatusSchema = z.object({
  id: z.string().min(1).max(512).optional().describe("Child session id or Agent call handle; omit to list your children."),
  offset: z.number().int().min(0).optional().describe("List offset from next_offset; ignored when id is supplied."),
});

type Input = z.infer<typeof agentStatusSchema>;
type View = Omit<ChildStatus, "startedAt" | "endedAt"> & { elapsedMs: number };
function view(child: ChildStatus, includeTail: boolean): View {
  const { startedAt, endedAt, tail, ...rest } = child;
  return { ...rest, elapsedMs: Math.max(0, (endedAt ?? Date.now()) - startedAt), tail: includeTail ? tail : [] };
}
export const agentStatusTool: ToolDefinition<Input, { children: View[]; total?: number; next_offset?: number; older_discarded?: number }> = {
  metadata: {
    name: "AgentStatus", description: "Read the state and recent transcript of your own subagents. Omit id to list them; use next_offset to continue. Up to 64 recent children per tier are retained. Poll background, detached, or handed-off session children; a parent blocked on a foreground child cannot poll until it returns or hands off.",
    readOnly: true, destructive: false, concurrentSafe: true, riskLevel: "low", sideEffectScope: "none", needsApproval: false,
    timeoutMs: 30_000, maxOutputBytes: 30000, resultBudget: { maxModelBytes: 30000, strategy: "truncate" },
  },
  inputSchema: agentStatusSchema,
  handler: async ({ id, offset }, ctx) => {
    const inline = ctx.subagents ? inlineChildStatusStore(ctx.subagents) : undefined;
    const session = ctx.sessionSubagents;
    if (id !== undefined) {
      const child = inline?.get(id) ?? session?.getStatus?.(id);
      return child ? { ok: true, output: { children: [view(child, true)] } } : { ok: false, errorKind: "invalid_input", error: "AgentStatus: child not found in this session." };
    }
    const all = [...(inline?.list() ?? []), ...(session?.listStatus?.() ?? [])];
    const start = Math.min(offset ?? 0, all.length);
    const end = Math.min(start + 20, all.length);
    const discarded = (inline?.discarded() ?? 0) + (session?.statusDiscarded?.() ?? 0);
    return { ok: true, output: { children: all.slice(start, end).map((child) => view(child, false)), total: all.length, ...(end < all.length ? { next_offset: end } : {}), ...(discarded ? { older_discarded: discarded } : {}) } };
  },
};

/** Shared declaration and dispatch for the foreign-engine Agent bridges. */
export const agentStatusBridgeDecl = {
  name: "agent_status",
  description: agentStatusTool.metadata.description,
  inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 512 }, offset: { type: "integer", minimum: 0 } }, additionalProperties: false },
};
export async function runAgentStatusBridge(args: unknown, port: import("../ports/session-subagent.js").SessionSubagentPort): Promise<{ text: string; isError: boolean }> {
  const parsed = agentStatusSchema.safeParse(args);
  if (!parsed.success) return { text: "Malformed AgentStatus arguments", isError: true };
  const result = await agentStatusTool.handler(parsed.data, { sessionSubagents: port } as import("../types/tools.js").ToolContext);
  return result.ok ? { text: JSON.stringify(result.output), isError: false } : { text: result.error ?? "AgentStatus failed", isError: true };
}

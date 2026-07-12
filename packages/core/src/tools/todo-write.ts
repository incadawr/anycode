/**
 * TodoWrite tool (design §2.14): replace-all semantics over CorePorts.todos;
 * ids are assigned for items that omit them. readOnly=true is intentional
 * (session state, not workspace), but concurrentSafe=false — writes run solo
 * so last-write order stays deterministic. Handler body is task 1.5.
 */

import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import { todoWriteInputSchema, type TodoWriteInput, type TodoWriteOutput } from "./schemas.js";

const metadata: ToolMetadata = {
  name: "TodoWrite",
  description: "Replace the session todo list with the provided items.",
  readOnly: true,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: 30_000,
};

export const todoWriteTool: ToolDefinition<TodoWriteInput, TodoWriteOutput> = {
  metadata,
  inputSchema: todoWriteInputSchema,
  handler: async (input, ctx) => {
    const items = input.todos.map((item) => ({
      id: item.id ?? globalThis.crypto.randomUUID(),
      content: item.content,
      status: item.status,
    }));
    const stored = ctx.ports.todos.replaceAll(items);
    return { ok: true, output: { todos: stored, count: stored.length } };
  },
};

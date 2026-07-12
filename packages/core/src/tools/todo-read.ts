/**
 * TodoRead tool (design §2.14): returns the session todo list from
 * CorePorts.todos. Handler body is task 1.5.
 */

import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import { todoReadInputSchema, type TodoReadInput, type TodoReadOutput } from "./schemas.js";

const metadata: ToolMetadata = {
  name: "TodoRead",
  description: "Read the current session todo list.",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: 30_000,
};

export const todoReadTool: ToolDefinition<TodoReadInput, TodoReadOutput> = {
  metadata,
  inputSchema: todoReadInputSchema,
  handler: async (_input, ctx) => {
    return { ok: true, output: { todos: ctx.ports.todos.read() } };
  },
};

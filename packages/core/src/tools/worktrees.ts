/** Paired terminal-control tools for relocating the current session host. */

import { z } from "zod";
import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import type {
  EnterWorktreeRequest,
  ExitWorktreeRequest,
  WorkspaceTransition,
} from "../ports/worktrees.js";

const WORKTREE_CONTROL_TIMEOUT_MS = 120_000;

export const enterWorktreeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    baseRef: z.string().trim().min(1).optional(),
    existing: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.existing === undefined || value.name === undefined, {
    message: "existing and name are mutually exclusive",
  });

export const exitWorktreeInputSchema = z.object({
  cleanup: z.enum(["auto", "keep", "remove"]).default("auto"),
});

export type EnterWorktreeInput = z.output<typeof enterWorktreeInputSchema>;
export type ExitWorktreeInput = z.output<typeof exitWorktreeInputSchema>;

const enterMetadata: ToolMetadata = {
  name: "EnterWorktree",
  description:
    "Create and enter an isolated git worktree for this same session. Use when the user explicitly asks to work in a worktree. `existing` enters an already-registered worktree instead of creating one. A success relocates the session and ends the current host segment, so do not propose later tool calls in the same response.",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  terminalControl: true,
  riskLevel: "medium",
  sideEffectScope: "filesystem",
  needsApproval: false,
  timeoutMs: WORKTREE_CONTROL_TIMEOUT_MS,
};

const exitMetadata: ToolMetadata = {
  name: "ExitWorktree",
  description:
    "Return this same session to its project root. cleanup=auto removes only a clean AnyCode-owned worktree, keep always retains it, and remove may discard dirty work and therefore requires explicit destructive approval. A success relocates the session and ends the current host segment.",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  terminalControl: true,
  riskLevel: "medium",
  sideEffectScope: "filesystem",
  needsApproval: false,
  timeoutMs: WORKTREE_CONTROL_TIMEOUT_MS,
};

const removeMetadata: ToolMetadata = {
  ...exitMetadata,
  destructive: true,
  riskLevel: "high",
  needsApproval: true,
};

function successResult(transition: WorkspaceTransition, message?: string) {
  return {
    ok: true as const,
    output: { transition, ...(message === undefined ? {} : { message }) },
    control: { type: "workspace_transition" as const, transition },
  };
}

export const enterWorktreeTool: ToolDefinition<
  EnterWorktreeInput,
  { transition: WorkspaceTransition; message?: string }
> = {
  metadata: enterMetadata,
  inputSchema: enterWorktreeInputSchema,
  handler: async (input, ctx) => {
    if (!ctx.worktrees) {
      return { ok: false, error: "EnterWorktree: worktree control is unavailable in this context." };
    }
    const request: EnterWorktreeRequest = input;
    const result = await ctx.worktrees.enter(request, { signal: ctx.abortSignal, toolCallId: ctx.toolCallId });
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.errorKind ? { errorKind: result.errorKind } : {}) };
    }
    return successResult(result.transition, result.message);
  },
};

export const exitWorktreeTool: ToolDefinition<
  ExitWorktreeInput,
  { transition: WorkspaceTransition; message?: string }
> = {
  metadata: exitMetadata,
  inputSchema: exitWorktreeInputSchema,
  resolveMetadata: (input) => (input.cleanup === "remove" ? removeMetadata : exitMetadata),
  handler: async (input, ctx) => {
    if (!ctx.worktrees) {
      return { ok: false, error: "ExitWorktree: worktree control is unavailable in this context." };
    }
    const request: ExitWorktreeRequest = input;
    const result = await ctx.worktrees.exit(request, { signal: ctx.abortSignal, toolCallId: ctx.toolCallId });
    if (!result.ok) {
      return { ok: false, error: result.error, ...(result.errorKind ? { errorKind: result.errorKind } : {}) };
    }
    return successResult(result.transition, result.message);
  },
};

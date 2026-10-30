import type { ToolDefinition } from "../types/tools.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import { gitInputSchema, type GitInput } from "./schemas.js";
import type { GitReadOutput } from "../ports/git-read.js";

export const gitTool: ToolDefinition<GitInput, GitReadOutput> = {
  metadata: {
    name: "Git",
    description: "Read local Git history and working-tree status. For a historical file use show with revision and path; list branch commits with log and revision develop..HEAD. Remote-tracking refs must already exist locally and may be stale. Working-tree comparisons suppress configured filters; shallow or partial history may be incomplete. Local filesystem races remain possible; this is not OS-level isolation.",
    readOnly: true, destructive: false, concurrentSafe: true, riskLevel: "low",
    sideEffectScope: "none", needsApproval: false, timeoutMs: DEFAULT_TOOL_TIMEOUT_MS, maxOutputBytes: 80_000,
  },
  inputSchema: gitInputSchema,
  handler: async (input, ctx) => {
    if (!ctx.ports.gitRead) return { ok: false, error: "Git read capability is unavailable" };
    try {
      return { ok: true, output: await ctx.ports.gitRead.read(input, ctx.cwd, ctx.abortSignal) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

import type { ToolDefinition } from "../types/tools.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import { writeInputSchema, type WriteInput, type WriteOutput } from "./schemas.js";

/** Creates or overwrites a file through FileSystemPort (parent dirs created as needed). */
export const writeTool: ToolDefinition<WriteInput, WriteOutput> = {
  metadata: {
    name: "Write",
    description:
      "Create a new file or overwrite an existing one with the given content. The path must be absolute.",
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    riskLevel: "medium",
    sideEffectScope: "filesystem",
    needsApproval: true,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  inputSchema: writeInputSchema,
  handler: async (input, ctx) => {
    try {
      const created = !(await ctx.ports.fs.exists(input.file_path));
      await ctx.ports.fs.writeFile(input.file_path, input.content);
      return {
        ok: true,
        output: {
          bytesWritten: new TextEncoder().encode(input.content).length,
          created,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

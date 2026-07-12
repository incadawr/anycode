import type { ToolDefinition } from "../types/tools.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import { readInputSchema, type ReadInput, type ReadOutput } from "./schemas.js";

/** Reads file content through FileSystemPort; supports offset/limit windowing. */
export const readTool: ToolDefinition<ReadInput, ReadOutput> = {
  metadata: {
    name: "Read",
    description:
      "Read a UTF-8 text file from the workspace. Returns the content, optionally starting at a line offset with a line limit.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  inputSchema: readInputSchema,
  handler: async (input, ctx) => {
    let raw: string;
    try {
      raw = await ctx.ports.fs.readFile(input.file_path);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Splitting on "\n" preserves a trailing empty segment when the file ends
    // with a newline; totalLines reports the segment count as-is.
    const lines = raw.split("\n");
    const totalLines = lines.length;
    const offset = input.offset ?? 0;
    const end = input.limit != null ? offset + input.limit : lines.length;
    const selected = lines.slice(offset, end);

    return {
      ok: true,
      output: {
        content: selected.join("\n"),
        totalLines,
        truncated: selected.length !== totalLines,
      },
    };
  },
};

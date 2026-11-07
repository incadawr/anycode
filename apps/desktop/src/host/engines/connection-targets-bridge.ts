import { z } from "zod";
import { createListConnectionsTool, type ConnectionTargets, type McpToolCallResult } from "@anycode/core";

/** Both native doors use the Core tool's schema and output whitelist. */
export function createConnectionTargetsBridge(read: () => ConnectionTargets) {
  const tool = createListConnectionsTool(read);
  const declaration = {
    description: tool.metadata.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
  };
  return {
    declaration,
    async call(args: unknown, signal: AbortSignal): Promise<McpToolCallResult> {
      if (signal.aborted) return { text: "ListConnections: call was cancelled.", isError: true };
      if (!tool.inputSchema.safeParse(args).success) return { text: "ListConnections: expected an empty object.", isError: true };
      const result = await tool.handler({}, {} as never);
      if (signal.aborted) return { text: "ListConnections: call was cancelled.", isError: true };
      return result.ok ? { text: JSON.stringify(result.output), isError: false }
        : { text: "ListConnections: connection information is unavailable.", isError: true };
    },
  };
}
export type ConnectionTargetsBridge = ReturnType<typeof createConnectionTargetsBridge>;

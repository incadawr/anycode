import type { ToolDefinition } from "../types/tools.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import { editInputSchema, type EditInput, type EditOutput } from "./schemas.js";

/** Non-overlapping occurrence count of a literal substring. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

/**
 * Exact-string replacement through FileSystemPort. Fails when old_string is
 * absent or ambiguous (unless replace_all), or equals new_string.
 */
export const editTool: ToolDefinition<EditInput, EditOutput> = {
  metadata: {
    name: "Edit",
    description:
      "Replace an exact text fragment in a file. The fragment must match uniquely unless replace_all is set.",
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    riskLevel: "medium",
    sideEffectScope: "filesystem",
    needsApproval: true,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  inputSchema: editInputSchema,
  handler: async (input, ctx) => {
    if (input.new_string === input.old_string) {
      return { ok: false, error: "new_string must differ from old_string" };
    }

    let content: string;
    try {
      content = await ctx.ports.fs.readFile(input.file_path);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const occurrences = countOccurrences(content, input.old_string);
    if (occurrences === 0) {
      return { ok: false, error: `old_string not found in ${input.file_path}` };
    }
    if (!input.replace_all && occurrences > 1) {
      return {
        ok: false,
        error: `old_string is not unique in ${input.file_path} (${occurrences} matches); pass replace_all:true or include more surrounding context`,
      };
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : replaceFirst(content, input.old_string, input.new_string);

    try {
      await ctx.ports.fs.writeFile(input.file_path, updated);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    return { ok: true, output: { replacements: input.replace_all ? occurrences : 1 } };
  },
};

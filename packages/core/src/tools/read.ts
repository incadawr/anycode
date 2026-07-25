import type { ToolDefinition } from "../types/tools.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  READ_CONTENT_MAX_BYTES,
  READ_MAX_TOKENS,
  READ_PARTIAL_VIEW_RATIO,
} from "../types/config.js";
import { estimateTokens } from "../util/tokens.js";
import { readInputSchema, type ReadInput, type ReadOutput } from "./schemas.js";

/** Target size of a partial view; the headroom pays for the notice and line numbering. */
const PARTIAL_VIEW_TOKENS = Math.floor(READ_MAX_TOKENS * READ_PARTIAL_VIEW_RATIO);

/**
 * A result is over cap on EITHER axis. Tokens are what the model is charged,
 * but the dispatcher's budget is in bytes, and the two diverge badly outside
 * ASCII: Cyrillic costs a third of a token per character and two bytes, so a
 * token-only cap lets ~127 KB through a 100 KB budget and the byte cut then
 * lands mid-JSON, taking the continuation notice with it.
 */
function overCap(text: string): boolean {
  return estimateTokens(text) > READ_MAX_TOKENS || Buffer.byteLength(text, "utf8") > READ_CONTENT_MAX_BYTES;
}

function fits(text: string): boolean {
  return (
    estimateTokens(text) <= PARTIAL_VIEW_TOKENS &&
    Buffer.byteLength(text, "utf8") <= READ_CONTENT_MAX_BYTES
  );
}

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
    const content = selected.join("\n");

    if (!overCap(content)) {
      return {
        ok: true,
        output: { totalLines, truncated: selected.length !== totalLines, content },
      };
    }

    // The caller named a window and it does not fit. Returning less than was
    // asked for would read as "the file ends here", so this fails instead.
    if (input.offset !== undefined || input.limit !== undefined) {
      return {
        ok: false,
        error:
          `The requested window is ~${estimateTokens(content)} tokens / ` +
          `${Buffer.byteLength(content, "utf8")} bytes, over the per-Read limit of ` +
          `${READ_MAX_TOKENS} tokens and ${READ_CONTENT_MAX_BYTES} bytes. ` +
          `Request fewer lines (a smaller limit, or a later offset), or use Grep to locate the section you need.`,
      };
    }

    return { ok: true, output: partialView(selected, offset, totalLines, content) };
  },
};

/**
 * Largest prefix of `selected` that fits the partial-view budget, plus a notice
 * telling the model exactly how to continue. A first line that alone exceeds
 * the budget (a minified bundle) is cut inside the line instead.
 */
function partialView(
  selected: string[],
  offset: number,
  totalLines: number,
  content: string,
): ReadOutput {
  const size = `~${estimateTokens(content)} tokens / ${Buffer.byteLength(content, "utf8")} bytes`;
  const keptLines = fitLines(selected);
  if (keptLines === 0) {
    // A minified bundle is one line: there is no line boundary to cut on, so
    // the cut lands inside it and the notice points at Grep instead of an offset.
    const first = selected[0] ?? "";
    return {
      // Field order is load-bearing: the serialized result is budgeted from the
      // head, so anything the model needs to recover must precede the content.
      notice:
        `Partial view: the first line alone is over the per-Read limit ` +
        `(the requested range is ${size}), so it was cut mid-line. ` +
        `Use Grep to locate the section you need.`,
      totalLines,
      truncated: true,
      content: first.slice(0, fitChars(first)),
    };
  }

  const nextOffset = offset + keptLines;
  return {
    notice:
      `Partial view: lines ${offset}-${nextOffset - 1} of ${totalLines}; the requested range is ` +
      `${size}, over the per-Read cap of ${READ_MAX_TOKENS} tokens / ${READ_CONTENT_MAX_BYTES} bytes. ` +
      `Continue with offset ${nextOffset} and limit ${keptLines}, ` +
      `or use Grep to jump straight to the section you need.`,
    totalLines,
    truncated: true,
    content: selected.slice(0, keptLines).join("\n"),
  };
}

/** Binary search for the largest line count whose joined text fits the budget. */
function fitLines(lines: string[]): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(lines.slice(0, mid).join("\n"))) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** Binary search for the largest character prefix of one line that fits the budget. */
function fitChars(line: string): number {
  let low = 0;
  let high = line.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(line.slice(0, mid))) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // The search counts UTF-16 units, so the cut can land between a surrogate
  // pair; backing off one unit drops the orphan instead of emitting it.
  const last = low > 0 ? line.charCodeAt(low - 1) : 0;
  return last >= 0xd800 && last <= 0xdbff ? low - 1 : low;
}

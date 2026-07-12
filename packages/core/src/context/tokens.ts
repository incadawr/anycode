/**
 * Convenience token estimation. Delegates to the Phase 1 HeuristicTokenizer
 * (design §2.5); provider-reported usage numbers are always preferred when
 * present (TokenUsage on "finish").
 */

import type { Tokenizer } from "./tokenizer.js";
import { HeuristicTokenizer } from "./tokenizer.js";
import type { ToolDeclaration } from "../types/tools.js";

const heuristic = new HeuristicTokenizer();

export function estimateTokensFromText(text: string): number {
  return heuristic.count(text);
}

/**
 * Sums estimated tokens across a list of tool declarations (design
 * slice-P7.17-cut.md §2.1, ctx-breakdown). Each declaration is counted as the
 * tokenizer's count over its JSON-serialized name/description/schema — a
 * cheap proxy for what actually goes over the wire to the model, not an exact
 * provider-side count.
 */
export function estimateToolDeclarationTokens(
  decls: readonly ToolDeclaration[],
  tokenizer: Tokenizer,
): number {
  let total = 0;
  for (const decl of decls) {
    total += tokenizer.count(
      JSON.stringify({
        name: decl.name,
        description: decl.description,
        inputSchema: decl.inputJsonSchema,
      }),
    );
  }
  return total;
}

/**
 * Partitions tool declarations into MCP-bridged vs everything else, by the
 * `mcp__<server>__<tool>` name prefix the bridge sanitizes every bridged tool
 * into (mcp/tool-bridge.ts). Used to split the ctx-breakdown's "System tools"
 * and "MCP tools" categories before summing each side with
 * estimateToolDeclarationTokens.
 */
export function splitToolDeclarationsByMcpPrefix(decls: readonly ToolDeclaration[]): {
  systemTools: ToolDeclaration[];
  mcpTools: ToolDeclaration[];
} {
  const systemTools: ToolDeclaration[] = [];
  const mcpTools: ToolDeclaration[] = [];
  for (const decl of decls) {
    (decl.name.startsWith("mcp__") ? mcpTools : systemTools).push(decl);
  }
  return { systemTools, mcpTools };
}

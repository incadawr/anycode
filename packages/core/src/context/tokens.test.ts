/**
 * Unit tests for the small pure-read token-estimation helpers added by slice
 * P7.17 W1 (ctx-breakdown design §2.1): estimateToolDeclarationTokens sums a
 * list of tool declarations, splitToolDeclarationsByMcpPrefix partitions a
 * list by the `mcp__` bridge-name prefix (mcp/tool-bridge.ts convention).
 * estimateTokensFromText's existing behaviour is untouched by this slice.
 */

import { describe, expect, it } from "vitest";
import type { ToolDeclaration } from "../types/tools.js";
import type { Tokenizer } from "./tokenizer.js";
import {
  estimateToolDeclarationTokens,
  estimateTokensFromText,
  splitToolDeclarationsByMcpPrefix,
} from "./tokens.js";

/** Deterministic 1-char-1-token stub so the sums below are exact, not tied to HeuristicTokenizer's heuristic. */
const lengthTokenizer: Tokenizer = { count: (text: string) => text.length };

function decl(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: "Read",
    description: "reads a file",
    inputJsonSchema: {},
    ...overrides,
  };
}

describe("estimateToolDeclarationTokens", () => {
  it("returns 0 for an empty list", () => {
    expect(estimateToolDeclarationTokens([], lengthTokenizer)).toBe(0);
  });

  it("sums tokenizer.count(JSON.stringify({name, description, inputSchema})) across every declaration", () => {
    const a = decl({ name: "Read", description: "reads a file" });
    const b = decl({ name: "Write", description: "writes a file", inputJsonSchema: { type: "object" } });
    const expected =
      JSON.stringify({ name: a.name, description: a.description, inputSchema: a.inputJsonSchema }).length +
      JSON.stringify({ name: b.name, description: b.description, inputSchema: b.inputJsonSchema }).length;
    expect(estimateToolDeclarationTokens([a, b], lengthTokenizer)).toBe(expected);
  });

  it("serializes inputJsonSchema (the real declaration schema, not a placeholder)", () => {
    const withSchema = decl({ inputJsonSchema: { type: "object", properties: { path: { type: "string" } } } });
    const withoutSchema = decl({ inputJsonSchema: {} });
    expect(estimateToolDeclarationTokens([withSchema], lengthTokenizer)).toBeGreaterThan(
      estimateToolDeclarationTokens([withoutSchema], lengthTokenizer),
    );
  });
});

describe("splitToolDeclarationsByMcpPrefix", () => {
  it("routes every mcp__-prefixed name to mcpTools and everything else to systemTools", () => {
    const read = decl({ name: "Read" });
    const bridged = decl({ name: "mcp__srv__tool" });
    const { systemTools, mcpTools } = splitToolDeclarationsByMcpPrefix([read, bridged]);
    expect(systemTools).toEqual([read]);
    expect(mcpTools).toEqual([bridged]);
  });

  it("returns empty arrays for an empty input, and preserves input order within each partition", () => {
    expect(splitToolDeclarationsByMcpPrefix([])).toEqual({ systemTools: [], mcpTools: [] });

    const a = decl({ name: "mcp__one__a" });
    const b = decl({ name: "Bash" });
    const c = decl({ name: "mcp__two__c" });
    const { systemTools, mcpTools } = splitToolDeclarationsByMcpPrefix([a, b, c]);
    expect(systemTools).toEqual([b]);
    expect(mcpTools).toEqual([a, c]);
  });

  it("a name that merely CONTAINS mcp__ but doesn't START with it stays a system tool", () => {
    const notBridged = decl({ name: "Notmcp__weird" });
    const { systemTools, mcpTools } = splitToolDeclarationsByMcpPrefix([notBridged]);
    expect(systemTools).toEqual([notBridged]);
    expect(mcpTools).toEqual([]);
  });
});

describe("estimateTokensFromText (pre-existing, unchanged by this slice)", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokensFromText("")).toBe(0);
  });

  it("returns a positive count for non-empty text", () => {
    expect(estimateTokensFromText("hello world")).toBeGreaterThan(0);
  });
});

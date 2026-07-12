/**
 * MCP tool bridge (design slice-3.2-cut.md §4.3): maps server tools into
 * fail-closed `ToolDefinition`s.
 *
 * Frozen metadata for every `mcp__*` tool (readOnly:false, destructive:true,
 * concurrentSafe:false, riskLevel:"high", needsApproval:true, …) that server
 * annotations NEVER soften — annotations are read structurally and deliberately
 * IGNORED (zero influence on metadata or the permission verdict). The server
 * `inputSchema` flows through verbatim as `rawInputJsonSchema` (top-level
 * `type:"object"` guaranteed), the zod slot is a permissive `z.looseObject({})`
 * (real validation is server-side), and the handler maps a normalized call
 * outcome into a ToolResult and NEVER throws.
 *
 * This module is third-party-free (structural mirrors of the SDK `Tool` /
 * `CallToolResult` shapes) — SDK types never enter here, mirroring the ports.
 * Task 3.2.2 owns and refines these signatures (they are NOT a frozen §3.1-3.5
 * contract, per the 3.2.1 stub note).
 */

import { z } from "zod";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_DECL_BUDGET_BYTES_PER_SERVER,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_RESULT_MAX_BYTES,
  MCP_TOOL_DESCRIPTION_MAX_BYTES,
} from "../types/config.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolMetadata,
  ToolResult,
} from "../types/tools.js";

/** One content block of a CallToolResult, read structurally (SDK `ContentBlock`). */
export interface McpContentBlock {
  type: string;
  /** Present on `type:"text"` blocks. */
  text?: string;
  [key: string]: unknown;
}

/** Structural mirror of the SDK `CallToolResult` (third-party-free). */
export interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Normalized outcome of one server call, produced by the manager (which owns the
 * SDK Client + transport and classifies abort/timeout/disconnect). The bridge
 * maps this into a ToolResult; keeping classification in the manager keeps this
 * module third-party-free and makes the content-mapping unit-testable with a
 * stubbed `callTool`.
 */
export type McpCallOutcome =
  | { kind: "result"; content: McpContentBlock[]; isError: boolean }
  | { kind: "cancelled" }
  | { kind: "timed_out" }
  | { kind: "failed"; error: string };

/** Invokes the server for a bridged tool; implemented by the manager (3.2.2). */
export type McpCallTool = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<McpCallOutcome>;

/**
 * Structural shape of a server tool from listTools (the SDK `Tool`), read
 * structurally so this file stays third-party-free like the ports. `annotations`
 * is captured only to prove it is ignored — it never reaches ToolMetadata.
 */
export interface McpRawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface BridgeMcpToolInput {
  serverName: string;
  transport: "stdio" | "http";
  tool: McpRawTool;
  callTool: McpCallTool;
}

/** Result of bridging one server's tool list, with caps + collision handling. */
export interface BridgeServerToolsInput {
  serverName: string;
  transport: "stdio" | "http";
  tools: McpRawTool[];
  callTool: McpCallTool;
  /** Default MCP_MAX_TOOLS_PER_SERVER. */
  maxTools?: number;
  /** Default MCP_DECL_BUDGET_BYTES_PER_SERVER. */
  declBudgetBytes?: number;
  /** Names already taken (built-ins + earlier servers): a collision is skipped. */
  reserved?: (name: string) => boolean;
}

export interface BridgeServerToolsResult {
  definitions: ToolDefinition[];
  warnings: string[];
  /** True when a per-server cap (tool count / byte budget) dropped part of the list. */
  toolsTruncated: boolean;
}

/** Sanitizes a name segment to the `mcp__srv__tool` alphabet: [^A-Za-z0-9_-] -> _. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The bridged tool name for a server tool: mcp__<server>__<tool>, sanitized. */
export function bridgedToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
}

/** Caps a string to `maxBytes` UTF-8 bytes (no partial-codepoint tail). */
function capUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Do not split a multibyte codepoint: back off over UTF-8 continuation bytes.
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: buf.subarray(0, end).toString("utf-8"), truncated: true };
}

/** Server inputSchema -> a raw JSON Schema with a guaranteed top-level object type. */
function normalizeInputSchema(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (inputSchema && inputSchema.type === "object") {
    return inputSchema;
  }
  // Missing schema OR a non-object top-level type: replace with an empty object
  // schema (provider 400 guard — the model's args still pass the loose zod slot).
  return { type: "object", properties: {} };
}

/** The frozen, fail-closed metadata for any bridged MCP tool (annotations ignored). */
function bridgedMetadata(input: BridgeMcpToolInput): ToolMetadata {
  const name = bridgedToolName(input.serverName, input.tool.name);
  const description = capUtf8Bytes(input.tool.description ?? "", MCP_TOOL_DESCRIPTION_MAX_BYTES).text;
  return {
    name,
    description,
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    riskLevel: "high",
    needsApproval: true,
    sideEffectScope: input.transport === "http" ? "network" : "process",
    timeoutMs: MCP_CALL_TIMEOUT_MS,
    maxOutputBytes: MCP_RESULT_MAX_BYTES,
  };
}

/** Maps a normalized call outcome into a model-visible ToolResult (never throws). */
function mapOutcomeToResult(outcome: McpCallOutcome): ToolResult<string> {
  switch (outcome.kind) {
    case "cancelled":
      return { ok: false, errorKind: "cancelled", error: "MCP tool call was cancelled." };
    case "timed_out":
      return { ok: false, errorKind: "timed_out", error: "MCP tool call timed out." };
    case "failed":
      return { ok: false, error: outcome.error };
    case "result": {
      const pieces: string[] = [];
      for (const block of outcome.content) {
        if (block.type === "text") {
          pieces.push(typeof block.text === "string" ? block.text : "");
        } else {
          pieces.push(`[non-text content: ${block.type}]`);
        }
      }
      const joined = pieces.join(pieces.some((p) => p.startsWith("[non-text content:")) ? "\n" : "");
      const { text } = capUtf8Bytes(joined, MCP_RESULT_MAX_BYTES);
      if (outcome.isError) {
        return { ok: false, error: text || "MCP tool reported an error with no message." };
      }
      return { ok: true, output: text };
    }
  }
}

/** Bridges one server tool into a fail-closed ToolDefinition (design §4.3). */
export function bridgeMcpTool(input: BridgeMcpToolInput): ToolDefinition {
  const metadata = bridgedMetadata(input);
  const rawInputJsonSchema = normalizeInputSchema(input.tool.inputSchema);
  const serverToolName = input.tool.name;
  const callTool = input.callTool;

  return {
    metadata,
    // Permissive passthrough: the model's arguments cross the dispatch pipeline
    // without local validation — the server validates and errors become an
    // error-outcome. `looseObject` keeps unknown keys instead of stripping them.
    inputSchema: z.looseObject({}) as unknown as ToolDefinition["inputSchema"],
    rawInputJsonSchema,
    async handler(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      try {
        const outcome = await callTool(serverToolName, args, ctx);
        return mapOutcomeToResult(outcome);
      } catch (error) {
        // Defensive net: callTool is expected to normalize every path, but the
        // handler contract is "never throw" regardless.
        if (ctx.abortSignal.aborted) {
          return { ok: false, errorKind: "cancelled", error: "MCP tool call was cancelled." };
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * Bridges a whole server tool list, applying (in order): sanitized naming,
 * collision skip (intra-server duplicates + `reserved` names), the per-server
 * tool-count cap, and the per-server declaration byte budget. Cap-driven drops
 * set `toolsTruncated`; collision skips only add a warning.
 */
export function bridgeServerTools(input: BridgeServerToolsInput): BridgeServerToolsResult {
  const maxTools = input.maxTools ?? MCP_MAX_TOOLS_PER_SERVER;
  const declBudget = input.declBudgetBytes ?? MCP_DECL_BUDGET_BYTES_PER_SERVER;
  const reserved = input.reserved ?? (() => false);

  const definitions: ToolDefinition[] = [];
  const warnings: string[] = [];
  const taken = new Set<string>();
  let usedBytes = 0;
  let toolsTruncated = false;

  for (const tool of input.tools) {
    const single: BridgeMcpToolInput = {
      serverName: input.serverName,
      transport: input.transport,
      tool,
      callTool: input.callTool,
    };
    const definition = bridgeMcpTool(single);
    const name = definition.metadata.name;

    if (taken.has(name) || reserved(name)) {
      warnings.push(`skipped tool "${tool.name}" from server "${input.serverName}": name collision on "${name}"`);
      continue;
    }

    // Per-server tool-count cap: once the cap is reached, the tail is dropped.
    if (definitions.length >= maxTools) {
      toolsTruncated = true;
      break;
    }

    // Per-server declaration byte budget: Σ(name + description + schema).
    const declBytes =
      Buffer.byteLength(name, "utf-8") +
      Buffer.byteLength(definition.metadata.description, "utf-8") +
      Buffer.byteLength(JSON.stringify(definition.rawInputJsonSchema ?? {}), "utf-8");
    if (usedBytes + declBytes > declBudget) {
      toolsTruncated = true;
      break;
    }

    usedBytes += declBytes;
    taken.add(name);
    definitions.push(definition);
  }

  return { definitions, warnings, toolsTruncated };
}

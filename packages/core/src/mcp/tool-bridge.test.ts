/**
 * Bridge unit tests (design slice-3.2-cut.md §5.2 item 1). Proves the frozen
 * fail-closed metadata table is byte-for-byte identical under ANY server
 * annotations (anti "trust downgrade"), naming/sanitize/collision->skip, the
 * per-server caps, result mapping (text-join / isError / non-text marker /
 * MCP_RESULT_MAX_BYTES cap), and the loose zod passthrough slot.
 */

import { describe, expect, it } from "vitest";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_RESULT_MAX_BYTES,
  MCP_TOOL_DESCRIPTION_MAX_BYTES,
} from "../types/config.js";
import type { ToolContext, ToolMetadata } from "../types/tools.js";
import {
  bridgeMcpTool,
  bridgeServerTools,
  bridgedToolName,
  type McpCallOutcome,
  type McpRawTool,
} from "./tool-bridge.js";

function ctx(signal?: AbortSignal): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: signal ?? new AbortController().signal,
    cwd: "/tmp",
    ports: {} as ToolContext["ports"],
  };
}

/** A callTool stub that always returns the given normalized outcome. */
function fixedCall(outcome: McpCallOutcome) {
  return async () => outcome;
}

const FROZEN_STDIO_METADATA: ToolMetadata = {
  name: "mcp__srv__tool",
  description: "does a thing",
  readOnly: false,
  destructive: true,
  concurrentSafe: false,
  riskLevel: "high",
  needsApproval: true,
  sideEffectScope: "process",
  timeoutMs: MCP_CALL_TIMEOUT_MS,
  maxOutputBytes: MCP_RESULT_MAX_BYTES,
};

describe("bridgeMcpTool — frozen metadata", () => {
  const raw: McpRawTool = { name: "tool", description: "does a thing" };

  it("emits the frozen fail-closed metadata table for a stdio tool", () => {
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: raw, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    expect(def.metadata).toEqual(FROZEN_STDIO_METADATA);
  });

  it("http tools differ ONLY in sideEffectScope (network)", () => {
    const def = bridgeMcpTool({ serverName: "srv", transport: "http", tool: raw, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    expect(def.metadata).toEqual({ ...FROZEN_STDIO_METADATA, sideEffectScope: "network" });
  });

  it("server annotations NEVER change metadata (advisory-only, anti trust-downgrade)", () => {
    const withAnnotations: McpRawTool = {
      name: "tool",
      description: "does a thing",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        title: "Totally Safe",
      },
    };
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: withAnnotations, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    // Byte-for-byte identical to the no-annotation baseline.
    expect(def.metadata).toEqual(FROZEN_STDIO_METADATA);
  });

  it("caps the description at MCP_TOOL_DESCRIPTION_MAX_BYTES", () => {
    const long = "d".repeat(MCP_TOOL_DESCRIPTION_MAX_BYTES + 500);
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "tool", description: long }, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    expect(Buffer.byteLength(def.metadata.description, "utf-8")).toBeLessThanOrEqual(MCP_TOOL_DESCRIPTION_MAX_BYTES);
  });
});

describe("bridgeMcpTool — naming + schema", () => {
  it("sanitizes server/tool names to the mcp__srv__tool alphabet", () => {
    expect(bridgedToolName("my server", "do.thing")).toBe("mcp__my_server__do_thing");
    expect(bridgedToolName("srv!", "x")).toBe("mcp__srv___x"); // trailing "!" -> "_"
    const def = bridgeMcpTool({ serverName: "a b", transport: "stdio", tool: { name: "x/y" }, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    expect(def.metadata.name).toBe("mcp__a_b__x_y");
  });

  it("passes an object-typed inputSchema through verbatim as rawInputJsonSchema", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t", inputSchema: schema }, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    expect(def.rawInputJsonSchema).toEqual(schema);
  });

  it("replaces a missing or non-object schema with an empty object schema (provider 400 guard)", () => {
    const missing = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    expect(missing.rawInputJsonSchema).toEqual({ type: "object", properties: {} });
    const nonObject = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t", inputSchema: { type: "array" } }, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    expect(nonObject.rawInputJsonSchema).toEqual({ type: "object", properties: {} });
  });

  it("uses a loose zod slot that accepts an arbitrary object and preserves unknown keys", () => {
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "result", content: [], isError: false }) });
    const parsed = def.inputSchema.safeParse({ any: 1, nested: { x: [2] }, extra: "keep" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ any: 1, nested: { x: [2] }, extra: "keep" });
  });
});

describe("bridgeMcpTool — result mapping (handler never throws)", () => {
  it("joins text content parts", async () => {
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "result", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], isError: false }) });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe("ab");
  });

  it("maps isError:true to an error-outcome with the text as the message", async () => {
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "result", content: [{ type: "text", text: "boom" }], isError: true }) });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
    expect(res.errorKind).toBeUndefined();
  });

  it("renders non-text content as a placeholder marker", async () => {
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "result", content: [{ type: "image", data: "…", mimeType: "image/png" }], isError: false }) });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe("[non-text content: image]");
  });

  it("caps a large result at MCP_RESULT_MAX_BYTES", async () => {
    const huge = "x".repeat(MCP_RESULT_MAX_BYTES + 50_000);
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "result", content: [{ type: "text", text: huge }], isError: false }) });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(Buffer.byteLength(String(res.output), "utf-8")).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
  });

  it("maps cancelled/timed_out/failed outcomes to classified error-results", async () => {
    const cancelled = await bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "cancelled" }) }).handler({}, ctx());
    expect(cancelled).toMatchObject({ ok: false, errorKind: "cancelled" });

    const timedOut = await bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "timed_out" }) }).handler({}, ctx());
    expect(timedOut).toMatchObject({ ok: false, errorKind: "timed_out" });

    const failed = await bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "failed", error: "server '<x>' is disconnected" }) }).handler({}, ctx());
    expect(failed).toMatchObject({ ok: false });
    expect(failed.error).toContain("disconnected");
    expect(failed.errorKind).toBeUndefined();
  });

  it("never throws even if callTool itself rejects", async () => {
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      callTool: async () => {
        throw new Error("unexpected");
      },
    });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unexpected");
  });
});

describe("bridgeServerTools — collision + caps", () => {
  const call = fixedCall({ kind: "result", content: [], isError: false });

  it("skips a within-server name collision (deterministic, warns, no last-wins)", () => {
    // "a.b" and "a/b" both sanitize to "a_b".
    const out = bridgeServerTools({
      serverName: "srv",
      transport: "stdio",
      tools: [{ name: "a.b" }, { name: "a/b" }],
      callTool: call,
    });
    expect(out.definitions).toHaveLength(1);
    expect(out.definitions[0]!.metadata.name).toBe("mcp__srv__a_b");
    expect(out.toolsTruncated).toBe(false);
    expect(out.warnings.join(" ")).toContain("collision");
  });

  it("skips a tool whose name is reserved (built-in / earlier server)", () => {
    const out = bridgeServerTools({
      serverName: "srv",
      transport: "stdio",
      tools: [{ name: "taken" }, { name: "fresh" }],
      callTool: call,
      reserved: (name) => name === "mcp__srv__taken",
    });
    expect(out.definitions.map((d) => d.metadata.name)).toEqual(["mcp__srv__fresh"]);
    expect(out.warnings.join(" ")).toContain("collision");
  });

  it("drops the 33rd tool at the per-server tool cap and flags toolsTruncated", () => {
    const tools: McpRawTool[] = Array.from({ length: MCP_MAX_TOOLS_PER_SERVER + 1 }, (_, i) => ({ name: `tool${i}` }));
    const out = bridgeServerTools({ serverName: "srv", transport: "stdio", tools, callTool: call });
    expect(out.definitions).toHaveLength(MCP_MAX_TOOLS_PER_SERVER);
    expect(out.toolsTruncated).toBe(true);
  });

  it("drops the tail once the declaration byte budget is exceeded", () => {
    const bigDesc = "d".repeat(MCP_TOOL_DESCRIPTION_MAX_BYTES);
    // Each tool contributes ~MCP_TOOL_DESCRIPTION_MAX_BYTES; a tiny budget admits a few.
    const tools: McpRawTool[] = Array.from({ length: 10 }, (_, i) => ({ name: `tool${i}`, description: bigDesc }));
    const out = bridgeServerTools({ serverName: "srv", transport: "stdio", tools, callTool: call, declBudgetBytes: MCP_TOOL_DESCRIPTION_MAX_BYTES * 3 });
    expect(out.definitions.length).toBeGreaterThan(0);
    expect(out.definitions.length).toBeLessThan(10);
    expect(out.toolsTruncated).toBe(true);
  });
});

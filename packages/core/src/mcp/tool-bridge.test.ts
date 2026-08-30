/**
 * Bridge unit tests (design slice-3.2-cut.md §5.2 item 1). Proves the frozen
 * fail-closed metadata table is byte-for-byte identical under ANY server
 * annotations (anti "trust downgrade"), naming/sanitize/collision->skip, the
 * per-server caps, result mapping (text-join / isError / non-text marker /
 * MCP_RESULT_MAX_BYTES cap), and the loose zod passthrough slot.
 *
 * TASK.198 slice B3 adds the `type:"image"` content-block path: validated
 * blocks become real `ToolResult.images` attachments instead of the generic
 * non-text placeholder. The pre-slice placeholder pin ("renders non-text
 * content as a placeholder marker") used an `image` block as its fixture;
 * that behavior is EXACTLY what this slice changes, so the fixture is
 * repointed to a genuinely non-media block type ("audio") to keep proving the
 * placeholder survives for types slice B3 does not touch. The image-content
 * describe block below covers acceptance/rejection of `type:"image"` itself.
 */

import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PER_MESSAGE,
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_RESULT_MAX_BYTES,
  MCP_RESULT_MAX_MODEL_BYTES,
  MCP_TOOL_DESCRIPTION_MAX_BYTES,
} from "../types/config.js";
import type { ChatMessage, ToolResultPart } from "../types/history.js";
import type { ToolContext, ToolMetadata } from "../types/tools.js";
import { toSdkMessages } from "../provider/sdk-mapping.js";
import {
  bridgeMcpTool,
  bridgeServerTools,
  bridgedToolName,
  type McpCallOutcome,
  type McpContentBlock,
  type McpRawTool,
} from "./tool-bridge.js";

/** A real 1x1 PNG (same fixture as image-wire.integration.test.ts): honest magic bytes for a meaningful sniff/round-trip. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** JPEG magic-byte header only (matches util/images.test.ts's JPEG_HEADER) — sniffImageMediaType reads only the leading bytes. */
const JPEG_HEADER_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

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
  // TASK.93: the model budget is tighter than the inline cap above.
  resultBudget: { maxModelBytes: MCP_RESULT_MAX_MODEL_BYTES },
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

  it("renders non-text, non-image content as a placeholder marker", async () => {
    // TASK.198 slice B3: this pin used to use `type:"image"` as its fixture;
    // that block type now goes through acceptImageBlock instead of this
    // generic branch, so the fixture is repointed to "audio" (untouched by
    // the slice) to keep proving the placeholder survives for other types.
    const def = bridgeMcpTool({ serverName: "srv", transport: "stdio", tool: { name: "t" }, callTool: fixedCall({ kind: "result", content: [{ type: "audio", data: "…", mimeType: "audio/mpeg" }], isError: false }) });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe("[non-text content: audio]");
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

describe("bridgeMcpTool — image content (TASK.198 slice B3)", () => {
  it("accepts a valid image block into `images`, replacing the old placeholder", async () => {
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      callTool: fixedCall({ kind: "result", content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }], isError: false }),
    });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.images).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
    expect(res.output).not.toContain("[non-text content:");
    expect(res.output).toBe("[image attached]");
  });

  it("drops an image block with invalid base64 data, noting the reason (images stays empty)", async () => {
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      // "…" is a single non-base64 character: fails the strict base64 charset+length check.
      callTool: fixedCall({ kind: "result", content: [{ type: "image", data: "…", mimeType: "image/png" }], isError: false }),
    });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.images ?? []).toHaveLength(0);
    expect(res.output).toContain("base64");
    expect(res.output).not.toBe("[non-text content: image]");
  });

  it("rejects an over-cap image via a length precheck, without decoding it", async () => {
    // Encoded length alone (before any decode) already implies a decoded size
    // over IMAGE_MAX_BYTES: the precheck must reject BEFORE Buffer.from(_,
    // "base64") is ever called with this payload.
    const encodedLength = Math.ceil((IMAGE_MAX_BYTES + 3_000_000) / 3) * 4;
    const huge = "A".repeat(encodedLength);
    const bufferFromSpy = vi.spyOn(Buffer, "from");
    try {
      const def = bridgeMcpTool({
        serverName: "srv",
        transport: "stdio",
        tool: { name: "t" },
        callTool: fixedCall({ kind: "result", content: [{ type: "image", data: huge, mimeType: "image/png" }], isError: false }),
      });
      const res = await def.handler({}, ctx());
      expect(res.ok).toBe(true);
      expect(res.images ?? []).toHaveLength(0);
      expect(res.output).toContain(String(IMAGE_MAX_BYTES));
      expect(bufferFromSpy.mock.calls.some(([arg]) => arg === huge)).toBe(false);
    } finally {
      bufferFromSpy.mockRestore();
    }
  });

  it("drops an image whose declared mimeType does not match the sniffed bytes", async () => {
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      // Bytes sniff as JPEG; the block declares PNG — an untrusted server's claim loses.
      callTool: fixedCall({ kind: "result", content: [{ type: "image", data: JPEG_HEADER_B64, mimeType: "image/png" }], isError: false }),
    });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.images ?? []).toHaveLength(0);
    expect(res.output).toContain("image/png");
    expect(res.output).toContain("image/jpeg");
  });

  it(`caps accepted images at IMAGE_MAX_PER_MESSAGE (${IMAGE_MAX_PER_MESSAGE}), noting the tail drop`, async () => {
    const blocks: McpContentBlock[] = Array.from({ length: IMAGE_MAX_PER_MESSAGE + 1 }, () => ({
      type: "image",
      data: PNG_B64,
      mimeType: "image/png",
    }));
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      callTool: fixedCall({ kind: "result", content: blocks, isError: false }),
    });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.images).toHaveLength(IMAGE_MAX_PER_MESSAGE);
    expect(res.output).toContain("cap");
  });

  it("keeps text and a resource placeholder while attaching a mixed-content image", async () => {
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      callTool: fixedCall({
        kind: "result",
        content: [
          { type: "text", text: "here is the screenshot" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///x" } },
        ],
        isError: false,
      }),
    });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.images).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
    expect(res.output).toContain("here is the screenshot");
    expect(res.output).toContain("[non-text content: resource]");
  });

  it("does not attach images on an isError result (falls back to the generic placeholder)", async () => {
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      callTool: fixedCall({ kind: "result", content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }], isError: true }),
    });
    const res = await def.handler({}, ctx());
    expect(res.ok).toBe(false);
    expect(res.images).toBeUndefined();
    expect(res.error).toBe("[non-text content: image]");
  });
});

describe("bridgeMcpTool — image content across the SDK mapping (TASK.198 slice B3 integration)", () => {
  it("an MCP tool-result image survives on anthropic-messages and is stripped-with-a-note on the openai transports", async () => {
    const def = bridgeMcpTool({
      serverName: "srv",
      transport: "stdio",
      tool: { name: "t" },
      callTool: fixedCall({
        kind: "result",
        content: [
          { type: "text", text: "screenshot" },
          { type: "image", data: PNG_B64, mimeType: "image/png" },
        ],
        isError: false,
      }),
    });
    const result = await def.handler({}, ctx());
    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1);

    const toolResultPart: ToolResultPart = {
      type: "tool_result",
      toolCallId: "call_1",
      toolName: "mcp__srv__t",
      text: String(result.output),
      images: result.images,
      status: "success",
    };
    const toolMessage: ChatMessage = { role: "tool", content: [toolResultPart] };

    interface SdkToolMessage {
      content: Array<{ output: { type: string; value: unknown } }>;
    }

    const [anthropicMessage] = toSdkMessages([toolMessage], "anthropic-messages");
    const anthropicOutput = (anthropicMessage as SdkToolMessage).content[0]!.output;
    expect(anthropicOutput.type).toBe("content");
    const anthropicParts = anthropicOutput.value as Array<{ type: string; mediaType?: string; data?: { data: string } }>;
    expect(
      anthropicParts.some(
        (part) => part.type === "file" && part.mediaType === "image/png" && part.data?.data === PNG_B64,
      ),
    ).toBe(true);

    const [openaiMessage] = toSdkMessages([toolMessage], "openai-chat-completions");
    const openaiOutput = (openaiMessage as SdkToolMessage).content[0]!.output;
    expect(openaiOutput.type).toBe("text");
    expect(String(openaiOutput.value)).toContain("image omitted");
    expect(String(openaiOutput.value)).not.toContain(PNG_B64);
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

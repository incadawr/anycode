/**

 * §6#1). Runs the REAL `@ai-sdk/anthropic` + `ai` stack (via AiSdkModelPort)
 * against a local `node:http` capture server on 127.0.0.1:<ephemeral> — the
 * exact harness of sse-fixture.integration.test.ts. The server captures the
 * outgoing POST body and replies with a minimal valid anthropic SSE stream so
 * the stream completes cleanly. Zero external network.
 *
 * The mapping in sdk-mapping.ts flexes to whatever anthropic wire shape these
 * asserts pin — the shape is fixed by the anthropic HTTP API, not by our types

 * with byte-for-byte base64; (b) a tool-result image serializes to an image
 * block INSIDE the tool_result block with the correct tool_use_id; (c) an
 * image-free request's messages deep-equal the pre-slice serialization.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";

/** A real 1×1 PNG: honest magic bytes, so the base64 round-trip is meaningful. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Minimal valid anthropic SSE so the AiSdkModelPort stream finishes without error. */
const RESPONSE_CHUNKS: ReadonlyArray<Record<string, unknown>> = [
  { type: "message_start", message: { id: "msg_1", model: "claude-x", role: "assistant", usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

function serializeSse(chunks: ReadonlyArray<Record<string, unknown>>): string {
  return chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
}

async function drain(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

interface AnthropicBlock {
  type: string;
  source?: { type: string; media_type?: string; data?: string };
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}
interface AnthropicMessage {
  role: string;
  content: AnthropicBlock[] | string;
}
interface AnthropicBody {
  messages: AnthropicMessage[];
  [key: string]: unknown;
}

/** All image blocks appearing directly in a message's top-level content. */
function topLevelImageBlocks(body: AnthropicBody): AnthropicBlock[] {
  const out: AnthropicBlock[] = [];
  for (const message of body.messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "image") out.push(block);
      }
    }
  }
  return out;
}

/** Every tool_result block across the message list. */
function toolResultBlocks(body: AnthropicBody): AnthropicBlock[] {
  const out: AnthropicBlock[] = [];
  for (const message of body.messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_result") out.push(block);
      }
    }
  }
  return out;
}

describe("image mapping over the real @ai-sdk/anthropic wire (slice 6.2 B6)", () => {
  let server: Server;
  let baseUrl: string;
  let capturedBody: AnthropicBody | undefined;

  beforeEach(async () => {
    capturedBody = undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicBody;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(serializeSse(RESPONSE_CHUNKS));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function portFor(): AiSdkModelPort {
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "claude-x",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    return new AiSdkModelPort(config);
  }

  it("(a) serializes a user image to an anthropic base64 image block, byte-for-byte", async () => {
    const request: ModelRequest = {
      messages: [{ role: "user", content: "look at this bug", images: [{ mediaType: "image/png", data: PNG_B64 }] }],
      tools: [],
    };

    const events = await drain(portFor().streamText(request));
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(capturedBody).toBeDefined();

    const images = topLevelImageBlocks(capturedBody!);
    expect(images).toHaveLength(1);
    const [imageBlock] = images;
    expect(imageBlock).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    });
    // Byte-for-byte: decode the captured base64 and compare to the original bytes.
    const capturedData = imageBlock?.source?.data ?? "";
    expect(Buffer.from(capturedData, "base64").equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
  });

  it("(b) serializes a tool-result image to an image block inside tool_result with the right tool_use_id", async () => {
    const request: ModelRequest = {
      messages: [
        { role: "user", content: "read the screenshot" },
        { role: "assistant", content: [{ type: "tool_call", toolCallId: "call_1", toolName: "Read", input: {} }] },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "call_1",
              toolName: "Read",
              text: "[image attached]",
              images: [{ mediaType: "image/png", data: PNG_B64 }],
              status: "success",
            },
          ],
        },
      ],
      tools: [],
    };

    const events = await drain(portFor().streamText(request));
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(capturedBody).toBeDefined();

    // No image at the top level; the image rides inside the tool_result block.
    expect(topLevelImageBlocks(capturedBody!)).toEqual([]);
    const toolResults = toolResultBlocks(capturedBody!);
    expect(toolResults).toHaveLength(1);
    const [toolResult] = toolResults;
    expect(toolResult?.tool_use_id).toBe("call_1");

    const inner = toolResult?.content as AnthropicBlock[];
    expect(Array.isArray(inner)).toBe(true);
    const innerImages = inner.filter((b) => b.type === "image");
    expect(innerImages).toHaveLength(1);
    expect(innerImages[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    });
    // The model-visible placeholder text also rides along as a text block.
    expect(inner.some((b) => b.type === "text" && b.text === "[image attached]")).toBe(true);
  });

  it("(c) image-free request messages deep-equal the pre-slice serialization", async () => {
    const request: ModelRequest = { messages: [{ role: "user", content: "hello" }], tools: [] };

    const events = await drain(portFor().streamText(request));
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(capturedBody).toBeDefined();

    expect(capturedBody!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    // Zero image/base64 anywhere in the image-free body (byte-lock spot-check).
    expect(JSON.stringify(capturedBody)).not.toContain("base64");
    expect(JSON.stringify(capturedBody)).not.toContain("\"image\"");
  });
});

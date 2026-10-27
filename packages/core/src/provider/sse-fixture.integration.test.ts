/**
 * End-to-end proof of R1 through the REAL `@ai-sdk/anthropic` + `ai` stack
 * (slice 3.7 §3.1, mirrors mcp/manager.integration.test.ts / the fake-IdP of
 * slice 2.5): a local `node:http` server on 127.0.0.1:<ephemeral> streams a
 * `text/event-stream` reproducing z.ai's shape — a server built-in `webReader`
 * call followed by its result carried as a `content_block_start` with the
 * non-standard `content_block.type: "tool_result"` (absent from the SDK's
 * closed chunk union) — then a normal text block and message close.
 *
 * The unpatched `AiSdkModelPort` would yield that unparsable chunk as an
 * `error` event mid-stream and kill the turn. Here we assert the real port
 * emits start / text / finish, ZERO `error` events, and never throws — the
 * finish and the text AFTER the artifact both arrive. Zero external network:
 * everything is 127.0.0.1 with an OS-assigned port.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";

/** z.ai-shaped SSE chunk sequence (design §3.1): the `tool_result` block is the artifact. */
const CHUNKS: ReadonlyArray<Record<string, unknown>> = [
  {
    type: "message_start",
    message: { id: "msg_1", model: "glm-5.2", role: "assistant", usage: { input_tokens: 17 } },
  },
  // The server built-in webReader CALL — a valid `server_tool_use` block the SDK
  // silently drops for an unknown tool name (webReader != web_fetch/web_search/...).
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "server_tool_use", id: "srvtool_1", name: "webReader", input: { url: "https://example.com" } },
  },
  { type: "content_block_stop", index: 0 },
  // The webReader RESULT — z.ai streams it as a `tool_result` content block,
  // which is NOT in the SDK's closed union: chunk parse fails here.
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_result", tool_use_id: "srvtool_1", content: "Example Domain — reserved for documentation." },
  },
  { type: "content_block_stop", index: 1 },
  // A normal text block AFTER the artifact — proves the stream keeps flowing.
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "text_delta", text: "Example Domain is a reserved documentation site." },
  },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 21 } },
  { type: "message_stop" },
];

function serializeSse(chunks: ReadonlyArray<Record<string, unknown>>): string {
  return chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe("AiSdkModelPort over a real @ai-sdk/anthropic SSE stream (slice 3.7 R1)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheRead: number | undefined;
  let capturedRaw: string;

  beforeEach(async () => {
    cacheRead = undefined;
    capturedRaw = "";
    server = createServer((req, res) => {
      // Drain the request into the capture buffer so the socket is not held
      // open AND the outgoing bytes are inspectable (GitHub #15: the anthropic
      // transport must never emit an OpenAI cache field).
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        capturedRaw = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(serializeSse(CHUNKS.map((chunk) => chunk.type === "message_start"
        ? { ...chunk, message: { id: "msg_1", model: "glm-5.2", role: "assistant",
          usage: { input_tokens: 17, ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}) } } }
        : chunk)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it.each([undefined, 0, 80])("preserves Anthropic cache reads: %s", async (cached) => {
    cacheRead = cached;
    const events = await collect(new AiSdkModelPort({
      transport: "anthropic-messages", baseUrl, apiKey: "test-key", model: "glm-5.2",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    }).streamText({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.find((e) => e.type === "finish")).toMatchObject({
      type: "finish", usage: { cachedInputTokens: cached ?? 0 },
    });
  });

  it("drops the unparsable `tool_result` artifact and still delivers start / text / finish", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "glm-5.2",
      // Isolate the drop behaviour: no retries, no stall watchdog.
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    const request: ModelRequest = { messages: [{ role: "user", content: "Fetch https://example.com" }], tools: [] };

    const events: ModelStreamEvent[] = await collect(new AiSdkModelPort(config).streamText(request));

    // No `error` event ever reached the consumer (the loop would have died on it).
    expect(events.filter((e) => e.type === "error")).toEqual([]);

    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();

    const text = events
      .filter((e): e is Extract<ModelStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toContain("Example Domain is a reserved documentation site.");

    const finishes = events.filter((e) => e.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ type: "finish", finishReason: "stop" });

    // The drop was warned (once — a single artifact signature).
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // GitHub #15: the anthropic-messages transport must ignore the opt-in cache
  // policy entirely — no OpenAI `prompt_cache_options` (or Anthropic-style
  // `cache_control`) may ever reach the wire, even when the endpoint config
  // carries an enabled value.
  it("ignores an enabled promptCache policy — no OpenAI/Anthropic cache field reaches the wire", async () => {
    const events = await collect(
      new AiSdkModelPort({
        transport: "anthropic-messages",
        baseUrl,
        apiKey: "test-key",
        model: "glm-5.2",
        retry: { maxRetries: 0, stallTimeoutMs: 0 },
        promptCache: { mode: "implicit", ttl: "30m" },
      }).streamText({ messages: [{ role: "user", content: "hi" }], tools: [] }),
    );
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(capturedRaw).not.toContain("prompt_cache_options");
    expect(capturedRaw).not.toContain("promptCacheOptions");
    expect(capturedRaw).not.toContain("cache_control");
  });
});

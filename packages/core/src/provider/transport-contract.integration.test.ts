/**
 * Cross-transport contract suite (TASK.43 §0.8/W3): the SAME eight scenarios —
 * text-only, tool round-trip, parallel tools, abort, retry-before-first-event,
 * mid-stream failure, images, maxOutputTokens — run against all THREE real
 * client stacks (`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`,
 * `@ai-sdk/openai`) through `AiSdkModelPort`, each over its own loopback SSE
 * server on 127.0.0.1:<ephemeral>. Zero external network.
 *
 * This does NOT replace the transport-specific fixtures (sse-fixture /
 * openai-sse-fixture / openai-responses-sse-fixture), which pin each wire
 * format's request-body specifics (tool_choice shape, headers, store:false,
 * reasoning). This file instead pins that the ModelPort's OBSERVABLE PORT
 * CONTRACT — the translated event vocabulary the agent loop actually consumes
 * — is identical in shape and semantics across the three transports, even
 * though each wire protocol gets there via a completely different SSE shape.
 *
 * A genuine, transport-AGNOSTIC finding surfaced while building the
 * "retry-before-first-event" scenario against the REAL `ai@7.0.14` core
 * (not the hand-rolled generator mocks in model-port.test.ts): `ai` core's
 * public `fullStream` is a `ReadableStream` whose `start()` handler enqueues
 * an unconditional `{type:"start"}` as the VERY FIRST item, before `doStream()`
 * — i.e. before any real network I/O — ever runs (verified by reading
 * `ai@7.0.14` dist and by a live probe against all three transports: a
 * destroyed socket on the first connection attempt always surfaces as a
 * translated `{type:"error"}` STREAM PART, never a thrown exception, and it
 * arrives strictly after `{type:"start"}`). `AiSdkModelPort`'s retry gate is
 * `!yieldedEvent`, and its own docstring already documents the intent
 * ("once any event (even `start`) has reached the consumer, a NON-stall error
 * propagates/gets yielded as-is") — so this is DELIBERATE, DOCUMENTED
 * behavior, not a bug this wave introduced. The practical, previously-hidden
 * consequence: a same-attempt connect/reset failure is classified retryable by
 * `retry.ts` (`isRetryableStreamError` returns true for it) but is NEVER
 * actually retried in production, on ANY transport, because `start` always
 * wins the race. This is flagged for TASK.33 ("observable retry" — the cut's
 * own W7 explicitly targets retry/abort/stall race conditions); this wave does
 * NOT touch `model-port.ts`'s retry loop, which is a different task's scope.
 * The scenario below pins the REAL, uniform, current behavior rather than a
 * scenario the real SDK cannot produce.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ToolDeclaration } from "../types/tools.js";
import { isRetryableStreamError } from "./retry.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { EndpointConfig } from "./endpoint.js";
import type { ProviderTransport } from "./catalog.js";
import { AiSdkModelPort } from "./model-port.js";

interface CapturedRequest {
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface ToolCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface TransportKit {
  transport: ProviderTransport;
  model: string;
  /** Expected suffix of the request URL for a sanity check. */
  requestPathSuffix: string;
  buildConfig(baseUrl: string, overrides?: Partial<EndpointConfig>): EndpointConfig;
  serialize(frames: ReadonlyArray<Record<string, unknown>>): string;
  textOnlyFrames(text: string): ReadonlyArray<Record<string, unknown>>;
  toolCallFrames(calls: ToolCallSpec[]): ReadonlyArray<Record<string, unknown>>;
  /** Some text, then a genuine stream-level failure (not an HTTP-level error). */
  midStreamFailureFrames(partialText: string): ReadonlyArray<Record<string, unknown>>;
  /** A response truncated by the token budget (provider-native truncation signal). */
  maxOutputTokensFrames(partialText: string): ReadonlyArray<Record<string, unknown>>;
  /** Base64 payload(s) of every user-message image found in the captured request body. */
  extractUserImageBase64(body: Record<string, unknown>): string[];
  /** A single successful request/response round trip, used by the retry scenario's final attempt. */
  buildRequest(overrides?: Partial<ModelRequest>): ModelRequest;
}

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const READ_TOOL: ToolDeclaration = {
  name: "Read",
  description: "Reads a file",
  inputJsonSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
};
const WRITE_TOOL: ToolDeclaration = {
  name: "Write",
  description: "Writes a file",
  inputJsonSchema: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"],
  },
};

function baseRequest(): ModelRequest {
  return { messages: [{ role: "user", content: "hi" }], tools: [] };
}

// ---------------------------------------------------------------------------
// anthropic-messages
// ---------------------------------------------------------------------------

function anthropicMessageStart(): Record<string, unknown> {
  return { type: "message_start", message: { id: "msg_1", model: "claude-x", role: "assistant", usage: { input_tokens: 10 } } };
}

const anthropicKit: TransportKit = {
  transport: "anthropic-messages",
  model: "claude-x",
  requestPathSuffix: "/v1/messages",
  buildConfig: (baseUrl, overrides = {}) => ({
    transport: "anthropic-messages",
    baseUrl,
    apiKey: "test-key",
    model: "claude-x",
    retry: { maxRetries: 0, stallTimeoutMs: 0 },
    ...overrides,
  }),
  serialize: (frames) => frames.map((f) => `event: ${f.type as string}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  textOnlyFrames: (text) => [
    anthropicMessageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ],
  toolCallFrames: (calls) => {
    const frames: Record<string, unknown>[] = [anthropicMessageStart()];
    calls.forEach((call, index) => {
      frames.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
      frames.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } });
      frames.push({ type: "content_block_stop", index });
    });
    frames.push({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
    frames.push({ type: "message_stop" });
    return frames;
  },
  midStreamFailureFrames: (partialText) => [
    anthropicMessageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: partialText } },
    { type: "content_block_stop", index: 0 },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded mid-stream" } },
  ],
  maxOutputTokensFrames: (partialText) => [
    anthropicMessageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: partialText } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 999 } },
    { type: "message_stop" },
  ],
  extractUserImageBase64: (body) => {
    const messages = body.messages as Array<{ content: unknown }> | undefined;
    const out: string[] = [];
    for (const message of messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "image") {
          const source = block.source as { data?: string } | undefined;
          if (source?.data) out.push(source.data);
        }
      }
    }
    return out;
  },
  buildRequest: (overrides) => ({ ...baseRequest(), ...overrides }),
};

// ---------------------------------------------------------------------------
// openai-chat-completions
// ---------------------------------------------------------------------------

const chatCompletionsKit: TransportKit = {
  transport: "openai-chat-completions",
  model: "gpt-oss-120b",
  requestPathSuffix: "/chat/completions",
  buildConfig: (baseUrl, overrides = {}) => ({
    transport: "openai-chat-completions",
    baseUrl,
    apiKey: "test-key",
    model: "gpt-oss-120b",
    retry: { maxRetries: 0, stallTimeoutMs: 0 },
    ...overrides,
  }),
  serialize: (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n",
  textOnlyFrames: (text) => [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ],
  toolCallFrames: (calls) => [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ],
  midStreamFailureFrames: (partialText) => [
    { choices: [{ index: 0, delta: { role: "assistant", content: partialText }, finish_reason: null }] },
    { error: { message: "server error mid-stream", type: "server_error" } },
  ],
  maxOutputTokensFrames: (partialText) => [
    { choices: [{ index: 0, delta: { role: "assistant", content: partialText }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 999, total_tokens: 1009 } },
  ],
  extractUserImageBase64: (body) => {
    const messages = body.messages as Array<{ content: unknown }> | undefined;
    const out: string[] = [];
    for (const message of messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === "image_url") {
          const imageUrl = part.image_url as { url?: string } | undefined;
          const url = imageUrl?.url ?? "";
          const match = /;base64,(.+)$/.exec(url);
          if (match) out.push(match[1]!);
        }
      }
    }
    return out;
  },
  buildRequest: (overrides) => ({ ...baseRequest(), ...overrides }),
};

// ---------------------------------------------------------------------------
// openai-responses
// ---------------------------------------------------------------------------

function responsesCreated(): Record<string, unknown> {
  return { type: "response.created", response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.1" } };
}

function responsesUsage(output: number): Record<string, unknown> {
  return {
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

const responsesKit: TransportKit = {
  transport: "openai-responses",
  model: "gpt-5.1",
  requestPathSuffix: "/responses",
  buildConfig: (baseUrl, overrides = {}) => ({
    transport: "openai-responses",
    baseUrl,
    apiKey: "test-key",
    model: "gpt-5.1",
    retry: { maxRetries: 0, stallTimeoutMs: 0 },
    ...overrides,
  }),
  serialize: (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""),
  textOnlyFrames: (text) => [
    responsesCreated(),
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.completed", response: responsesUsage(5) },
  ],
  toolCallFrames: (calls) => {
    const frames: Record<string, unknown>[] = [responsesCreated()];
    calls.forEach((call, index) => {
      frames.push({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "function_call", id: `item_${index}`, call_id: call.id, name: call.name, arguments: "" },
      });
      frames.push({
        type: "response.output_item.done",
        output_index: index,
        item: {
          type: "function_call",
          id: `item_${index}`,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
          status: "completed",
        },
      });
    });
    frames.push({ type: "response.completed", response: responsesUsage(5) });
    return frames;
  },
  midStreamFailureFrames: (partialText) => [
    responsesCreated(),
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: partialText },
    {
      type: "response.failed",
      sequence_number: 1,
      response: { error: { code: "server_error", message: "Failed mid-stream" }, ...responsesUsage(3) },
    },
  ],
  maxOutputTokensFrames: (partialText) => [
    responsesCreated(),
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: partialText },
    {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" }, ...responsesUsage(999) },
    },
  ],
  extractUserImageBase64: (body) => {
    const input = body.input as Array<{ role?: string; content?: unknown }> | undefined;
    const out: string[] = [];
    for (const item of input ?? []) {
      if (item.role !== "user" || !Array.isArray(item.content)) continue;
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part.type === "input_image") {
          const url = (part.image_url as string | undefined) ?? "";
          const match = /;base64,(.+)$/.exec(url);
          if (match) out.push(match[1]!);
        }
      }
    }
    return out;
  },
  buildRequest: (overrides) => ({ ...baseRequest(), ...overrides }),
};

const KITS: readonly TransportKit[] = [anthropicKit, chatCompletionsKit, responsesKit];

// ---------------------------------------------------------------------------
// shared server harness
// ---------------------------------------------------------------------------

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

function textOf(events: ModelStreamEvent[]): string {
  return events
    .filter((e): e is Extract<ModelStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
}

describe.each(KITS)("cross-transport contract: $transport", (kit) => {
  let server: Server;
  let baseUrl: string;
  let captured: CapturedRequest | undefined;
  let responseChunks: ReadonlyArray<Record<string, unknown>> = [];

  beforeEach(async () => {
    captured = undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        captured = { url: req.url, headers: req.headers, body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>) };
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(kit.serialize(responseChunks));
      });
    });
    baseUrl = `${await listen(server)}/v1`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("text-only: streams text and finishes with stop, zero errors", async () => {
    responseChunks = kit.textOnlyFrames("Hello there");
    const events = await collect(new AiSdkModelPort(kit.buildConfig(baseUrl)).streamText(kit.buildRequest()));

    expect(captured?.url).toMatch(new RegExp(`${kit.requestPathSuffix.replace(/\//g, "\\/")}$`));
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events[0]).toEqual({ type: "start" });
    expect(textOf(events)).toBe("Hello there");
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("tool round-trip: a single tool call arrives with parsed input and finishReason tool_calls", async () => {
    responseChunks = kit.toolCallFrames([{ id: "call_1", name: "Read", args: { file_path: "/a.txt" } }]);
    const request = kit.buildRequest({ tools: [READ_TOOL], messages: [{ role: "user", content: "read /a.txt" }] });
    const events = await collect(new AiSdkModelPort(kit.buildConfig(baseUrl)).streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const toolCall = events.find((e): e is Extract<ModelStreamEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolCall).toMatchObject({ id: "call_1", name: "Read", input: { file_path: "/a.txt" } });
    expect(toolCall!.toolCall.invalid).toBeUndefined();
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });

  it("parallel tools: two distinct tool calls both arrive with their own ids/inputs", async () => {
    responseChunks = kit.toolCallFrames([
      { id: "call_1", name: "Read", args: { file_path: "/a.txt" } },
      { id: "call_2", name: "Write", args: { file_path: "/b.txt", content: "hi" } },
    ]);
    const request = kit.buildRequest({ tools: [READ_TOOL, WRITE_TOOL], messages: [{ role: "user", content: "read a, write b" }] });
    const events = await collect(new AiSdkModelPort(kit.buildConfig(baseUrl)).streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const toolCalls = events.filter((e): e is Extract<ModelStreamEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((e) => e.toolCall.id).sort()).toEqual(["call_1", "call_2"]);
    const byId = new Map(toolCalls.map((e) => [e.toolCall.id, e.toolCall]));
    expect(byId.get("call_1")).toMatchObject({ name: "Read", input: { file_path: "/a.txt" } });
    expect(byId.get("call_2")).toMatchObject({ name: "Write", input: { file_path: "/b.txt", content: "hi" } });
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });

  it("images: a user-message image survives on the wire as a base64 payload byte-identical to the source", async () => {
    responseChunks = kit.textOnlyFrames("ok");
    const request = kit.buildRequest({
      messages: [{ role: "user", content: "look at this", images: [{ mediaType: "image/png", data: PNG_B64 }] }],
    });
    const events = await collect(new AiSdkModelPort(kit.buildConfig(baseUrl)).streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured).toBeDefined();
    const images = kit.extractUserImageBase64(captured!.body);
    expect(images).toHaveLength(1);
    expect(Buffer.from(images[0]!, "base64").equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
  });

  it("maxOutputTokens: a token-budget-truncated response maps to finishReason length", async () => {
    responseChunks = kit.maxOutputTokensFrames("truncated by budget");
    const request = kit.buildRequest({ maxOutputTokens: 16 });
    const events = await collect(new AiSdkModelPort(kit.buildConfig(baseUrl)).streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(textOf(events)).toBe("truncated by budget");
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish", finishReason: "length" });
  });

  it("mid-stream failure: partial text survives, an error event fires, and finish (when present) never claims success", async () => {
    responseChunks = kit.midStreamFailureFrames("partial answer");
    const events = await collect(new AiSdkModelPort(kit.buildConfig(baseUrl)).streamText(kit.buildRequest()));

    expect(textOf(events)).toBe("partial answer");
    expect(events.some((e) => e.type === "error")).toBe(true);
    // `ai` core synthesizes a trailing finish once the source stream ends,
    // regardless of whether the specific provider transform itself enqueued
    // one (verified empirically for all three transports) — identically
    // "error", never a success reason, on all three.
    expect(events.find((e) => e.type === "finish")).toMatchObject({ type: "finish", finishReason: "error" });
    expect(events.some((e) => e.type === "finish" && (e.finishReason === "stop" || e.finishReason === "tool_calls"))).toBe(false);
  });

  it("abort: aborting mid-request rejects promptly without waiting for a response", async () => {
    const hangServer = createServer((req) => {
      req.resume(); // drain, then never respond — the connection just hangs
    });
    const hangBaseUrl = `${await listen(hangServer)}/v1`;
    try {
      const controller = new AbortController();
      const port = new AiSdkModelPort(kit.buildConfig(hangBaseUrl, { retry: { maxRetries: 0, stallTimeoutMs: 0 } }));
      const request = kit.buildRequest({ abortSignal: controller.signal });
      const iterator = port.streamText(request)[Symbol.asyncIterator]();

      // `ai` core's fullStream unconditionally yields a synthetic `{type:"start"}`
      // as its very first item, before any network I/O runs (see file docstring)
      // — consume it first so the SECOND `next()` is the one that actually
      // blocks on (and is cancelled by) the in-flight request.
      const first = await iterator.next();
      expect(first.value).toEqual({ type: "start" });

      const pending = iterator.next();
      // Give the request a tick to actually leave the process before aborting,
      // so this proves real in-flight cancellation, not "never started".
      await new Promise((resolve) => setTimeout(resolve, 20));
      const abortReason = new Error("stopped by caller");
      controller.abort(abortReason);

      const start = Date.now();
      await expect(pending).rejects.toBeDefined();
      expect(Date.now() - start).toBeLessThan(2_000);
    } finally {
      await closeServer(hangServer);
    }
  });

  it("retry-before-first-event: documents the real, uniform, current behavior — a connect failure is classified retryable but is not retried once the SDK's synthetic start has fired (TASK.33 finding, see file docstring)", async () => {
    let attempts = 0;
    const flakyServer = createServer((req, res) => {
      attempts += 1;
      // Abrupt reset before any response.
      req.socket.destroy();
      void res;
    });
    const flakyBaseUrl = `${await listen(flakyServer)}/v1`;
    try {
      const port = new AiSdkModelPort(
        kit.buildConfig(flakyBaseUrl, { retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, stallTimeoutMs: 0 } }),
      );
      const events = await collect(port.streamText(kit.buildRequest()));

      // start, then the connect failure as a translated error — no throw, no
      // stream_retry, and exactly ONE request ever reached the server: the
      // "no event yet" retry gate is already closed by the synthetic start.
      expect(events[0]).toEqual({ type: "start" });
      const errorEvent = events.find((e): e is Extract<ModelStreamEvent, { type: "error" }> => e.type === "error");
      expect(errorEvent).toBeDefined();
      // The classifier itself is correct — the failure IS retryable in
      // principle; it just never reaches AiSdkModelPort's retry path here.
      expect(isRetryableStreamError(errorEvent!.error)).toBe(true);
      expect(events.some((e) => e.type === "stream_retry")).toBe(false);
      expect(attempts).toBe(1);
    } finally {
      await closeServer(flakyServer);
    }
  });
});

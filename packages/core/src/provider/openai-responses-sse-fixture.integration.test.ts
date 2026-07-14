/**
 * End-to-end proof of the openai-responses transport (TASK.43 §0.8/W3) through
 * the REAL `@ai-sdk/openai` + `ai` stack (mirrors openai-sse-fixture.integration.test.ts's
 * harness): a local `node:http` server on 127.0.0.1:<ephemeral> captures the
 * outgoing request and replies with a stream shaped like the real OpenAI
 * Responses API (`POST /responses`, `data: {...}` frames whose JSON payload
 * itself carries a `type` like `response.output_text.delta` — the SDK's parser
 * keys off that field, not the SSE `event:` line, so plain `data:` frames are
 * sufficient and match the sibling chat-completions fixture's style).
 *
 * Response item/event shapes below are reverse-engineered from the installed
 * `@ai-sdk/openai@4.0.14` dist (`openaiResponsesChunkSchema` and the stream
 * transform in `dist/index.js`), not guessed from docs: the exact required
 * fields per event type, and the crucial fact that a streamed `function_call`'s
 * full `arguments` string rides on `response.output_item.done` (not assembled
 * client-side from `response.function_call_arguments.delta`, which is only a
 * cosmetic streaming preview here).
 *
 * Zero external network: everything is 127.0.0.1 with an OS-assigned port.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ToolDeclaration } from "../types/tools.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { EndpointConfig } from "./endpoint.js";
import { AiSdkModelPort } from "./model-port.js";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

function serializeResponsesSse(chunks: ReadonlyArray<Record<string, unknown>>): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

const READ_TOOL: ToolDeclaration = {
  name: "Read",
  description: "Reads a file",
  inputJsonSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
};

/** A minimal `response.created` frame — always the first event on a real stream. */
function created(id = "resp_1"): Record<string, unknown> {
  return { type: "response.created", response: { id, created_at: 1_700_000_000, model: "gpt-5.1" } };
}

/** A minimal `response.completed` usage/finish frame. Output items are NOT re-sent here on the streaming path. */
function completed(usage: { input: number; output: number; cached?: number; reasoning?: number }): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: usage.input,
        input_tokens_details: { cached_tokens: usage.cached ?? 0 },
        output_tokens: usage.output,
        output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
      },
    },
  };
}

describe("AiSdkModelPort over a real @ai-sdk/openai Responses SSE stream (TASK.43 W3)", () => {
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
        captured = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
        };
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(serializeResponsesSse(responseChunks));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function portFor(config: Partial<EndpointConfig> = {}): AiSdkModelPort {
    const full: EndpointConfig = {
      transport: "openai-responses",
      baseUrl,
      apiKey: "test-key",
      model: "gpt-5.1",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
      ...config,
    };
    return new AiSdkModelPort(full);
  }

  it("posts to /responses with store:false in the body and streams text through finish.usage", async () => {
    responseChunks = [
      created(),
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello " },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "there" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
      completed({ input: 12, output: 4, cached: 3 }),
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    const events = await collect(portFor().streamText(request));

    // --- request bytes ---
    expect(captured).toBeDefined();
    expect(captured!.url).toBe("/v1/responses");
    expect(captured!.url).toMatch(/\/responses$/);
    expect(captured!.headers["authorization"]).toBe("Bearer test-key");
    // store:false MUST always be present — AnyCode owns history; a hidden
    // second persistence on OpenAI's servers is exactly what this prevents
    // (TASK.43 §0.2). Present here even though no reasoning was requested.
    expect(captured!.body["store"]).toBe(false);
    expect(captured!.body["stream"]).toBe(true);

    // --- translated port events ---
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events[0]).toEqual({ type: "start" });

    const text = events
      .filter((e): e is Extract<ModelStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello there");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16 },
    });
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("carries reasoning_effort in body.reasoning.effort alongside store:false on a reasoning-capable model id", async () => {
    responseChunks = [
      created(),
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
      completed({ input: 5, output: 2 }),
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [], reasoningEffort: "high" };

    await collect(portFor({ model: "gpt-5.1" }).streamText(request));

    expect(captured!.body["store"]).toBe(false);
    expect(captured!.body["reasoning"]).toMatchObject({ effort: "high" });
  });

  it("does the full function_call round trip: tool-input streaming, tool_call with the FULL parsed arguments, finishReason tool_calls", async () => {
    responseChunks = [
      created(),
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "item_1", call_id: "call_1", name: "Read", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, delta: '{"file_path"' },
      { type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, delta: ':"/a.txt"}' },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_1",
          name: "Read",
          arguments: '{"file_path":"/a.txt"}',
          status: "completed",
        },
      },
      completed({ input: 8, output: 6 }),
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "read /a.txt" }], tools: [READ_TOOL] };

    const events = await collect(portFor().streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const inputDeltas = events.filter((e) => e.type === "tool_input_delta");
    expect(inputDeltas.length).toBeGreaterThan(0);

    const toolCall = events.find((e): e is Extract<ModelStreamEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolCall).toMatchObject({ id: "call_1", name: "Read", input: { file_path: "/a.txt" } });
    expect(toolCall!.toolCall.invalid).toBeUndefined();

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });

  it("surfaces a genuine terminal failure (response.failed after some text already streamed) as an error event, not a silent success", async () => {
    responseChunks = [
      created(),
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "partial answer" },
      {
        type: "response.failed",
        sequence_number: 1,
        response: {
          error: { code: "content_filter", message: "Content was blocked by moderation." },
          usage: {
            input_tokens: 9,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    const events = await collect(portFor().streamText(request));

    // The partial text before the failure still arrived.
    const text = events
      .filter((e): e is Extract<ModelStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("partial answer");

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();

    // The stream still terminates in a finish (finishReason "error"), not a
    // hang or a silent "stop" — a failed generation must never look like a
    // clean success to the loop above this boundary.
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", finishReason: "error" });
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("maps a length-truncated response (response.incomplete, reason max_output_tokens) to finishReason length", async () => {
    responseChunks = [
      created(),
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "cut off" },
      {
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 4,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 16,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 16 };

    const events = await collect(portFor().streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", finishReason: "length" });
    expect(captured!.body["max_output_tokens"]).toBe(16);
  });

  it("never leaks an ambient OPENAI_API_KEY: apiKey undefined sends a deterministic empty Bearer token, not process.env", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-secret-should-never-be-sent";
    try {
      responseChunks = [
        created(),
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
        completed({ input: 1, output: 1 }),
      ];
      const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

      const events = await collect(portFor({ apiKey: undefined }).streamText(request));

      expect(events.filter((e) => e.type === "error")).toEqual([]);
      // The `Bearer ` prefix + empty token round-trips through undici with the
      // trailing space trimmed off the wire header value — what matters is that
      // it is NOT the ambient key.
      expect(captured!.headers["authorization"]).toBe("Bearer");
      expect(captured!.headers["authorization"]).not.toContain("ambient-secret-should-never-be-sent");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});

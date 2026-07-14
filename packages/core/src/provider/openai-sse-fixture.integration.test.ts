/**
 * End-to-end proof of the openai-chat-completions transport (TASK.43 §0.8/§10.2
 * p2) through the REAL `@ai-sdk/openai-compatible` + `ai` stack (mirrors
 * sse-fixture.integration.test.ts's harness): a local `node:http` server on
 * 127.0.0.1:<ephemeral> captures the outgoing request and replies with a
 * standard OpenAI-shaped chat-completions SSE stream (plain `data: {...}`
 * lines terminated by `data: [DONE]` — no `event:` framing, unlike Anthropic's
 * named-event SSE).
 *
 * This is the regression fixture for the two live LiteLLM-gateway failures
 * that motivate the whole transport (TASK.43 §1): HTTP 400 on
 * `tool_choice.type` because the Anthropic-shaped `{type:"auto"}` object was
 * forwarded as-is to a Responses-backed group, and HTTP 404 because an
 * Anthropic body was posted at an endpoint with no `/v1/messages` route. Both
 * are structural on this transport (openai-compatible always serializes
 * `tool_choice` as a bare string and always posts to `/chat/completions`), so
 * the asserts below pin the request bytes, not just the response translation.
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

function serializeOpenAiSse(chunks: ReadonlyArray<Record<string, unknown>>): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
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

describe("AiSdkModelPort over a real @ai-sdk/openai-compatible SSE stream (TASK.43 W2)", () => {
  let server: Server;
  let baseUrl: string;
  let captured: CapturedRequest | undefined;
  /** Set by each test before the request lands; drives the server's canned SSE reply. */
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
        res.end(serializeOpenAiSse(responseChunks));
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
      transport: "openai-chat-completions",
      baseUrl,
      apiKey: "test-key",
      model: "gpt-oss-120b",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
      ...config,
    };
    return new AiSdkModelPort(full);
  }

  it("posts to /chat/completions with Bearer auth (no x-api-key), include_usage, reasoning_effort, and streams through finish.usage", async () => {
    responseChunks = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking it through" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hello there" }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 3 } },
      },
    ];
    const request: ModelRequest = {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      reasoningEffort: "high",
      maxOutputTokens: 2048,
    };

    const events = await collect(portFor({ includeUsage: true }).streamText(request));

    // --- request bytes ---
    expect(captured).toBeDefined();
    expect(captured!.url).toBe("/v1/chat/completions");
    expect(captured!.url).toMatch(/\/chat\/completions$/);
    expect(captured!.headers["authorization"]).toBe("Bearer test-key");
    expect(captured!.headers["x-api-key"]).toBeUndefined();
    expect(captured!.body["stream_options"]).toEqual({ include_usage: true });
    expect(captured!.body["reasoning_effort"]).toBe("high");
    expect(captured!.body["stream"]).toBe(true);

    // --- translated port events ---
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events[0]).toEqual({ type: "start" });

    const reasoning = events
      .filter((e): e is Extract<ModelStreamEvent, { type: "reasoning_delta" }> => e.type === "reasoning_delta")
      .map((e) => e.text)
      .join("");
    expect(reasoning).toBe("thinking it through");

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
    // finish is the terminal event of the step.
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("serializes tool_choice as a bare STRING when tools are offered (the LiteLLM 400 regression, TASK.43 §1 fact #1)", async () => {
    responseChunks = [
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } },
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "list tools" }], tools: [READ_TOOL] };

    await collect(portFor().streamText(request));

    expect(captured!.body["tool_choice"]).toBe("auto");
    expect(typeof captured!.body["tool_choice"]).toBe("string");
    const tools = captured!.body["tools"] as Array<{ type: string; function: { name: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", function: { name: "Read" } });
  });

  it("assembles a vLLM-style tool call delivered in ONE chunk (full name+arguments together, no id-then-delta split)", async () => {
    responseChunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_vllm_1", type: "function", function: { name: "Read", arguments: '{"file_path":"/a.txt"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } },
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "read /a.txt" }], tools: [READ_TOOL] };

    const events = await collect(portFor().streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const toolCall = events.find((e): e is Extract<ModelStreamEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolCall).toMatchObject({ id: "call_vllm_1", name: "Read", input: { file_path: "/a.txt" } });
    expect(toolCall!.toolCall.invalid).toBeUndefined();

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", finishReason: "tool_calls" });
  });

  it("sends NO Authorization header at all for a no-auth endpoint (local vLLM/Ollama without a key)", async () => {
    responseChunks = [
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    const events = await collect(portFor({ apiKey: undefined }).streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured!.headers["authorization"]).toBeUndefined();
    expect(captured!.headers["x-api-key"]).toBeUndefined();
  });

  it("omits stream_options entirely when includeUsage is not set (strict-server capability, not a constant)", async () => {
    responseChunks = [
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ];
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    await collect(portFor().streamText(request)); // no includeUsage passed

    expect(captured!.body["stream_options"]).toBeUndefined();
  });
});

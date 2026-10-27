/**
 * GitHub #15 — deterministic recording proof of the opt-in prompt-cache wire
 * behavior on BOTH OpenAI transports, through the REAL `AiSdkModelPort` +
 * `@ai-sdk/openai-compatible` / `@ai-sdk/openai` + `ai` stack (no mocks, no
 * `streamText`-argument inspection). A local `node:http` loopback endpoint
 * captures the RAW UTF-8 request body, so these assertions pin what actually
 * crosses the wire, not what the adapter was handed.
 *
 * The baseline raw bodies below are FROZEN from the pre-change production
 * bytes (captured through the exact `createOpenAICompatibleLanguageModel` /
 * `createOpenAIResponsesLanguageModel` factories with `promptCache` absent):
 *
 *   - chat-completions: `{"model":"gpt-oss-120b","messages":[{"role":"user","content":"hi"}],"stream":true}`
 *   - responses:        `{"model":"gpt-5.1","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],"store":false,"include":["reasoning.encrypted_content"],"stream":true}`
 *
 * Off/unset must stay byte-identical to those frozen bodies; enabled must add
 * precisely ONE `prompt_cache_options` object and nothing else.
 *
 * Zero external network: everything is 127.0.0.1 with an OS-assigned port.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ToolDeclaration } from "../types/tools.js";
import type { EndpointConfig } from "./endpoint.js";
import type { ImplicitPromptCache } from "../types/config.js";
import { AiSdkModelPort } from "./model-port.js";

const ENABLED: ImplicitPromptCache = { mode: "implicit", ttl: "30m" };

const READ_TOOL: ToolDeclaration = {
  name: "Read",
  description: "Reads a file",
  inputJsonSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
};

const SENTINEL = "SENTINEL_FILE_BODY_42";

function serializeOpenAiSse(chunks: ReadonlyArray<Record<string, unknown>>): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

const RESPONSES_FRAMES: ReadonlyArray<Record<string, unknown>> = [
  { type: "response.created", response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  },
];

function serializeResponsesSse(frames: ReadonlyArray<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** A prior tool round-trip: one Read call, then its result. */
function toolRoundTripRequest(): ModelRequest {
  return {
    messages: [
      { role: "user", content: "read /a.txt" },
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "call_1", toolName: "Read", input: { file_path: "/a.txt" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call_1", toolName: "Read", text: SENTINEL, status: "success" }],
      },
    ],
    tools: [READ_TOOL],
  };
}

describe("AiSdkModelPort prompt-cache wire options (GitHub #15)", () => {
  let server: Server;
  let baseUrl: string;
  let capturedRaw: string;

  beforeEach(async () => {
    capturedRaw = "";
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        capturedRaw = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const isResponses = req.url !== undefined && req.url.includes("/responses");
        res.end(isResponses ? serializeResponsesSse(RESPONSES_FRAMES) : serializeOpenAiSse([
          { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function portFor(
    transport: "openai-chat-completions" | "openai-responses",
    overrides: Partial<EndpointConfig> = {},
  ): AiSdkModelPort {
    return new AiSdkModelPort({
      transport,
      baseUrl,
      apiKey: "test-key",
      model: transport === "openai-chat-completions" ? "gpt-oss-120b" : "gpt-5.1",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
      ...overrides,
    });
  }

  function parsed(): Record<string, unknown> {
    return JSON.parse(capturedRaw) as Record<string, unknown>;
  }

  function cacheOccurrences(raw: string): number {
    return (raw.match(/prompt_cache_options/g) ?? []).length;
  }

  const CHAT_BASELINE =
    '{"model":"gpt-oss-120b","messages":[{"role":"user","content":"hi"}],"stream":true}';
  const RESPONSES_BASELINE =
    '{"model":"gpt-5.1","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],"store":false,"include":["reasoning.encrypted_content"],"stream":true}';

  describe("openai-chat-completions", () => {
    it("off/unset emits the frozen pre-change body, byte-identical", async () => {
      const events = await collect(portFor("openai-chat-completions").streamText({ messages: [{ role: "user", content: "hi" }], tools: [] }));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(capturedRaw).toBe(CHAT_BASELINE);
      expect(cacheOccurrences(capturedRaw)).toBe(0);
    });

    it("enabled adds precisely one prompt_cache_options object and nothing else", async () => {
      const events = await collect(
        portFor("openai-chat-completions", { promptCache: ENABLED }).streamText({ messages: [{ role: "user", content: "hi" }], tools: [] }),
      );
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(cacheOccurrences(capturedRaw)).toBe(1);
      expect(parsed()["prompt_cache_options"]).toEqual(ENABLED);
      // Removing the added field restores the frozen baseline byte-for-byte.
      const { prompt_cache_options: _dropped, ...rest } = parsed() as Record<string, unknown> & { prompt_cache_options?: unknown };
      expect(JSON.stringify(rest)).toBe(CHAT_BASELINE);
    });

    it.each([undefined, "off", "high", "max"] as const)(
      "enabled coexists with reasoning effort %s",
      async (effort) => {
        const request: ModelRequest = {
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          ...(effort !== undefined ? { reasoningEffort: effort, maxOutputTokens: 2048 } : {}),
        };
        await collect(portFor("openai-chat-completions", { promptCache: ENABLED }).streamText(request));

        const body = parsed();
        expect(body["prompt_cache_options"]).toEqual(ENABLED);
        if (effort === undefined || effort === "off") {
          expect(body["reasoning_effort"]).toBeUndefined();
        } else {
          // "max" collapses to "high" on chat-completions (§4.3).
          expect(body["reasoning_effort"]).toBe(effort === "max" ? "high" : effort);
        }
        expect(cacheOccurrences(capturedRaw)).toBe(1);
      },
    );

    it("enabled survives a prior tool round-trip without disturbing the message serialization", async () => {
      const events = await collect(portFor("openai-chat-completions", { promptCache: ENABLED }).streamText(toolRoundTripRequest()));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(parsed()["prompt_cache_options"]).toEqual(ENABLED);
      expect(capturedRaw).toContain("Read");
      expect(capturedRaw).toContain(SENTINEL);
    });
  });

  describe("openai-responses", () => {
    it("off/unset emits the frozen pre-change body (store:false, no cache field)", async () => {
      const events = await collect(portFor("openai-responses").streamText({ messages: [{ role: "user", content: "hi" }], tools: [] }));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(capturedRaw).toBe(RESPONSES_BASELINE);
      expect(parsed()["store"]).toBe(false);
      expect(cacheOccurrences(capturedRaw)).toBe(0);
    });

    it("enabled preserves store:false and adds precisely one prompt_cache_options object", async () => {
      const events = await collect(
        portFor("openai-responses", { promptCache: ENABLED }).streamText({ messages: [{ role: "user", content: "hi" }], tools: [] }),
      );
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(parsed()["store"]).toBe(false);
      expect(parsed()["prompt_cache_options"]).toEqual(ENABLED);
      expect(cacheOccurrences(capturedRaw)).toBe(1);
      const { prompt_cache_options: _dropped, ...rest } = parsed() as Record<string, unknown> & { prompt_cache_options?: unknown };
      expect(JSON.stringify(rest)).toBe(RESPONSES_BASELINE);
    });

    it.each([undefined, "off", "high", "max"] as const)(
      "enabled coexists with store:false and reasoning effort %s (verbatim)",
      async (effort) => {
        const request: ModelRequest = {
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          ...(effort !== undefined ? { reasoningEffort: effort, maxOutputTokens: 2048 } : {}),
        };
        await collect(portFor("openai-responses", { promptCache: ENABLED }).streamText(request));

        const body = parsed();
        expect(body["store"]).toBe(false);
        expect(body["prompt_cache_options"]).toEqual(ENABLED);
        if (effort === undefined || effort === "off") {
          expect(body["reasoning"]).toBeUndefined();
        } else {
          // Responses serializes reasoningEffort as `reasoning.effort` (verbatim,
          // no max->high collapse), alongside the SDK's `summary:"detailed"`.
          expect(body["reasoning"]).toEqual({ effort, summary: "detailed" });
        }
        expect(cacheOccurrences(capturedRaw)).toBe(1);
      },
    );

    it("enabled keeps the prior tool result serialized as function_call_output alongside store:false", async () => {
      const events = await collect(portFor("openai-responses", { promptCache: ENABLED }).streamText(toolRoundTripRequest()));
      expect(events.filter((e) => e.type === "error")).toEqual([]);

      const body = parsed();
      expect(body["store"]).toBe(false);
      expect(body["prompt_cache_options"]).toEqual(ENABLED);
      const input = (body["input"] ?? []) as Array<Record<string, unknown>>;
      const fnOut = input.find((i) => i.type === "function_call_output" && i.call_id === "call_1");
      expect(fnOut).toBeDefined();
      expect(JSON.stringify(fnOut)).toContain(SENTINEL);
    });
  });
});

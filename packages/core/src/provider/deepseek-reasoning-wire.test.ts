/**
 * Wire-byte proof of the DeepSeek (TASK 4241) reasoning-effort mapping: the
 * unit coverage in model-port.test.ts only asserts the PURE
 * `reasoningRequestOptions` options object — it never drives a real request
 * through `AiSdkModelPort` and inspects what actually lands on the wire. The
 * mapping could regress (drop the enum, re-introduce a thinking budget,
 * mutate max_tokens) while every one of those unit tests stayed green,
 * because none of them ever serialize through the real `@ai-sdk/anthropic`
 * stack.
 *
 * SUPPLIED FACT (2026-10-10, live GET /models listing): DeepSeek models
 * expose distinct effort tiers low/high/max, default high. The wire encoding
 * is LOCAL SDK EVIDENCE (@ai-sdk/anthropic@4.0.7 dist): the request builder
 * serializes `providerOptions.anthropic.effort` to `output_config.effort`
 * whether or not `thinking` is present (~3730), and computes
 * `max_tokens = maxTokens + (thinkingBudget ?? 0)` (~3894) — so omitting the
 * budget sends `max_tokens = maxOutputTokens` unchanged and emits no
 * `thinking` key. No thinking budget is sent because no DeepSeek budget fact
 * exists; borrowing GLM's GLM_BUDGET_TOKENS numbers would be an unsupported
 * live-service inference.
 *
 * Harness (zero sockets/network): unlike glm-reasoning-wire.integration.test.ts's
 * loopback server, the installed SDK's default fetch is `globalThis.fetch`, so
 * a `vi.stubGlobal("fetch", ...)` captures the exact serialized POST body and
 * replies with a minimal valid Anthropic-messages SSE stream so the call
 * completes cleanly. baseUrl points at 127.0.0.1:9 — a port that is never
 * dialed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";

/** Minimal valid anthropic SSE so the AiSdkModelPort stream finishes without error. */
const RESPONSE_CHUNKS: ReadonlyArray<Record<string, unknown>> = [
  { type: "message_start", message: { id: "msg_1", model: "deepseek-flash", role: "assistant", usage: { input_tokens: 5 } } },
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

describe("DeepSeek reasoning-effort mapping over the real @ai-sdk/anthropic wire (TASK 4241)", () => {
  const captured: { url: string; body: Record<string, unknown> }[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): void {
    captured.length = 0; // each test inspects only its own request
    vi.stubGlobal(
      "fetch",
      async (input: unknown, init?: RequestInit) => {
        captured.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(serializeSse(RESPONSE_CHUNKS), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
  }

  function portFor(reasoningEffort: "low" | "high" | "max"): { port: AiSdkModelPort; request: ModelRequest } {
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      // Never dialed — the stubbed fetch intercepts before any socket opens.
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "deepseek-flash",
      providerName: "DeepSeek",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    const request: ModelRequest = {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxOutputTokens: 4_096,
      reasoningEffort,
    };
    return { port: new AiSdkModelPort(config), request };
  }

  it("low: SDK wire carries output_config.effort='low', no thinking key, max_tokens unchanged", async () => {
    stubFetch();
    const { port, request } = portFor("low");

    const events = await drain(port.streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured[0]!.url.endsWith("/v1/messages")).toBe(true); // normalizeAnthropicBaseUrl appends /v1
    expect(captured[0]!.body).toMatchObject({ output_config: { effort: "low" }, max_tokens: 4_096 });
    expect("thinking" in captured[0]!.body).toBe(false);
    expect(captured[0]!.body["effort"]).toBeUndefined(); // not top-level
  });

  it("high: SDK wire carries output_config.effort='high', no thinking key, max_tokens unchanged", async () => {
    stubFetch();
    const { port, request } = portFor("high");

    const events = await drain(port.streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured[0]!.url.endsWith("/v1/messages")).toBe(true);
    expect(captured[0]!.body).toMatchObject({ output_config: { effort: "high" }, max_tokens: 4_096 });
    expect("thinking" in captured[0]!.body).toBe(false);
    expect(captured[0]!.body["effort"]).toBeUndefined();
  });

  it("max: SDK wire carries output_config.effort='max' verbatim, no thinking key, max_tokens unchanged", async () => {
    stubFetch();
    const { port, request } = portFor("max");

    const events = await drain(port.streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured[0]!.url.endsWith("/v1/messages")).toBe(true);
    expect(captured[0]!.body).toMatchObject({ output_config: { effort: "max" }, max_tokens: 4_096 });
    expect("thinking" in captured[0]!.body).toBe(false);
    expect(captured[0]!.body["effort"]).toBeUndefined();
  });
});

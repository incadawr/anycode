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
import { generateSessionTitle } from "../context/session-title.js";
import { SwitchableModelPort } from "../cli/model.js";
import { createMediaProjectionPort } from "./media-projection.js";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";
import { findCatalogEntry } from "./catalog-data.js";
import { resolveReasoningEffort } from "./capabilities.js";
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

/**
 * Output tokens the simulated mandatory-thinking reply spends before it can
 * say anything: the live deepseek-flash title call stops at `max_tokens` with
 * no text at all when the cap is below this (the card's measurement was 32).
 * Sized well above the old 32-token title cap and well below the policy's
 * ceiling, so a fixture built from it cannot pass under the broken limit.
 */
const THINKING_COST_TOKENS = 150;

/**
 * A reply from a model that ALWAYS thinks first: a thinking content block,
 * then the answer — but only if the requested `max_tokens` outlasts the
 * thinking block. A smaller cap reproduces the live failure exactly:
 * `stop_reason: "max_tokens"`, thinking block truncated, no text block.
 */
function thinkingFirstChunks(maxTokens: number): Record<string, unknown>[] {
  const head: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_1", model: "deepseek-flash", role: "assistant", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weighing the request before answering." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
  ];
  if (maxTokens <= THINKING_COST_TOKENS) {
    return [
      ...head,
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: maxTokens } },
      { type: "message_stop" },
    ];
  }
  return [
    ...head,
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Fix the sidebar" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: THINKING_COST_TOKENS + 3 } },
    { type: "message_stop" },
  ];
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

  /**
   * Stubs `fetch` with a server that behaves like the live mandatory-thinking
   * service: the reply content depends on the requested `max_tokens`, so the
   * test judges the CAP, not a constant read out of the implementation.
   */
  function stubThinkingFirstFetch(): void {
    captured.length = 0;
    vi.stubGlobal(
      "fetch",
      async (input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        captured.push({ url: String(input), body });
        const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 0;
        return new Response(serializeSse(thinkingFirstChunks(maxTokens)), {
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

  it("serializes the saved retired Claude model's resolved effort", async () => {
    stubFetch();
    const model = "claude-opus-4-20250514";
    const effort = resolveReasoningEffort(model, findCatalogEntry("anthropic"), "high");
    const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test-key", model, providerName: "Anthropic", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await drain(port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 4096, reasoningEffort: effort }));
    expect(captured[0]!.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 24576 });
  });

  it("serializes the resolved Claude effort with adaptive thinking", async () => {
    stubFetch();
    const model = "claude-opus-5-5";
    const effort = resolveReasoningEffort(model, findCatalogEntry("anthropic"), "xhigh");
    const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test-key", model, providerName: "Anthropic", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    const events = await drain(port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 4096, reasoningEffort: effort }));
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(captured[0]!.body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" }, max_tokens: 4096 });
  });

  it("title request sends no tools or thinking and uses low effort (Taskana 4893)", async () => {
    stubFetch();
    const { port } = portFor("low");
    // Desktop wraps the real port in both decorators; test the actual chain.
    const switchable = new SwitchableModelPort(port);
    const desktopPort = createMediaProjectionPort(switchable, () => true);
    expect(await generateSessionTitle({ modelPort: desktopPort, text: "Fix the sidebar" })).toBe("ok");
    // DeepSeek always thinks before it answers, so the tiny title cap would be
    // eaten by that thinking block (stop_reason max_tokens, no text, heuristic
    // title kept). A live title request produced its title at max_tokens: 200;
    // this pins a literal ceiling well above that, independently of whatever
    // the implementation declares — reverting to the old 32 fails here.
    expect(captured[0]!.body.output_config).toMatchObject({ effort: "low" });
    expect(captured[0]!.body.max_tokens).toBe(512);
    expect(captured[0]!.body.max_tokens as number).toBeGreaterThanOrEqual(200);
    expect(captured[0]!.body.tools).toBeUndefined();
    expect(captured[0]!.body.thinking).toBeUndefined();

    // The wrapper must follow a later model/provider switch as well.
    switchable.setPort(new AiSdkModelPort({
      transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key", model: "other-model", providerName: "Anthropic",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    }));
    expect(await generateSessionTitle({ modelPort: desktopPort, text: "Fix the sidebar" })).toBe("ok");
    expect(captured[1]!.body.output_config).toBeUndefined();
    // A provider without mandatory thinking keeps the small default title cap.
    expect(captured[1]!.body.max_tokens).toBe(32);
  });

  it("a reply that spends its whole cap on thinking leaves no title, so the title cap must outlast it", async () => {
    stubThinkingFirstFetch();
    // Control: the default 32-token title cap (a provider without the DeepSeek
    // policy) is fully consumed by the thinking block — the same failure the
    // card reports live: stop_reason max_tokens, no text, no refined title.
    const plain = new AiSdkModelPort({
      transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key", model: "deepseek-flash", providerName: "Anthropic",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    });
    expect(await generateSessionTitle({ modelPort: plain, text: "Fix the sidebar" })).toBeNull();
    expect(captured[0]!.body.max_tokens).toBe(32);

    // DeepSeek's policy outlasts the thinking block, so the very same reply
    // yields a title. Reverting the ceiling reintroduces the null above.
    const { port } = portFor("low");
    expect(await generateSessionTitle({ modelPort: port, text: "Fix the sidebar" })).toBe("Fix the sidebar");
    expect(captured[1]!.body.max_tokens as number).toBeGreaterThan(THINKING_COST_TOKENS);
  });

  it("exposes the raised title ceiling only for DeepSeek", () => {
    const { port } = portFor("low");
    // Literal: the policy's ceiling must stay clear of the thinking block and
    // of the 200-token request the live check proved sufficient.
    expect(port.titleMaxOutputTokens).toBe(512);
    expect(port.titleMaxOutputTokens as number).toBeGreaterThan(THINKING_COST_TOKENS);
    expect(port.titleReasoningEffort).toBe("low");
    const anthropic = new AiSdkModelPort({
      transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key", model: "claude-opus-5-5", providerName: "Anthropic",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    });
    expect(anthropic.titleMaxOutputTokens).toBeUndefined();
    expect(anthropic.titleReasoningEffort).toBeUndefined();
  });

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

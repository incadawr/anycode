/**
 * Wire-byte proof that a custom Anthropic-compatible endpoint can observe the
 * difference between the `xhigh` and `max` effort tiers (GitHub #2 review of
 * the xhigh mapping).
 *
 * The unit coverage in model-port.test.ts only asserts the pure
 * `reasoningRequestOptions` options object; it never drives a real request
 * through `AiSdkModelPort` and inspects the serialized POST body. Before the
 * fix, the generic anthropic-messages path collapsed both tiers to the SAME
 * thinking budget (high's 24_576) and sent no effort field at all, so a
 * custom endpoint declaring both `xhigh` and `max` could never distinguish
 * them.
 *
 * Harness (zero sockets/network, mirrors deepseek-reasoning-wire.test.ts):
 * the installed SDK's default fetch is `globalThis.fetch`, so a stubbed
 * fetch captures the exact serialized POST body and replies with a minimal
 * valid Anthropic-messages SSE stream. baseUrl points at 127.0.0.1:9 — a
 * port that is never dialed. The provider is a NON-catalog custom name, so
 * the request takes the generic anthropic-messages path under test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";

/** Minimal valid anthropic SSE so the AiSdkModelPort stream finishes cleanly. */
const RESPONSE_CHUNKS: ReadonlyArray<Record<string, unknown>> = [
  { type: "message_start", message: { id: "msg_1", model: "custom-model", role: "assistant", usage: { input_tokens: 5 } } },
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

describe("custom Anthropic-compatible endpoint distinguishes xhigh vs max on the wire", () => {
  const captured: { body: Record<string, unknown> }[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): void {
    captured.length = 0;
    vi.stubGlobal(
      "fetch",
      async (_input: unknown, init?: RequestInit) => {
        captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(serializeSse(RESPONSE_CHUNKS), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
  }

  /**
   * A custom (user-added, non-catalog) Anthropic-compatible endpoint
   * declaring both `xhigh` and `max` tiers. The wiring layer
   * (buildCliEndpointConfig) sets providerName ONLY from a catalog entry, so
   * a custom connection carries none — that absence is the gate for the
   * xhigh/max wire distinction. No named branch matches either, so the
   * request exercises the generic anthropic-messages mapping.
   */
  function customPort(): { port: AiSdkModelPort; requestFor: (effort: "xhigh" | "max") => ModelRequest } {
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl: "http://127.0.0.1:9", // never dialed — the stub intercepts
      apiKey: "test-key",
      model: "custom-reasoner-1",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    return {
      port: new AiSdkModelPort(config),
      requestFor: (effort) => ({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxOutputTokens: 4_096,
        reasoningEffort: effort,
      }),
    };
  }

  /**
   * Regression gate: a CATALOG anthropic-transport provider without a
   * dedicated branch (Kimi kimi.com, providerName set by the wiring layer via
   * matchCatalogEntryByBaseUrl). These worked before the xhigh/max fix and
   * must keep their exact pre-fix request bytes for every effort — including
   * max: high's 24_576 budget and NO output_config.effort key. Sending the
   * new effort field / larger budget to a strict catalog proxy is the
   * regression this test pins out.
   */
  function catalogKimiPort(): { port: AiSdkModelPort; requestFor: (effort: "xhigh" | "max") => ModelRequest } {
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl: "http://127.0.0.1:9", // never dialed — the stub intercepts
      apiKey: "test-key",
      model: "k3",
      providerName: "Kimi (kimi.com subscription)",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    return {
      port: new AiSdkModelPort(config),
      requestFor: (effort) => ({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxOutputTokens: 4_096,
        reasoningEffort: effort,
      }),
    };
  }

  it("xhigh and max produce different bodies: distinct effort enums AND distinct thinking budgets", async () => {
    stubFetch();
    const { port, requestFor } = customPort();

    const xhighEvents = await drain(port.streamText(requestFor("xhigh")));
    expect(xhighEvents.filter((e) => e.type === "error")).toEqual([]);
    const maxEvents = await drain(port.streamText(requestFor("max")));
    expect(maxEvents.filter((e) => e.type === "error")).toEqual([]);

    const xhighBody = captured[0]!.body;
    const maxBody = captured[1]!.body;

    // The effort enum rides the wire for both tiers (serialized by
    // @ai-sdk/anthropic from providerOptions.anthropic.effort).
    expect(xhighBody.output_config).toMatchObject({ effort: "xhigh" });
    expect(maxBody.output_config).toMatchObject({ effort: "max" });

    // Even for an endpoint that ignores output_config, the thinking budgets
    // differ, so the requests are never byte-equal on the reasoning fields.
    expect(xhighBody.thinking).toMatchObject({ type: "enabled", budget_tokens: 24_576 });
    expect(maxBody.thinking).toMatchObject({ type: "enabled", budget_tokens: 32_000 });
    expect(JSON.stringify(xhighBody)).not.toBe(JSON.stringify(maxBody));
  });

  it("xhigh keeps high's budget and max_tokens accounting holds for both tiers", async () => {
    stubFetch();
    const { port, requestFor } = customPort();

    await drain(port.streamText(requestFor("xhigh")));
    await drain(port.streamText(requestFor("max")));

    // The SDK serializes max_tokens = maxOutputTokens + budgetTokens; with
    // maxOutputTokens floored at budget + 1024, xhigh keeps the pre-fix wire
    // bytes (24_576 + 25_600) while max strictly exceeds it.
    expect(captured[0]!.body.max_tokens).toBe(24_576 + 25_600);
    expect(captured[1]!.body.max_tokens).toBe(32_000 + 33_024);
    expect(captured[1]!.body.max_tokens as number).toBeGreaterThan(captured[0]!.body.max_tokens as number);
  });

  it("catalog Kimi/MiMo-class providers keep their exact pre-fix bytes for max: high's budget, no effort field", async () => {
    stubFetch();
    const { port, requestFor } = catalogKimiPort();

    await drain(port.streamText(requestFor("max")));

    const body = captured[0]!.body;
    // Pre-fix wire bytes: NO output_config.effort and high's 24_576 budget.
    expect(body.output_config).toBeUndefined();
    expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 24_576 });
    expect(body.max_tokens).toBe(24_576 + 25_600);
  });

});

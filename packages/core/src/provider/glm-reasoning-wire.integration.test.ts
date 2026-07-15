/**
 * Wire-byte proof of GLM (Z.AI) reasoning-effort mapping (W1#6, TASK.43 W6):
 * the existing coverage in model-port.test.ts (lines ~44-67, ~595-608) only
 * asserts the PURE `reasoningRequestOptions` options object — it never drives
 * a real request through `AiSdkModelPort` and inspects what actually lands on
 * the wire. `reasoningRequestOptions` could regress (drop a field, mis-key it)
 * while every one of those unit tests stayed green, because none of them ever
 * serialize through the real `@ai-sdk/anthropic` stack.
 *
 * Same loopback-capture harness as sse-fixture.integration.test.ts /
 * image-wire.integration.test.ts: a local `node:http` server on
 * 127.0.0.1:<ephemeral> captures the real outgoing POST and replies with a
 * minimal valid Anthropic-messages SSE stream so the call completes cleanly.
 * Zero external network.
 *
 * The installed `@ai-sdk/anthropic@4.0.7` dist (`dist/index.js`, the
 * `getArgs`-equivalent request-builder around line 3720) serializes
 * `providerOptions.anthropic.effort` under `output_config.effort`, NOT a
 * top-level `effort` key — reasoningRequestOptions's own comment
 * (model-port.ts: "the proxy honors `effort` (output_config.effort) as the
 * tier selector") already names this; this test pins that exact wire location
 * so a future SDK bump or refactor that moves it is caught here, not silently.
 *
 * Wire `max_tokens` is NOT the `maxOutputTokens` value reasoningRequestOptions
 * hands to `streamText` (115072/99072 for high/max) — the installed SDK's
 * request builder ADDS `thinking.budget_tokens` back on top of it
 * (`dist/index.js:3894`, `baseArgs.max_tokens = maxTokens + thinkingBudget`),
 * so the two exactly cancel out and the wire value converges back to the
 * catalog's 131072 ceiling for EVERY tier. model-port.ts's own comment
 * documents this ("@ai-sdk/anthropic serializes enabled thinking as
 * `max_tokens = maxOutputTokens + thinking.budget_tokens`") and
 * model-port.test.ts:60/67 pins the arithmetic on the pure options object;
 * this is the wire-level consequence of that arithmetic, and the exact gap a
 * pure-options assertion cannot see.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** Minimal valid anthropic SSE so the AiSdkModelPort stream finishes without error. */
const RESPONSE_CHUNKS: ReadonlyArray<Record<string, unknown>> = [
  { type: "message_start", message: { id: "msg_1", model: "glm-5.2", role: "assistant", usage: { input_tokens: 5 } } },
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

describe("GLM (Z.AI) reasoning-effort mapping over the real @ai-sdk/anthropic wire (W1#6)", () => {
  let server: Server;
  let baseUrl: string;
  let captured: CapturedRequest | undefined;

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

  function portFor(reasoningEffort: "high" | "max"): { port: AiSdkModelPort; request: ModelRequest } {
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "glm-5.2",
      providerName: "Z.AI (GLM)",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    const request: ModelRequest = {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxOutputTokens: 131_072,
      reasoningEffort,
    };
    return { port: new AiSdkModelPort(config), request };
  }

  it("high: posts to /v1/messages with max_tokens=131072 (ceiling), thinking.budget_tokens=16000, output_config.effort='high', dual auth headers", async () => {
    const { port, request } = portFor("high");

    const events = await drain(port.streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured).toBeDefined();
    expect(captured!.url).toBe("/v1/messages");

    // Dual-auth (anthropic.ts's buildDualAuthHeaders): the SDK's native
    // x-api-key alongside the explicit Authorization Bearer shim.
    expect(captured!.headers["x-api-key"]).toBe("test-key");
    expect(captured!.headers["authorization"]).toBe("Bearer test-key");

    // Wire max_tokens stays pinned at the 131072 ceiling for every tier (see
    // this file's header comment for why 115072 + 16000 converges back here).
    expect(captured!.body["max_tokens"]).toBe(131_072);
    expect(captured!.body).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 16_000 },
      output_config: { effort: "high" },
    });
    // Not a top-level `effort` — the proxy only honors it nested under output_config.
    expect(captured!.body["effort"]).toBeUndefined();
  });

  it("max: posts with max_tokens=131072 (ceiling), thinking.budget_tokens=32000, output_config.effort='max'", async () => {
    const { port, request } = portFor("max");

    const events = await drain(port.streamText(request));

    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(captured).toBeDefined();
    expect(captured!.url).toBe("/v1/messages");
    expect(captured!.body["max_tokens"]).toBe(131_072);
    expect(captured!.body).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 32_000 },
      output_config: { effort: "max" },
    });
    expect(captured!.body["effort"]).toBeUndefined();
  });
});

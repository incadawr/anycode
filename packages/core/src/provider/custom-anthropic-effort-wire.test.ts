/**
 * Wire-byte proof that a custom Anthropic-compatible endpoint can observe the
 * difference between the `xhigh` and `max` effort tiers (GitHub #2 review of
 * the xhigh mapping) — WITHOUT an endpoint that does not understand
 * `output_config.effort` ever being sent that field.
 *
 * The unit coverage in model-port.test.ts only asserts the pure
 * `reasoningRequestOptions` options object; it never drives a real request
 * through `AiSdkModelPort` and inspects the serialized POST body. Before the
 * fix, the generic anthropic-messages path collapsed both tiers to the SAME
 * thinking budget (high's 24_576) and sent no effort field at all, so a
 * custom endpoint declaring both `xhigh` and `max` could never distinguish
 * them. The first fix then sent the effort enum to EVERY custom endpoint,
 * which a strict server that only knows `thinking.budget_tokens` rejects —
 * so the gate is now the connection's own declaration:
 *
 *  - no declared effort vocabulary  ⇒ distinct thinking budgets only, no
 *    `output_config` key at all (byte-safe for a strict server);
 *  - a declared effort vocabulary   ⇒ the DECLARED level that is selected
 *    rides `output_config.effort`, for EVERY level (low included — an
 *    endpoint that ignores `thinking.budget_tokens` and switches tier on the
 *    enum keeps its own default, the maximum, when no enum is sent), and the
 *    distinct budgets stay as they were.
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
   * A custom (user-added, non-catalog) Anthropic-compatible endpoint. The
   * wiring layer (buildCliEndpointConfig) sets providerName ONLY from a
   * catalog entry, so a custom connection carries none — and no named branch
   * matches either, so the request exercises the generic anthropic-messages
   * mapping. `declaredEffortLevels` is the connection's own declaration
   * (`ANYCODE_EFFORT_LEVELS`): a connection that declared the selected level
   * authorises the effort enum on the wire, one that declared nothing never
   * sees the field.
   */
  function customPort(
    declaredEffortLevels?: readonly ("low" | "medium" | "high" | "xhigh" | "max")[],
  ): { port: AiSdkModelPort; requestFor: (effort: "low" | "medium" | "high" | "xhigh" | "max") => ModelRequest } {
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl: "http://127.0.0.1:9", // never dialed — the stub intercepts
      apiKey: "test-key",
      model: "custom-reasoner-1",
      ...(declaredEffortLevels !== undefined ? { declaredEffortLevels } : {}),
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
  function catalogKimiPort(): { port: AiSdkModelPort; requestFor: (effort: "low" | "medium" | "high" | "xhigh" | "max") => ModelRequest } {
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

  it("an endpoint that never declared the effort enum gets distinct budgets and no output_config field", async () => {
    stubFetch();
    const { port, requestFor } = customPort();

    const xhighEvents = await drain(port.streamText(requestFor("xhigh")));
    expect(xhighEvents.filter((e) => e.type === "error")).toEqual([]);
    const maxEvents = await drain(port.streamText(requestFor("max")));
    expect(maxEvents.filter((e) => e.type === "error")).toEqual([]);

    const xhighBody = captured[0]!.body;
    const maxBody = captured[1]!.body;

    // No declaration ⇒ the request carries no field the endpoint never
    // advertised: a strict server that only knows thinking.budget_tokens
    // accepts the body unchanged (pinned by the rejecting stub below too).
    expect(xhighBody.output_config).toBeUndefined();
    expect(maxBody.output_config).toBeUndefined();

    // The tiers still differ: xhigh keeps high's 24_576, max gets a strictly
    // larger budget, so the requests are never byte-equal on the reasoning
    // fields even for a budget-only endpoint.
    expect(xhighBody.thinking).toMatchObject({ type: "enabled", budget_tokens: 24_576 });
    expect(maxBody.thinking).toMatchObject({ type: "enabled", budget_tokens: 32_000 });
    expect(JSON.stringify(xhighBody)).not.toBe(JSON.stringify(maxBody));

    // The SDK serializes max_tokens = maxOutputTokens + budgetTokens; with
    // maxOutputTokens floored at budget + 1024, xhigh keeps the pre-fix wire
    // bytes (24_576 + 25_600) while max strictly exceeds it.
    expect(xhighBody.max_tokens).toBe(24_576 + 25_600);
    expect(maxBody.max_tokens).toBe(32_000 + 33_024);
  });

  /**
   * The regression this fixes: an endpoint that ignores `thinking.budget_tokens`
   * and switches its reasoning tier on the effort enum (MiniMax and other
   * effort-enum endpoints) keeps its OWN default — the maximum — when no enum
   * is sent, so picking "low" did nothing. A connection that DECLARED its
   * effort vocabulary therefore has to see the selected level on the wire,
   * for every level, low included.
   */
  it("every declared level rides the effort enum on the wire", async () => {
    stubFetch();
    const declared = ["low", "medium", "high", "xhigh", "max"] as const;
    const { port, requestFor } = customPort(declared);

    for (const level of declared) {
      const events = await drain(port.streamText(requestFor(level)));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    }

    // The effort enum rides the wire (serialized by @ai-sdk/anthropic from
    // providerOptions.anthropic.effort) and equals the selected level.
    expect(captured.map((c) => c.body.output_config)).toMatchObject([
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
      { effort: "max" },
    ]);

    // The budgets stay exactly as before the fix — the enum is an addition,
    // not a replacement: distinct per tier, xhigh vs max still distinct.
    expect(captured.map((c) => c.body.thinking)).toMatchObject([
      { type: "enabled", budget_tokens: 4_096 },
      { type: "enabled", budget_tokens: 12_288 },
      { type: "enabled", budget_tokens: 24_576 },
      { type: "enabled", budget_tokens: 24_576 },
      { type: "enabled", budget_tokens: 32_000 },
    ]);
  });

  it("a connection that declared both tiers gets the matching effort enum alongside distinct budgets", async () => {
    stubFetch();
    const { port, requestFor } = customPort(["xhigh", "max"]);

    await drain(port.streamText(requestFor("xhigh")));
    await drain(port.streamText(requestFor("max")));

    // The effort enum rides the wire (serialized by @ai-sdk/anthropic from
    // providerOptions.anthropic.effort) exactly because the connection
    // declared the tier itself.
    expect(captured[0]!.body.output_config).toMatchObject({ effort: "xhigh" });
    expect(captured[1]!.body.output_config).toMatchObject({ effort: "max" });
    expect(captured[0]!.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 24_576 });
    expect(captured[1]!.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 32_000 });
  });

  it("a declared level the connection did not declare never rides the wire", async () => {
    stubFetch();
    // The connection declared "max" only; "low" was not part of its
    // vocabulary, so no enum may be sent for it.
    const { port, requestFor } = customPort(["max"]);

    await drain(port.streamText(requestFor("low")));
    await drain(port.streamText(requestFor("max")));

    expect(captured[0]!.body.output_config).toBeUndefined();
    expect(captured[1]!.body.output_config).toMatchObject({ effort: "max" });
  });

  it("without a declaration no level sends an effort field and the bytes stay as they are", async () => {
    stubFetch();
    const { port, requestFor } = customPort();

    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    for (const level of levels) {
      const events = await drain(port.streamText(requestFor(level)));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    }

    // No field the endpoint never advertised, for ANY level.
    for (const capture of captured) {
      expect(capture.body.output_config).toBeUndefined();
    }

    // The bytes are exactly the pre-fix ones: the same budgets and the same
    // max_tokens (maxOutputTokens + budgetTokens) as before the change.
    expect(captured.map((c) => c.body.thinking)).toMatchObject([
      { type: "enabled", budget_tokens: 4_096 },
      { type: "enabled", budget_tokens: 12_288 },
      { type: "enabled", budget_tokens: 24_576 },
      { type: "enabled", budget_tokens: 24_576 },
      { type: "enabled", budget_tokens: 32_000 },
    ]);
    expect(captured.map((c) => c.body.max_tokens)).toEqual([
      4_096 + 5_120,
      12_288 + 13_312,
      24_576 + 25_600,
      24_576 + 25_600,
      32_000 + 33_024,
    ]);
  });

  it("a strict server that rejects output_config never sees the field unless the connection declared it", async () => {
    // The rejecting stub is the server the reviewer worried about: ANY body
    // carrying output_config is a 400. It proves both halves of the gate.
    captured.length = 0;
    const rejected: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        captured.push({ body });
        if (body.output_config !== undefined) {
          rejected.push(body);
          return new Response(
            JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config: unknown field" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(serializeSse(RESPONSE_CHUNKS), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    );

    // Undeclared: every level passes through the strict server untouched.
    const strict = customPort();
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const events = await drain(strict.port.streamText(strict.requestFor(effort)));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    }
    expect(rejected).toEqual([]);

    // Declared: the same server rejects the added field — the gate is what
    // keeps it off the wire above, not a permissive server.
    const declared = customPort(["low", "medium", "high", "xhigh", "max"]);
    const declaredEvents = await drain(declared.port.streamText(declared.requestFor("max")));
    expect(declaredEvents.filter((e) => e.type === "error")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.output_config).toMatchObject({ effort: "max" });
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

  it("a declared vocabulary never changes what a catalog provider sends", async () => {
    stubFetch();
    const { port, requestFor } = catalogKimiPort();

    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    for (const level of levels) {
      await drain(port.streamText(requestFor(level)));
    }

    // A catalog provider is not a custom endpoint: the effort enum belongs to
    // its own branch (or to no branch at all), so no declaration may add a
    // field it never advertised.
    for (const capture of captured) {
      expect(capture.body.output_config).toBeUndefined();
    }
    expect(captured.map((c) => c.body.thinking)).toMatchObject([
      { type: "enabled", budget_tokens: 4_096 },
      { type: "enabled", budget_tokens: 12_288 },
      { type: "enabled", budget_tokens: 24_576 },
      { type: "enabled", budget_tokens: 24_576 },
      { type: "enabled", budget_tokens: 24_576 },
    ]);
  });

});

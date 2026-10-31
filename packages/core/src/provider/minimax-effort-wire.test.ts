/**
 * Wire-byte proof of the MiniMax reasoning-effort mapping.
 *
 * The unit coverage in model-port.test.ts only asserts the PURE
 * `reasoningRequestOptions` options object; it never drives a real request
 * through `AiSdkModelPort` and inspects what actually lands on the wire. The
 * mapping could regress (drop the enum, re-introduce a thinking budget, send
 * `thinking: disabled`) while every unit test stayed green, because none of
 * them serialize through the real `@ai-sdk/anthropic` stack.
 *
 * SUPPLIED FACT (platform.minimax.io/docs/api-reference/text-anthropic-api,
 * checked 2026-10-31):
 *
 *  - `output_config.effort` — "Tunes thinking depth for MiniMax-M3.1-Flash.
 *    Accepts low, medium, high, xhigh, and max; defaults to max when
 *    omitted." `none` is not supported and returns 400.
 *  - `thinking` — "MiniMax-M3.1-Flash always thinks and returns 400 if
 *    disabled is sent"; the endpoint's own error text is `thinking.type=
 *    "disabled" (including reasoning.effort=none) is not allowed (2013)`.
 *    Omitting `thinking` leaves thinking ON.
 *  - `thinking.budget_tokens` is not part of MiniMax's vocabulary.
 *
 * The wire encoding is LOCAL SDK EVIDENCE (@ai-sdk/anthropic@4.0.7): the
 * request builder serializes `providerOptions.anthropic.effort` to
 * `output_config.effort` and computes `max_tokens = maxTokens +
 * (thinkingBudget ?? 0)` — so a request with NO thinking budget sends
 * `max_tokens = maxOutputTokens` unchanged and emits no `thinking` key.
 *
 * Harness (zero sockets/network, mirrors deepseek-reasoning-wire.test.ts):
 * the installed SDK's default fetch is `globalThis.fetch`, so a stubbed fetch
 * captures the exact serialized POST body and replies with a minimal valid
 * Anthropic-messages SSE stream. baseUrl points at 127.0.0.1:9 — a port that
 * is never dialed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";
import { findCatalogEntry, getBuiltinCatalog } from "./catalog-data.js";
import { matchCatalogEntryByBaseUrl } from "../cli/model.js";
import { resolveReasoningEffort } from "./capabilities.js";
import type { AnthropicEndpointConfig } from "./anthropic.js";

/** Minimal valid anthropic SSE so the AiSdkModelPort stream finishes cleanly. */
const RESPONSE_CHUNKS: ReadonlyArray<Record<string, unknown>> = [
  { type: "message_start", message: { id: "msg_1", model: "MiniMax-M3.1-Flash", role: "assistant", usage: { input_tokens: 5 } } },
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

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

describe("MiniMax reasoning-effort mapping over the real @ai-sdk/anthropic wire", () => {
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
   * A CATALOG MiniMax connection: the wiring layer sets `providerName` from
   * the catalog entry's display NAME (`catalogEntry.name`), so the branch
   * keys on that name, never on the id or on the base URL.
   */
  function minimaxPort(
    providerName: string,
    model: string,
  ): { port: AiSdkModelPort; requestFor: (effort: (typeof EFFORT_LEVELS)[number]) => ModelRequest } {
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl: "http://127.0.0.1:9", // never dialed — the stub intercepts
      apiKey: "test-key",
      model,
      providerName,
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

  it("every tier rides the effort enum, and no tier sends a thinking key", async () => {
    stubFetch();
    const { port, requestFor } = minimaxPort("MiniMax", "MiniMax-M3.1-Flash");

    for (const level of EFFORT_LEVELS) {
      const events = await drain(port.streamText(requestFor(level)));
      expect(events.filter((event) => event.type === "error")).toEqual([]);
    }

    // The enum rides the wire for EVERY tier, `low` included: the endpoint
    // switches its reasoning depth on the enum, so a tier that is not sent is
    // a tier that did nothing (the endpoint would apply its own `max`).
    expect(captured.map((capture) => capture.body.output_config)).toMatchObject([
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
      { effort: "max" },
    ]);

    // NO thinking key at all — never `{type:"disabled"}` (a 400, error 2013),
    // never a budget (a field MiniMax does not speak). Omitting it leaves
    // thinking ON, which is what MiniMax-M3.1-Flash requires.
    for (const capture of captured) {
      expect(capture.body.thinking).toBeUndefined();
    }
  });

  it("max_tokens is the requested ceiling, with no budget added on top", async () => {
    stubFetch();
    const { port, requestFor } = minimaxPort("MiniMax", "MiniMax-M3.1-Flash");

    await drain(port.streamText(requestFor("high")));

    // The SDK sends max_tokens = maxOutputTokens + thinkingBudget; with no
    // budget the ceiling passes through unchanged (no GLM-style subtraction
    // is needed — MiniMax counts thinking tokens against max_tokens and the
    // catalog's 131_072 IS the provider's recommended ceiling).
    expect(captured[0]!.body.max_tokens).toBe(4_096);
  });

  it("the request goes to the endpoint's documented .../anthropic/v1/messages URL", async () => {
    stubFetch();
    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl: "https://api.minimax.io/anthropic",
      apiKey: "test-key",
      model: "MiniMax-M3.1-Flash",
      providerName: "MiniMax",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    const port = new AiSdkModelPort(config);
    await drain(port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 4_096, reasoningEffort: "high" }));

    // Our `normalizeAnthropicBaseUrl` appends the "/v1" and the SDK appends
    // "/messages" — exactly the URL MiniMax documents.
    expect(captured[0]!.url).toContain("https://api.minimax.io/anthropic/v1/messages");
  });

  it("MiniMax-M3 sends neither an effort enum nor a thinking key", async () => {
    stubFetch();
    const { port, requestFor } = minimaxPort("MiniMax", "MiniMax-M3");

    await drain(port.streamText(requestFor("high")));

    // The docs scope `output_config.effort` to M3.1-Flash, and M3's thinking
    // is OFF by default — omitting `thinking` keeps it off. The generic
    // tail's thinking budget would be a field MiniMax does not speak.
    expect(captured[0]!.body.output_config).toBeUndefined();
    expect(captured[0]!.body.thinking).toBeUndefined();
    expect(captured[0]!.body.max_tokens).toBe(4_096);
  });

  it("the China region maps exactly like the international one", async () => {
    stubFetch();
    const { port, requestFor } = minimaxPort("MiniMax (China)", "MiniMax-M3.1-Flash");

    await drain(port.streamText(requestFor("xhigh")));

    expect(captured[0]!.body.output_config).toMatchObject({ effort: "xhigh" });
    expect(captured[0]!.body.thinking).toBeUndefined();
  });

  it("a custom MiniMax URL uses the catalog mapping, including model overrides", async () => {
    stubFetch();
    const baseUrl = "https://api.minimax.io/anthropic/v1";
    const entry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), baseUrl);
    expect(entry?.id).toBe("minimax");
    const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl, apiKey: "test-key", model: "MiniMax-M3.1-Flash", providerName: entry?.name, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    for (const levels of [undefined, ["low", "high"] as const]) {
      const reasoningEffort = resolveReasoningEffort("MiniMax-M3.1-Flash", entry, "high", undefined, levels);
      await drain(port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 4_096, reasoningEffort }));
    }
    for (const { body } of captured) {
      expect(body.output_config).toMatchObject({ effort: "high" });
      expect(body.thinking).toBeUndefined();
    }
  });

  it("a catalog MiniMax connection resolves its tier from the catalog row", async () => {
    stubFetch();
    // The catalog row's own `effortLevels` is the declaration: the pick is
    // validated against it upstream, so an undeclared level never reaches
    // the wire.
    const entry = findCatalogEntry("minimax")!;
    expect(resolveReasoningEffort("MiniMax-M3.1-Flash", entry, "xhigh")).toBe("xhigh");
    expect(resolveReasoningEffort("MiniMax-M3.1-Flash", entry, undefined)).toBe("max");
    expect(resolveReasoningEffort("MiniMax-M3.1-Flash", entry, "off")).toBe("max");
    expect(resolveReasoningEffort("MiniMax-M3", entry, "high")).toBeUndefined();
  });

  it("keeps every other catalog provider's bytes unchanged", async () => {
    stubFetch();
    // The GLM / DeepSeek / Anthropic / Kimi branches and the generic tail are
    // untouched by the MiniMax branch: each of these keeps the bytes it had
    // before, pinned here by their own shape. MiMo has its own (measured)
    // effort-enum branch too — it never reaches this mapping.
    const cases: { providerName: string; model: string; body: Record<string, unknown> }[] = [
      // GLM: its own effort enum PLUS a thinking budget.
      { providerName: "Z.AI (GLM)", model: "glm-5.3", body: { output_config: { effort: "max" }, thinking: { type: "enabled", budget_tokens: 32_000 } } },
      // DeepSeek: its own enum, no thinking key.
      { providerName: "DeepSeek", model: "deepseek-flash", body: { output_config: { effort: "max" } } },
      // Anthropic: adaptive thinking + effort.
      { providerName: "Anthropic", model: "claude-opus-5-5", body: { output_config: { effort: "max" }, thinking: { type: "adaptive" } } },
      // Kimi (no branch): the generic tail's budget only, no enum.
      { providerName: "Kimi (kimi.com subscription)", model: "k3", body: { thinking: { type: "enabled", budget_tokens: 24_576 } } },
      // MiMo: its own branch — the measured enum only, no budget. `max` is
      // unmeasured and collapses onto `high`.
      { providerName: "Xiaomi MiMo API", model: "mimo-v2.6-pro", body: { output_config: { effort: "high" } } },
    ];
    for (const testCase of cases) {
      captured.length = 0;
      const { port, requestFor } = minimaxPort(testCase.providerName, testCase.model);
      await drain(port.streamText(requestFor("max")));
      expect(captured[0]!.body, testCase.providerName).toMatchObject(testCase.body);
      if (testCase.providerName.startsWith("Xiaomi MiMo")) {
        expect(captured[0]!.body.thinking, "MiMo sends no thinking key").toBeUndefined();
      }
    }
  });
});

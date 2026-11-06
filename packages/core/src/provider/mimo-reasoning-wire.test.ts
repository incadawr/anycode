/**
 * Wire-byte proof of the Xiaomi MiMo reasoning mapping.
 *
 * MiMo speaks the Anthropic-messages protocol and documents only
 * `thinking.type` (enabled by default) — no budget field, no effort
 * vocabulary (mimo.mi.com, accessed 2026-10-31).
 *
 * MEASURED against the direct API (mimo-v2.6-pro, hard no-tool prompt, 2 reps
 * per cell, all answers correct):
 *   thinking omitted                        31.3k out / 482 s
 *   output_config.effort "low", no budget   28.7k out / 420 s
 *   output_config.effort "high", no budget  48.0k out / 700 s
 *   old bytes (thinking enabled + budget)   low 22.6k ≈ high 20.1k
 * So `thinking.budget_tokens` is IGNORED (every level produced the same
 * amount of reasoning) while the effort enum IS honoured (high ≈ 1.7x low).
 *
 * Thus a MiMo request for a reasoning level carries `output_config.effort`
 * and NO thinking key, and `max_tokens` passes through unchanged (the SDK
 * adds a thinking budget to max_tokens only when one exists).
 *
 * Only `low` and `high` are measured, and no effort vocabulary is
 * documented, so those are the only two values ever emitted: `medium`,
 * `xhigh` and `max` collapse onto `high` rather than inventing enum values the
 * endpoint may reject.
 *
 * Harness (zero sockets/network, mirrors minimax-effort-wire.test.ts): the
 * installed SDK's default fetch is `globalThis.fetch`, so a stubbed fetch
 * captures the exact serialized POST body and replies with a minimal valid
 * Anthropic-messages SSE stream. baseUrl points at 127.0.0.1:9 — never dialed.
 */

import { afterEach, expect, it, vi } from "vitest";

vi.mock("../tools/to-model-tools.js", () => ({
  toToolDeclarations: () => [],
}));

import { AgentLoop } from "../loop/agent-loop.js";
import type { CorePorts } from "../ports/index.js";
import type { HookRunner } from "../types/hooks.js";
import type { ToolRegistry } from "../tools/registry.js";
import { findCatalogEntry } from "./catalog-data.js";
import { resolveEffortLevels } from "./capabilities.js";
import { AiSdkModelPort } from "./model-port.js";
import type { ReasoningEffort } from "../types/config.js";

const chunks = [
  { type: "message_start", message: { id: "msg_1", model: "mimo-v2.6-pro", role: "assistant", usage: { input_tokens: 5 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

afterEach(() => vi.unstubAllGlobals());

it("sends exactly the measured effort enum per MiMo reasoning level, with no thinking key", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  // Every level the picker offers for a MiMo model, plus "no level stored".
  // `off` and `undefined` are the same "No thinking" state and keep the bytes
  // they had before the effort fix.
  const expected = [
    { level: undefined, effort: undefined, thinking: { type: "disabled" } },
    { level: "off", effort: undefined, thinking: { type: "disabled" } },
    { level: "low", effort: "low", thinking: undefined },
    { level: "medium", effort: "high", thinking: undefined },
    { level: "high", effort: "high", thinking: undefined },
    // Not offered by the catalog today, but a live vocabulary could name them:
    // neither is measured, so both collapse onto `high` instead of claiming an
    // unmeasured depth (and instead of emitting an enum value the endpoint may
    // reject).
    { level: "xhigh", effort: "high", thinking: undefined },
    { level: "max", effort: "high", thinking: undefined },
  ] as const satisfies ReadonlyArray<{ level: ReasoningEffort | undefined; effort: "low" | "high" | undefined; thinking: { type: string } | undefined }>;

  for (const mode of ["api", "sgp", "cn", "ams"]) {
    const entry = findCatalogEntry(`xiaomi-mimo-${mode}`)!;
    for (const model of entry.models) {
      // The catalog row declares no effortLevels, so the legacy four-level
      // vocabulary applies; `medium` is therefore a real, selectable tier.
      expect(resolveEffortLevels(model.id, entry)).toEqual(["off", "low", "medium", "high"]);

      const port = new AiSdkModelPort({
        transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test-key",
        model: model.id, providerName: entry.name, retry: { maxRetries: 0, stallTimeoutMs: 0 },
      });

      for (const { level, effort, thinking } of expected) {
        const events = [];
        for await (const event of port.streamText({
          messages: [{ role: "user", content: "hi" }], tools: [],
          maxOutputTokens: model.maxOutputTokens, reasoningEffort: level,
        })) events.push(event);
        expect(events.filter((event) => event.type === "error")).toEqual([]);

        const body = bodies.at(-1)!;
        const label = `${entry.id}/${model.id}/${level ?? "none"}`;

        // The effort enum is the tier selector: present for every level, and
        // always one of the two measured values.
        expect(body.output_config, label).toEqual(effort === undefined ? undefined : { effort });

        // No thinking key for a level (the old bytes sent
        // `{type:"enabled",budget_tokens:N}`, which MiMo ignores) and the
        // unchanged `disabled` marker for "No thinking".
        expect(body.thinking, label).toEqual(thinking);

        // No thinking budget ⇒ the SDK adds nothing to max_tokens, so the
        // catalog ceiling passes through as-is (the old bytes subtracted the
        // budget from 131_072).
        expect(body.max_tokens, label).toBe(model.maxOutputTokens);
      }
    }
  }
});

/**
 * GitHub #41: MiMo keeps its reasoning between requests (Xiaomi recommends
 * sending all previous reasoning back). On the anthropic transport that is a
 * signed `thinking` block; the tool loop's second request must carry it.
 */
it("replays MiMo's signed thinking before tool_use on the next request, on every MiMo entry", async () => {
  const sse = (list: Record<string, unknown>[]): string =>
    list.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
  const thinkThenTool = [
    { type: "message_start", message: { id: "msg_1", model: "mimo-v2.6-pro", role: "assistant", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look at the file." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "mimo-sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ];
  const text = [
    { type: "message_start", message: { id: "msg_2", model: "mimo-v2.6-pro", role: "assistant", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];

  for (const mode of ["api", "sgp", "cn", "ams"]) {
    const entry = findCatalogEntry(`xiaomi-mimo-${mode}`)!;
    expect(entry.preserveReasoning, entry.id).toBeUndefined();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(sse(bodies.length === 1 ? thinkThenTool : text), { headers: { "content-type": "text/event-stream" } });
    });
    const port = new AiSdkModelPort({
      transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test-key",
      model: "mimo-v2.6-pro", providerName: entry.name, retry: { maxRetries: 0, stallTimeoutMs: 0 },
    });
    const loop = new AgentLoop({
      modelPort: port,
      reasoningEffort: "high",
      registry: { get: () => undefined } as unknown as ToolRegistry,
      hooks: { register: () => {}, runPreToolUse: async () => ({}), runUserPromptSubmit: async () => ({}), runObservers: async () => {} } as unknown as HookRunner,
      permissionEngine: { check: () => ({ decision: "allow" }) },
      permissionBroker: { requestPermission: async () => ({ behavior: "deny", reason: "no client" }) },
      mode: "build",
      ports: {} as CorePorts,
      cwd: "/work",
    });
    for await (const _event of loop.runTurn("read a.txt")) { /* drain */ }

    expect(bodies, entry.id).toHaveLength(2);
    const assistant = (bodies[1]!.messages as { role: string; content: unknown }[]).find((message) => message.role === "assistant");
    expect(assistant?.content, entry.id).toEqual([
      { type: "thinking", thinking: "Look at the file.", signature: "mimo-sig" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);
    vi.unstubAllGlobals();
  }
});

it("omits stored thinking when MiMo thinking is disabled", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const baseUrl = "http://127.0.0.1:9";
  const providerName = findCatalogEntry("xiaomi-mimo-api")!.name;
  const model = "mimo-v2.6-pro";
  const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl, apiKey: "test", model, providerName, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
  const messages = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: [
      { type: "reasoning" as const, text: "thought", source: { transport: "anthropic-messages", baseUrl, provider: providerName, model }, providerMetadata: { anthropic: { signature: "sig" } } },
      { type: "text" as const, text: "answer" },
    ] },
    { role: "user" as const, content: "continue" },
  ];
  for (const effort of ["off", "high"] as const) {
    for await (const _ of port.streamText({ messages, tools: [], reasoningEffort: effort })) { /* drain */ }
  }
  expect(bodies[0]!.thinking).toEqual({ type: "disabled" });
  expect(JSON.stringify(bodies[0]!.messages)).not.toContain("thought");
  expect(JSON.stringify(bodies[1]!.messages)).toContain("thought");
});

it("replay off produces the complete pre-replay request body unchanged", async () => {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const baseUrl = "http://127.0.0.1:9";
  const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl, apiKey: "test", model: "custom", preserveReasoning: false, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
  const text = { type: "text" as const, text: "answer" };
  const thought = { type: "reasoning" as const, text: "thought", source: { transport: "anthropic-messages", baseUrl, model: "custom" }, providerMetadata: { anthropic: { signature: "sig" } } };
  for (const content of [[text], [thought, text]]) {
    for await (const _ of port.streamText({ system: "system", messages: [{ role: "user", content: "hi" }, { role: "assistant", content }, { role: "user", content: "continue" }], tools: [], maxOutputTokens: 123 })) { /* drain */ }
  }
  expect(bodies[1]).toBe(bodies[0]);
});

it("honors the global override for catalog providers and custom endpoints", () => {
  for (const [providerName, override, enabled] of [
    ["OpenAI", true, true], ["Anthropic", true, true], ["Z.AI (GLM)", true, true],
    ["Z.AI (GLM)", false, false], [undefined, true, true], ["Custom gateway", true, true], [undefined, undefined, true],
  ] as const) {
    const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test", model: "model", providerName, preserveReasoning: override });
    expect(port.reasoningReplaySource("high") !== undefined, String(providerName)).toBe(enabled);
  }
});

it("sends stored unsigned MiMo thinking on the SDK wire", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const baseUrl = "http://127.0.0.1:9";
  const provider = findCatalogEntry("xiaomi-mimo-api")!.name;
  const model = "mimo-v2.6-pro";
  const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl, apiKey: "test", model, providerName: provider, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
  for await (const _ of port.streamText({ reasoningEffort: "high", tools: [], messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "reasoning", text: "unsigned thought", source: { transport: "anthropic-messages", baseUrl, provider, model } }, { type: "text", text: "answer" }] },
    { role: "user", content: "continue" },
  ] })) { /* drain */ }
  const assistant = (bodies[0]!.messages as { role: string; content: unknown[] }[]).find((item) => item.role === "assistant");
  expect(assistant!.content[0]).toEqual({ type: "thinking", thinking: "unsigned thought", signature: "" });
});

import { afterEach, expect, it, vi } from "vitest";
import { resolveOpenCodeGoEndpointPolicy } from "./opencode-go-policy.js";
import { AiSdkModelPort } from "./model-port.js";
import type { ReasoningEffort } from "../types/config.js";

afterEach(() => vi.unstubAllGlobals());

// Policy shapes: Messages toggle+effort, toggle+budget, toggle only;
// Chat effort+reasoning_content, none, single max, default max, no effort;
// Responses minimal, none, and ordinary effort. Tool-choice/strict variants
// are checked against each model's own declaration.
const cases: [string, ReasoningEffort | undefined, string | undefined][] = [
  ["claude-haiku-5-5", "high", "high"], ["qwen3.8-max", "xhigh", "xhigh"],
  ["qwen3.8-flash", "low", "low"], ["qwen3.7-plus", "low", undefined],
  ["minimax-m3", "off", undefined], ["deepseek-v4.1-flash", "low", "low"],
  ["glm-5.2", "high", "high"], ["hy4", "off", "none"],
  ["kimi-k3", "max", "max"], ["kimi-k3.1-pro", undefined, "max"],
  ["kimi-k2.7-code", "high", undefined], ["mimo-v2.6-flash", "high", undefined],
  ["longcat-2.0", "off", undefined], ["iceman-contributor-free", "high", undefined],
  ["grok-4.7", "high", "high"], ["muse-spark-1.2-contributor", "minimal", "minimal"],
  ["gpt-6-luna", "off", "none"],
];

it.each(cases)("captures the declared Go request for %s", async (id, effort, expected) => {
  const route = resolveOpenCodeGoEndpointPolicy("opencode", id);
  if (route.kind !== "route") throw new Error("missing fixture route");
  let body: any;
  vi.stubGlobal("fetch", async (_: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response("bad request", { status: 400 });
  });
  const port = new AiSdkModelPort({ ...route.route, goModelPolicy: route.route.policy, model: id, apiKey: "test", includeUsage: false, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
  try { for await (const _ of port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "test", description: "test", inputJsonSchema: { type: "object", properties: {} } }], reasoningEffort: effort, temperature: 0.3, maxOutputTokens: 32000 })) {} } catch { /* request is captured before the fixture error */ }
  expect(body).toBeDefined();
  const { transport, policy } = route.route;
  if (policy.capabilities?.temperature !== true) expect(body.temperature).toBeUndefined();
  if (!policy.apiCapabilities?.tools?.choice?.includes("auto")) expect(body.tool_choice).toBeUndefined();
  if (policy.apiCapabilities?.tools?.strict !== true) expect(JSON.stringify(body.tools)).not.toContain('"strict"');
  if (transport === "anthropic-messages") {
    if (expected) { expect(body.output_config?.effort).toBe(expected); expect(body.thinking).toEqual({ type: "adaptive" }); }
    if (id === "qwen3.7-plus") expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    if (id === "minimax-m3") expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.stream_options).toBeUndefined();
  } else if (transport === "openai-responses") {
    expect(body.store).toBe(false); expect(body.reasoning?.effort).toBe(expected); expect(body.stream_options).toBeUndefined();
  } else expect(body.reasoning_effort).toBe(expected);
});

it("leaves an OpenAI endpoint with the same model id on its existing wire path", async () => {
  let body: any;
  vi.stubGlobal("fetch", async (_: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response("bad request", { status: 400 }); });
  const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: "https://example.test/v1", model: "kimi-k2.7-code", apiKey: "test", includeUsage: false, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
  try { for await (const _ of port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [], reasoningEffort: "high", temperature: 0.3, maxOutputTokens: 100 })) {} } catch {}
  expect(body.reasoning_effort).toBe("high");
  expect(body.temperature).toBe(0.3);
});

it("completes mocked streams when switching between the three Go protocols", async () => {
  const seen: string[] = [];
  const messages = [
    { type: "message_start", message: { id: "m", model: "minimax-m3", role: "assistant", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" },
  ];
  const responses = [
    { type: "response.created", response: { id: "r", created_at: 1700000000, model: "gpt-6-luna" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m" } },
    { type: "response.output_text.delta", item_id: "m", delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m" } },
    { type: "response.completed", response: { usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  vi.stubGlobal("fetch", async (url: unknown) => {
    const path = String(url); seen.push(path);
    const chunks = path.endsWith("/messages") ? messages : path.endsWith("/responses") ? responses : [
      { id: "c", object: "chat.completion.chunk", created: 1, model: "hy4", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "c", object: "chat.completion.chunk", created: 1, model: "hy4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  for (const id of ["minimax-m3", "hy4", "gpt-6-luna", "minimax-m3"]) {
    const route = resolveOpenCodeGoEndpointPolicy("opencode", id);
    if (route.kind !== "route") throw new Error("missing route");
    const port = new AiSdkModelPort({ ...route.route, goModelPolicy: route.route.policy, model: id, apiKey: "test", includeUsage: false, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    const events = [];
    for await (const event of port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(event);
    expect(events.some(event => event.type === "text_delta" && event.text === "ok")).toBe(true);
    expect(events.some(event => event.type === "finish")).toBe(true);
  }
  expect(seen.map(url => new URL(url).pathname)).toEqual(["/inference/go/anthropic/v1/messages", "/inference/go/openai/v1/chat/completions", "/inference/go/openai/v1/responses", "/inference/go/anthropic/v1/messages"]);
});

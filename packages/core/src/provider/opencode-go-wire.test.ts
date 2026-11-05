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

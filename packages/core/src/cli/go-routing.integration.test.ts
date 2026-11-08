import { afterEach, expect, it, vi } from "vitest";
import { buildCliEndpointConfig } from "./main.js";
import { AiSdkModelPort } from "../provider/model-port.js";
import { loadEnvConfig } from "../provider/env.js";

afterEach(() => vi.unstubAllGlobals());
it.each([
  ["claude-haiku-5-5", "/anthropic/v1/messages", "anthropic-messages"],
  ["glm-5.3", "/openai/v1/chat/completions", "openai-chat-completions"],
  ["grok-4.7", "/openai/v1/responses", "openai-responses"],
] as const)("routes %s through its declared door", async (model, path, transport) => {
  const envConfig = loadEnvConfig({ ANYCODE_API_KEY: "fake", ANYCODE_MODEL: model, ANYCODE_PROVIDER_ID: "opencode" });
  const config = buildCliEndpointConfig({ transport: "anthropic-messages", envConfig, catalogEntry: undefined, retryOverride: { maxRetries: 0, stallTimeoutMs: 0 }, includeUsageResolved: false, model });
  let url = ""; let body: any;
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit) => { url = String(input); body = JSON.parse(String(init.body)); return new Response("bad", { status: 400 }); });
  const port = new AiSdkModelPort(config);
  try { for await (const _ of port.streamText({ messages: [{ role: "user", content: "hello" }], tools: [], reasoningEffort: "high", maxOutputTokens: 1000 })) {} } catch {}
  expect(config.transport).toBe(transport);
  expect(url).toBe(`https://opencode.ai/inference/go${path}`);
  if (transport === "anthropic-messages") expect(body.thinking).toEqual({ type: "adaptive" });
  if (transport === "openai-chat-completions") expect(body.reasoning_effort).toBe("high");
  if (transport === "openai-responses") expect(body.store).toBe(false);
});
it("refuses an unavailable model before a client can POST", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const envConfig = loadEnvConfig({ ANYCODE_API_KEY: "fake", ANYCODE_MODEL: "gemini-4-argon", ANYCODE_PROVIDER_ID: "opencode" });
  expect(() => buildCliEndpointConfig({ transport: "anthropic-messages", envConfig, catalogEntry: undefined, retryOverride: {}, includeUsageResolved: false, model: envConfig.model })).toThrow("not supported on OpenCode Go");
  expect(fetch).not.toHaveBeenCalled();
});

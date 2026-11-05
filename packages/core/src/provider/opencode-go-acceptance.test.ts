import { afterEach, expect, it, vi } from "vitest";
import { applyAutomaticModelRoute } from "./endpoint.js";
import { AiSdkModelPort } from "./model-port.js";
import { openCodeGoModelIds, resolveOpenCodeGoEndpointPolicy } from "./opencode-go-policy.js";

afterEach(() => vi.unstubAllGlobals());

it.each(openCodeGoModelIds("opencode"))("routes %s through its declared Go door", async model => {
  const route = resolveOpenCodeGoEndpointPolicy("opencode", model);
  if (route.kind !== "route") throw new Error("fixture route unavailable");
  const captured: { url: string; body: Record<string, any> }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response("fixture refusal", { status: 400 });
  });
  const config = applyAutomaticModelRoute({ providerId: "opencode", automaticModelRouting: true, transport: "anthropic-messages", baseUrl: "https://invalid.test", apiKey: "fixture", model, retry: { maxRetries: 0, stallTimeoutMs: 0 } });
  try { for await (const _event of new AiSdkModelPort(config).streamText({ messages: [{ role: "user", content: "hello" }], tools: [], maxOutputTokens: 64 })) {} } catch { /* deliberate 400 */ }
  expect(captured).toHaveLength(1);
  const request = captured[0]!;
  expect(request.body.model).toBe(model);
  expect(request.url).toBe(route.route.baseUrl + (route.route.transport === "anthropic-messages" ? "/messages" : route.route.transport === "openai-responses" ? "/responses" : "/chat/completions"));
  if (route.route.transport === "openai-responses") expect(request.body.store).toBe(false);
  if (route.route.transport !== "openai-chat-completions") expect(request.body.stream_options).toBeUndefined();
  if (route.route.policy.capabilities?.temperature !== true) expect(request.body.temperature).toBeUndefined();
});

it("refuses unsupported and unknown models before a network request", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const model of ["gemini-4-argon", "missing-model"]) {
    expect(() => applyAutomaticModelRoute({ providerId: "opencode", automaticModelRouting: true, transport: "anthropic-messages", baseUrl: "https://invalid.test", model })).toThrow("unavailable");
  }
  expect(fetch).not.toHaveBeenCalled();
});

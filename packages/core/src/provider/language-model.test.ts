/**
 * Transport dispatcher tests (TASK.43 §0.3). `createLanguageModel` is the ONE
 * place that maps a transport onto a client factory. Today a single branch is
 * live (anthropic-messages); the OpenAI transports must fail LOUDLY rather than
 * silently POST an Anthropic body to an OpenAI endpoint — the exact failure the
 * transport discriminant exists to prevent.
 */

import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "./endpoint.js";
import { createLanguageModel } from "./language-model.js";
import type { ProviderTransport } from "./catalog.js";

function config(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    transport: "anthropic-messages",
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    model: "claude-test",
    ...overrides,
  };
}

describe("createLanguageModel", () => {
  it("builds an Anthropic model for the anthropic-messages transport", () => {
    const model = createLanguageModel(config());
    // The AI SDK LanguageModel carries the requested model id; construction is
    // side-effect free (no network until streamText).
    expect(model).toBeDefined();
    expect(typeof model === "string" ? model : model.modelId).toBe("claude-test");
  });

  it("refuses the anthropic-messages transport without an api key (fail-closed)", () => {
    expect(() => createLanguageModel(config({ apiKey: undefined }))).toThrow(/api key/i);
  });

  it.each<ProviderTransport>(["openai-chat-completions", "openai-responses"])(
    "throws not-implemented for %s instead of falling back to Anthropic",
    (transport) => {
      expect(() => createLanguageModel(config({ transport }))).toThrow(/not implemented/i);
      expect(() => createLanguageModel(config({ transport }))).toThrow(new RegExp(transport));
    },
  );

  it("throws on an unknown transport smuggled in past the type system", () => {
    const rogue = config({ transport: "anthropic" as unknown as ProviderTransport });
    expect(() => createLanguageModel(rogue)).toThrow(/unknown provider transport/i);
  });
});

/**
 * Transport dispatcher tests (TASK.43 §0.3). `createLanguageModel` is the ONE
 * place that maps a transport onto a client factory. All three branches are
 * live (anthropic-messages, openai-chat-completions, openai-responses); an
 * unknown transport smuggled in past the type system must still fail LOUDLY
 * rather than silently POST a body shaped for one protocol at an endpoint
 * speaking another — the exact failure the transport discriminant exists to
 * prevent.
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

  it("builds an OpenAI-compatible model for the openai-chat-completions transport", () => {
    const model = createLanguageModel(
      config({ transport: "openai-chat-completions", baseUrl: "https://gw.example/v1", model: "gpt-oss" }),
    );
    expect(model).toBeDefined();
    expect(typeof model === "string" ? model : model.modelId).toBe("gpt-oss");
  });

  it("builds an openai-chat-completions model even without an api key (no-auth endpoint)", () => {
    expect(() =>
      createLanguageModel(config({ transport: "openai-chat-completions", apiKey: undefined })),
    ).not.toThrow();
  });

  it("builds an OpenAI Responses model for the openai-responses transport", () => {
    const model = createLanguageModel(
      config({ transport: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" }),
    );
    expect(model).toBeDefined();
    expect(typeof model === "string" ? model : model.modelId).toBe("gpt-5.1");
  });

  it("builds an openai-responses model even without an api key (construction is side-effect free)", () => {
    expect(() =>
      createLanguageModel(config({ transport: "openai-responses", apiKey: undefined })),
    ).not.toThrow();
  });

  it("throws on an unknown transport smuggled in past the type system", () => {
    const rogue = config({ transport: "anthropic" as unknown as ProviderTransport });
    expect(() => createLanguageModel(rogue)).toThrow(/unknown provider transport/i);
  });
});

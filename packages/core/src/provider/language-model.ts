/**
 * Transport dispatcher: the ONE place that maps a `ProviderTransport` onto a
 * client factory (TASK.43 §0.3). Target mapping:
 *
 *   anthropic-messages       -> @ai-sdk/anthropic          (live)
 *   openai-chat-completions  -> @ai-sdk/openai-compatible  (live)
 *   openai-responses         -> @ai-sdk/openai             (live)
 *
 * An unknown transport (smuggled in past the type system) throws. It never
 * falls back to another protocol: a silent fallback would send an Anthropic
 * body to an OpenAI endpoint and surface as an unexplained 400/404 from the
 * endpoint, hiding the real cause (a mis-resolved transport) from the user.
 */

import type { LanguageModel } from "ai";
import { createAnthropicLanguageModel } from "./anthropic.js";
import type { EndpointConfig } from "./endpoint.js";
import { createOpenAICompatibleLanguageModel } from "./openai-compatible.js";
import { createOpenAIResponsesLanguageModel } from "./openai-responses.js";

export function createLanguageModel(config: EndpointConfig): LanguageModel {
  switch (config.transport) {
    case "anthropic-messages":
      // `EndpointConfig.transport` is a flat union field, not a discriminated
      // union of per-transport shapes, so the switch narrows `config.transport`
      // but not `config` itself; the cast is safe because this case already
      // confirmed the discriminant. createAnthropicLanguageModel's own runtime
      // assert is the real defense for callers that bypass this dispatcher.
      return createAnthropicLanguageModel(config as EndpointConfig & { transport: "anthropic-messages" });
    case "openai-chat-completions":
      return createOpenAICompatibleLanguageModel(config);
    case "openai-responses":
      return createOpenAIResponsesLanguageModel(config);
    default: {
      const unknown: never = config.transport;
      throw new Error(`Unknown provider transport: ${JSON.stringify(unknown)}`);
    }
  }
}

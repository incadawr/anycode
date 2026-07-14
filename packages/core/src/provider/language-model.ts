/**
 * Transport dispatcher: the ONE place that maps a `ProviderTransport` onto a
 * client factory (TASK.43 §0.3). Target mapping:
 *
 *   anthropic-messages       -> @ai-sdk/anthropic          (live)
 *   openai-chat-completions  -> @ai-sdk/openai-compatible  (not implemented yet)
 *   openai-responses         -> @ai-sdk/openai             (not implemented yet)
 *
 * An unimplemented or unknown transport throws. It never falls back to another
 * protocol: a silent fallback would send an Anthropic body to an OpenAI endpoint
 * and surface as an unexplained 400/404 from the endpoint, hiding the real cause
 * (a mis-resolved transport) from the user.
 */

import type { LanguageModel } from "ai";
import { createAnthropicLanguageModel } from "./anthropic.js";
import type { EndpointConfig } from "./endpoint.js";

export function createLanguageModel(config: EndpointConfig): LanguageModel {
  switch (config.transport) {
    case "anthropic-messages":
      return createAnthropicLanguageModel(config);
    case "openai-chat-completions":
    case "openai-responses":
      throw new Error(`Provider transport "${config.transport}" is not implemented yet`);
    default: {
      const unknown: never = config.transport;
      throw new Error(`Unknown provider transport: ${JSON.stringify(unknown)}`);
    }
  }
}

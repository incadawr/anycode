/**
 * ModelPort: the model boundary. One call = exactly one SDK step
 * (stopWhen: stepCountIs(1) is set explicitly by the adapter); the multi-turn
 * behavior lives entirely in the agent loop. Fully de-SDK'd (design §2.2):
 * requests are built from the own envelope (ChatMessage) and provider-agnostic
 * ToolDeclaration; provider/sdk-mapping.ts converts to SDK shapes inside the
 * provider layer only.
 */

import type { ChatMessage } from "../types/history.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { ToolDeclaration } from "../types/tools.js";
import type { ReasoningEffort } from "../types/config.js";

export interface ModelRequest {
  /**
   * System prompt for this step, passed out-of-band (AI SDK v7 rejects
   * system-role entries inside `messages`; the adapter forwards it as
   * `instructions`).
   */
  system?: string;
  /** Conversation as user/assistant/tool messages only — never a system message. */
  messages: ChatMessage[];
  /** Provider-agnostic declarations (no execute bodies — the model only proposes calls). */
  tools: ToolDeclaration[];
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface ModelPort {
  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

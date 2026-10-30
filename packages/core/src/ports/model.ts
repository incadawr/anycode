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
  /**
   * Identity readback: the id this port was constructed for. Constructed-port
   * identity, NOT execution identity — no production port canonicalizes ids.
   */
  readonly modelId?: string;
  /** Provider-specific minimum effort for lightweight title requests, if needed. */
  readonly titleReasoningEffort?: ReasoningEffort;
  /**
   * Provider-specific output-token ceiling for the one-shot title request.
   * `undefined` means the caller's default title cap, which is sized for a
   * title alone. A provider that always thinks before it answers needs enough
   * room for that thinking block plus the title, or the reply stops at
   * `max_tokens` with no text at all.
   */
  readonly titleMaxOutputTokens?: number;
  /**
   * Provider-reported model id from the most recent raw response observed by
   * this port (anthropic-messages `message_start.message.model`). `undefined`
   * until a raw claim is seen and on transports/providers that expose none.
   * NEVER populated from SDK response metadata, which falls back to the
   * requested id and would fabricate a match. Meaningful for a single-consumer
   * port (e.g. a fixed child port); on a shared port it reflects whichever call
   * streamed last — consumers read it only immediately after a call they own
   * completes.
   */
  readonly lastResponseModel?: string;
}

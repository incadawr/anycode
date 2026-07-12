/**
 * Own conversation envelope (Phase 1, design §2.1). No type from the "ai" SDK
 * appears above the provider layer: the loop, context manager and persistence
 * all speak ChatMessage/HistoryItem; provider/sdk-mapping.ts converts to SDK
 * shapes at the boundary.
 */

import type { ToolCallStatus } from "./tools.js";
import type { ImageAttachment } from "./images.js";

export interface AssistantTextPart {
  type: "text";
  text: string;
}

export interface AssistantToolCallPart {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  /** Always a JSON object. Invalid model input is sanitized to {} before append (design §2.9). */
  input: unknown;
}

export type AssistantPart = AssistantTextPart | AssistantToolCallPart;

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  /** Model-visible result text (= ToolCallOutcome.modelText). */
  text: string;
  /** Present only on successful image-capable tool outcomes; microcompact clears it together with the text. */
  images?: ImageAttachment[];
  /** Kept for persistence/analytics; only `text` reaches the model. */
  status: ToolCallStatus;
}

export type ChatMessage =
  | { role: "user"; content: string; images?: ImageAttachment[] }
  | { role: "assistant"; content: AssistantPart[] }
  | { role: "tool"; content: ToolResultPart[] };

export interface HistoryItem {
  /** Stable uuid; persisted as-is. */
  id: string;
  /** Epoch milliseconds. */
  createdAt: number;
  message: ChatMessage;
  /** Cached token estimate (items are immutable after append; replacement recomputes). */
  tokenEstimate?: number;
  kind?: "normal" | "compact_summary" | "microcompact_cleared";
}

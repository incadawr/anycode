/**
 * Own conversation envelope (Phase 1, design §2.1). No type from the "ai" SDK
 * appears above the provider layer: the loop, context manager and persistence
 * all speak ChatMessage/HistoryItem; provider/sdk-mapping.ts converts to SDK
 * shapes at the boundary.
 */

import type { ToolCallStatus } from "./tools.js";
import type { ImageAttachment } from "./images.js";
import type { ToolResultPresentation } from "./subagent-card.js";

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
  /**
   * Persistence/hydration only (TASK.102 slice S1, CUT-S1 §2.3): NOT part of
   * messageTokenText (context/history.ts) and never mapped onto an SDK
   * message (provider/sdk-mapping.ts) — the model never sees this field on
   * any transport.
   */
  presentation?: ToolResultPresentation;
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
  /**
   * TASK.145 срез 2: marks a `role:"user"` item the human never typed — the
   * host injected it on the model's behalf (a detached background child's
   * terminal report). `role` stays "user" (owner decision, spec §4bis п.1:
   * the MODEL must not be able to tell the two apart), so this field exists
   * purely for PRESENTATION — a renderer/CLI reading persisted history picks
   * a different view for it without the model-facing role ever lying about
   * who "spoke". Absent = an ordinary human-typed turn (the overwhelming
   * majority of items).
   */
  origin?: "system";
}

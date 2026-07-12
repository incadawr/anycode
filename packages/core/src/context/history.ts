/**
 * ConversationHistory (design §2.1): the loop's own message envelope with
 * cached per-item token estimates and an optional write-behind persistence
 * sink. Items are immutable after append; compaction swaps the whole list
 * atomically via replaceAll.
 *
 * Integrity invariant (§2.10): in a valid history every assistant tool_call is
 * answered by exactly one tool_result before the next user/assistant message.
 * The class does not enforce it on append (generic writer); it exposes
 * unansweredToolCallIds() and the loop is responsible for closing every call
 * before loop_end.
 */

import type { ChatMessage, HistoryItem } from "../types/history.js";
import { IMAGE_TOKEN_ESTIMATE } from "../types/config.js";
import { HeuristicTokenizer, type Tokenizer } from "./tokenizer.js";

/** Write-behind persistence sink: never throws into the turn; flush() awaits the queue. */
export interface HistorySink {
  append(items: readonly HistoryItem[]): void;
  replaceAll(items: readonly HistoryItem[]): void;
  /** For graceful shutdown / tests. */
  flush(): Promise<void>;
}

export class ConversationHistory {
  private list: HistoryItem[];
  private readonly sink: HistorySink | undefined;
  private readonly tokenizer: Tokenizer;

  constructor(opts?: { initial?: HistoryItem[]; sink?: HistorySink; tokenizer?: Tokenizer }) {
    this.list = opts?.initial ? [...opts.initial] : [];
    this.sink = opts?.sink;
    this.tokenizer = opts?.tokenizer ?? new HeuristicTokenizer();
  }

  get items(): readonly HistoryItem[] {
    return this.list;
  }

  /** Appends a message as a new item (uuid, timestamp, token estimate) and feeds the sink. */
  append(message: ChatMessage): HistoryItem {
    const item: HistoryItem = {
      id: globalThis.crypto.randomUUID(),
      createdAt: Date.now(),
      message,
      tokenEstimate: estimateMessageTokens(this.tokenizer, message),
      kind: "normal",
    };
    this.list.push(item);
    this.sink?.append([item]);
    return item;
  }

  /** Atomic swap (compaction); feeds sink.replaceAll with the new list. */
  replaceAll(items: HistoryItem[]): void {
    this.list = [...items];
    this.sink?.replaceAll(this.list);
  }

  toMessages(): ChatMessage[] {
    return this.list.map((item) => item.message);
  }

  /** Sum of cached per-item estimates (items missing a cache are counted on the fly). */
  totalTokenEstimate(): number {
    let total = 0;
    for (const item of this.list) {
      total += item.tokenEstimate ?? estimateMessageTokens(this.tokenizer, item.message);
    }
    return total;
  }

  /** toolCallIds of assistant tool_call parts that have no matching tool_result (§2.10). */
  unansweredToolCallIds(): string[] {
    const answered = new Set<string>();
    for (const item of this.list) {
      if (item.message.role === "tool") {
        for (const part of item.message.content) {
          answered.add(part.toolCallId);
        }
      }
    }
    const unanswered: string[] = [];
    for (const item of this.list) {
      if (item.message.role === "assistant") {
        for (const part of item.message.content) {
          if (part.type === "tool_call" && !answered.has(part.toolCallId)) {
            unanswered.push(part.toolCallId);
          }
        }
      }
    }
    return unanswered;
  }
}

/**
 * Flattens a message into the text that drives its token estimate. Exported so
 * the ContextManager recomputes item estimates identically when it rewrites
 * messages (microcompact / compaction summary) outside of append().
 */
export function messageTokenText(message: ChatMessage): string {
  switch (message.role) {
    case "user":
      return message.content;
    case "assistant":
      return message.content
        .map((part) =>
          part.type === "text" ? part.text : `${part.toolName} ${safeStringify(part.input)}`,
        )
        .join("\n");
    case "tool":
      return message.content.map((part) => part.text).join("\n");
  }
}

/**
 * Per-message token estimate = the text token count (messageTokenText, untouched

 * Applied at every estimate site (append, sum, microcompact recompute, compaction
 * summary) so the "recomputes identically" law holds through one shared helper;
 * an image-free message returns exactly the old text-only number (L4).
 */
export function estimateMessageTokens(tokenizer: Tokenizer, message: ChatMessage): number {
  return tokenizer.count(messageTokenText(message)) + imageCount(message) * IMAGE_TOKEN_ESTIMATE;
}

/** Number of image attachments carried by a message: user-message images + the sum over tool parts. */
function imageCount(message: ChatMessage): number {
  switch (message.role) {
    case "user":
      return message.images?.length ?? 0;
    case "assistant":
      return 0;
    case "tool":
      return message.content.reduce((sum, part) => sum + (part.images?.length ?? 0), 0);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

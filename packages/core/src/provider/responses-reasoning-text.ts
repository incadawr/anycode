/**
 * Recovers reasoning that an OpenAI Responses endpoint streams as
 * `reasoning_text` (GitHub #27). `@ai-sdk/openai@4.0.14` parses
 * `response.reasoning_text.delta`/`.done` as unknown chunks and never reads a
 * reasoning item's `content`, so that text never becomes a reasoning part.
 * model-port enables `includeRawChunks` on this transport and passes every
 * fullStream part of ONE attempt through `observe`; the returned core events
 * are yielded before that part's own translation. Block ids reuse the SDK's
 * `${itemId}:0`, so the text fills the block the SDK opens on
 * `output_item.added`; when an item also has a summary, the summary wins if
 * it arrives first. Text arriving before a summary can concatenate with it.
 */
import type { ModelStreamEvent } from "../types/events.js";

export type ReasoningEvent = Extract<
  ModelStreamEvent,
  { type: "reasoning_start" | "reasoning_delta" | "reasoning_end" }
>;

/** Item id used when a gateway omits `item_id` on reasoning_text frames. */
export const FALLBACK_REASONING_ITEM_ID = "reasoning";
const PART_SEPARATOR = "\n\n";

export class ResponsesReasoningTextRecovery {
  readonly #open = new Set<string>();          // block ids currently open (SDK-opened or ours)
  readonly #synthesized = new Set<string>();   // block ids whose start WE emitted (we owe the end)
  readonly #summarized = new Set<string>();    // item ids with an SDK summary delta
  readonly #hasText = new Set<string>();       // item ids that already got text from us
  readonly #streamedParts = new Set<string>(); // `${itemId}#${contentIndex}` parts that streamed
  readonly #done = new Set<string>();          // item ids past their output_item.done

  observe(part: unknown): ReasoningEvent[] {
    if (!isRecord(part)) return [];
    switch (part.type) {
      case "reasoning-start":
        if (typeof part.id === "string") this.#open.add(part.id);
        return [];
      case "reasoning-delta":
        if (typeof part.id === "string") this.#summarized.add(itemIdOfBlock(part.id));
        return [];
      case "reasoning-end":
        if (typeof part.id === "string") {
          this.#open.delete(part.id);
          this.#synthesized.delete(part.id);
        }
        return [];
      case "finish-step":
      case "finish":
        return this.#closeSynthesized();
      case "raw":
        return this.#observeRaw(part.rawValue);
      default:
        return [];
    }
  }

  #observeRaw(value: unknown): ReasoningEvent[] {
    if (!isRecord(value)) return [];
    switch (value.type) {
      case "response.reasoning_text.delta": {
        if (typeof value.delta !== "string" || value.delta === "") return [];
        const itemId = itemIdFrom(value.item_id);
        if (this.#summarized.has(itemId) || this.#done.has(itemId)) return [];
        const key = partKey(itemId, value.content_index);
        const firstOfPart = !this.#streamedParts.has(key);
        this.#streamedParts.add(key);
        const text = firstOfPart && this.#hasText.has(itemId) ? PART_SEPARATOR + value.delta : value.delta;
        return this.#emit(itemId, text);
      }
      case "response.reasoning_text.done": {
        if (typeof value.text !== "string" || value.text === "") return [];
        const itemId = itemIdFrom(value.item_id);
        if (this.#summarized.has(itemId) || this.#done.has(itemId)) return [];
        const key = partKey(itemId, value.content_index);
        if (this.#streamedParts.has(key)) return [];
        this.#streamedParts.add(key);
        return this.#emit(itemId, this.#hasText.has(itemId) ? PART_SEPARATOR + value.text : value.text);
      }
      case "response.output_item.done": {
        const item = value.item;
        if (!isRecord(item) || item.type !== "reasoning") return [];
        const itemId = itemIdFrom(item.id);
        const events: ReasoningEvent[] = [];
        if (!this.#summarized.has(itemId) && !this.#hasText.has(itemId) && !this.#done.has(itemId)) {
          const text = reasoningContentText(item.content);
          if (text !== "") events.push(...this.#emit(itemId, text));
        }
        this.#done.add(itemId);
        const id = blockId(itemId);
        if (this.#synthesized.has(id)) {
          this.#synthesized.delete(id);
          this.#open.delete(id);
          events.push({ type: "reasoning_end", id });
        }
        return events;
      }
      default:
        return [];
    }
  }

  #emit(itemId: string, text: string): ReasoningEvent[] {
    const id = blockId(itemId);
    const events: ReasoningEvent[] = [];
    if (!this.#open.has(id)) {
      this.#open.add(id);
      this.#synthesized.add(id);
      events.push({ type: "reasoning_start", id });
    }
    this.#hasText.add(itemId);
    events.push({ type: "reasoning_delta", id, text });
    return events;
  }

  #closeSynthesized(): ReasoningEvent[] {
    const events: ReasoningEvent[] = [];
    for (const id of this.#synthesized) {
      this.#open.delete(id);
      events.push({ type: "reasoning_end", id });
    }
    this.#synthesized.clear();
    return events;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function blockId(itemId: string): string {
  return `${itemId}:0`;
}
function itemIdFrom(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : FALLBACK_REASONING_ITEM_ID;
}
/** SDK reasoning part id `${itemId}:${summaryIndex}` -> itemId. */
function itemIdOfBlock(partId: string): string {
  const at = partId.lastIndexOf(":");
  return at > 0 ? partId.slice(0, at) : partId;
}
function partKey(itemId: string, contentIndex: unknown): string {
  return `${itemId}#${typeof contentIndex === "number" ? contentIndex : 0}`;
}
function reasoningContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const entry of content) {
    if (isRecord(entry) && entry.type === "reasoning_text" && typeof entry.text === "string" && entry.text !== "") {
      texts.push(entry.text);
    }
  }
  return texts.join(PART_SEPARATOR);
}

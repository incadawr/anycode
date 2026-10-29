/** Recover Responses reasoning_text events before the SDK buffers its stream. */
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
  readonly #emittedParts = new Set<string>();
  readonly #completedParts = new Set<string>();
  readonly #pendingParts = new Map<string, Map<number, string>>(); // parts waiting for earlier indices to complete
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
        const index = contentIndexOf(value.content_index);
        const key = partKey(itemId, index);
        const firstOfPart = !this.#streamedParts.has(key);
        this.#streamedParts.add(key);
        if (this.#bufferPart(itemId, index, value.delta)) return this.#flushReadyParts(itemId);
        this.#emittedParts.add(key);
        const text = firstOfPart && this.#hasText.has(itemId) ? PART_SEPARATOR + value.delta : value.delta;
        return this.#emit(itemId, text);
      }
      case "response.reasoning_text.done": {
        const itemId = itemIdFrom(value.item_id);
        if (this.#summarized.has(itemId) || this.#done.has(itemId)) return [];
        const index = contentIndexOf(value.content_index);
        const key = partKey(itemId, index);
        this.#completedParts.add(key);
        if (this.#streamedParts.has(key) || typeof value.text !== "string" || value.text === "") {
          return this.#flushReadyParts(itemId);
        }
        this.#streamedParts.add(key);
        if (this.#bufferPart(itemId, index, value.text)) return this.#flushReadyParts(itemId);
        this.#emittedParts.add(key);
        const events = this.#emit(itemId, this.#hasText.has(itemId) ? PART_SEPARATOR + value.text : value.text);
        return [...events, ...this.#flushReadyParts(itemId)];
      }
      case "response.output_item.done": {
        const item = value.item;
        if (!isRecord(item) || item.type !== "reasoning") return [];
        const itemId = itemIdFrom(item.id);
        const events: ReasoningEvent[] = [];
        if (!this.#summarized.has(itemId) && !this.#done.has(itemId) && Array.isArray(item.content)) {
          const missing: string[] = [];
          const pending = this.#pendingParts.get(itemId);
          item.content.forEach((entry, index) => {
            const buffered = pending?.get(index);
            if (buffered) { missing.push(buffered); pending?.delete(index); }
            else if (isRecord(entry) && entry.type === "reasoning_text" && typeof entry.text === "string" && entry.text !== "" && !this.#streamedParts.has(partKey(itemId, index))) {
              this.#streamedParts.add(partKey(itemId, index));
              missing.push(entry.text);
            }
          });
          if (pending) { for (const [, text] of [...pending].sort(([a], [b]) => a - b)) missing.push(text); this.#pendingParts.delete(itemId); }
          if (missing.length > 0) events.push(...this.#emit(itemId, (this.#hasText.has(itemId) ? PART_SEPARATOR : "") + missing.join(PART_SEPARATOR)));
        }
        if (!this.#summarized.has(itemId)) events.push(...this.#flushPending(itemId));
        else this.#pendingParts.delete(itemId);
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

  #bufferPart(itemId: string, index: number, text: string): boolean {
    let pending = this.#pendingParts.get(itemId);
    if (this.#emittedParts.has(partKey(itemId, index))) return false;
    let missingEarlier = false;
    for (let i = 0; !pending && i < index; i++) {
      if (!this.#completedParts.has(partKey(itemId, i))) { missingEarlier = true; break; }
    }
    if (!pending && missingEarlier) {
      pending = new Map();
      this.#pendingParts.set(itemId, pending);
    }
    if (!pending) return false;
    pending.set(index, (pending.get(index) ?? "") + text);
    return true;
  }

  #flushReadyParts(itemId: string): ReasoningEvent[] {
    const pending = this.#pendingParts.get(itemId);
    if (!pending) return [];
    const events: ReasoningEvent[] = [];
    for (let index = 0; ; index++) {
      const key = partKey(itemId, index);
      if (this.#emittedParts.has(key)) {
        if (!this.#completedParts.has(key)) break;
        continue;
      }
      const text = pending.get(index);
      if (text === undefined) {
        if (!this.#completedParts.has(key)) break;
        continue;
      }
      pending.delete(index);
      this.#emittedParts.add(key);
      events.push(...this.#emit(itemId, (this.#hasText.has(itemId) ? PART_SEPARATOR : "") + text));
      if (!this.#completedParts.has(key)) break;
    }
    if (pending.size === 0) this.#pendingParts.delete(itemId);
    return events;
  }

  #flushPending(itemId: string): ReasoningEvent[] {
    const pending = this.#pendingParts.get(itemId);
    if (!pending) return [];
    this.#pendingParts.delete(itemId);
    const text = [...pending].sort(([a], [b]) => a - b).map(([, part]) => part).join(PART_SEPARATOR);
    return text ? this.#emit(itemId, (this.#hasText.has(itemId) ? PART_SEPARATOR : "") + text) : [];
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
    for (const itemId of this.#pendingParts.keys()) {
      if (!this.#summarized.has(itemId)) events.push(...this.#flushPending(itemId));
      else this.#pendingParts.delete(itemId);
    }
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
function contentIndexOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function partKey(itemId: string, contentIndex: unknown): string {
  return `${itemId}#${contentIndexOf(contentIndex)}`;
}
export function reasoningContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const entry of content) {
    if (isRecord(entry) && entry.type === "reasoning_text" && typeof entry.text === "string" && entry.text !== "") {
      texts.push(entry.text);
    }
  }
  return texts.join(PART_SEPARATOR);
}

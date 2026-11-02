/**
 * Collects one model step's reasoning blocks for the assistant history item
 * (GitHub #41). Only blocks whose `reasoning_end` carried a `source` are kept:
 * the model port sets it only on routes that replay reasoning, so other
 * routes store nothing new. The stream order of text segments, reasoning
 * blocks and tool calls is recorded, so the stored order matches the stream.
 */

import type { ModelStreamEvent } from "../types/events.js";
import type { AssistantPart, AssistantReasoningPart } from "../types/history.js";

interface Block {
  text: string;
  part?: AssistantReasoningPart;
}

/** One stream-order slot: a text segment, a reasoning block, or a tool call. */
type Slot =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; id: string }
  | { kind: "tool" };

export class ReasoningCapture {
  private readonly blocks = new Map<string, Block>();
  private slots: Slot[] = [];

  observe(event: ModelStreamEvent): void {
    switch (event.type) {
      case "text_delta": {
        if (event.text.length === 0) break;
        const last = this.slots.at(-1);
        if (last?.kind === "text") last.text += event.text;
        else this.slots.push({ kind: "text", text: event.text });
        break;
      }
      case "tool_call":
        this.slots.push({ kind: "tool" });
        break;
      case "reasoning_start":
        this.block(event.id);
        break;
      case "reasoning_delta":
        this.block(event.id).text += event.text;
        break;
      case "reasoning_end": {
        if (event.source === undefined) break;
        const block = this.block(event.id);
        block.part = {
          type: "reasoning",
          text: block.text,
          ...(event.providerMetadata !== undefined ? { providerMetadata: event.providerMetadata } : {}),
          source: event.source,
        };
        break;
      }
      default:
        break;
    }
  }

  /** Drops everything from an abandoned attempt (`stream_retry`). */
  reset(): void {
    this.blocks.clear();
    this.slots = [];
  }

  /**
   * Rebuilds the step's parts in stream order with the kept reasoning in
   * place. `base` is what the loop built (all text joined into one leading
   * part, then the tool calls); without kept reasoning it is returned as is.
   * Text on both sides of a reasoning block stays two parts, so an
   * interleaved `thinking -> text -> thinking -> text` step replays exactly.
   */
  weave(base: AssistantPart[]): AssistantPart[] {
    const kept = [...this.blocks.values()].some((block) => block.part !== undefined);
    if (!kept) return base;
    const tools = base.filter((part) => part.type === "tool_call");
    const baseText = base.filter((part) => part.type === "text").map((part) => part.text).join("");
    let slots = this.slots;
    const streamText = slots.map((slot) => (slot.kind === "text" ? slot.text : "")).join("");
    if (streamText !== baseText) {
      // Should not happen: the loop builds its text from the same deltas.
      // Trust the loop's text, placed where the first text segment was (or
      // before the first tool call).
      const firstText = slots.findIndex((slot) => slot.kind === "text");
      slots = slots.filter((slot) => slot.kind !== "text");
      const firstTool = slots.findIndex((slot) => slot.kind === "tool");
      const at = firstText !== -1 ? firstText : firstTool !== -1 ? firstTool : slots.length;
      if (baseText.length > 0) slots.splice(at, 0, { kind: "text", text: baseText });
    }
    let nextTool = 0;
    const out: AssistantPart[] = [];
    for (const slot of slots) {
      if (slot.kind === "text") {
        const last = out.at(-1);
        // Merge across a dropped (unsigned) reasoning block.
        if (last?.type === "text") last.text += slot.text;
        else out.push({ type: "text", text: slot.text });
      } else if (slot.kind === "tool") {
        const tool = tools[nextTool++];
        if (tool !== undefined) out.push(tool);
      } else {
        const part = this.blocks.get(slot.id)?.part;
        if (part !== undefined) out.push(part);
      }
    }
    // Tool calls the stream did not announce in order (should not happen).
    out.push(...tools.slice(nextTool));
    // Keep the loop's rule: a step with no text and no tools still has a text part.
    if (!out.some((part) => part.type === "text" || part.type === "tool_call")) {
      out.push({ type: "text", text: "" });
    }
    return out;
  }

  private block(id: string): Block {
    let block = this.blocks.get(id);
    if (block === undefined) {
      block = { text: "" };
      this.blocks.set(id, block);
      this.slots.push({ kind: "reasoning", id });
    }
    return block;
  }
}

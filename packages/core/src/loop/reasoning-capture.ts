/**
 * Collects one model step's reasoning blocks for the assistant history item
 * (GitHub #41). Only blocks whose `reasoning_end` carried a `source` are kept:
 * the model port sets it only on routes that replay reasoning, so other
 * routes store nothing new. Each block remembers how much text / how many
 * tool calls came before it, so the stored order matches the stream.
 */

import type { ModelStreamEvent } from "../types/events.js";
import type { AssistantPart, AssistantReasoningPart } from "../types/history.js";

interface Block {
  text: string;
  afterText: boolean;
  afterTools: number;
  part?: AssistantReasoningPart;
}

export class ReasoningCapture {
  private readonly blocks = new Map<string, Block>();
  private textSeen = false;
  private toolsSeen = 0;

  observe(event: ModelStreamEvent): void {
    switch (event.type) {
      case "text_delta":
        if (event.text.length > 0) this.textSeen = true;
        break;
      case "tool_call":
        this.toolsSeen += 1;
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
    this.textSeen = false;
    this.toolsSeen = 0;
  }

  /**
   * Weaves the kept reasoning into `base` (an optional leading text part,
   * then the tool calls in stream order, as the loop builds it).
   */
  weave(base: AssistantPart[]): AssistantPart[] {
    const kept = [...this.blocks.values()].filter((block) => block.part !== undefined);
    if (kept.length === 0) return base;
    const group = (afterText: boolean, afterTools: number): AssistantPart[] =>
      kept
        .filter((block) => block.afterText === afterText && block.afterTools === afterTools)
        .map((block) => block.part!);
    const out: AssistantPart[] = [...group(false, 0)];
    let tools = 0;
    for (const part of base) {
      out.push(part);
      if (part.type === "text") {
        out.push(...group(true, 0));
      } else if (part.type === "tool_call") {
        tools += 1;
        out.push(...kept.filter((block) => block.afterTools === tools).map((block) => block.part!));
      }
    }
    // Blocks after more tool calls than were kept (should not happen) go last.
    out.push(...kept.filter((block) => block.afterTools > tools).map((block) => block.part!));
    return out;
  }

  private block(id: string): Block {
    let block = this.blocks.get(id);
    if (block === undefined) {
      block = { text: "", afterText: this.textSeen, afterTools: this.toolsSeen };
      this.blocks.set(id, block);
    }
    return block;
  }
}

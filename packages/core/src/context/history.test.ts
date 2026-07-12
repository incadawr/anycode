/**
 * ConversationHistory envelope behavior shipped by task 1.1 (design §2.1):
 * append/replaceAll/sink plumbing, token estimate caching, toMessages and the
 * unansweredToolCallIds integrity helper. Compaction-oriented property tests
 * are task 1.2.
 */

import { describe, expect, it } from "vitest";
import type { ChatMessage, HistoryItem } from "../types/history.js";
import type { ImageAttachment } from "../types/images.js";
import { IMAGE_TOKEN_ESTIMATE } from "../types/config.js";
import { ConversationHistory, estimateMessageTokens, messageTokenText, type HistorySink } from "./history.js";
import { HeuristicTokenizer } from "./tokenizer.js";

class RecordingSink implements HistorySink {
  readonly appended: HistoryItem[][] = [];
  readonly replaced: HistoryItem[][] = [];

  append(items: readonly HistoryItem[]): void {
    this.appended.push([...items]);
  }

  replaceAll(items: readonly HistoryItem[]): void {
    this.replaced.push([...items]);
  }

  async flush(): Promise<void> {}
}

describe("ConversationHistory", () => {
  it("append assigns id/createdAt/tokenEstimate and feeds the sink", () => {
    const sink = new RecordingSink();
    const history = new ConversationHistory({ sink });

    const item = history.append({ role: "user", content: "hello world" });

    expect(item.id).toBeTruthy();
    expect(item.createdAt).toBeGreaterThan(0);
    expect(item.tokenEstimate).toBeGreaterThan(0);
    expect(item.kind).toBe("normal");
    expect(history.items).toHaveLength(1);
    expect(sink.appended).toEqual([[item]]);
  });

  it("toMessages returns the messages in append order", () => {
    const history = new ConversationHistory();
    history.append({ role: "user", content: "one" });
    history.append({ role: "assistant", content: [{ type: "text", text: "two" }] });

    expect(history.toMessages()).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ]);
  });

  it("totalTokenEstimate sums the cached per-item estimates", () => {
    const history = new ConversationHistory();
    const a = history.append({ role: "user", content: "aaaa bbbb cccc dddd" });
    const b = history.append({ role: "user", content: "eeee ffff" });
    expect(history.totalTokenEstimate()).toBe((a.tokenEstimate ?? 0) + (b.tokenEstimate ?? 0));
  });

  it("replaceAll swaps the list atomically and feeds sink.replaceAll", () => {
    const sink = new RecordingSink();
    const history = new ConversationHistory({ sink });
    history.append({ role: "user", content: "old" });

    const replacement: HistoryItem[] = [
      {
        id: "summary-1",
        createdAt: 1,
        message: { role: "user", content: "session summary" },
        tokenEstimate: 3,
        kind: "compact_summary",
      },
    ];
    history.replaceAll(replacement);

    expect(history.items.map((i) => i.id)).toEqual(["summary-1"]);
    expect(sink.replaced).toHaveLength(1);
    expect(sink.replaced[0]?.map((i) => i.id)).toEqual(["summary-1"]);
  });

  it("restores from initial items (resume path)", () => {
    const initial: HistoryItem[] = [
      { id: "u1", createdAt: 1, message: { role: "user", content: "hi" }, tokenEstimate: 1 },
    ];
    const history = new ConversationHistory({ initial });
    expect(history.toMessages()).toEqual([{ role: "user", content: "hi" }]);
  });

  it("unansweredToolCallIds reports assistant tool_calls without a tool_result", () => {
    const history = new ConversationHistory();
    history.append({
      role: "assistant",
      content: [
        { type: "tool_call", toolCallId: "c1", toolName: "Read", input: {} },
        { type: "tool_call", toolCallId: "c2", toolName: "Grep", input: {} },
      ],
    });
    history.append({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", text: "ok", status: "success" }],
    });

    expect(history.unansweredToolCallIds()).toEqual(["c2"]);

    history.append({
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "c2", toolName: "Grep", text: "cancelled", status: "cancelled" },
      ],
    });
    expect(history.unansweredToolCallIds()).toEqual([]);
  });
});

describe("estimateMessageTokens (design §2-C3/R13/L4)", () => {
  const tokenizer = new HeuristicTokenizer();
  const img = (): ImageAttachment => ({ mediaType: "image/png", data: "AAAA", sourcePath: "/x.png" });

  it("returns exactly the text-only count for image-free messages (L4 byte-lock)", () => {
    const user: ChatMessage = { role: "user", content: "hello world" };
    const assistant: ChatMessage = {
      role: "assistant",
      content: [{ type: "text", text: "reply here" }],
    };
    const tool: ChatMessage = {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", text: "ok", status: "success" }],
    };
    for (const message of [user, assistant, tool]) {
      expect(estimateMessageTokens(tokenizer, message)).toBe(tokenizer.count(messageTokenText(message)));
    }
  });

  it("adds a flat IMAGE_TOKEN_ESTIMATE for each image on a user message", () => {
    const base: ChatMessage = { role: "user", content: "look at this" };
    const withImages: ChatMessage = { role: "user", content: "look at this", images: [img(), img()] };
    expect(estimateMessageTokens(tokenizer, withImages)).toBe(
      estimateMessageTokens(tokenizer, base) + 2 * IMAGE_TOKEN_ESTIMATE,
    );
  });

  it("sums images across tool-result parts", () => {
    const tool: ChatMessage = {
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "c1", toolName: "Read", text: "a", status: "success", images: [img()] },
        { type: "tool_result", toolCallId: "c2", toolName: "Read", text: "b", status: "success", images: [img(), img()] },
      ],
    };
    const textOnly = tokenizer.count(messageTokenText(tool));
    expect(estimateMessageTokens(tokenizer, tool)).toBe(textOnly + 3 * IMAGE_TOKEN_ESTIMATE);
  });

  it("append caches the image-inclusive estimate", () => {
    const history = new ConversationHistory({ tokenizer: new HeuristicTokenizer() });
    const plain = history.append({ role: "user", content: "same text" });
    const withImg = history.append({ role: "user", content: "same text", images: [img()] });
    expect((withImg.tokenEstimate ?? 0) - (plain.tokenEstimate ?? 0)).toBe(IMAGE_TOKEN_ESTIMATE);
  });
});

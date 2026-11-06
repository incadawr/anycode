import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelPort } from "./model-port.js";
import type { ModelStreamEvent } from "../types/events.js";

const created = { type: "response.created", response: { id: "r", created_at: 1700000000, model: "gateway-model" } };
const completed = { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } };
const added = { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m" } };
const done = { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m" } };
const delta = (text: string) => ({ type: "response.output_text.delta", item_id: "m", delta: text });
const part = (type: string, text: string) => ({
  type: "response.content_part.added", item_id: "m", output_index: 0, content_index: 0,
  part: { type, text },
});

async function run(frames: object[]) {
  // Exercise the real SDK, recovery middleware and model port without loopback.
  const bytes = new TextEncoder().encode([created, ...frames, completed]
    .map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
    start(controller) {
      // Include byte boundaries inside UTF-8 characters and SSE delimiters.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const port = new AiSdkModelPort({
    transport: "openai-responses", baseUrl: "https://gateway.example/v1", model: "gateway-model",
    apiKey: "fixture", retry: { maxRetries: 0, stallTimeoutMs: 0 },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(event);
  const text = events.filter(e => e.type === "text_delta").map(e => e.text).join("");
  const reasoning = events.filter(e => e.type === "reasoning_delta").map(e => e.text).join("");
  return { events, text, reasoning };
}

afterEach(() => vi.unstubAllGlobals());

describe("gateway Responses stream hypotheses", () => {
  it.each(["Kafka down", "О чём думать?"])("preserves the first output_text.delta: %s", async text => {
    const result = await run([added, delta(text.slice(0, 1)), delta(text.slice(1)), done]);
    expect(result.text).toBe(text);
    expect(result.events.filter(e => e.type === "error")).toEqual([]);
  });

  it.each([true, false])("recovers reasoning_text with item_id present=%s", async withId => {
    const fields = withId ? { item_id: "rs" } : {};
    const result = await run([
      { type: "response.reasoning_text.delta", ...fields, content_index: 0, delta: "Think." },
      { type: "response.reasoning_text.done", ...fields, content_index: 0, text: "Think." },
      added, delta("Kafka down"), done,
    ]);
    expect(result.reasoning).toBe("Think.");
    expect(result.text).toBe("Kafka down");
    expect(result.events.filter(e => e.type === "error")).toEqual([]);
  });

  it("recovers reasoning from output_item.done content", async () => {
    const result = await run([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs" } },
      { type: "response.output_item.done", output_index: 0, item: {
        type: "reasoning", id: "rs", summary: [], content: [{ type: "reasoning_text", text: "Think." }],
      } }, added, delta("Kafka down"), done,
    ]);
    expect(result.reasoning).toBe("Think.");
    expect(result.text).toBe("Kafka down");
  });

  it("keeps summaries without duplicating reasoning_text", async () => {
    const result = await run([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 0, delta: "Summary." },
      { type: "response.reasoning_text.delta", item_id: "rs", delta: "Think." },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs", summary: [] } },
      added, delta("Kafka down"), done,
    ]);
    expect(result.reasoning).toBe("Summary.");
    expect(result.text).toBe("Kafka down");
  });

  // Expected failures describe synthetic gateway deviations, not captured traffic.
  // Keep the desired output visible without claiming these shapes occurred live.
  it.fails("would preserve initial answer text carried only by content_part.added", async () => {
    const result = await run([added, part("output_text", "K"), delta("afka down"), done]);
    expect(result.text).toBe("Kafka down");
  });

  it.fails("would recover reasoning carried only by content_part.added", async () => {
    const result = await run([part("reasoning_text", "Think."), added, delta("Kafka down"), done]);
    expect(result.reasoning).toBe("Think.");
  });

  it("preserves a delta arriving before output_item.added", async () => {
    const result = await run([delta("K"), added, delta("afka down"), done]);
    expect(result.text).toBe("Kafka down");
  });

  it.each(["", " "])("opens an empty assistant block for a message containing %j", async text => {
    const result = await run([added, ...(text ? [delta(text)] : []), done]);
    expect(result.events).toContainEqual({ type: "text_start", id: "m" });
    expect(result.text.trim()).toBe("");
  });
});

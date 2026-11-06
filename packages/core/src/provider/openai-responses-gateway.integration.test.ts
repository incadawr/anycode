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

async function run(frames: (object | string)[], chunkSize = 7, finish = true) {
  // Exercise the real SDK, recovery middleware and model port without loopback.
  const bytes = new TextEncoder().encode([created, ...frames, ...(finish ? [completed] : [])]
    .map(frame => typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`).join(""));
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
    start(controller) {
      // Include byte boundaries inside UTF-8 characters and SSE delimiters.
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
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

  // Synthetic gateway deviations; these are not captured traffic.
  it("preserves initial answer text carried only by content_part.added", async () => {
    const result = await run([added, part("output_text", "K"), delta("afka down"), done]);
    expect(result.text).toBe("Kafka down");
  });

  it("recovers reasoning carried only by content_part.added", async () => {
    const result = await run([part("reasoning_text", "Think."), added, delta("Kafka down"), done]);
    expect(result.reasoning).toBe("Think.");
  });

  it("preserves a delta arriving before output_item.added", async () => {
    const result = await run([delta("K"), added, delta("afka down"), done]);
    expect(result.text).toBe("Kafka down");
  });

  it.each(["", " "])("omits empty assistant blocks for a message containing %j", async text => {
    const result = await run([added, ...(text ? [delta(text)] : []), done]);
    expect(result.events.filter(e => e.type === "text_start" || e.type === "text_delta")).toEqual([]);
    expect(result.text.trim()).toBe("");
  });
});

 it("preserves leading whitespace in a non-empty answer", async () => {
   const result = await run([added, delta(" \n"), delta("Kafka down"), done]);
   expect(result.text).toBe(" \nKafka down");
 });

 it.each([1, 7, 100000])("preserves adjacent reasoning and answer frames with chunk size %s", async chunkSize => {
   const result = await run([
     { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "Think." },
     delta("О"), added, delta(" чём думать?"), done,
   ], chunkSize);
   expect(result.reasoning).toBe("Think.");
   expect(result.text).toBe("О чём думать?");
   expect(result.events.filter(e => e.type === "error")).toEqual([]);
 });
 it("recovers a summary without an added reasoning item", async () => {
   const result = await run([
     { type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 0, delta: "Summary." },
     added, delta("Kafka down"), done,
   ]);
   expect(result.reasoning).toBe("Summary.");
   expect(result.events.filter(e => e.type === "error")).toEqual([]);
 });
 it("resolves omitted delta item ids through output_index", async () => {
   const result = await run([added, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Kafka down" }, done]);
   expect(result.text).toBe("Kafka down");
 });
 it("cannot reconstruct a token absent from every gateway frame", async () => {
   expect((await run([added, delta("afka down"), done])).text).toBe("afka down");
 });

 it("reports invalid JSON when two events share one SSE data frame", async () => {
   const frame = `data: ${JSON.stringify({type:"response.reasoning_text.delta",item_id:"rs",delta:"Think."})}\ndata: ${JSON.stringify(delta("K"))}\n\n`;
   const result = await run([frame, added, delta("afka down"), done]);
   expect(result.events.some(e => e.type === "error")).toBe(true);
   expect(result.text).toBe("afka down");
 });

 it("recovers done-only reasoning when its item start was omitted", async () => {
   const result = await run([{type:"response.output_item.done",output_index:0,item:{
     type:"reasoning",id:"rs",summary:[],content:[{type:"reasoning_text",text:"Think."}],encrypted_content:"sealed",
   }}, added, delta("Kafka down"), done]);
   expect(result.reasoning).toBe("Think.");
   expect(result.events.filter(e => e.type === "error")).toEqual([]);
   expect(result.events.find(e => e.type === "reasoning_end")).toMatchObject({providerMetadata:{openai:{reasoningEncryptedContent:"sealed"}}});
 });

// Populated added parts may be a segment or a preview of the first delta.
it.each([1, 7, 100000].flatMap(size => ["output_text", "reasoning_text", "summary_text"].map(kind => [size, kind] as const)))("holds added text until delta or completion, chunk %s, %s", async (chunkSize, kind) => {
    const summary = kind === "summary_text";
    const start = { type: "response.output_item.added", output_index: 0,
      item: { type: kind === "output_text" ? "message" : "reasoning", id: "m" } };
    const seed = (text: string) => ({ ...part(kind, text),
      type: summary ? "response.reasoning_summary_part.added" : "response.content_part.added",
      ...(summary ? { summary_index: 0 } : {}),
    });
    const next = (text: string) => ({ type: `response.${summary ? "reasoning_summary_text" : kind}.delta`,
      item_id: "m", content_index: 0, summary_index: 0, delta: text });
    const end = { ...done, item: { ...start.item, summary: [] } };
    for (const [initial, first, expected] of [
      ["K", "afka down", "Kafka down"], ["Kafka down", "Kafka down", "Kafka down"],
      ["", "Kafka down", "Kafka down"],
      // Coincidental repeated prefix is ambiguous: retain the whole longer delta.
      ["K", "Kafka down", "Kafka down"],
    ]) {
      const result = await run([start, seed(initial!), next(first!), end], chunkSize);
      expect(kind === "output_text" ? result.text : result.reasoning).toBe(expected);
      expect(result.events.filter(e => e.type === "error")).toEqual([]);
    }
    for (const ending of [
      [{ ...seed("Kafka down"), type: summary ? "response.reasoning_summary_part.done" : "response.content_part.done" }, end],
      [end], [completed], [],
    ]) {
      const result = await run([start, seed("Kafka down"), ...ending], chunkSize, false);
      expect(kind === "output_text" ? result.text : result.reasoning).toBe("Kafka down");
      expect(result.events.filter(e => e.type === "error")).toEqual([]);
    }
});

it.each([1, 7, 100000].flatMap(size =>
  ["output_text", "reasoning_text", "reasoning_summary_text"].flatMap(kind =>
    ["missing delta id", "missing seed id", "output index fallback", "part index mismatch"].map(identity =>
      ({ size, kind, identity })))))("keeps seeds ahead of deltas: $kind, $identity, chunk $size", async ({ size, kind, identity }) => {
  const summary = kind === "reasoning_summary_text";
  const start = { ...added, item: { id: "m", type: kind === "output_text" ? "message" : "reasoning" } };
  const seed = { type: summary ? "response.reasoning_summary_part.added" : "response.content_part.added",
    part: { type: summary ? "summary_text" : kind, text: "K" } };
  const seedIdentity = identity === "missing seed id" ? {} : {
    item_id: "m", output_index: 0, ...(identity === "part index mismatch" ? { content_index: 1, summary_index: 1 } : {}),
  };
  const deltaIdentity = identity === "missing delta id" ? {} : identity === "output index fallback" ? { output_index: 0 }
    : { item_id: "m", output_index: 0, ...(identity === "part index mismatch" ? { content_index: 0, summary_index: 0 } : {}) };
  for (const repeated of [false, true]) {
    const result = await run([start, { ...seed, ...seedIdentity },
      { type: `response.${kind}.delta`, ...deltaIdentity, delta: repeated ? "Kafka down" : "afka down" }], size);
    expect(kind === "output_text" ? result.text : result.reasoning).toBe("Kafka down");
    expect(result.events.filter(e => e.type === "error")).toEqual([]);
  }
});

it.each([1, 7, 100000])("matches pending seeds by kind with mixed identity, chunk %s", async size => {
  const result = await run([
    added, part("output_text", "K"),
    { type: "response.content_part.added", part: { type: "reasoning_text", text: "Th" } },
    { type: "response.output_text.delta", delta: "afka down" },
    { type: "response.reasoning_text.delta", item_id: "rs", output_index: 1, delta: "ink." },
  ], size);
  expect(result.text).toBe("Kafka down");
  expect(result.reasoning).toBe("Think.");
  expect(result.events.filter(e => e.type === "error")).toEqual([]);
});

it.each([1, 7, 100000])("flushes ambiguous pending seeds in order before a delta, chunk %s", async size => {
  const result = await run([
    added, part("output_text", "Ka"), { ...part("output_text", "fk"), content_index: 1 },
    { type: "response.output_text.delta", delta: "a down" },
  ], size);
  expect(result.text).toBe("Kafka down");
  expect(result.events.filter(e => e.type === "error")).toEqual([]);
});

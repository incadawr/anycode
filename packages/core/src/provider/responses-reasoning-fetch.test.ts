import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapResponsesReasoningFetch } from "./responses-reasoning-fetch.js";
import { AiSdkModelPort } from "./model-port.js";
import type { ModelStreamEvent } from "../types/events.js";

describe("Responses reasoning stream adapter", () => {
  it("unblocks fragmented UTF-8 SSE frames and preserves their content", async () => {
    const original = 'data: {"type":"response.created"}\r\n\r\ndata: {"type":"vendor.unknown","delta":"思"}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(original);
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const fetcher = wrapResponsesReasoningFetch(async () => new Response(body, {headers:{"content-type":"text/event-stream"}}));
    const result = await (await fetcher("http://example.test")).text();
    expect(result.replace('data: {"type":"response.reasoning_summary_part.added","item_id":"__anycode_gate__","summary_index":0}\n\n', "")).toBe(original);
    expect(result.indexOf("__anycode_gate__")).toBeLessThan(result.indexOf("vendor.unknown"));
  });
  it("passes mixed line endings while the stream remains open", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    const response = await wrapResponsesReasoningFetch(async () => new Response(body, {headers:{"content-type":"text/event-stream"}}))("http://example.test");
    const reader = response.body!.getReader();
    source.enqueue(new TextEncoder().encode('data: {"type":"vendor.unknown"}\n\r\n'));
    const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("frame buffered")), 1000))]);
    expect(new TextDecoder().decode(result.value)).toContain("__anycode_gate__");
    await reader.cancel();
  });
  it("leaves JSON and error responses untouched", async () => {
    for (const response of [new Response("{}", {headers:{"content-type":"application/json"}}), new Response("error", {status:500})]) {
      expect(await wrapResponsesReasoningFetch(async () => response)("http://example.test")).toBe(response);
    }
  });
});

it.each([1, 7, 100000])("preserves normal empty-added SSE bytes, chunk size %s", async size => {
  const original = [
    { type: "response.created" },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m" } },
    { type: "response.content_part.added", item_id: "m", content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", item_id: "m", content_index: 0, delta: "Kafka down" },
    { type: "response.content_part.done", item_id: "m", content_index: 0, part: { type: "output_text", text: "Kafka down" } },
    { type: "response.output_item.done", item: { type: "message", id: "m" } },
    { type: "response.completed" },
  ].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(original);
  const body = new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
    c.close();
  } });
  const response = await wrapResponsesReasoningFetch(async () => new Response(body,
    { headers: { "content-type": "text/event-stream" } }))("http://example.test");
  expect((await response.text()).replace('data: {"type":"response.reasoning_summary_part.added","item_id":"__anycode_gate__","summary_index":0}\n\n', "")).toBe(original);
});


// Exercise the actual SDK parser and port with deterministic SSE, without sockets.

describe("preview reconciliation through the SDK", () => {
  afterEach(() => vi.unstubAllGlobals());
  async function run(kind: string, identity: string, deltas: string[], doneText?: string, ending = "part") {
    const summary = kind === "reasoning_summary_text";
    const itemType = kind === "output_text" ? "message" : "reasoning";
    const partType = summary ? "summary_text" : kind;
    const index = summary ? "summary_index" : "content_index";
    const streamId = deltas.length === 0 && doneText === undefined ? "m" : identity === "absent" ? itemType : "m";
    const address: Record<string, unknown> = identity === "absent" && (deltas.length > 0 || doneText !== undefined) ? {} : { item_id: streamId, [index]: identity === "mismatched-index" && (deltas.length > 0 || doneText !== undefined) ? 1 : 0 };
    const part = { type: partType, text: "Kafka down" };
    const frames = [
      { type: "response.created", response: { id: "r", created_at: 1, model: "fixture" } },
      { type: "response.output_item.added", output_index: 0, item: { type: itemType, id: "m" } },
      { type: summary ? "response.reasoning_summary_part.added" : "response.content_part.added", item_id: "m", [index]: 0, part },
      ...deltas.map(delta => ({ type: `response.${kind}.delta`, ...address, delta })),
      ...(doneText === undefined ? [] : [{ type: `response.${kind}.done`, ...address, text: doneText }]),
      ...(ending === "part" ? [{ type: summary ? "response.reasoning_summary_part.done" : "response.content_part.done", ...address, part }] : []),
      ...(ending !== "eof" ? [
        { type: "response.output_item.done", output_index: 0, item: { type: itemType, id: streamId } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ] : []),
    ];
    vi.stubGlobal("fetch", async () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } }));
    const port = new AiSdkModelPort({ transport: "openai-responses", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "fixture", retry: { maxRetries: 0 } });
    const events: ModelStreamEvent[] = [];
    for await (const event of port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(event);
    expect(events.filter(event => event.type === "error")).toEqual([]);
    return events.flatMap(event => event.type === (kind === "output_text" ? "text_delta" : "reasoning_delta") ? [event.text] : []).join("");
  }
  for (const kind of ["output_text", "reasoning_text", "reasoning_summary_text"]) {
    for (const identity of ["present", "absent", "mismatched-index"]) {
      it.each([
        [["K", "afka down"], "Kafka down"],
        [["Ka", "f", "ka ", "down!"], "Kafka down!"],
        [["Kafka down!"], "Kafka down!"],
        [["Kafka down"], "Kafka down"],
        [["K", "afka down", " later"], "Kafka down later"],
        [[" con", "tinues"], "Kafka down continues"],
        [[" continues"], "Kafka down continues"],
        [["K", "aboom"], "Kafka downKaboom"],
        [["K", "af"], "Kafka down"],
        [[], "Kafka down"],
      ] as [string[], string][])(`${kind}, ${identity}, deltas %j`, async (deltas, expected) => {
        expect(await run(kind, identity, deltas)).toBe(expected);
      });
      it.each(["item", "eof"])(`${kind}, ${identity}, incomplete match at %s`, async ending => {
        expect(await run(kind, identity, ["K", "af"], undefined, ending)).toBe("Kafka down");
      });
    }
  }
  it.each(["present", "absent", "mismatched-index"])("absorbs done-only reasoning, %s", async identity => {
    for (const ending of ["part", "item"]) {
      for (const full of ["Kafka down", "Kafka down; retry later"]) {
        for (const deltas of [[], ["K", "af"]]) {
          expect(await run("reasoning_text", identity, deltas, full, ending)).toBe(full);
        }
      }
    }
  });
});

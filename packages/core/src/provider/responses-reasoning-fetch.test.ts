import { describe, expect, it } from "vitest";
import { wrapResponsesReasoningFetch } from "./responses-reasoning-fetch.js";

describe("Responses reasoning stream adapter", () => {
  it("unblocks fragmented UTF-8 SSE frames and preserves their content", async () => {
    const original = 'data: {"type":"response.created"}\r\n\r\ndata: {"type":"response.reasoning_text.delta","delta":"思"}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(original);
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const fetcher = wrapResponsesReasoningFetch(async () => new Response(body, {headers:{"content-type":"text/event-stream"}}));
    const result = await (await fetcher("http://example.test")).text();
    expect(result.replace('data: {"type":"response.reasoning_summary_part.added","item_id":"__anycode_gate__","summary_index":0}\n\n', "")).toBe(original);
    expect(result.indexOf("__anycode_gate__")).toBeLessThan(result.indexOf("response.reasoning_text.delta"));
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

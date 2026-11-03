import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { AiSdkModelPort } from "./model-port.js";

it("retries a socket drop after reasoning and delivers the completed response", async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      attempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (chunk: Record<string, unknown>) => res.write(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`);
      send({ type: "message_start", message: { id: "msg", model: "fixture", role: "assistant", usage: { input_tokens: 1 } } });
      send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: attempts === 1 ? "abandoned" : "kept" } });
      if (attempts === 1) {
        setTimeout(() => res.destroy(), 50);
        return;
      }
      send({ type: "content_block_stop", index: 0 });
      send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "finished" } });
      send({ type: "content_block_stop", index: 1 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
      send({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = new AiSdkModelPort({ transport: "anthropic-messages", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "fixture", model: "fixture", retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, stallTimeoutMs: 0 } });
    const events = [];
    for await (const event of port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [] })) events.push(event);
    expect(attempts).toBe(2);
    expect(events.filter((event) => event.type === "stream_retry")).toHaveLength(1);
    expect(events.findIndex((event) => event.type === "reasoning_delta" && event.text === "abandoned"))
      .toBeLessThan(events.findIndex((event) => event.type === "stream_retry"));
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning_delta", text: "abandoned" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning_delta", text: "kept" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "finished" }));
    expect(events.at(-1)?.type).toBe("finish");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

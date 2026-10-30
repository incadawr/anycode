import { afterEach, expect, it, vi } from "vitest";
import { findCatalogEntry } from "./catalog-data.js";
import { resolveEffortLevels } from "./capabilities.js";
import { AiSdkModelPort } from "./model-port.js";

const chunks = [
  { type: "message_start", message: { id: "msg_1", model: "mimo-v2.6-pro", role: "assistant", usage: { input_tokens: 5 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

afterEach(() => vi.unstubAllGlobals());

it("keeps MiMo requests within the output ceiling for every offered effort", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  for (const region of ["sgp", "cn", "ams"]) {
    const entry = findCatalogEntry(`xiaomi-mimo-${region}`)!;
    for (const model of entry.models) {
      const efforts = resolveEffortLevels(model.id, entry)!;
      expect(efforts).toEqual(["off", "low", "medium", "high"]);
      const port = new AiSdkModelPort({
        transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test-key",
        model: model.id, providerName: entry.name, retry: { maxRetries: 0, stallTimeoutMs: 0 },
      });
      for (const reasoningEffort of efforts) {
        const events = [];
        for await (const event of port.streamText({
          messages: [{ role: "user", content: "hi" }], tools: [],
          maxOutputTokens: model.maxOutputTokens, reasoningEffort,
        })) events.push(event);
        expect(events.filter((event) => event.type === "error")).toEqual([]);
        expect(bodies.at(-1)!.max_tokens).toBeLessThanOrEqual(131_072);
      }
    }
  }
});

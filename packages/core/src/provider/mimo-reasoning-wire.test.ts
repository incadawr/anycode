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

  for (const mode of ["api", "sgp", "cn", "ams"]) {
    const entry = findCatalogEntry(`xiaomi-mimo-${mode}`)!;
    for (const model of entry.models) {
      const efforts = resolveEffortLevels(model.id, entry)!;
      expect(efforts).toEqual(["off", "low", "medium", "high"]);
      const port = new AiSdkModelPort({
        transport: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test-key",
        model: model.id, providerName: entry.name, retry: { maxRetries: 0, stallTimeoutMs: 0 },
      });
      for (const reasoningEffort of [...efforts, undefined]) {
        const events = [];
        for await (const event of port.streamText({
          messages: [{ role: "user", content: "hi" }], tools: [],
          maxOutputTokens: model.maxOutputTokens, reasoningEffort,
        })) events.push(event);
        expect(events.filter((event) => event.type === "error")).toEqual([]);
        const body = bodies.at(-1)!;
        expect(body.max_tokens).toBeLessThanOrEqual(131_072);
        if (reasoningEffort === undefined || reasoningEffort === "off") {
          expect(body.thinking).toEqual({ type: "disabled" });
        } else {
          const budgets = { low: 4_096, medium: 12_288, high: 24_576 };
          expect(body.thinking).toEqual({ type: "enabled", budget_tokens: budgets[reasoningEffort as keyof typeof budgets] });
        }
      }
    }
  }
});

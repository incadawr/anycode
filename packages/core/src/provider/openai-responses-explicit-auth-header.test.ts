/**
 * Wire-level proof for the W6 codex review MEDIUM#1 fix: `stripAuthorizationFetch`
 * (installed for no-apiKey `openai-responses` endpoints — see openai-responses.ts
 * and the no-header case in openai-responses-auth.test.ts) must NOT strip an
 * EXPLICIT `headers.Authorization` configured on the endpoint. Before the fix,
 * the wrapper deleted the "authorization" header from every outgoing request
 * whenever `config.apiKey === undefined`, regardless of whether that header
 * carried the SDK-generated empty Bearer token or a real header-based
 * credential — a no-apiKey + header-auth endpoint silently lost its
 * credential (401).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { EndpointConfig } from "./endpoint.js";
import { AiSdkModelPort } from "./model-port.js";

interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** A minimal one-shot Responses SSE stream, just enough for the call to finish cleanly. */
function minimalResponsesSse(): string {
  const chunks: ReadonlyArray<Record<string, unknown>> = [
    { type: "response.created", response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<void> {
  for await (const _item of iterable) {
    // drain only — these tests assert on the captured request, not the stream.
  }
}

describe("openai-responses transport: explicit Authorization header survives no-apiKey stripping (W6-FIX #1)", () => {
  let server: Server;
  let baseUrl: string;
  let captured: CapturedRequest | undefined;

  beforeEach(async () => {
    captured = undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured = { headers: req.headers };
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(minimalResponsesSse());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function portFor(config: Partial<EndpointConfig> = {}): AiSdkModelPort {
    const full: EndpointConfig = {
      transport: "openai-responses",
      baseUrl,
      apiKey: undefined,
      model: "gpt-5.1",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
      ...config,
    };
    return new AiSdkModelPort(full);
  }

  it("preserves an explicit headers.Authorization credential when apiKey is undefined", async () => {
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    await drain(portFor({ headers: { Authorization: "Custom my-header-credential" } }).streamText(request));

    expect(captured).toBeDefined();
    expect(captured!.headers["authorization"]).toBe("Custom my-header-credential");
  });

  it("still omits the Authorization header when apiKey is undefined and no header credential is configured", async () => {
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    await drain(portFor({}).streamText(request));

    expect(captured).toBeDefined();
    expect(captured!.headers["authorization"]).toBeUndefined();
  });
});

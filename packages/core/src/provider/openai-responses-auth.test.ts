/**
 * Wire-level proof of MEDIUM#2 (TASK.43 W6): a no-auth `openai-responses`
 * endpoint (`config.apiKey === undefined`) must send NO `Authorization` header
 * at all, matching the `openai-chat-completions` transport's behaviour
 * (`openai-compatible.ts` only adds the header when a key is configured).
 *
 * Before this fix, `createOpenAIResponsesLanguageModel`'s anti-ambient-leak
 * short-circuit (`apiKey: config.apiKey ?? ""`, see that file's header
 * comment) produced a real outgoing `Authorization: Bearer ` header — present
 * with an empty token, rather than absent. Same loopback-capture harness as
 * openai-responses-sse-fixture.integration.test.ts.
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

describe("openai-responses transport: Authorization header on no-auth endpoints (MEDIUM#2)", () => {
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
      apiKey: "test-key",
      model: "gpt-5.1",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
      ...config,
    };
    return new AiSdkModelPort(full);
  }

  it("omits the Authorization header entirely for a genuine no-auth endpoint (apiKey undefined)", async () => {
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    await drain(portFor({ apiKey: undefined }).streamText(request));

    expect(captured).toBeDefined();
    expect(captured!.headers["authorization"]).toBeUndefined();
  });

  it("sends the exact Bearer token when apiKey is a non-empty string", async () => {
    const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

    await drain(portFor({ apiKey: "sk-test-xyz" }).streamText(request));

    expect(captured).toBeDefined();
    expect(captured!.headers["authorization"]).toBe("Bearer sk-test-xyz");
  });

  it("never leaks an ambient OPENAI_API_KEY onto the wire for a no-auth endpoint", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-secret-should-never-be-sent";
    try {
      const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };

      await drain(portFor({ apiKey: undefined }).streamText(request));

      expect(captured).toBeDefined();
      expect(captured!.headers["authorization"]).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});

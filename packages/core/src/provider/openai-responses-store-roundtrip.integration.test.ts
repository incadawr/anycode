/**
 * TASK.43 HIGH#1 verification (codex W3+W4 review): does @ai-sdk/openai@4.0.14's
 * Responses transport serialize a prior tool result as a `function_call_output`
 * input item when `store:false` is forced? If it drops it, a multi-turn tool
 * round-trip is BROKEN on the responses transport (the model never sees the
 * result). This is the stateful counterpart to the one-way contract-suite
 * tool-round-trip scenario (cut W6 #4). Single streamText call carrying a full
 * prior history; we inspect the OUTGOING /responses request body only.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../ports/model.js";
import type { ToolDeclaration } from "../types/tools.js";
import type { EndpointConfig } from "./endpoint.js";
import type { ModelStreamEvent } from "../types/events.js";
import { AiSdkModelPort } from "./model-port.js";

const READ_TOOL: ToolDeclaration = {
  name: "Read",
  description: "Reads a file",
  inputJsonSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
};

const SENTINEL = "SENTINEL_FILE_BODY_42";

function responsesConfig(baseUrl: string): EndpointConfig {
  return {
    transport: "openai-responses",
    baseUrl,
    apiKey: "test-key",
    model: "gpt-5.1",
    retry: { maxRetries: 0, stallTimeoutMs: 0 },
  };
}

const OK_FRAMES: Record<string, unknown>[] = [
  { type: "response.created", response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  },
];

function serialize(frames: ReadonlyArray<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("openai-responses store:false tool round-trip (HIGH#1)", () => {
  let server: Server;
  let baseUrl: string;
  let captured: Record<string, unknown> | undefined;

  beforeEach(async () => {
    captured = undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        captured = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(serialize(OK_FRAMES));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("serializes the prior function_call AND function_call_output into the /responses body", async () => {
    const request: ModelRequest = {
      messages: [
        { role: "user", content: "read /a.txt" },
        { role: "assistant", content: [{ type: "tool_call", toolCallId: "call_1", toolName: "Read", input: { file_path: "/a.txt" } }] },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", toolName: "Read", text: SENTINEL, status: "success" }] },
      ],
      tools: [READ_TOOL],
    };

    const events: ModelStreamEvent[] = await collect(new AiSdkModelPort(responsesConfig(baseUrl)).streamText(request));
    // Errors are tolerated (we only care about the OUTGOING body); log for visibility.
    const errs = events.filter((e) => e.type === "error");
    if (errs.length) console.error("STREAM ERRORS:", JSON.stringify(errs));

    const input = (captured?.input ?? []) as Array<Record<string, unknown>>;
    expect(captured?.store).toBe(false);

    const fnCall = input.find((i) => i.type === "function_call" && i.call_id === "call_1");
    const fnOut = input.find((i) => i.type === "function_call_output" && i.call_id === "call_1");

    expect(fnCall, "prior function_call (call_1) must be serialized").toBeDefined();
    expect(fnOut, "prior function_call_output (call_1) must be serialized").toBeDefined();
    expect(JSON.stringify(fnOut)).toContain(SENTINEL);
  });
});

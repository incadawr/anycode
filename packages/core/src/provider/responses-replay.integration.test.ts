import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelPort } from "./model-port.js";
import { ReasoningCapture } from "../loop/reasoning-capture.js";
import { toSdkMessages } from "./sdk-mapping.js";
import type { EndpointConfig } from "./endpoint.js";
import type { ChatMessage } from "../types/history.js";

const config: EndpointConfig = { transport: "openai-responses", baseUrl: "https://fixture.invalid/v1", model: "o3", apiKey: "fixture", retry: { maxRetries: 0 } };
const source = { transport: config.transport, baseUrl: config.baseUrl, model: config.model };
const history: ChatMessage[] = [{ role: "assistant", content: [
  { type: "reasoning", text: "", source, providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-one" } } },
  { type: "tool_call", toolCallId: "call_1", toolName: "Read", input: {} },
  { type: "reasoning", text: "summary", source, providerMetadata: { openai: { itemId: "rs_2", reasoningEncryptedContent: "encrypted-two" } } },
] }, { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", toolName: "Read", text: "contents", status: "success" }] }];
const completed = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
afterEach(() => vi.unstubAllGlobals());
async function run(extra: Partial<EndpointConfig> = {}, messages = history, reject: boolean | string = false) {
  const bodies: Record<string, any>[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return reject && bodies.length === 1
      ? new Response(JSON.stringify({ error: { message: (typeof reject === "string" ? reject : "Invalid input reasoning encrypted_content"), type: "invalid_request_error" } }), { status: 400 })
      : new Response(completed, { headers: { "content-type": "text/event-stream" } });
  });
  const notices: unknown[] = [];
  const port = new AiSdkModelPort({ ...config, ...extra }, event => notices.push(event));
  const request = { messages, tools: [] };
  for await (const _event of port.streamText(request)) { /* Drain the fake response. */ }
  return { bodies, notices, port, request };
}

describe("Responses encrypted reasoning replay", () => {
  it("round-trips encrypted items in order around tool calls and results", async () => {
    const { bodies } = await run();
    expect(bodies[0]!.input).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-one", summary: [] },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
      { type: "reasoning", id: "rs_2", encrypted_content: "encrypted-two", summary: [{ type: "summary_text", text: "summary" }] },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
    expect(bodies[0]!.include).toContain("reasoning.encrypted_content");
    expect(bodies[0]!.store).toBe(false);
  });

  it.each(["off", "none", "factual", "foreign-model", "foreign-endpoint", "text-only"])("strips independently: %s", async mode => {
    const messages: ChatMessage[] = history.map(message => message.role !== "assistant" ? message : { ...message, content: message.content.map(part => part.type !== "reasoning" ? part : {
      ...part,
      source: { ...source, ...(mode === "foreign-model" ? { model: "other" } : {}), ...(mode === "foreign-endpoint" ? { baseUrl: "https://other.invalid" } : {}) },
      ...(mode === "text-only" ? { text: "plain reasoning", providerMetadata: undefined } : {}),
    }) });
    const extra: Partial<EndpointConfig> = mode === "off" ? { preserveReasoning: false } : mode === "none" ? { reasoningHistory: "none" } : mode === "factual" ? { reasoningHistory: "factual_4" } : {};
    const { bodies } = await run(extra, messages);
    expect(bodies[0]!.input.map((item: any) => item.type)).toEqual(["function_call", "function_call_output"]);
    if (["off", "none", "factual"].includes(mode)) expect(bodies[0]!.include ?? []).not.toContain("reasoning.encrypted_content");
    expect(bodies[0]!.store).toBe(false);
  });

  it("corrects a fake 400 once and remembers the rejection with one notice", async () => {
    const { bodies, notices, port, request } = await run({}, history, true);
    for await (const _event of port.streamText(request)) { /* Check remembered policy. */ }
    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.input[0].encrypted_content).toBe("encrypted-one");
    for (const body of bodies.slice(1)) {
      expect(body.input.map((item: any) => item.type)).toEqual(["function_call", "function_call_output"]);
      expect(body.include ?? []).not.toContain("reasoning.encrypted_content");
    }
    expect(notices).toEqual([{ kind: "reasoning_replay_rejected", reason: "provider-rejected", baseUrl: config.baseUrl, model: config.model }]);
  });

  it.each(["Unrecognized request argument supplied: include", "Unsupported include value: reasoning.encrypted_content", "Invalid parameter: include"])("corrects include rejection before any replay: %s", async message => {
    const { bodies, notices, port, request } = await run({ includeUsage: true }, [{ role: "user", content: "think" }], message);
    for await (const _event of port.streamText(request)) { /* Remembered rejection. */ }
    expect(bodies).toHaveLength(3);
    const { include, ...original } = bodies[0]!;
    expect(include).toEqual(["reasoning.encrypted_content"]);
    expect(bodies.slice(1)).toEqual([original, original]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "reasoning_replay_rejected" });
  });

  it.each(["Invalid input: include a user message", "Unsupported format; include more details", "Invalid parameter: temperature; include a valid number", "Invalid parameter: include; quota exceeded", "Invalid parameter: include; model not found", "Invalid parameter: include; context length exceeded", "Invalid parameter: include; authentication failed", "Invalid parameter: include; rate limit"])("does not correct unrelated or higher-priority errors: %s", async message => {
    const { bodies, notices } = await run({}, [{ role: "user", content: "think" }], message);
    expect(bodies).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it.each([true, false])("never corrects include rejection with explicit replay=%s", async preserveReasoning => {
    const { bodies, notices } = await run({ preserveReasoning }, history, "Unrecognized request argument supplied: include");
    expect(bodies).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it("strips a foreign item without suppressing a later same-source item", async () => {
    const messages: ChatMessage[] = history.map(message => message.role !== "assistant" ? message : { ...message, content: message.content.map((part, index) => part.type === "reasoning" && index === 0 ? { ...part, source: { ...source, model: "other" } } : part) });
    const { bodies } = await run({}, messages);
    expect(bodies[0]!.input.map((item: any) => item.type)).toEqual(["function_call", "reasoning", "function_call_output"]);
    expect(bodies[0]!.input[1].encrypted_content).toBe("encrypted-two");
  });

  it.each(["empty", "content", "summary"])("captures encrypted SSE without inventing summaries: %s", async origin => {
    const frames = [
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_received", summary: [] } },
      ...(origin === "content" ? [{ type: "response.reasoning_text.delta", item_id: "rs_received", content_index: 0, delta: "private content" }] : []),
      ...(origin === "summary" ? [{ type: "response.reasoning_summary_part.added", item_id: "rs_received", summary_index: 0 }, { type: "response.reasoning_summary_text.delta", item_id: "rs_received", summary_index: 0, delta: "real summary" }] : []),
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_received", summary: origin === "summary" ? [{ type: "summary_text", text: "real summary" }] : [], encrypted_content: "received-cipher" } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + completed;
    vi.stubGlobal("fetch", async () => new Response(frames, { headers: { "content-type": "text/event-stream" } }));
    const port = new AiSdkModelPort(config, () => {});
    const events = [];
    const capture = new ReasoningCapture();
    for await (const event of port.streamText({ messages: [{ role: "user", content: "think" }], tools: [] })) { events.push(event); capture.observe(event); }
    const end = events.find(event => event.type === "reasoning_end");
    expect(end).toMatchObject({ source, providerMetadata: { openai: { itemId: "rs_received", reasoningEncryptedContent: "received-cipher" } } });
    if (end?.type !== "reasoning_end") throw new Error("missing reasoning end");
    const { bodies } = await run({}, [{ role: "assistant", content: capture.weave([]) }]);
    expect(bodies[0]!.input.filter((item: any) => item.type === "reasoning")).toEqual([{ type: "reasoning", id: "rs_received", encrypted_content: "received-cipher", summary: origin === "summary" ? [{ type: "summary_text", text: "real summary" }] : [] }]);
    if (origin === "content") expect(capture.weave([])).toContainEqual(expect.objectContaining({ text: "private content" }));
  });

  it("requests encrypted output for an unfamiliar gateway model", async () => {
    const { bodies } = await run({ model: "gateway-model" }, [{ role: "user", content: "think" }]);
    expect(bodies[0]!.include).toContain("reasoning.encrypted_content");
    expect(bodies[0]!.store).toBe(false);
  });

  it("does not correct an explicit On after a Responses rejection", async () => {
    const { bodies, notices } = await run({ preserveReasoning: true }, history, true);
    expect(bodies).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it("strips encrypted metadata when replay is absent even with a matching source", () => {
    expect(JSON.stringify(toSdkMessages(history, "openai-responses"))).not.toContain("encrypted");
  });
});

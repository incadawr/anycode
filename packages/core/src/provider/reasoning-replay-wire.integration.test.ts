/**
 * Wire-byte proof of reasoning replay (GitHub #41): a real AgentLoop over a
 * real AiSdkModelPort against a loopback server (same harness as
 * glm-reasoning-wire.integration.test.ts). The first response streams
 * reasoning and a tool call; the test reads the SECOND request body.
 *
 *  - anthropic-messages + z-ai: the assistant message carries a `thinking`
 *    block with its signature, before `tool_use`;
 *  - openai-chat-completions with replay on: `reasoning_content`;
 *  - after a model switch the old reasoning is not sent;
 *  - a provider with replay off sends nothing and stores nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools/to-model-tools.js", () => ({
  toToolDeclarations: () => [],
}));

import { AgentLoop, type AgentLoopConfig } from "../loop/agent-loop.js";
import { SwitchableModelPort } from "../cli/model.js";
import type { ModelPort } from "../ports/model.js";
import type { AgentEvent } from "../types/events.js";
import type { CorePorts } from "../ports/index.js";
import type { PermissionBroker, PermissionEngine } from "../types/permissions.js";
import type { HookRunner, AggregatedPreToolUseResult } from "../types/hooks.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AiSdkModelPort } from "./model-port.js";
import type { EndpointConfig } from "./endpoint.js";

type Chunk = Record<string, unknown>;

const anthropicSse = (chunks: readonly Chunk[]): string =>
  chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
const openAiSse = (chunks: readonly Chunk[]): string =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

/** Thinking (signed) + a tool call: the step that must be replayed. */
const ANTHROPIC_THINK_THEN_TOOL: Chunk[] = [
  { type: "message_start", message: { id: "msg_1", model: "glm-5.3", role: "assistant", usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Need to read the file " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "first." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.txt\"}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  { type: "message_stop" },
];

/** Thinking (signed) + a plain text answer: ends the turn. */
const ANTHROPIC_THINK_THEN_TEXT: Chunk[] = [
  { type: "message_start", message: { id: "msg_2", model: "glm-5.3", role: "assistant", usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Answer briefly." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-xyz" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const OPENAI_THINK_THEN_TOOL: Chunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Need to read the file first." }, finish_reason: null }] },
  {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "{\"path\":\"a.txt\"}" } }] },
      finish_reason: null,
    }],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

const OPENAI_TEXT: Chunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

interface Fixture {
  baseUrl: string;
  bodies: Record<string, unknown>[];
}

/** Captures SDK request bodies and serves deterministic responses without sockets. */
async function startServer(responses: readonly string[], contentType = "text/event-stream"): Promise<Fixture> {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(responses[Math.min(bodies.length - 1, responses.length - 1)]!, { headers: { "content-type": contentType } });
  });
  return { baseUrl: "http://127.0.0.1:9", bodies };
}

afterEach(() => vi.unstubAllGlobals());

function makeLoop(modelPort: ModelPort): AgentLoop {
  const hooks = {
    register: () => {},
    runPreToolUse: async () => ({}) as AggregatedPreToolUseResult,
    runUserPromptSubmit: async () => ({}),
    runObservers: async () => {},
  } as unknown as HookRunner;
  const allow: PermissionEngine = { check: () => ({ decision: "allow" }) };
  const deny: PermissionBroker = { requestPermission: async () => ({ behavior: "deny", reason: "no client" }) };
  const config: AgentLoopConfig = {
    modelPort,
    registry: { get: () => undefined } as unknown as ToolRegistry,
    hooks,
    permissionEngine: allow,
    permissionBroker: deny,
    mode: "build",
    ports: {} as CorePorts,
    cwd: "/work",
  };
  return new AgentLoop(config);
}

async function run(loop: AgentLoop, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop.runTurn(prompt)) events.push(event);
  return events;
}

function zaiPort(baseUrl: string, model = "glm-5.3", extra: Partial<EndpointConfig> = {}): AiSdkModelPort {
  return new AiSdkModelPort({
    transport: "anthropic-messages",
    baseUrl,
    apiKey: "test-key",
    model,
    providerName: "Z.AI (GLM)",
    retry: { maxRetries: 0, stallTimeoutMs: 0 },
    ...extra,
  });
}

type WireMessage = { role: string; content: unknown };

function assistantMessages(body: Record<string, unknown>): WireMessage[] {
  return (body.messages as WireMessage[]).filter((message) => message.role === "assistant");
}

describe("reasoning replay over the real SDK wire (GitHub #41)", () => {
  it("preserves signed blocks that reuse an index", async () => {
    const chunks: Chunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_details: [{ index: 0, type: "reasoning.text", text: "First block." }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ index: 0, type: "reasoning.text", text: "", signature: "sig-A" }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ index: 0, type: "reasoning.text", text: "Second block." }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ index: 0, type: "reasoning.text", text: "", signature: "sig-B" }] }, finish_reason: null }] },
      ...OPENAI_THINK_THEN_TOOL.slice(1),
    ];
    const fixture = await startServer([openAiSse(chunks), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await run(makeLoop(port), "read");
    expect(assistantMessages(fixture.bodies[1]!)[0]).toMatchObject({ reasoning_details: [
      { index: 0, type: "reasoning.text", text: "First block.", signature: "sig-A" },
      { index: 0, type: "reasoning.text", text: "Second block.", signature: "sig-B" },
    ] });
  });

  it("keeps accumulated text when a signature delta has null text", async () => {
    const chunks: Chunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_details: [{ index: 0, type: "reasoning.text", text: "A thought" }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ index: 0, text: null, signature: "sig" }] }, finish_reason: null }] },
      ...OPENAI_THINK_THEN_TOOL.slice(1),
    ];
    const fixture = await startServer([openAiSse(chunks), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await run(makeLoop(port), "read");
    expect(assistantMessages(fixture.bodies[1]!)[0]).toMatchObject({ reasoning_details: [{ index: 0, type: "reasoning.text", text: "A thought", signature: "sig" }] });
  });

  it("keeps blocks with conflicting IDs separate even when they share an index", async () => {
    const chunks: Chunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_details: [{ index: 0, id: "a", type: "reasoning.text", text: "first" }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ index: 0, id: "b", type: "reasoning.text", text: "second" }] }, finish_reason: null }] },
      ...OPENAI_THINK_THEN_TOOL.slice(1),
    ];
    const fixture = await startServer([openAiSse(chunks), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await run(makeLoop(port), "read");
    expect(assistantMessages(fixture.bodies[1]!)[0]).toMatchObject({ reasoning_details: [
      { index: 0, id: "a", text: "first" }, { index: 0, id: "b", text: "second" },
    ] });
  });

  it("captures and replays an explicitly empty details array", async () => {
    const chunks: Chunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_details: [] }, finish_reason: null }] },
      ...OPENAI_THINK_THEN_TOOL.slice(1),
    ];
    const fixture = await startServer([openAiSse(chunks), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    const loop = makeLoop(port);
    await run(loop, "read");
    expect(loop.history.toMessages()).toContainEqual(expect.objectContaining({ role: "assistant", content: expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", providerMetadata: { openrouter: { reasoningDetails: [] } } }),
    ]) }));
    expect(assistantMessages(fixture.bodies[1]!)[0]).toMatchObject({ reasoning_details: [] });
  });

  it("keeps distinct unindexed blocks and assembles matching indexed and identified deltas", async () => {
    const chunks: Chunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_details: [{ id: "enc-1", type: "reasoning.encrypted", data: "A" }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ id: "enc-2", type: "reasoning.encrypted", data: "B" }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ index: 3, id: "text-1", type: "reasoning.text", text: "hello" }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ id: "text-1", type: "reasoning.text", text: " world" }, { index: 3, text: "!" }, { type: "reasoning.encrypted", data: "C" }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "D" }] }, finish_reason: null }] },
      ...OPENAI_THINK_THEN_TOOL.slice(1),
    ];
    const fixture = await startServer([openAiSse(chunks), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await run(makeLoop(port), "read");
    expect(assistantMessages(fixture.bodies[1]!)[0]).toMatchObject({ reasoning_details: [
      { id: "enc-1", type: "reasoning.encrypted", data: "A" },
      { id: "enc-2", type: "reasoning.encrypted", data: "B" },
      { index: 3, id: "text-1", type: "reasoning.text", text: "hello world!" },
      { type: "reasoning.encrypted", data: "C" },
      { type: "reasoning.encrypted", data: "D" },
    ] });
  });
  it("OpenRouter retains streamed reasoning details and replays the complete blocks", async () => {
    const chunks: Chunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning: "Think ", reasoning_details: [{ index: 0, type: "reasoning.text", format: "unknown", id: "r1", text: "Think " }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning: "first.", reasoning_details: [{ index: 0, type: "reasoning.text", format: "unknown", id: "r1", text: "first." }, { index: 1, type: "reasoning.encrypted", format: "test", data: "cipher" }] }, finish_reason: null }] },
      ...OPENAI_THINK_THEN_TOOL.slice(1),
    ];
    const fixture = await startServer([openAiSse(chunks), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await run(makeLoop(port), "read");
    const assistant = assistantMessages(fixture.bodies[1]!)[0];
    expect(assistant).toMatchObject({ reasoning_details: [
      { index: 0, type: "reasoning.text", format: "unknown", id: "r1", text: "Think first." },
      { index: 1, type: "reasoning.encrypted", format: "test", data: "cipher" },
    ] });
    expect(assistant).not.toHaveProperty("reasoning_content");
  });

  it("OpenRouter retains encrypted-only reasoning", async () => {
    const chunks: Chunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_details: [{ index: 0, type: "reasoning.encrypted", data: "secret-block" }] }, finish_reason: null }] },
      ...OPENAI_THINK_THEN_TOOL.slice(1),
    ];
    const fixture = await startServer([openAiSse(chunks), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await run(makeLoop(port), "read");
    expect(assistantMessages(fixture.bodies[1]!)[0]).toMatchObject({ reasoning_details: [{ index: 0, type: "reasoning.encrypted", data: "secret-block" }] });
  });

  it("OpenRouter replays plaintext when details are absent", async () => {
    const fixture = await startServer([openAiSse(OPENAI_THINK_THEN_TOOL), openAiSse(OPENAI_TEXT)]);
    const port = new AiSdkModelPort({ transport: "openai-chat-completions", baseUrl: fixture.baseUrl, apiKey: "test", model: "test", providerName: "OpenRouter", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    await run(makeLoop(port), "read");
    expect(assistantMessages(fixture.bodies[1]!)[0]).toMatchObject({ reasoning_content: "Need to read the file first." });
  });

  it("anthropic-messages + z-ai: the next request carries the signed thinking block before tool_use", async () => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TOOL), anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const loop = makeLoop(zaiPort(fixture.baseUrl));

    const events = await run(loop, "read a.txt");

    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
    expect(fixture.bodies).toHaveLength(2);
    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([
      { type: "thinking", thinking: "Need to read the file first.", signature: "sig-abc" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);

    // History stores it in stream order, with the route that produced it.
    const stored = loop.history.toMessages().find((message) => message.role === "assistant");
    expect(stored).toEqual({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Need to read the file first.",
          providerMetadata: { anthropic: { signature: "sig-abc" } },
          source: { transport: "anthropic-messages", replayUnsigned: true, provider: "Z.AI (GLM)", baseUrl: fixture.baseUrl, model: "glm-5.3" },
        },
        { type: "tool_call", toolCallId: "toolu_1", toolName: "Read", input: {} },
      ],
    });
  });

  it("anthropic-messages + z-ai: reasoning from an earlier turn is preserved on the same model", async () => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const loop = makeLoop(zaiPort(fixture.baseUrl));

    await run(loop, "first");
    await run(loop, "second");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([
      { type: "thinking", thinking: "Answer briefly.", signature: "sig-xyz" },
      { type: "text", text: "done" },
    ]);
  });

  it("after a model switch the earlier reasoning is not sent", async () => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const port = new SwitchableModelPort(zaiPort(fixture.baseUrl, "glm-5.3"));
    const loop = makeLoop(port);

    await run(loop, "first");
    port.setPort(zaiPort(fixture.baseUrl, "glm-5.3-flash"));
    await run(loop, "second");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("after a connection switch (other endpoint, same model) the earlier reasoning is not sent", async () => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const port = new SwitchableModelPort(zaiPort(fixture.baseUrl));
    const loop = makeLoop(port);

    await run(loop, "first");
    // Same server, but a different endpoint path is a different route.
    port.setPort(zaiPort(`${fixture.baseUrl}/other`));
    await run(loop, "second");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("a provider with replay off sends no thinking and stores no reasoning", async () => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TOOL), anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const loop = makeLoop(new AiSdkModelPort({
      transport: "anthropic-messages",
      baseUrl: fixture.baseUrl,
      apiKey: "test-key",
      model: "claude-sonnet-5-5",
      providerName: "Anthropic",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    }));

    const events = await run(loop, "read a.txt");

    // The UI still sees the reasoning stream...
    expect(events.some((event) => event.type === "reasoning_delta")).toBe(true);
    // ...but the reasoning_end carries no replay data, nothing is stored or sent.
    expect(events.find((event) => event.type === "reasoning_end")).toEqual({ type: "reasoning_end", id: "0" });
    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }]);
    const stored = loop.history.toMessages().find((message) => message.role === "assistant");
    expect(stored?.role === "assistant" && stored.content.some((part) => part.type === "reasoning")).toBe(false);
  });

  it.each(["DeepSeek", "MiniMax", "MiniMax (China)"])("anthropic-messages + %s: the signed thinking block is replayed", async (providerName) => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TOOL), anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const loop = makeLoop(new AiSdkModelPort({
      transport: "anthropic-messages",
      baseUrl: fixture.baseUrl,
      apiKey: "test-key",
      model: "some-model",
      providerName,
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    }));

    await run(loop, "read a.txt");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([
      { type: "thinking", thinking: "Need to read the file first.", signature: "sig-abc" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    ]);
  });

  it("custom anthropic-compatible endpoints default to off", async () => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TOOL), anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const loop = makeLoop(new AiSdkModelPort({
      transport: "anthropic-messages",
      baseUrl: fixture.baseUrl,
      apiKey: "test-key",
      model: "some-model",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    }));

    await run(loop, "read a.txt");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }]);
  });

  it("the connection override turns replay off for a catalog provider", async () => {
    const fixture = await startServer([anthropicSse(ANTHROPIC_THINK_THEN_TOOL), anthropicSse(ANTHROPIC_THINK_THEN_TEXT)]);
    const loop = makeLoop(zaiPort(fixture.baseUrl, "glm-5.3", { preserveReasoning: false }));

    await run(loop, "read a.txt");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant!.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }]);
  });

  function chatPort(baseUrl: string, preserveReasoning?: boolean): AiSdkModelPort {
    return new AiSdkModelPort({
      transport: "openai-chat-completions",
      baseUrl,
      apiKey: "test-key",
      model: "glm-5.3",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
      ...(preserveReasoning !== undefined ? { preserveReasoning } : {}),
    });
  }

  it("openai-chat-completions with replay on: the next request carries reasoning_content", async () => {
    const fixture = await startServer([openAiSse(OPENAI_THINK_THEN_TOOL), openAiSse(OPENAI_TEXT)]);
    const loop = makeLoop(chatPort(fixture.baseUrl, true));

    const events = await run(loop, "read a.txt");

    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant).toMatchObject({
      role: "assistant",
      reasoning_content: "Need to read the file first.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } }],
    });
  });

  it("openai-chat-completions with replay on: a tool-call turn with no reasoning still sends reasoning_content \"\"", async () => {
    const noReasoningTool: Chunk[] = OPENAI_THINK_THEN_TOOL.slice(1);
    const fixture = await startServer([openAiSse(noReasoningTool), openAiSse(OPENAI_TEXT)]);
    const loop = makeLoop(chatPort(fixture.baseUrl, true));

    await run(loop, "read a.txt");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant).toMatchObject({ role: "assistant", reasoning_content: "", tool_calls: [{ id: "call_1" }] });
  });

  it("openai-chat-completions with replay on: reasoning from another model becomes reasoning_content \"\"", async () => {
    const fixture = await startServer([openAiSse(OPENAI_THINK_THEN_TOOL), openAiSse(OPENAI_TEXT)]);
    const port = new SwitchableModelPort(chatPort(fixture.baseUrl, true));
    const loop = makeLoop(port);

    await run(loop, "read a.txt");
    port.setPort(new AiSdkModelPort({
      transport: "openai-chat-completions",
      baseUrl: fixture.baseUrl,
      apiKey: "test-key",
      model: "other-model",
      preserveReasoning: true,
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    }));
    await run(loop, "again");

    const [assistant] = assistantMessages(fixture.bodies.at(-1)!);
    expect(assistant).toMatchObject({ role: "assistant", reasoning_content: "", tool_calls: [{ id: "call_1" }] });
  });

  it("openai-chat-completions on a custom endpoint (default off): no reasoning_content", async () => {
    const fixture = await startServer([openAiSse(OPENAI_THINK_THEN_TOOL), openAiSse(OPENAI_TEXT)]);
    const loop = makeLoop(chatPort(fixture.baseUrl));

    await run(loop, "read a.txt");

    const [assistant] = assistantMessages(fixture.bodies[1]!);
    expect(assistant).not.toHaveProperty("reasoning_content");
  });
});

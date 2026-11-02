import { describe, expect, it, vi } from "vitest";

vi.mock("../tools/to-model-tools.js", () => ({
  toToolDeclarations: () => [],
}));

import { AgentLoop } from "./agent-loop.js";
import { ReasoningCapture } from "./reasoning-capture.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { CorePorts } from "../ports/index.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { AssistantPart, ReasoningSource } from "../types/history.js";
import type { HookRunner } from "../types/hooks.js";
import type { ToolRegistry } from "../tools/registry.js";

const source: ReasoningSource = { transport: "anthropic-messages", provider: "Z.AI (GLM)", baseUrl: "http://z", model: "glm-5.3" };
const sig = (signature: string) => ({ anthropic: { signature } });

function feed(capture: ReasoningCapture, events: ModelStreamEvent[]): void {
  for (const event of events) capture.observe(event);
}

const text = (value: string): AssistantPart => ({ type: "text", text: value });
const call = (id: string): AssistantPart => ({ type: "tool_call", toolCallId: id, toolName: "Read", input: {} });

describe("ReasoningCapture (GitHub #41)", () => {
  it("assembles deltas per id and keeps blocks in stream order around text and tool calls", () => {
    const capture = new ReasoningCapture();
    feed(capture, [
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "first " },
      { type: "reasoning_delta", id: "r1", text: "thought" },
      { type: "reasoning_end", id: "r1", providerMetadata: sig("s1"), source },
      { type: "text_delta", id: "t", text: "Reading." },
      { type: "reasoning_start", id: "r2" },
      { type: "reasoning_delta", id: "r2", text: "after text" },
      { type: "reasoning_end", id: "r2", providerMetadata: sig("s2"), source },
      { type: "tool_call", toolCall: { id: "c1", name: "Read", input: {} } },
      { type: "reasoning_start", id: "r3" },
      { type: "reasoning_delta", id: "r3", text: "between calls" },
      { type: "reasoning_end", id: "r3", providerMetadata: sig("s3"), source },
      { type: "tool_call", toolCall: { id: "c2", name: "Read", input: {} } },
    ]);

    expect(capture.weave([text("Reading."), call("c1"), call("c2")])).toEqual([
      { type: "reasoning", text: "first thought", providerMetadata: sig("s1"), source },
      text("Reading."),
      { type: "reasoning", text: "after text", providerMetadata: sig("s2"), source },
      call("c1"),
      { type: "reasoning", text: "between calls", providerMetadata: sig("s3"), source },
      call("c2"),
    ]);
  });

  it("keeps nothing when reasoning_end has no source (a route that does not replay)", () => {
    const capture = new ReasoningCapture();
    feed(capture, [
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "x" },
      { type: "reasoning_end", id: "r1" },
    ]);
    const base = [text("ok")];
    expect(capture.weave(base)).toBe(base);
  });

  it("keeps nothing for a block that never ended", () => {
    const capture = new ReasoningCapture();
    feed(capture, [
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "cut off" },
    ]);
    expect(capture.weave([call("c1")])).toEqual([call("c1")]);
  });

  it("reset() forgets an abandoned attempt", () => {
    const capture = new ReasoningCapture();
    feed(capture, [
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "abandoned" },
      { type: "reasoning_end", id: "r1", providerMetadata: sig("old"), source },
    ]);
    capture.reset();
    feed(capture, [
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "fresh" },
      { type: "reasoning_end", id: "r1", providerMetadata: sig("new"), source },
    ]);
    expect(capture.weave([text("ok")])).toEqual([
      { type: "reasoning", text: "fresh", providerMetadata: sig("new"), source },
      text("ok"),
    ]);
  });
});

/** A port that plays scripted steps; each step is a list of events. */
function scriptedPort(steps: ModelStreamEvent[][]): ModelPort & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      return (async function* () {
        yield* step;
      })();
    },
  };
}

function loopFor(port: ModelPort): AgentLoop {
  return new AgentLoop({
    modelPort: port,
    registry: { get: () => undefined } as unknown as ToolRegistry,
    hooks: { register: () => {}, runPreToolUse: async () => ({}), runUserPromptSubmit: async () => ({}), runObservers: async () => {} } as unknown as HookRunner,
    permissionEngine: { check: () => ({ decision: "allow" }) },
    permissionBroker: { requestPermission: async () => ({ behavior: "deny", reason: "no client" }) },
    mode: "build",
    ports: {} as CorePorts,
    cwd: "/work",
  });
}

const finish: ModelStreamEvent = { type: "finish", finishReason: "stop", usage: {} };

describe("AgentLoop stores replayable reasoning (GitHub #41)", () => {
  it("writes the reasoning part into the assistant item, and drops the abandoned attempt's half", async () => {
    const port = scriptedPort([[
      { type: "reasoning_start", id: "0" },
      { type: "reasoning_delta", id: "0", text: "half a thou" },
      { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 0, error: new Error("reset") } as unknown as ModelStreamEvent,
      { type: "reasoning_start", id: "0" },
      { type: "reasoning_delta", id: "0", text: "a whole thought" },
      { type: "reasoning_end", id: "0", providerMetadata: sig("s"), source },
      { type: "text_delta", id: "1", text: "answer" },
      finish,
    ]]);
    const loop = loopFor(port);
    for await (const _event of loop.runTurn("hi")) { /* drain */ }

    const assistant = loop.history.items.find((item) => item.message.role === "assistant")!;
    expect(assistant.message).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "a whole thought", providerMetadata: sig("s"), source },
        { type: "text", text: "answer" },
      ],
    });
    // The stored reasoning counts toward the item's token estimate.
    const plain = loopFor(scriptedPort([[{ type: "text_delta", id: "1", text: "answer" }, finish]]));
    for await (const _event of plain.runTurn("hi")) { /* drain */ }
    const plainAssistant = plain.history.items.find((item) => item.message.role === "assistant")!;
    expect(assistant.tokenEstimate!).toBeGreaterThan(plainAssistant.tokenEstimate!);
  });
});

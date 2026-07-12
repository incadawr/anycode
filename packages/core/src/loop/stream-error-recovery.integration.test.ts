/**
 * Integration proof of TASK.2 DoD-a/b (design/slice-P7.7-cut.md §3.2): a
 * malformed message-level SSE chunk (known top-level type, unparsable body)
 * makes the REAL AiSdkModelPort (untouched — model-port.ts is codex-WIP,
 * imported only) yield a mid-stream `{type:"error"}` event. The loop-level
 * finish-gate added in W1 (agent-loop.ts §3.1) decides what happens next:
 *
 *  - If valid `message_delta` + `message_stop` follow (finish arrives), the
 *    assistant frame is complete and the turn is FORGIVEN: the error event is
 *    still visible to the consumer, but loop_end is "completed", not "error".
 *  - If the server instead closes the stream with no `message_stop` (finish
 *    never arrives), the frame is untrustworthy and the gate stays
 *    fail-closed: loop_end is "error".
 *
 * Stack: local 127.0.0.1 node:http SSE server (mirrors sse-fixture.integration
 * .test.ts) + the real AiSdkModelPort + a real AgentLoop with a mock registry
 * (no tools are exercised here, only the stream/loop-end path).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools/to-model-tools.js", () => ({
  toToolDeclarations: () => [],
}));

import { AgentLoop, type AgentLoopConfig } from "./agent-loop.js";
import type { AgentEvent } from "../types/events.js";
import type { CorePorts } from "../ports/index.js";
import type { PermissionBroker, PermissionEngine } from "../types/permissions.js";
import type { HookRunner, AggregatedPreToolUseResult } from "../types/hooks.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AiSdkModelPort } from "../provider/model-port.js";
import type { AnthropicEndpointConfig } from "../provider/anthropic.js";

/**
 * Valid `message_start` + a valid text block. Common prefix for both fixtures
 * below, proving text delivered BEFORE the artifact reaches history either way.
 */
const PREFIX: ReadonlyArray<Record<string, unknown>> = [
  {
    type: "message_start",
    message: { id: "msg_1", model: "glm-5.2", role: "assistant", usage: { input_tokens: 12 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "before the artifact " },
  },
  { type: "content_block_stop", index: 0 },
];

/**
 * The artifact: a `message_delta` whose `stop_reason` is a number, not one of
 * the closed string-literal union the SDK expects. This is a known top-level
 * chunk TYPE (message_delta is a real, handled event) with an unparsable BODY
 * — the SDK's chunk schema rejects it mid-parse, so AiSdkModelPort's
 * fail-closed classifier (model-port.ts:315-322, message-level chunks are NOT
 * ignorable — design §1.1) yields `{type:"error"}` instead of dropping it
 * silently. Chosen over a content-block-level artifact (already forgiven by
 * the existing stream-artifacts.ts filter) specifically because it exercises
 * the NEW loop-level gate, not the pre-existing port-level one.
 */
const MALFORMED_MESSAGE_DELTA: Record<string, unknown> = {
  type: "message_delta",
  delta: { stop_reason: 123 },
};

/** Valid closing chunks — finish reaches the loop. */
const VALID_SUFFIX: ReadonlyArray<Record<string, unknown>> = [
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "after the artifact" },
  },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
  { type: "message_stop" },
];

function serializeSse(chunks: ReadonlyArray<Record<string, unknown>>): string {
  return chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
}

async function startFixtureServer(body: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function makeHooks(): HookRunner {
  const result: AggregatedPreToolUseResult = {};
  return {
    register: () => {},
    runPreToolUse: async () => result,
    runUserPromptSubmit: async () => ({}),
    runObservers: async () => {},
  } as unknown as HookRunner;
}

const allowEngine: PermissionEngine = { check: () => ({ decision: "allow" }) };
const denyBroker: PermissionBroker = {
  requestPermission: async () => ({ behavior: "deny", reason: "no client" }),
};

function makeRegistry(): ToolRegistry {
  return { get: () => undefined } as unknown as ToolRegistry;
}

function makeLoop(modelPort: AiSdkModelPort): AgentLoop {
  const config: AgentLoopConfig = {
    modelPort,
    registry: makeRegistry(),
    hooks: makeHooks(),
    permissionEngine: allowEngine,
    permissionBroker: denyBroker,
    mode: "build",
    ports: {} as CorePorts,
    cwd: "/work",
  };
  return new AgentLoop(config);
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

describe("AgentLoop stream-error recovery over a real AiSdkModelPort (P7.7 TASK.2)", () => {
  let server: Server | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
  });

  it("forgives a mid-stream error when finish was received: completed, not error, text before/after preserved", async () => {
    const body = serializeSse([...PREFIX, MALFORMED_MESSAGE_DELTA, ...VALID_SUFFIX]);
    const started = await startFixtureServer(body);
    server = started.server;

    const config: AnthropicEndpointConfig = {
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      model: "glm-5.2",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    const loop = makeLoop(new AiSdkModelPort(config));

    const events = await collect(loop.runTurn("hello"));

    // The malformed chunk DID surface as a visible error event (loop-level
    // forgiveness never means the error is swallowed — DoD-a/c).
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);

    // ...and finish still arrived: the assistant frame is complete.
    const finishEvents = events.filter((e) => e.type === "finish");
    expect(finishEvents).toHaveLength(1);
    expect(finishEvents[0]).toMatchObject({ type: "finish", finishReason: "stop" });

    // The turn completes cleanly — the finish-gate forgave the error.
    const loopEnd = events.at(-1);
    expect(loopEnd).toMatchObject({ type: "loop_end", reason: "completed" });

    // Text delivered before AND after the artifact both reach history.
    const messages = loop.history.toMessages();
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const parts = assistant?.content as unknown as Array<{ type: string; text?: string }>;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain("before the artifact");
    expect(text).toContain("after the artifact");
  });

  it("fail-closed control: the same artifact with no message_stop still ends the turn in error", async () => {
    // No VALID_SUFFIX at all — the server closes right after the artifact,
    // so `message_stop`/a trustworthy `finish` never arrives.
    const body = serializeSse([...PREFIX, MALFORMED_MESSAGE_DELTA]);
    const started = await startFixtureServer(body);
    server = started.server;

    const config: AnthropicEndpointConfig = {
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      model: "glm-5.2",
      retry: { maxRetries: 0, stallTimeoutMs: 0 },
    };
    const loop = makeLoop(new AiSdkModelPort(config));

    const events = await collect(loop.runTurn("hello"));

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);

    // No real finish ever reached the loop — a synthetic SDK finish with
    // finishReason "error" may still surface, but it does not count as a
    // real finish, so the gate stays fail-closed.
    const realFinishEvents = events.filter(
      (e) => e.type === "finish" && e.finishReason !== "error",
    );
    expect(realFinishEvents).toEqual([]);

    const loopEnd = events.at(-1);
    expect(loopEnd).toMatchObject({ type: "loop_end", reason: "error" });
  });
});

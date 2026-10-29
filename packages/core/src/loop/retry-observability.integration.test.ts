/**
 * Loop-level proof of TASK.33 W7b: terminal-retry metadata (attemptsMade/
 * maxAttempts/retryable/hadModelOutput/code) riding the {type:"error"} event
 * AgentLoop emits, driven by a REAL loopback AiSdkModelPort — zero `ai` mocks.
 *
 * The "3 stream_retry, then a terminal error" scenario is a REAL, discriminating
 * test only BECAUSE OF the W7a gate-fix (isModelOutputEvent, provider/failure.ts):
 * before it, the AI SDK's synthetic `{type:"start"}` closed the retry gate
 * before any wire event could ever be observed, so a same-attempt connect/reset
 * failure never actually retried in production — `attempts` below would have
 * stayed 1 and the `stream_retry` count 0 no matter what this test asserted
 * (see transport-contract.integration.test.ts's docstring for the underlying
 * finding). Harness mirrors stream-error-recovery.integration.test.ts (real
 * AgentLoop + real AiSdkModelPort + a local node:http loopback server) and the
 * RST-socket pattern from transport-contract.integration.test.ts.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function findErrorEvent(events: AgentEvent[]): Extract<AgentEvent, { type: "error" }> | undefined {
  return events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
}

describe("AgentLoop terminal retry metadata over a real AiSdkModelPort (TASK.33 W7b)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it("3 stream_retry, then a terminal error carrying retry.attemptsMade === 3 (real gate, W7a-dependent)", async () => {
    let attempts = 0;
    server = createServer((req, res) => {
      attempts += 1;
      req.socket.destroy(); // RST before any response, every time
      void res;
    });
    const baseUrl = `${await listen(server)}/v1`;

    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "claude-x",
      // Taskana 4705: default policy now carries a 5-min network budget which
      // an RST rides; pinned off so this stays a pure count-exhaustion pin.
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, stallTimeoutMs: 0, networkRetryBudgetMs: 0 },
    };
    const loop = makeLoop(new AiSdkModelPort(config));

    const events = await collect(loop.runTurn("hi"));

    // One initial connection plus three retries.
    expect(attempts).toBe(4);
    expect(events.filter((e) => e.type === "stream_retry")).toHaveLength(3);
    const errorEvent = findErrorEvent(events);
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.retry).toMatchObject({
      attemptsMade: 3,
      maxAttempts: 3,
      retryable: true,
      hadModelOutput: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("a same-attempt 401 carries retry.attemptsMade === 0, no maxAttempts, retryable:false, code:auth (negative)", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }));
      });
    });
    const baseUrl = `${await listen(server)}/v1`;

    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "claude-x",
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, stallTimeoutMs: 0 },
    };
    const loop = makeLoop(new AiSdkModelPort(config));

    const events = await collect(loop.runTurn("hi"));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    const errorEvent = findErrorEvent(events);
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.retry).toMatchObject({
      attemptsMade: 0,
      retryable: false,
      hadModelOutput: false,
      code: "auth",
    });
    expect(errorEvent?.retry && "maxAttempts" in errorEvent.retry).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("a same-attempt 400 schema-validation error carries retry.attemptsMade === 0, retryable:false (negative)", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "invalid request: schema validation failed", type: "invalid_request_error" } }),
        );
      });
    });
    const baseUrl = `${await listen(server)}/v1`;

    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "claude-x",
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, stallTimeoutMs: 0 },
    };
    const loop = makeLoop(new AiSdkModelPort(config));

    const events = await collect(loop.runTurn("hi"));

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    const errorEvent = findErrorEvent(events);
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.retry).toMatchObject({ attemptsMade: 0, retryable: false });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("abort during the retry backoff delay ends the turn cancelled, not error", async () => {
    server = createServer((req, res) => {
      req.socket.destroy(); // RST before any response, every time
      void res;
    });
    const baseUrl = `${await listen(server)}/v1`;

    // Deterministic full-jitter ceiling: delay == baseDelayMs == maxDelayMs.
    vi.spyOn(Math, "random").mockReturnValue(1);

    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "claude-x",
      retry: { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 200, stallTimeoutMs: 0 },
    };
    const loop = makeLoop(new AiSdkModelPort(config));
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("hi", { signal: controller.signal })) {
      events.push(event);
      if (event.type === "stream_retry") {
        // Abort mid-backoff — well before the deterministic 200ms delay elapses.
        setTimeout(() => controller.abort(new Error("stopped by caller")), 20);
      }
    }

    expect(events.some((e) => e.type === "stream_retry")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "cancelled" });
  });

  // ── Taskana 4705: bounded mid-stream whole-step replay + quota refusal ──

  /** Serializes SSE chunks the way the stream-error-recovery harness does. */
  function serializeSse(chunks: ReadonlyArray<Record<string, unknown>>): string {
    return chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
  }

  it.each(["reasoning", "text"] as const)("handles a confirmed %s connection drop", async (kind) => {
    let hits = 0;
    let cut: (() => void) | undefined;
    server = createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (hits === 1) {
        cut = () => res.destroy();
        const block = kind === "reasoning" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
        const delta = kind === "reasoning" ? { type: "thinking_delta", thinking: "discarded" } : { type: "text_delta", text: "delivered" };
        res.write(serializeSse([
          { type: "message_start", message: { id: "msg_1", model: "deepseek", role: "assistant", usage: { input_tokens: 12 } } },
          { type: "content_block_start", index: 0, content_block: block },
          { type: "content_block_delta", index: 0, delta },
        ]));
        return;
      }
      res.end(serializeSse([
        { type: "message_start", message: { id: "msg_2", model: "deepseek", role: "assistant", usage: { input_tokens: 12 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ]));
    });
    const baseUrl = `${await listen(server)}/v1`;
    const loop = makeLoop(new AiSdkModelPort({ transport: "anthropic-messages", baseUrl, apiKey: "test-key", model: "deepseek", retry: { maxRetries: 2, midStreamRetries: 0, baseDelayMs: 1, maxDelayMs: 1, stallTimeoutMs: 0 } }));
    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("hi")) {
      events.push(event);
      if ((kind === "reasoning" && event.type === "reasoning_delta") || (kind === "text" && event.type === "text_delta")) {
        if (cut) { const destroy = cut; cut = undefined; destroy(); }
      }
    }
    if (kind === "reasoning") {
      expect(events.filter(e => e.type === "stream_retry")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
      expect(JSON.stringify(loop.history.toMessages())).toContain("recovered");
      expect(JSON.stringify(loop.history.toMessages())).not.toContain("discarded");
      expect(hits).toBe(2);
    } else {
      expect(events.filter(e => e.type === "stream_retry")).toHaveLength(0);
      expect(findErrorEvent(events)?.retry).toMatchObject({ replayStopped: "output_started", hadModelOutput: true });
      expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
      expect(hits).toBe(1);
    }
  });

  it("quota 429 (z.ai code 1308) exhausts immediately: no retries, terminal quota error (Taskana 4705)", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        // Top-level type:"error" is required by the SDK's anthropic error
        // schema — without it the message falls back to bare statusText.
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Insufficient quota for this account (code 1308)" },
          }),
        );
      });
    });
    const baseUrl = `${await listen(server)}/v1`;

    const config: AnthropicEndpointConfig = {
      transport: "anthropic-messages",
      baseUrl,
      apiKey: "test-key",
      model: "glm-5.2",
      retry: { maxRetries: 8, baseDelayMs: 1, maxDelayMs: 1 },
    };
    const loop = makeLoop(new AiSdkModelPort(config));

    const events = await collect(loop.runTurn("hi"));

    expect(events.filter((e) => e.type === "stream_retry")).toHaveLength(0);
    const errorEvent = findErrorEvent(events);
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.retry).toMatchObject({
      code: "quota",
      retryable: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });
});

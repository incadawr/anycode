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
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, stallTimeoutMs: 0 },
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
});

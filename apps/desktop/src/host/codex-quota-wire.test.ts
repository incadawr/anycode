/**
 * TASK.51 (codex-profiles cut §5/§6) — the Session wire for a REAL CodexEngine:
 * proves the whole translator → engine → Session → renderer-port path carries
 *
 *  - `context_usage` (C-bug-1: the event must be ON THE WIRE in a Codex
 *    session; the Composer gate split that consumes it is W3 lane G),
 *  - `engine_session_tokens` with the wire's CUMULATIVE totals (REPLACE),
 *  - `engine_quota` merged snapshots, and
 *  - `host_ready.engine` with `supportsContextUsage: true` + the boot quota
 *    snapshot in `EnginePresentation.quota`.
 *
 * Session is built directly (the harness is hard-wired to a core AgentLoop);
 * the engine is the REAL CodexEngine over a scripted transport, so nothing
 * here can green-by-mock the translation itself.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { SessionPermissionRules } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import { createNativeCodexSession, type CodexClient } from "./engines/codex/codex-engine.js";
import type { JsonRpcNotification } from "./engines/codex/protocol.js";
import { MemFs, nodeWirePort } from "./test-harness.js";

const THREAD = "wire-thread";
const TURN = "wire-turn-1";

/** Minimal scripted app-server: boots one thread, answers one turn/start, replays pushed notifications. */
class ScriptedCodexServer implements CodexClient {
  readonly calls: string[] = [];
  private queue: JsonRpcNotification[] = [];
  private waiter: ((result: IteratorResult<JsonRpcNotification>) => void) | null = null;

  push(notification: JsonRpcNotification): void {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: notification, done: false });
      return;
    }
    this.queue.push(notification);
  }

  request<T>(method: string): Promise<T> {
    this.calls.push(method);
    if (method === "account/read") return Promise.resolve({ account: { type: "chatgpt" } } as T);
    if (method === "model/list") return Promise.resolve({ data: [], nextCursor: null } as T);
    if (method === "thread/start") return Promise.resolve({ thread: { id: THREAD }, model: "gpt-native" } as T);
    if (method === "account/rateLimits/read") {
      // The LIVE W0-R1 single-window shape (secondary present-but-null).
      return Promise.resolve({
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_784_791_993 },
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: "0" },
          planType: "plus",
        },
      } as T);
    }
    if (method === "turn/start") return Promise.resolve({ turn: { id: TURN, status: "inProgress" } } as T);
    return Promise.resolve({} as T);
  }

  notify(): void {}

  notifications(): AsyncIterable<JsonRpcNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = this.queue.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          return new Promise((resolve) => {
            this.waiter = resolve;
          });
        },
      }),
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface Fixture {
  server: ScriptedCodexServer;
  received: HostToUiMessage[];
  send(message: UiToHostMessage): void;
  settle(): Promise<void>;
  close(): void;
}

const open: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const server = new ScriptedCodexServer();
  const connected = await createNativeCodexSession(server, "/work");

  const channel = new MessageChannel();
  const received: HostToUiMessage[] = [];
  channel.port1.on("message", (value: unknown) => received.push(value as HostToUiMessage));
  channel.port1.start();

  const outbound = new Outbound();
  const session = new Session({
    outbound,
    engine: connected.engine,
    engineSettings: connected.engine,
    broker: new IpcPermissionBroker((message) => outbound.emit(message)),
    fs: new MemFs(),
    workspace: "/work",
    model: connected.model,
    sessionId: "codex-session",
    rules: new SessionPermissionRules(),
  });
  session.bindPort(nodeWirePort(channel.port2 as NodeMessagePort));

  const value: Fixture = {
    server,
    received,
    send: (message) => channel.port1.postMessage(message),
    settle: async () => {
      for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
  open.push(value);
  return value;
}

function agentEvents(received: HostToUiMessage[]): Array<{ type: string } & Record<string, unknown>> {
  return received
    .filter((message): message is Extract<HostToUiMessage, { type: "agent_event" }> => message.type === "agent_event")
    .map((message) => message.event as { type: string } & Record<string, unknown>);
}

afterEach(() => {
  for (const value of open.splice(0)) value.close();
});

describe("codex quota/ctx wire (TASK.51)", () => {
  it("host_ready advertises supportsContextUsage and carries the boot quota snapshot in EnginePresentation.quota", async () => {
    const ui = await fixture();
    ui.send({ type: "ui_ready" });
    await ui.settle();

    const ready = ui.received.find((message) => message.type === "host_ready")!;
    expect(ready).toMatchObject({
      engine: {
        id: "codex",
        // C-bug-1: true on the wire is what un-gates the Composer ring.
        capabilities: { supportsContextUsage: true, supportsContextBreakdown: false },
        quota: {
          primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_784_791_993 },
          planType: "plus",
        },
      },
    });
  });

  it("a live turn puts context_usage, cumulative engine_session_tokens, and merged engine_quota on the renderer wire", async () => {
    const ui = await fixture();
    ui.send({ type: "ui_ready" });
    await ui.settle();
    ui.send({ type: "user_message", requestId: "r1", text: "go" });
    await ui.settle();

    ui.server.push({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: THREAD,
        turnId: TURN,
        tokenUsage: {
          last: { totalTokens: 13_495 },
          total: { inputTokens: 12_000, cachedInputTokens: 9_000, outputTokens: 1_495, reasoningOutputTokens: 300, totalTokens: 13_495 },
          modelContextWindow: 353_400,
        },
      },
    });
    // Sparse push carries ONLY primary; planType/credits must survive from boot.
    ui.server.push({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 41, windowDurationMins: 10_080 } } } });
    ui.server.push({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "completed" } } });
    await ui.settle();

    const events = agentEvents(ui.received);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "context_usage", estimatedTokens: 13_495, budgetTokens: 353_400, source: "provider" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "engine_session_tokens", input: 12_000, output: 1_495, total: 13_495, cachedInput: 9_000, reasoningOutput: 300 }),
    );
    const quota = events.find((event) => event.type === "engine_quota");
    expect(quota).toMatchObject({
      quota: {
        primary: { usedPercent: 41 },
        planType: "plus",
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
    });

    // A renderer reload after the turn re-handshakes with the UPDATED snapshot
    // (ui_ready pull, never a bind-time push).
    ui.send({ type: "ui_ready" });
    await ui.settle();
    const readies = ui.received.filter((message) => message.type === "host_ready");
    expect(readies.at(-1)).toMatchObject({ engine: { quota: { primary: { usedPercent: 41 }, planType: "plus" } } });
  });
});

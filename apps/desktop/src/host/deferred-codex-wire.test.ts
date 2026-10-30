import { afterEach, expect, it } from "vitest";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { SessionPermissionRules } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import { createNativeCodexSession, type CodexClient } from "./engines/codex/codex-engine.js";
import type { JsonRpcNotification } from "./engines/codex/protocol.js";
import { MemFs, nodeWirePort } from "./test-harness.js";

class Server implements CodexClient {
  readonly calls: { method: string; params?: unknown }[] = [];
  private queue: JsonRpcNotification[] = [];
  private waiter: ((result: IteratorResult<JsonRpcNotification>) => void) | undefined;
  private start: { resolve(value: unknown): void; reject(reason: Error): void } | undefined;
  holdStart = false;
  turn = 0;
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "account/read") return Promise.resolve({ account: { type: "chatgpt" } } as T);
    if (method === "model/list") return Promise.resolve({ data: [
      { id: "native", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })) },
      { id: "plain", supportedReasoningEfforts: [] },
    ], nextCursor: null } as T);
    if (method === "thread/start") return Promise.resolve({ thread: { id: "thread" }, model: "native" } as T);
    if (method === "turn/start") {
      if (this.holdStart) return new Promise<T>((resolve, reject) => { this.start = { resolve: (value) => resolve(value as T), reject }; });
      return Promise.resolve({ turn: { id: `turn-${++this.turn}`, status: "inProgress" } } as T);
    }
    return Promise.resolve({} as T);
  }
  accept(): void {
    const start = this.start; this.start = undefined;
    if (!start) throw new Error("no held start");
    start.resolve({ turn: { id: `turn-${++this.turn}`, status: "inProgress" } });
  }
  reject(): void {
    const start = this.start; this.start = undefined;
    if (!start) throw new Error("no held start");
    start.reject(new Error("start refused"));
  }
  complete(): void {
    const value = { method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${this.turn}`, status: "completed" } } };
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); }
    else this.queue.push(value);
  }
  notify(): void {}
  notifications(): AsyncIterable<JsonRpcNotification> {
    return { [Symbol.asyncIterator]: () => ({ next: () => {
      const value = this.queue.shift();
      return value ? Promise.resolve({ value, done: false }) : new Promise((resolve) => { this.waiter = resolve; });
    } }) };
  }
  close(): Promise<void> { return Promise.resolve(); }
}

const open: Array<() => void> = [];
afterEach(() => { for (const close of open.splice(0)) close(); });

it("defers Codex effort until the next accepted turn/start and reasserts it", async () => {
  const server = new Server();
  const connected = await createNativeCodexSession(server, "/work");
  const channel = new MessageChannel();
  const received: HostToUiMessage[] = [];
  channel.port1.on("message", (message: HostToUiMessage) => received.push(message));
  channel.port1.start();
  const outbound = new Outbound();
  const session = new Session({ outbound, engine: connected.engine, engineSettings: connected.engine, broker: new IpcPermissionBroker((message) => outbound.emit(message)), fs: new MemFs(), workspace: "/work", model: connected.model, sessionId: "session", rules: new SessionPermissionRules() });
  session.bindPort(nodeWirePort(channel.port2 as NodeMessagePort));
  open.push(() => { channel.port1.close(); channel.port2.close(); });
  const send = (message: UiToHostMessage) => channel.port1.postMessage(message);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const starts = () => server.calls.filter((call) => call.method === "turn/start");
  const applied = () => received.filter((message) => message.type === "engine_settings_changed" && message.state === "applied");
  send({ type: "ui_ready" });
  send({ type: "user_message", requestId: "a", text: "first" });
  await settle();
  expect(starts()).toHaveLength(1);
  expect(starts()[0]?.params).toMatchObject({ effort: "medium" });
  const calls = server.calls.length;
  send({ type: "set_engine_effort", effort: "high" });
  send({ type: "set_engine_effort", effort: "xhigh" });
  send({ type: "set_engine_effort", effort: "unsupported" });
  await settle();
  expect(server.calls).toHaveLength(calls);
  expect(received).toContainEqual(expect.objectContaining({ type: "mode_change_rejected" }));
  expect(received).toContainEqual(expect.objectContaining({ type: "engine_settings_changed", state: "pending", effort: "xhigh" }));
  server.complete();
  await settle();
  server.holdStart = true;
  send({ type: "user_message", requestId: "b", text: "second" });
  await settle();
  expect(starts()).toHaveLength(2);
  expect(starts()[1]?.params).toMatchObject({ effort: "xhigh" });
  expect(applied()).toHaveLength(0);
  send({ type: "set_engine_effort", effort: "medium" });
  await settle();
  expect(received.at(-1)).toMatchObject({ type: "engine_settings_changed", state: "pending", effort: "medium", deferredEffort: true });
  server.accept();
  await settle();
  expect(applied().at(-1)).toMatchObject({ effort: "xhigh" });
  expect(received.at(-1)).toMatchObject({ type: "engine_settings_changed", state: "pending", effort: "medium" });
  server.complete();
  await settle();
  server.holdStart = false;
  send({ type: "user_message", requestId: "c", text: "third" });
  await settle();
  expect(starts()[2]?.params).toMatchObject({ effort: "medium" });
  server.complete();
  await settle();
  send({ type: "user_message", requestId: "d", text: "fourth" });
  await settle();
  expect(starts()[3]?.params).toMatchObject({ effort: "medium" });
  server.complete();
  await settle();
  send({ type: "set_model", model: "plain" });
  send({ type: "user_message", requestId: "e", text: "fifth" });
  await settle();
  const count = server.calls.length;
  send({ type: "set_engine_effort", effort: "high" });
  await settle();
  expect(server.calls).toHaveLength(count);
  expect(received).toContainEqual(expect.objectContaining({ type: "mode_change_rejected", reason: expect.stringContaining("plain") }));
  server.complete();
  await settle();
  send({ type: "set_model", model: "native" });
  send({ type: "user_message", requestId: "f", text: "sixth" });
  await settle();
  send({ type: "set_engine_effort", effort: "high" });
  await settle();
  server.complete();
  await settle();
  const appliedCount = applied().length;
  server.holdStart = true;
  send({ type: "user_message", requestId: "g", text: "seventh" });
  await settle();
  expect(starts().at(-1)?.params).toMatchObject({ effort: "high" });
  server.reject();
  await settle();
  expect(applied()).toHaveLength(appliedCount);
});

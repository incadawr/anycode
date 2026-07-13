import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage } from "../../../shared/protocol.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import { CodexApprovalBridge } from "./approval-bridge.js";
import type { JsonRpcNotification } from "./protocol.js";
import {
  CODEX_NOT_SIGNED_IN,
  CodexEngine,
  createNativeCodexSession,
  resumeNativeCodexSession,
  type CodexClient,
} from "./codex-engine.js";

class Notifications implements AsyncIterable<JsonRpcNotification> {
  private values: JsonRpcNotification[] = [];
  private waiter: ((value: IteratorResult<JsonRpcNotification>) => void) | undefined;
  private closed = false;

  push(value: JsonRpcNotification): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonRpcNotification> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
    };
  }
}

function fakeClient(notifications: Notifications): CodexClient & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "turn/start") return { turn: { id: "native-turn" } } as T;
    return {} as T;
  };
  return {
    calls,
    request,
    notify: vi.fn(),
    notifications: () => notifications,
    close: vi.fn(async () => notifications.close()),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForActiveTurn(engine: CodexEngine): Promise<void> {
  for (let i = 0; i < 32; i += 1) {
    if (engine.activeTurnDetails !== null) return;
    await Promise.resolve();
  }
  throw new Error("engine did not establish the native active turn");
}

describe("CodexEngine", () => {
  it("creates only after initialize/account and resumes only the persisted native ref", async () => {
    const notifications = new Notifications();
    const client = fakeClient(notifications);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      client.calls.push({ method, params });
      if (method === "account/read") return { account: { type: "chatgpt" } } as T;
      if (method === "thread/start") return { thread: { id: "fresh-thread" }, model: "gpt-native" } as T;
      if (method === "thread/resume") return { thread: { id: "persisted-thread" }, model: "gpt-resumed" } as T;
      return {} as T;
    };
    const created = await createNativeCodexSession(client, "/work");
    expect(created).toMatchObject({ threadId: "fresh-thread", model: "gpt-native" });
    expect(client.calls.map((call) => call.method)).toEqual(["initialize", "account/read", "thread/start"]);

    client.calls.length = 0;
    const resumed = await resumeNativeCodexSession(client, "/work", "persisted-thread");
    expect(resumed).toMatchObject({ threadId: "persisted-thread", model: "gpt-resumed" });
    expect(client.calls.map((call) => call.method)).toEqual(["initialize", "account/read", "thread/resume", "thread/read"]);
    expect(client.calls.find((call) => call.method === "thread/resume")?.params).toEqual({ threadId: "persisted-thread", cwd: "/work" });
    expect(client.calls).not.toContainEqual(expect.objectContaining({ method: "thread/start" }));
  });

  it("refuses a signed-out account before native thread creation", async () => {
    const client = fakeClient(new Notifications());
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      client.calls.push({ method, params });
      return (method === "account/read" ? { account: null } : {}) as T;
    };
    await expect(createNativeCodexSession(client, "/work")).rejects.toThrow(CODEX_NOT_SIGNED_IN);
    expect(client.calls.map((call) => call.method)).toEqual(["initialize", "account/read"]);
  });

  it("projects one native text turn and leaves no core loop dependency", async () => {
    const notifications = new Notifications();
    const client = fakeClient(notifications);
    const engine = new CodexEngine(client, "native-thread");
    notifications.push({ method: "item/agentMessage/delta", params: { threadId: "native-thread", turnId: "native-turn", itemId: "m", delta: "hello" } });
    notifications.push({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "native-turn", status: "completed" } } });

    const events = [];
    for await (const event of engine.runTurn("hi", { signal: new AbortController().signal })) events.push(event);

    expect(events.map((event) => event.type)).toEqual(["turn_start", "text_start", "text_delta", "text_end", "turn_end", "loop_end"]);
    expect(events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
    expect(client.calls[0]).toEqual({ method: "turn/start", params: { threadId: "native-thread", input: [{ type: "text", text: "hi" }] } });
    expect(engine.historyItems()).toEqual([]);
  });

  it("interrupts an aborted native turn and remains terminal after an app-server failure", async () => {
    const notifications = new Notifications();
    const client = fakeClient(notifications);
    const engine = new CodexEngine(client, "native-thread");
    const controller = new AbortController();
    notifications.push({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "native-turn" } } });
    notifications.push({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "native-turn", status: "interrupted" } } });
    controller.abort();

    const events = [];
    for await (const event of engine.runTurn("cancel", { signal: controller.signal })) events.push(event);
    expect(client.calls.some((call) => call.method === "turn/interrupt")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });

    const broken = new CodexEngine({ ...client, notifications: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    }) }, "native-thread");
    const failure = [];
    for await (const event of broken.runTurn("broken", { signal: new AbortController().signal })) failure.push(event);
    expect(failure.map((event) => event.type).slice(-3)).toEqual(["error", "turn_end", "loop_end"]);
    const later = [];
    for await (const event of broken.runTurn("later", { signal: new AbortController().signal })) later.push(event);
    expect(later.map((event) => event.type)).toEqual(["error", "turn_end", "loop_end"]);
  });

  it("bounds a denied approval when Codex never completes, but cancels that deadline on normal completion", async () => {
    vi.useFakeTimers();
    try {
      const make = () => {
        const notifications = new Notifications();
        const client = fakeClient(notifications);
        const emitted: HostToUiMessage[] = [];
        const broker = new IpcPermissionBroker((message) => emitted.push(message));
        let engine: CodexEngine | null = null;
        const bridge = new CodexApprovalBridge({
          broker,
          activeTurn: () => engine?.activeTurnDetails ?? null,
          onTerminalDenial: (reason) => engine?.beginTerminalDenial(reason),
        });
        engine = new CodexEngine(client, "native-thread", bridge, 25);
        return { notifications, client, emitted, broker, bridge, engine };
      };
      const denied = make();
      const deniedEvents: unknown[] = [];
      const deniedDone = (async () => {
        for await (const event of denied.engine.runTurn("deny", { signal: new AbortController().signal })) deniedEvents.push(event);
      })();
      await waitForActiveTurn(denied.engine);
      const serverRequest = {
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "native-thread", turnId: "native-turn", itemId: "item", command: "pwd", cwd: "/work" },
      };
      denied.bridge?.handle(serverRequest, { result: vi.fn(), error: vi.fn() });
      await flush();
      const ask = denied.emitted.find((message) => message.type === "permission_request");
      if (!ask || ask.type !== "permission_request") throw new Error("missing approval ask");
      denied.broker.handleResponse(ask.requestId, "deny");
      await flush();
      await vi.advanceTimersByTimeAsync(25);
      await deniedDone;
      expect(denied.client.close).toHaveBeenCalledTimes(1);
      expect(deniedEvents.map((event) => (event as { type: string }).type).slice(-3)).toEqual(["error", "turn_end", "loop_end"]);

      const completed = make();
      const completedEvents: unknown[] = [];
      const completedDone = (async () => {
        for await (const event of completed.engine.runTurn("deny but complete", { signal: new AbortController().signal })) completedEvents.push(event);
      })();
      await waitForActiveTurn(completed.engine);
      completed.bridge?.handle(serverRequest, { result: vi.fn(), error: vi.fn() });
      await flush();
      const completedAsk = completed.emitted.find((message) => message.type === "permission_request");
      if (!completedAsk || completedAsk.type !== "permission_request") throw new Error("missing approval ask");
      completed.broker.handleResponse(completedAsk.requestId, "deny");
      await flush();
      completed.notifications.push({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "native-turn", status: "interrupted" } } });
      await completedDone;
      await vi.advanceTimersByTimeAsync(25);
      expect(completed.client.close).not.toHaveBeenCalled();
      expect(completedEvents.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

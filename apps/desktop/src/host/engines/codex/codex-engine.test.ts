import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@anycode/core";
import type { HostToUiMessage } from "../../../shared/protocol.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import { CodexApprovalBridge } from "./approval-bridge.js";
import type { JsonRpcNotification, JsonRpcServerRequest } from "./protocol.js";
import {
  CODEX_NOT_SIGNED_IN,
  CodexEngine,
  createNativeCodexSession,
  resumeNativeCodexSession,
  type CodexClient,
} from "./codex-engine.js";

const THREAD = "native-thread";

class Notifications implements AsyncIterable<JsonRpcNotification> {
  private values: JsonRpcNotification[] = [];
  private waiter: ((value: IteratorResult<JsonRpcNotification>) => void) | undefined;
  private closed = false;
  /** True while a consumer is parked inside next() — the state the killer test needs. */
  parked = false;

  constructor(private readonly observers: Set<(notification: JsonRpcNotification) => void>) {}

  push(value: JsonRpcNotification): void {
    if (this.closed) return;
    // Wire order: the transport tap sees a line before the pull-based consumer.
    for (const observe of this.observers) observe(value);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      this.parked = false;
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
      this.parked = false;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonRpcNotification> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        this.parked = true;
        return new Promise((resolve) => { this.waiter = resolve; });
      },
    };
  }
}

type TurnStartMode = "immediate" | "deferred" | "never";

/**
 * Fake app-server modelled on the LIVE traces in contract/fixtures (cut §7
 * hazard #2 — a fake that answers everything would hide the very bug B1 fixes):
 *
 *  - `turn/start` answers with `{turn:{id, status:"inProgress"}}` immediately,
 *    i.e. BEFORE any turn notification (w1-p1 line 7).
 *  - the FIRST `turn/interrupt` answers and the turn then reaches
 *    `turn/completed{status:"interrupted"}` (w1-p2/w1-p7).
 *  - a REPEATED `turn/interrupt` NEVER answers while the turn settles (L9) —
 *    the black hole. Any code that can send two interrupts hangs here.
 *  - `timeoutMs` is honoured exactly as AppServerClient honours it.
 */
class FakeAppServer implements CodexClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly observers = new Set<(notification: JsonRpcNotification) => void>();
  readonly stream = new Notifications(this.observers);
  closeCount = 0;
  interrupts = 0;
  turnStartMode: TurnStartMode = "immediate";
  /** "complete": the interrupted turn settles; "silent": the server never settles it. */
  interruptSettles: "complete" | "silent" = "complete";
  account: unknown = { type: "chatgpt" };
  private pendingTurnStart: { resolve: (value: unknown) => void } | null = null;
  private turnCount = 0;
  private currentTurnId = "";

  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    this.calls.push({ method, params });
    return this.bound(method, this.answer<T>(method), opts) as Promise<T>;
  }

  notify = vi.fn();

  notifications(): AsyncIterable<JsonRpcNotification> {
    return this.stream;
  }

  observeNotifications(observe: (notification: JsonRpcNotification) => void): () => void {
    this.observers.add(observe);
    return () => this.observers.delete(observe);
  }

  close(): Promise<void> {
    this.closeCount += 1;
    this.stream.close();
    return Promise.resolve();
  }

  /** Answers a `turn/start` that was configured as "deferred". */
  releaseTurnStart(): void {
    const pending = this.pendingTurnStart;
    if (pending === null) throw new Error("no deferred turn/start is pending");
    this.pendingTurnStart = null;
    this.currentTurnId = this.nextTurnId();
    pending.resolve({ turn: { id: this.currentTurnId, status: "inProgress" } });
  }

  get turnId(): string {
    return this.currentTurnId;
  }

  completeTurn(status: "completed" | "interrupted", turnId = this.currentTurnId): void {
    this.stream.push({ method: "turn/completed", params: { threadId: THREAD, turn: { id: turnId, status } } });
  }

  private answer<T>(method: string): Promise<T> {
    if (method === "account/read") return Promise.resolve({ account: this.account } as T);
    if (method === "thread/start") return Promise.resolve({ thread: { id: "fresh-thread" }, model: "gpt-native" } as T);
    if (method === "thread/resume") return Promise.resolve({ thread: { id: "persisted-thread" }, model: "gpt-resumed" } as T);
    if (method === "turn/start") {
      if (this.turnStartMode === "never") return new Promise<T>(() => {});
      if (this.turnStartMode === "deferred") {
        return new Promise<T>((resolve) => {
          this.pendingTurnStart = { resolve: resolve as (value: unknown) => void };
        });
      }
      this.currentTurnId = this.nextTurnId();
      return Promise.resolve({ turn: { id: this.currentTurnId, status: "inProgress" } } as T);
    }
    if (method === "turn/interrupt") {
      this.interrupts += 1;
      if (this.interrupts > 1) return new Promise<T>(() => {}); // black hole (L9)
      if (this.interruptSettles === "complete") {
        const turnId = this.currentTurnId;
        setTimeout(() => this.completeTurn("interrupted", turnId), 0);
      }
      return Promise.resolve({} as T);
    }
    return Promise.resolve({} as T);
  }

  private bound<T>(method: string, value: Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
    if (opts?.timeoutMs === undefined) return value;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`app-server request timed out: ${method}`)), opts.timeoutMs);
      value.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error: Error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private nextTurnId(): string {
    this.turnCount += 1;
    return `native-turn-${this.turnCount}`;
  }
}

async function tick(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Drives an engine turn in the background, exactly as Session's dispatcher does. */
function drive(engine: CodexEngine, input: string, signal: AbortSignal): { events: AgentEvent[]; done: Promise<void> } {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of engine.runTurn(input, { signal })) events.push(event);
  })();
  return { events, done };
}

/** Waits until the notification iterator is REALLY parked (cut §7 hazard #4). */
async function waitForParkedIterator(server: FakeAppServer, engine: CodexEngine): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (engine.activeTurnDetails !== null && server.stream.parked) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the turn never parked on the notification iterator");
}

function types(events: AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("CodexEngine — native session boot", () => {
  it("creates only after initialize/account and resumes only the persisted native ref", async () => {
    const server = new FakeAppServer();
    const created = await createNativeCodexSession(server, "/work");
    expect(created).toMatchObject({ threadId: "fresh-thread", model: "gpt-native" });
    expect(server.calls.map((call) => call.method)).toEqual(["initialize", "account/read", "thread/start"]);

    server.calls.length = 0;
    const resumed = await resumeNativeCodexSession(server, "/work", "persisted-thread");
    expect(resumed).toMatchObject({ threadId: "persisted-thread", model: "gpt-resumed" });
    expect(server.calls.map((call) => call.method)).toEqual(["initialize", "account/read", "thread/resume", "thread/read"]);
    expect(server.calls.find((call) => call.method === "thread/resume")?.params).toEqual({ threadId: "persisted-thread", cwd: "/work" });
  });

  it("refuses a signed-out account before native thread creation", async () => {
    const server = new FakeAppServer();
    server.account = null;
    await expect(createNativeCodexSession(server, "/work")).rejects.toThrow(CODEX_NOT_SIGNED_IN);
    expect(server.calls.map((call) => call.method)).toEqual(["initialize", "account/read"]);
  });

  it("bounds every boot RPC and surfaces a comprehensible timeout", async () => {
    const server = new FakeAppServer();
    const never = new Promise<never>(() => {});
    server.request = ((method: string, params: unknown, opts?: { timeoutMs?: number }) => {
      server.calls.push({ method, params });
      if (method === "initialize") {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error(`app-server request timed out: ${method}`)), opts?.timeoutMs ?? 5);
        });
      }
      return never;
    }) as CodexClient["request"];

    await expect(createNativeCodexSession(server, "/work", undefined, { bootRpcMs: 5 }))
      .rejects.toThrow(/timed out: initialize/);
  });
});

describe("CodexEngine — turn projection", () => {
  it("projects one native text turn and leaves no core loop dependency", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const turn = drive(engine, "hi", new AbortController().signal);
    await tick();
    server.stream.push({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: server.turnId, itemId: "m", delta: "hello" } });
    server.completeTurn("completed");
    await turn.done;

    expect(types(turn.events)).toEqual(["turn_start", "text_start", "text_delta", "text_end", "turn_end", "loop_end"]);
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
    expect(server.calls[0]).toEqual({ method: "turn/start", params: { threadId: THREAD, input: [{ type: "text", text: "hi" }] } });
    expect(engine.historyItems()).toEqual([]);
  });

  it("ignores between-turn chatter instead of counting it toward the pre-turn limit", async () => {
    const server = new FakeAppServer();
    server.turnStartMode = "deferred";
    const engine = new CodexEngine(server, THREAD);
    const turn = drive(engine, "hi", new AbortController().signal);
    await tick();

    // 400 benign notifications (> PRE_TURN_NOTIFICATION_LIMIT) that belong to no
    // thread or to a foreign one: the previous shape would have thrown.
    for (let i = 0; i < 400; i += 1) {
      server.stream.push({ method: "mcpServer/startupStatus/updated", params: { server: "x" } });
      server.stream.push({ method: "thread/status/changed", params: { threadId: "someone-else", status: { type: "idle" } } });
      await tick(1);
    }
    server.releaseTurnStart();
    await tick();
    server.completeTurn("completed");
    await turn.done;

    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
    expect(turn.events.some((event) => event.type === "error")).toBe(false);
  });
});

describe("CodexEngine — Stop (TASK.38 blocker)", () => {
  it("interrupts EXACTLY ONCE when the abort lands on a parked iterator, with no notification before it", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const controller = new AbortController();
    const turn = drive(engine, "long task", controller.signal);

    // The turn is running and the iterator is genuinely parked; NOTHING has been
    // pushed since turn/start. The old shape only re-checked signal.aborted after
    // the next notification, so it could never fire an interrupt from here.
    await waitForParkedIterator(server, engine);
    expect(server.calls.filter((call) => call.method === "turn/interrupt")).toHaveLength(0);

    controller.abort();
    await turn.done;

    const interrupts = server.calls.filter((call) => call.method === "turn/interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]?.params).toEqual({ threadId: THREAD, turnId: "native-turn-1" });
    expect(server.interrupts).toBe(1);
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    expect(types(turn.events).slice(-2)).toEqual(["turn_end", "loop_end"]);
    expect(turn.events.some((event) => event.type === "error")).toBe(false);
  });

  it("latches the interrupt so a Stop followed by dispose still sends exactly one", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const controller = new AbortController();
    const turn = drive(engine, "long task", controller.signal);
    await waitForParkedIterator(server, engine);

    controller.abort();
    await tick();
    // A second interrupt would hit the live black hole; the latch forbids it.
    await engine.dispose("session-close");
    await turn.done;

    expect(server.interrupts).toBe(1);
    expect(turn.events.at(-1)).toMatchObject({ type: "loop_end", reason: "cancelled" });
  });

  it("bounds a Stop that lands BEFORE the turn/start response and interrupts as soon as the id arrives", async () => {
    const server = new FakeAppServer();
    server.turnStartMode = "deferred";
    const engine = new CodexEngine(server, THREAD);
    const controller = new AbortController();
    const turn = drive(engine, "cancel me", controller.signal);
    await tick();

    controller.abort();
    await tick();
    // No native turn id exists yet, so nothing can be interrupted.
    expect(server.interrupts).toBe(0);
    expect(engine.activeTurnDetails).toBeNull();

    server.releaseTurnStart();
    await turn.done;

    expect(server.interrupts).toBe(1);
    expect(server.calls.find((call) => call.method === "turn/interrupt")?.params)
      .toEqual({ threadId: THREAD, turnId: "native-turn-1" });
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    // Session is released: the async iterable completed rather than staying busy.
    expect(engine.activeTurnDetails).toBeNull();
  });

  it("an abort before an already-aborted signal's turn still completes without hanging", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const controller = new AbortController();
    controller.abort();
    const turn = drive(engine, "pre-aborted", controller.signal);
    await turn.done;
    expect(server.interrupts).toBe(1);
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
  });

  it("fails the turn and releases the child when the server never settles an interrupted turn", async () => {
    const server = new FakeAppServer();
    server.interruptSettles = "silent";
    const engine = new CodexEngine(server, THREAD, undefined, { postInterruptSettleMs: 30 });
    const controller = new AbortController();
    const turn = drive(engine, "wedged", controller.signal);
    await waitForParkedIterator(server, engine);

    controller.abort();
    await turn.done;

    expect(server.interrupts).toBe(1);
    expect(types(turn.events).slice(-3)).toEqual(["error", "turn_end", "loop_end"]);
    expect((turn.events.find((event) => event.type === "error") as { error: Error }).error.message)
      .toMatch(/did not settle the interrupted turn within 30ms/);
    expect(server.closeCount).toBe(1);
  });

  it("bounds a turn/start that never answers and releases the child", async () => {
    const server = new FakeAppServer();
    server.turnStartMode = "never";
    const engine = new CodexEngine(server, THREAD, undefined, { turnStartMs: 25 });
    const turn = drive(engine, "wedged start", new AbortController().signal);
    await turn.done;

    expect((turn.events.find((event) => event.type === "error") as { error: Error }).error.message)
      .toMatch(/timed out: turn\/start/);
    expect(types(turn.events).slice(-2)).toEqual(["turn_end", "loop_end"]);
    expect(turn.events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
    expect(server.closeCount).toBe(1);
  });

  it("stays terminal after the app-server dies mid-turn", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const turn = drive(engine, "broken", new AbortController().signal);
    await tick();
    server.stream.close();
    await turn.done;
    expect(types(turn.events).slice(-3)).toEqual(["error", "turn_end", "loop_end"]);

    const later = drive(engine, "later", new AbortController().signal);
    await later.done;
    expect(types(later.events)).toEqual(["error", "turn_end", "loop_end"]);
  });
});

describe("CodexEngine — approvals on one live client process", () => {
  function rig(server: FakeAppServer) {
    const emitted: HostToUiMessage[] = [];
    const broker = new IpcPermissionBroker((message) => emitted.push(message));
    let engine: CodexEngine | null = null;
    const bridge = new CodexApprovalBridge({ broker, activeTurn: () => engine?.activeTurnDetails ?? null });
    engine = new CodexEngine(server, THREAD, bridge);
    return { emitted, broker, bridge, engine };
  }

  function approval(server: FakeAppServer, itemId: string): JsonRpcServerRequest {
    return {
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: THREAD,
        turnId: server.turnId,
        itemId,
        startedAtMs: 1,
        environmentId: "local",
        command: "/bin/zsh -lc \"echo hi\"",
        cwd: "/work",
        availableDecisions: ["accept", "acceptForSession", "cancel"],
      },
    };
  }

  async function settle(rigged: ReturnType<typeof rig>, behavior: "allow" | "deny"): Promise<void> {
    for (let i = 0; i < 50 && !rigged.emitted.some((message) => message.type === "permission_request"); i += 1) {
      await tick(1);
    }
    const ask = rigged.emitted.filter((message) => message.type === "permission_request").at(-1);
    if (!ask || ask.type !== "permission_request") throw new Error("no permission_request reached the UI");
    rigged.broker.handleResponse(ask.requestId, behavior);
    await tick();
  }

  it("Allow, then Deny, then a SECOND successful turn on the same client process", async () => {
    const server = new FakeAppServer();
    const rigged = rig(server);
    const responses: unknown[] = [];
    const responder = () => ({ result: (value: unknown) => responses.push(value), error: (value: unknown) => responses.push({ error: value }) });

    const first = drive(rigged.engine, "run it", new AbortController().signal);
    await waitForParkedIterator(server, rigged.engine);
    void rigged.bridge.handle(approval(server, "item-allow"), responder());
    await settle(rigged, "allow");
    void rigged.bridge.handle(approval(server, "item-deny"), responder());
    await settle(rigged, "deny");
    // L1: after a decline the agent keeps talking and the turn ends `completed`.
    server.completeTurn("completed");
    await first.done;

    expect(responses).toEqual([{ decision: "accept" }, { decision: "decline" }]);
    expect(server.closeCount).toBe(0);
    expect(first.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });

    const second = drive(rigged.engine, "again", new AbortController().signal);
    await tick();
    server.completeTurn("completed");
    await second.done;
    expect(second.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 2 });
    expect(server.closeCount).toBe(0);
  });

  it("answers Stop-during-approval with cancel and settles the turn as cancelled", async () => {
    const server = new FakeAppServer();
    const rigged = rig(server);
    const responses: unknown[] = [];
    const controller = new AbortController();
    const turn = drive(rigged.engine, "run it", controller.signal);
    await waitForParkedIterator(server, rigged.engine);

    void rigged.bridge.handle(approval(server, "item-stop"), {
      result: (value: unknown) => responses.push(value),
      error: (value: unknown) => responses.push({ error: value }),
    });
    for (let i = 0; i < 50 && !rigged.emitted.some((message) => message.type === "permission_request"); i += 1) await tick(1);

    controller.abort();
    await turn.done;

    expect(responses).toEqual([{ decision: "cancel" }]);
    expect(server.interrupts).toBe(1);
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    // A denied/cancelled approval must never kill the engine.
    expect(server.closeCount).toBe(0);
  });

  it("keeps the transport alive when a malformed approval is rejected, and the turn still completes", async () => {
    const server = new FakeAppServer();
    const rigged = rig(server);
    const errors: unknown[] = [];
    const turn = drive(rigged.engine, "run it", new AbortController().signal);
    await waitForParkedIterator(server, rigged.engine);

    void rigged.bridge.handle(
      { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: server.turnId } },
      { result: () => { throw new Error("a malformed approval must never be granted"); }, error: (value: unknown) => errors.push(value) },
    );
    await tick();

    expect(errors).toEqual([expect.objectContaining({ code: -32002 })]);
    expect(server.closeCount).toBe(0);
    expect(rigged.emitted.some((message) => message.type === "permission_request")).toBe(false);

    server.completeTurn("completed");
    await turn.done;
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
  });

  it("describes a file change from the item index even though the approval carries no diff", async () => {
    const server = new FakeAppServer();
    const rigged = rig(server);
    const turn = drive(rigged.engine, "patch it", new AbortController().signal);
    await waitForParkedIterator(server, rigged.engine);

    // Live order (w1-p3): the fileChange item/started precedes the approval, and
    // the approval itself carries neither path nor diff.
    server.stream.push({
      method: "item/started",
      params: {
        threadId: THREAD,
        turnId: server.turnId,
        item: {
          type: "fileChange",
          id: "exec-file",
          status: "inProgress",
          changes: [{ path: "/work/w1.txt", kind: { type: "add" }, diff: "W1_FILE_OK\n" }],
        },
      },
    });
    void rigged.bridge.handle(
      {
        id: 0,
        method: "item/fileChange/requestApproval",
        params: { threadId: THREAD, turnId: server.turnId, itemId: "exec-file", startedAtMs: 1, reason: null, grantRoot: null },
      },
      { result: vi.fn(), error: vi.fn() },
    );
    await tick();

    const ask = rigged.emitted.find((message) => message.type === "permission_request");
    expect(ask).toMatchObject({
      toolName: "CodexApplyPatch",
      input: {
        reason: null,
        grantRoot: null,
        paths: ["/work/w1.txt"],
        changes: [{ path: "/work/w1.txt", kind: "add", diff: "W1_FILE_OK\n" }],
      },
    });

    server.completeTurn("completed");
    await turn.done;
  });
});

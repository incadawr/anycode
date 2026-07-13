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
  /**
   * Catalog pages, keyed by cursor ("" = first page). Modelled on the LIVE
   * `model/list` result (fixture w1-p4): `{data:[Model…], nextCursor}`, where each
   * Model carries a dozen keys this host has never heard of.
   */
  modelPages: Record<string, { data: unknown[]; nextCursor: string | null }> = {
    "": {
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Latest frontier agentic coding model.",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "…" },
            { reasoningEffort: "medium", description: "…" },
            { reasoningEffort: "high", description: "…" },
          ],
          // Undeclared keys the live wire really carries (L9) — a strict decoder would reject here.
          availabilityNux: { message: "…" },
          serviceTiers: [{ id: "priority", name: "Fast", description: "…" }],
          upgradeInfo: null,
        },
        {
          id: "gpt-5.4-mini",
          model: "gpt-5.4-mini",
          displayName: "GPT-5.4-Mini",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "…" }],
        },
      ],
      nextCursor: null,
    },
  };
  /** `model/list` failure mode: the boot must survive it (empty catalog, no model override). */
  modelListFails = false;
  /** The effective-settings echo appended to thread/start and thread/resume responses. */
  threadEcho: Record<string, unknown> = {
    approvalPolicy: "on-request",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    reasoningEffort: "high",
  };
  threadStartParams: unknown = undefined;
  private pendingTurnStart: { resolve: (value: unknown) => void } | null = null;
  private turnCount = 0;
  private currentTurnId = "";

  /** Params of every turn/start, in order — the posture-reassertion assertions read this. */
  turnStartParams(): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === "turn/start").map((call) => call.params as Record<string, unknown>);
  }

  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    this.calls.push({ method, params });
    return this.bound(method, this.answer<T>(method, params), opts) as Promise<T>;
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

  private answer<T>(method: string, params?: unknown): Promise<T> {
    if (method === "account/read") return Promise.resolve({ account: this.account } as T);
    if (method === "model/list") return this.answerModelList<T>(params);
    if (method === "thread/start") {
      // THE GREEN-BY-MOCK GUARD (live fact L7, fixture w1-p6): the real
      // app-server does NOT reject an unknown model here — it accepts it, starts
      // the thread, and fails late. This fake must be exactly as permissive, or
      // it would silently do the host's validation job for it and every
      // "invalid model" test below would pass for the wrong reason.
      const model = (params as { model?: string } | undefined)?.model;
      this.threadStartParams = params;
      return Promise.resolve({
        thread: { id: "fresh-thread" },
        model: model ?? "gpt-native",
        ...this.threadEcho,
      } as T);
    }
    if (method === "thread/resume") {
      return Promise.resolve({ thread: { id: "persisted-thread" }, model: "gpt-resumed", ...this.threadEcho } as T);
    }
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

  private answerModelList<T>(params?: unknown): Promise<T> {
    if (this.modelListFails) return Promise.reject(new Error("app-server request timed out: model/list"));
    const cursor = (params as { cursor?: string } | undefined)?.cursor ?? "";
    const page = this.modelPages[cursor];
    if (page === undefined) return Promise.resolve({ data: [], nextCursor: null } as T);
    return Promise.resolve(page as T);
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
    // TASK.39: the catalog is read BEFORE thread/start, so the first model id the
    // host could ever put on the wire is already validatable by then (L7).
    expect(server.calls.map((call) => call.method)).toEqual(["initialize", "account/read", "model/list", "thread/start"]);

    server.calls.length = 0;
    const resumed = await resumeNativeCodexSession(server, "/work", "persisted-thread");
    expect(resumed).toMatchObject({ threadId: "persisted-thread", model: "gpt-resumed" });
    expect(server.calls.map((call) => call.method)).toEqual([
      "initialize",
      "account/read",
      "model/list",
      "thread/resume",
      "thread/read",
    ]);
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

// ─────────────────────────────────────────────────────────────────────────────
// TASK.39 — native model + permission controls.
//
// Read the FakeAppServer's thread/start and turn/start answers first: they
// ACCEPT any model id, exactly as the real 0.144.3 app-server does (L7, fixture
// w1-p6). Nothing in this fake will ever save the host from an invalid model —
// if a test below sees no bogus id on the wire, it is because host-side
// validation kept it off, which is the entire point of catalog.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs one full turn to `loop_end`. The terminal notification is addressed to the
 * ENGINE's own thread (a booted engine owns `fresh-thread`/`persisted-thread`,
 * not the bare-construction THREAD) — a foreign-thread notification is correctly
 * ignored by the engine and would simply hang the turn.
 */
async function runTurn(server: FakeAppServer, engine: CodexEngine, input = "hi"): Promise<AgentEvent[]> {
  const turn = drive(engine, input, new AbortController().signal);
  await tick();
  server.stream.push({
    method: "turn/completed",
    params: { threadId: engine.threadId, turn: { id: server.turnId, status: "completed" } },
  });
  await turn.done;
  return turn.events;
}

function notices(events: AgentEvent[]): string[] {
  return events.filter((event) => event.type === "engine_notice").map((event) => (event as { message: string }).message);
}

describe("TASK.39 — model catalog + initial values", () => {
  it("carries a validated draft model and the draft preset's policy into thread/start", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.4-mini",
      presetId: "read-only",
      origin: "draft",
    });

    expect(server.threadStartParams).toEqual({
      cwd: "/work",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      model: "gpt-5.4-mini",
    });
    // DoD-2: the value shown/persisted is the one the SERVER confirmed, not the ask.
    expect(connected.model).toBe("gpt-5.4-mini");
    expect(connected.presetId).toBe("read-only");
    expect(connected.engine.snapshot()).toEqual({ model: "gpt-5.4-mini", activePresetId: "read-only" });
  });

  it("defaults to the `ask` preset and the server's own model when no draft was made", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work");

    expect(server.threadStartParams).toEqual({ cwd: "/work", approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(connected.presetId).toBe("ask");
    expect(connected.model).toBe("gpt-native");
  });

  it("refuses to send a removed draft model, keeps the session, and says so once (recoverable — no turn burned)", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-removed-yesterday",
      origin: "draft",
    });

    // The server would have ACCEPTED it and failed the first turn late (L7).
    expect(server.threadStartParams).not.toHaveProperty("model");
    expect(connected.model).toBe("gpt-native");

    const events = await runTurn(server, connected.engine);
    expect(notices(events)).toEqual([
      'Codex model "gpt-removed-yesterday" is no longer available; the default model is used.',
    ]);
    // Recoverable: the turn still runs to completion on the default model.
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
    // …and the bogus id never reached ANY wire call.
    expect(JSON.stringify(server.calls)).not.toContain("gpt-removed-yesterday");
  });

  it("survives an unreadable model list: no model override is ever sent (fail-closed)", async () => {
    const server = new FakeAppServer();
    server.modelListFails = true;
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      origin: "draft",
    });

    expect(server.threadStartParams).not.toHaveProperty("model");
    expect(connected.engine.models()).toEqual([]);
    // Posture is still fully expressible — presets never depend on the catalog.
    expect(connected.engine.presets().map((preset) => preset.id)).toEqual(["read-only", "ask", "workspace"]);

    const events = await runTurn(server, connected.engine);
    expect(notices(events)[0]).toContain("could not be verified");
    const [turnStart] = server.turnStartParams();
    expect(turnStart).not.toHaveProperty("model");
    // Even with no catalog, the posture is asserted.
    expect(turnStart).toMatchObject({ approvalPolicy: "untrusted" });
  });

  it("degrades a draft preset that is really a raw-config payload to the default posture (DoD-4)", async () => {
    const server = new FakeAppServer();
    // The worst thing argv could ever carry: a policy object smuggled in as an id.
    // It is an UNKNOWN preset id and nothing else — it can never become a policy,
    // because a policy is only ever read from the frozen table, never from input.
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: '{"approvalPolicy":"never","sandbox":"danger-full-access"}',
      origin: "draft",
    });

    expect(connected.presetId).toBe("ask");
    expect(server.threadStartParams).toEqual({ cwd: "/work", approvalPolicy: "untrusted", sandbox: "workspace-write" });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/work"] },
    });
    expect(JSON.stringify(server.calls)).not.toContain("danger-full-access");
  });

  it("projects the catalog for the UI: hidden models dropped, unknown wire fields ignored", async () => {
    const server = new FakeAppServer();
    server.modelPages = {
      "": {
        data: [
          { id: "visible", displayName: "Visible", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
          { id: "secret", displayName: "Secret", hidden: true },
          { id: "no-label", futureKeyNobodyKnows: 42 },
          { notAModel: true },
        ],
        nextCursor: null,
      },
    };
    const connected = await createNativeCodexSession(server, "/work");

    expect(connected.engine.models()).toEqual([
      { id: "visible", label: "Visible", efforts: ["high"] },
      { id: "no-label", label: "no-label" },
    ]);
  });
});

describe("TASK.39 — posture enforcement on every turn (cut §2(k).1)", () => {
  it("re-asserts the FULL effective set on turn 1 and on every later turn", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      presetId: "workspace",
      origin: "draft",
    });

    await runTurn(server, connected.engine);
    await runTurn(server, connected.engine, "again");

    const expected = {
      model: "gpt-5.6-sol",
      // The thread's OWN effective effort ("high" in the echo) is re-asserted —
      // never silently downgraded to the model's catalog default ("medium").
      effort: "high",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/work"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
    const starts = server.turnStartParams();
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject(expected);
    // The second turn re-asserts identically: this is what neutralizes L8 (the
    // server forgetting `untrusted` / emptying `writableRoots` between turns).
    expect(starts[1]).toMatchObject(expected);
  });

  it("applies a preset change to the NEXT turn, with the full new policy set", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, { presetId: "ask", origin: "draft" });
    const engine = connected.engine;

    await runTurn(server, engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "workspaceWrite" },
    });

    expect(engine.selectPreset("read-only")).toEqual({ ok: true, model: "gpt-native", activePresetId: "read-only" });
    // Not a single RPC is made by the change itself — it rides the next turn.
    expect(server.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);

    await runTurn(server, engine, "second");
    expect(server.turnStartParams()[1]).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("rejects an unknown model/preset host-side, before any RPC (no turn is burned)", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    const callsBefore = server.calls.length;

    expect(engine.selectModel("gpt-does-not-exist")).toEqual({
      ok: false,
      reason: 'Codex model "gpt-does-not-exist" is not available for this account.',
    });
    expect(engine.selectPreset("yolo")).toEqual({ ok: false, reason: 'Unknown Codex permission preset "yolo".' });
    expect(server.calls).toHaveLength(callsBefore);
    // State is untouched by a refused change.
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "ask" });
  });

  it("re-resolves the effort when the new model does not advertise the current one", async () => {
    const server = new FakeAppServer();
    // gpt-5.4-mini advertises ONLY "medium"; the thread's effective effort is "high".
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      origin: "draft",
    });
    expect(engine.selectModel("gpt-5.4-mini")).toMatchObject({ ok: true });

    await runTurn(server, engine);
    expect(server.turnStartParams()[0]).toMatchObject({ model: "gpt-5.4-mini", effort: "medium" });
  });

  it("acks a change only once a turn/start has actually carried it", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    const applied: { model: string; activePresetId: string }[] = [];
    engine.onSettingsApplied((snapshot) => applied.push(snapshot));

    expect(engine.selectPreset("workspace")).toMatchObject({ ok: true });
    // Phase 1: nothing is applied yet — the server has not been told anything.
    expect(applied).toEqual([]);

    await runTurn(server, engine);
    expect(applied).toEqual([{ model: "gpt-native", activePresetId: "workspace" }]);

    // A turn with nothing pending acks nothing (the posture is still re-asserted).
    await runTurn(server, engine, "second");
    expect(applied).toHaveLength(1);
  });

  it("does not ack when the turn/start itself fails", async () => {
    const server = new FakeAppServer();
    // The ack IS the accepted turn/start, so a turn/start that never answers must
    // produce no ack — the bounded turnStart deadline ends the turn as an error.
    const { engine } = await createNativeCodexSession(server, "/work", undefined, { turnStartMs: 20 });
    const applied: unknown[] = [];
    engine.onSettingsApplied((snapshot) => applied.push(snapshot));
    engine.selectPreset("read-only");

    server.turnStartMode = "never";
    const turn = drive(engine, "hi", new AbortController().signal);
    await turn.done; // bounded by the turn/start timeout

    expect(applied).toEqual([]);
    // Still pending: the next successful turn/start will carry it and ack then.
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "read-only" });
  });
});

describe("TASK.39 — resume (cut §2(k).2/.4)", () => {
  it("restores the persisted preset and model, and re-asserts them on the next turn", async () => {
    const server = new FakeAppServer();
    server.modelPages[""]!.data.push({ id: "gpt-resumed", displayName: "Resumed", supportedReasoningEfforts: [{ reasoningEffort: "high" }] });
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, {
      model: "gpt-resumed",
      presetId: "read-only",
      origin: "persisted",
    });

    expect(connected.presetId).toBe("read-only");
    expect(connected.model).toBe("gpt-resumed");

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      model: "gpt-resumed",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
    });
  });

  it("treats a pre-TASK.39 session row (mode='build') as the default preset, silently", async () => {
    const server = new FakeAppServer();
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, {
      model: "gpt-resumed",
      presetId: "build",
      origin: "persisted",
    });

    expect(connected.presetId).toBe("ask");
    const events = await runTurn(server, connected.engine);
    // A legacy row is not a user error: only the (real) missing-model notice fires.
    expect(notices(events)).toEqual([
      'Codex model "gpt-resumed" is no longer available; the default model is used.',
    ]);
  });

  it("never reverse-maps the echo: `untrusted`->`on-request` round-trip loss is NOT drift (L8)", async () => {
    const server = new FakeAppServer();
    // Exactly the live L8 echo: the thread was started `untrusted`, resumes `on-request`.
    server.threadEcho = {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite", writableRoots: [] },
      reasoningEffort: "high",
    };
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, {
      presetId: "ask",
      origin: "persisted",
    });

    expect(connected.presetId).toBe("ask");
    const events = await runTurn(server, connected.engine);
    expect(notices(events)).toEqual([]);
    // Display truth stays OUR preset; the posture is re-asserted regardless.
    expect(connected.engine.snapshot().activePresetId).toBe("ask");
    expect(server.turnStartParams()[0]).toMatchObject({ approvalPolicy: "untrusted" });
  });

  it("warns exactly once when the server's sandbox is genuinely weaker than the preset", async () => {
    const server = new FakeAppServer();
    server.threadEcho = { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } };
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, {
      presetId: "read-only",
      origin: "persisted",
    });

    const first = await runTurn(server, connected.engine);
    expect(notices(first).filter((message) => message.includes("weaker sandbox"))).toHaveLength(1);
    // Once — the notice is drained, not re-emitted every turn.
    const second = await runTurn(server, connected.engine, "again");
    expect(notices(second)).toEqual([]);
  });
});

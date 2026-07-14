import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@anycode/core";
import type { HostToUiMessage } from "../../../shared/protocol.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import { CodexApprovalBridge } from "./approval-bridge.js";
import type { JsonRpcNotification, JsonRpcServerRequest } from "./protocol.js";
import { NATIVE_PERSISTED, type ShadowCommandItem } from "./history-projection.js";
import type { CodexShadowLogPort } from "./shadow-log.js";
import {
  CODEX_NOT_SIGNED_IN,
  CodexEngine,
  createNativeCodexSession,
  resumeNativeCodexSession,
  type CodexClient,
} from "./codex-engine.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

/** Every notification (method + params) line of a captured app-server fixture, in wire order — RPC responses/requests (an `id`) are excluded. */
function loadFixtureNotifications(file: string): JsonRpcNotification[] {
  const lines = readFileSync(join(FIXTURES_DIR, file), "utf8").split("\n").filter((line) => line.trim().length > 0);
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((message): message is { method: string; params: unknown } => typeof message.method === "string" && message.id === undefined)
    .map((message) => ({ method: message.method, params: message.params }));
}

/** The JSON-RPC `result` of the LAST `id`-carrying line in a fixture (the final response the capture recorded). */
function lastFixtureResult(file: string): unknown {
  const lines = readFileSync(join(FIXTURES_DIR, file), "utf8").split("\n").filter((line) => line.trim().length > 0);
  const responses = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((message) => message.id !== undefined);
  const last = responses.at(-1);
  if (last === undefined) throw new Error(`fixture ${file} carries no id-response line`);
  return last.result;
}

/**
 * A minimal `CodexClient` that replays a REAL captured live notification
 * stream verbatim, in order, answering `turn/start` with the REAL native turn
 * id the capture used (so every `item/completed`'s `turnId` matches what the
 * engine expects). No approval bridge, no settings machinery — this exists
 * ONLY to drive the REAL writer (`CodexEngine.runTurn`) over REAL wire bytes
 * for the W6 composition test below.
 */
class ReplayClient implements CodexClient {
  private index = 0;

  constructor(
    private readonly stream: JsonRpcNotification[],
    private readonly liveTurnId: string,
  ) {}

  request<T>(method: string): Promise<T> {
    if (method === "turn/start") return Promise.resolve({ turn: { id: this.liveTurnId } } as T);
    return Promise.resolve({} as T);
  }

  notify(): void {}

  notifications(): AsyncIterable<JsonRpcNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this.index < this.stream.length) {
            return Promise.resolve({ value: this.stream[this.index++]!, done: false });
          }
          // The fixture's own `turn/completed` line always terminates the
          // real turn before exhaustion is reached; parking here (rather than
          // signalling `done`) matches a real transport that stays open.
          return new Promise(() => {});
        },
      }),
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Records every write and answers `list()` from a settable fixture — the shadow-log test double. */
class RecordingShadowLog implements CodexShadowLogPort {
  readonly writes: Array<{ threadId: string; itemId: string; item: ShadowCommandItem }> = [];
  listResult: ShadowCommandItem[] = [];

  record(threadId: string, itemId: string, item: ShadowCommandItem): void {
    this.writes.push({ threadId, itemId, item });
  }

  async list(_threadId: string): Promise<ShadowCommandItem[]> {
    return this.listResult;
  }
}

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
  /** EVERY `turn/interrupt` the server received, rejected ones included. */
  interrupts = 0;
  turnStartMode: TurnStartMode = "immediate";
  /** "complete": the interrupted turn settles; "silent": the server never settles it. */
  interruptSettles: "complete" | "silent" = "complete";
  /**
   * How many `turn/interrupt` calls are rejected with JSON-RPC `-32600`
   * ("no active turn to interrupt") before one is accepted — the LIVE reject
   * window measured on codex-cli 0.144.3 (TASK.38): an interrupt sent in the
   * first ~10-25ms of a turn's life is refused even though `turn/start` has
   * already returned a real turn id. 0 (the default) reproduces the previous
   * fake exactly: the first interrupt is accepted.
   */
  interruptRejections = 0;
  /**
   * `code`/message of every rejected `turn/interrupt` (TASK.38 W14): broken out
   * so a test can prove the engine classifies a rejection by `code` ALONE —
   * never by prose. Defaults reproduce the live wire error exactly (W12's
   * fixture value and its code), so no existing test that leaves these alone
   * observes any change.
   */
  interruptRejectionCode = -32600;
  interruptRejectionMessage = "app-server request failed: no active turn to interrupt";
  private rejectedInterrupts = 0;
  private acceptedInterrupts = 0;
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
  /** `thread/read`'s response (TASK.42 resume-history hydration); default has zero turns — an empty resumed thread. */
  threadReadResult: unknown = { thread: { id: "persisted-thread", turns: [] } };
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
    if (method === "thread/read") {
      return Promise.resolve(this.threadReadResult as T);
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
      // The live reject window (see interruptRejections): while no interrupt has
      // been ACCEPTED yet and rejections remain, the server refuses this one with
      // the real wire error. `code` rides the rejection exactly as AppServerClient
      // now surfaces it.
      if (this.acceptedInterrupts === 0 && this.rejectedInterrupts < this.interruptRejections) {
        this.rejectedInterrupts += 1;
        return Promise.reject(
          Object.assign(new Error(this.interruptRejectionMessage), { code: this.interruptRejectionCode }),
        );
      }
      this.acceptedInterrupts += 1;
      if (this.acceptedInterrupts > 1) return new Promise<T>(() => {}); // black hole (L9)
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

  // TASK.38 (W12): the live app-server refuses a `turn/interrupt` sent in the
  // first ~10-25ms of a turn's life with JSON-RPC -32600 — AFTER `turn/start`
  // has already returned a real turn id. The pre-fix engine sent exactly one
  // interrupt, swallowed that rejection, and latched: the Stop was lost, and a
  // turn longer than the settle deadline then failed the session outright.
  it("retries an interrupt the server rejected as \"no active turn\" until the turn is really interrupted", async () => {
    const server = new FakeAppServer();
    server.interruptRejections = 2;
    server.turnStartMode = "deferred";
    const engine = new CodexEngine(server, THREAD, undefined, {
      interruptRetryDelaysMs: [5, 10, 20],
      postInterruptSettleMs: 200,
    });
    const controller = new AbortController();
    const turn = drive(engine, "stop me instantly", controller.signal);
    await tick();

    // Stop lands BEFORE the native turn id exists — the exact race that lands
    // the first interrupt inside the server's reject window.
    controller.abort();
    await tick();
    server.releaseTurnStart();
    await turn.done;

    const interrupts = server.calls.filter((call) => call.method === "turn/interrupt");
    expect(server.interrupts).toBe(3); // 2 rejected + 1 accepted
    expect(interrupts).toHaveLength(3);
    // Every attempt — retries included — names the SAME captured turn.
    expect(interrupts.map((call) => (call.params as { turnId?: unknown }).turnId))
      .toEqual(["native-turn-1", "native-turn-1", "native-turn-1"]);
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    expect(turn.events.some((event) => event.type === "error")).toBe(false);
    expect(server.closeCount).toBe(0);
  });

  it("never lets a retried interrupt reach the NEXT turn, even if every attempt is rejected", async () => {
    const server = new FakeAppServer();
    server.interruptRejections = 999; // no attempt is ever accepted.
    server.turnStartMode = "deferred";
    const engine = new CodexEngine(server, THREAD, undefined, { interruptRetryDelaysMs: [5, 10, 20] });
    const controller = new AbortController();
    const first = drive(engine, "stop me instantly", controller.signal);
    await tick();

    controller.abort();
    await tick();
    server.releaseTurnStart();
    await tick();
    // The server ignored the Stop and completed the turn normally: the turn the
    // retry schedule was captured against is now DEAD.
    server.completeTurn("completed");
    await first.done;

    // Longer than the whole retry schedule (5 + 10 + 20ms): an ungated retry loop
    // would keep firing interrupts at a turn that no longer exists.
    await new Promise((resolve) => setTimeout(resolve, 120));

    server.turnStartMode = "immediate";
    const second = drive(engine, "next question", new AbortController().signal);
    await tick();
    server.completeTurn("completed");
    await second.done;

    const interrupts = server.calls.filter((call) => call.method === "turn/interrupt");
    expect(server.interrupts).toBe(1);
    expect(interrupts.map((call) => (call.params as { turnId?: unknown }).turnId)).toEqual(["native-turn-1"]);
    // No interrupt may be written after the SECOND turn/start: the second turn is
    // not the one the user stopped.
    const secondStart = server.calls.map((call) => call.method).lastIndexOf("turn/start");
    const lastInterrupt = server.calls.map((call) => call.method).lastIndexOf("turn/interrupt");
    expect(lastInterrupt).toBeLessThan(secondStart);
    expect(second.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 2 });
  });

  // TASK.38 (W14): `isNoActiveTurnRejection` classifies ONLY on the numeric
  // JSON-RPC `code` (codex-engine.ts ~line 133) — the message is free-form
  // server prose and must never be pattern-matched. The two tests below pin
  // that rule at the seams a code+text-matching fake could otherwise hide: the
  // ORIGINAL retry tests above always pair -32600 with the exact "no active
  // turn" text, so a regression to text-matching stays green against them.
  it("retries an interrupt rejected with code -32600 even when its message names something else entirely", async () => {
    const server = new FakeAppServer();
    server.interruptRejections = 2;
    // Deliberately NOT "no active turn": a text-matching classifier would fail
    // to recognize this as the retryable rejection and give up after one try.
    server.interruptRejectionMessage = "turn is not yet interruptible";
    server.turnStartMode = "deferred";
    const engine = new CodexEngine(server, THREAD, undefined, {
      interruptRetryDelaysMs: [5, 10, 20],
      postInterruptSettleMs: 200,
    });
    const controller = new AbortController();
    const turn = drive(engine, "stop me instantly", controller.signal);
    await tick();

    controller.abort();
    await tick();
    server.releaseTurnStart();
    await turn.done;

    const interrupts = server.calls.filter((call) => call.method === "turn/interrupt");
    expect(server.interrupts).toBe(3); // 2 rejected + 1 accepted — the code alone earns the retry.
    expect(interrupts).toHaveLength(3);
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    expect(turn.events.some((event) => event.type === "error")).toBe(false);
    expect(server.closeCount).toBe(0);
  });

  it("never retries an interrupt rejection whose message resembles \"no active turn\" but whose code is not -32600", async () => {
    const server = new FakeAppServer();
    // The prose a text-matching classifier would key on — paired with a code
    // that is NOT -32600. A rejection budget of 1 means that IF a second
    // (retried) attempt reaches the server, it is ACCEPTED: the retry itself
    // is the tell that separates a text-matching classifier (wrongly retries,
    // interrupts=2, turn cancelled) from a code-only one (never retries,
    // interrupts=1, turn completes normally).
    server.interruptRejectionCode = -32000;
    server.interruptRejections = 1;
    server.turnStartMode = "deferred";
    const engine = new CodexEngine(server, THREAD, undefined, { interruptRetryDelaysMs: [5, 10, 20] });
    const controller = new AbortController();
    const turn = drive(engine, "stop me instantly", controller.signal);
    await tick();

    controller.abort();
    await tick();
    server.releaseTurnStart();
    await tick();

    // Longer than the whole retry schedule (5 + 10 + 20ms): a correct,
    // code-only classifier sends exactly one interrupt and never retries a
    // rejection whose code is not -32600, no matter what its message says.
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The server never saw a Stop it was obliged to honor, so the turn runs to
    // its own ordinary completion.
    server.completeTurn("completed");
    await turn.done;

    expect(server.interrupts).toBe(1);
    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
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
    // `snapshot()` is the APPLIED posture (W3-review): a change no turn/start
    // ever carried is NOT active, however much the user asked for it — that is
    // the whole meaning of the two-phase ack. It is reported as pending instead.
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "ask" });
    expect(engine.pendingSnapshot()).toEqual({ model: "gpt-native", activePresetId: "read-only" });
  });

  // W3-review: display truth vs enforcement. Enforcement is NOT in question —
  // every turn/start re-asserts the chosen preset (asserted above) — but until
  // one has, the UI must not present the choice as active.
  it("keeps a chosen-but-unapplied change OUT of snapshot() while still enforcing it on the next turn", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, { presetId: "workspace", origin: "draft" });
    const engine = connected.engine;

    expect(engine.selectPreset("read-only")).toMatchObject({ ok: true, activePresetId: "read-only" });
    // Displayed: still the old posture. Pending: the new one.
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "workspace" });
    expect(engine.pendingSnapshot()).toEqual({ model: "gpt-native", activePresetId: "read-only" });

    await runTurn(server, engine);

    // The turn CARRIED the new posture (enforcement, untouched) and only now is
    // it applied — and therefore only now displayed as active.
    expect(server.turnStartParams()[0]).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "read-only" });
    expect(engine.pendingSnapshot()).toBeNull();
  });

  it("treats picking back to the applied value as nothing pending", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, { presetId: "ask", origin: "draft" });
    const engine = connected.engine;

    engine.selectPreset("read-only");
    expect(engine.pendingSnapshot()).not.toBeNull();

    engine.selectPreset("ask");
    expect(engine.pendingSnapshot()).toBeNull();
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "ask" });
  });
});

describe("TASK.39 — resume (cut §2(k).2/.4)", () => {
  // W3-review test (b): a host RESPAWN boots from the persisted posture, so
  // chosen === applied by design (cut §2(k).1) — the restored posture is not a
  // "pending change" that a user has to wait a turn for, and the UI must not
  // show a pending badge for it. The first turn/start still carries it.
  it("boots a respawn from the persisted settings with NOTHING pending, and carries that posture on the first turn", async () => {
    const server = new FakeAppServer();
    server.modelPages[""]!.data.push({ id: "gpt-resumed", displayName: "Resumed", supportedReasoningEfforts: [{ reasoningEffort: "high" }] });
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, {
      model: "gpt-resumed",
      presetId: "read-only",
      origin: "persisted",
    });

    expect(connected.engine.snapshot()).toEqual({ model: "gpt-resumed", activePresetId: "read-only" });
    expect(connected.engine.pendingSnapshot()).toBeNull();

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      model: "gpt-resumed",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
    });
  });

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

// ─────────────────────────────────────────────────────────────────────────────
// TASK.42 — resume-history hydration + the command shadow log (cut §2(e)).
// ─────────────────────────────────────────────────────────────────────────────

describe("CodexEngine — resume-history hydration (TASK.42)", () => {
  it("historyItems() is [] for a bare/fresh-started engine", async () => {
    const server = new FakeAppServer();
    const created = await createNativeCodexSession(server, "/work");
    expect(created.engine.historyItems()).toEqual([]);
  });

  it("resume wires thread/read's turns through projectCodexHistory into historyItems() — a real merged transcript, not []", async () => {
    const server = new FakeAppServer();
    server.threadReadResult = {
      thread: {
        id: "persisted-thread",
        turns: [
          {
            id: "turn-a",
            startedAt: 100,
            items: [
              { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] },
              { type: "agentMessage", id: "a1", text: "hi there" },
            ],
          },
        ],
      },
    };
    // Pre-fix: resumeNativeCodexSession discarded the thread/read result
    // entirely and historyItems() always returned [] — this assertion would
    // fail with an empty array. No shadowLog was supplied, so the fallback
    // degradation marker is also expected (asserted separately below) — this
    // test only cares that the REAL native turn items came through.
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread");
    const items = connected.engine.historyItems().filter((item) => item.kind !== "compact_summary");
    expect(items).toEqual([
      { id: "turn-a:u1", createdAt: 100000, message: { role: "user", content: "hello" } },
      { id: "turn-a:a1", createdAt: 100001, message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
    ]);
  });

  it("resume merges shadow-logged commands into the projected history via the injected CodexShadowLogPort", async () => {
    const server = new FakeAppServer();
    server.threadReadResult = { thread: { id: "persisted-thread", turns: [{ id: "turn-a", startedAt: 0, items: [] }] } };
    const shadowLog = new RecordingShadowLog();
    shadowLog.listResult = [{ turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo shadow", exitCode: 0, outputHead: "shadow\n" }];

    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, shadowLog);
    const items = connected.engine.historyItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ message: { content: [{ type: "tool_call", toolName: "Bash", input: { command: "echo shadow" } }] } });
    expect(items[1]).toMatchObject({ message: { role: "tool", content: [{ status: "success", text: "shadow\n" }] } });
  });

  it("resume with a shadow log that has zero rows (but the thread has turns) projects the fallback degradation marker", async () => {
    const server = new FakeAppServer();
    server.threadReadResult = {
      thread: { id: "persisted-thread", turns: [{ id: "turn-a", startedAt: 0, items: [{ type: "agentMessage", id: "a1", text: "hi" }] }] },
    };
    const shadowLog = new RecordingShadowLog();
    shadowLog.listResult = [];

    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, shadowLog);
    const items = connected.engine.historyItems();
    expect(items[0]).toMatchObject({ kind: "compact_summary", message: { content: [{ text: expect.stringContaining("not retained by Codex") }] } });
  });
});

describe("CodexEngine — command shadow log live writer (TASK.42)", () => {
  it("writes a shadow row for a completed commandExecution, with the correct turnOrdinal/positionInTurn", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", cwd: "/work" } } });
    await tick();
    server.stream.push({
      method: "item/completed",
      // Real wire echoes `command`/`cwd` on the completed item too (fixture
      // w1-p1-command-decline.jsonl) — the writer reads them from HERE, the
      // terminal snapshot, not from the earlier item/started.
      params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", cwd: "/work", status: "completed", exitCode: 0, aggregatedOutput: "hi\n" } },
    });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(1);
    expect(shadowLog.writes[0]).toEqual({
      threadId: THREAD,
      itemId: "exec-1",
      item: { turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo hi", cwd: "/work", exitCode: 0, outputHead: "hi\n" },
    });
  });

  it("positionInTurn counts only NATIVE_PERSISTED completions (userMessage/agentMessage/fileChange); seqInTurn counts every completion", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    // A NATIVE_PERSISTED text item completes FIRST (advances BOTH counters),
    // THEN the command — the shadow row must record positionInTurn 1 (one
    // native-visible completion happened first), not 0.
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", id: "msg-1" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", id: "msg-1", text: "hi" } } });
    await tick();
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(1);
    expect(shadowLog.writes[0]?.item.positionInTurn).toBe(1);
    expect(shadowLog.writes[0]?.item.seqInTurn).toBe(1);
  });

  it("a reasoning completion between two native-visible items advances seqInTurn but NOT positionInTurn (W6 — the reviewer's exact defect)", async () => {
    // Live evidence (contract/fixtures/w0-command-accept.jsonl): a real
    // gpt-5-codex turn is user -> reasoning -> agent -> command -> agent.
    // `thread/read` never persists `reasoning` (NATIVE_PERSISTED), so the
    // command's anchor must be counted in the native-visible space, not the
    // raw live-completion space, or the resume merge drifts the command past
    // the agent message that follows it.
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", id: "msg-1", text: "commentary" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "reasoning", id: "rs-1", summary: [] } } });
    await tick();
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(1);
    // Only the agentMessage advanced positionInTurn; the reasoning did not.
    expect(shadowLog.writes[0]?.item.positionInTurn).toBe(1);
    // seqInTurn saw all 3 completions (agentMessage, reasoning, command) before it.
    expect(shadowLog.writes[0]?.item.seqInTurn).toBe(2);
  });

  it("turnOrdinal is offset by baseTurnOrdinal (a resumed thread's live turns continue its own numbering)", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    // Resumed with 3 prior native turns already persisted — this launch's
    // FIRST live turn is native turn ordinal 3, not 0.
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 3);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes[0]?.item.turnOrdinal).toBe(3);
  });

  it("a rejected/early-returned turn does NOT advance the native ordinal shadow rows anchor to (LOW1)", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);

    // Burned turn: rejected by runTurn()'s early-return guard (unsupported
    // image attachments) BEFORE any turn/start is ever sent — no native turn
    // exists. `turnNumber` (the UI-facing counter) still advances; that is
    // fine and unrelated to shadow-row anchoring.
    const rejectedEvents: AgentEvent[] = [];
    for await (const event of engine.runTurn("look at this", {
      signal: new AbortController().signal,
      attachments: [{ mediaType: "image/png", data: "AA==" }],
    })) {
      rejectedEvents.push(event);
    }
    expect(rejectedEvents.some((event) => event.type === "error")).toBe(true);
    expect(server.calls.some((call) => call.method === "turn/start")).toBe(false);

    // The FIRST real turn must still anchor to native ordinal 0
    // (baseTurnOrdinal) — a burned runTurn() call must never consume an
    // ordinal slot, or every shadow row on a resumed thread silently drifts
    // by one after any rejected turn.
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes[0]?.item.turnOrdinal).toBe(0);
  });

  it("caps outputHead at 8 KiB", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();
    const hugeOutput = "x".repeat(20_000);
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "yes x | head -c 20000" } } });
    server.stream.push({
      method: "item/completed",
      params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "yes x | head -c 20000", status: "completed", exitCode: 0, aggregatedOutput: hugeOutput } },
    });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes[0]?.item.outputHead).toHaveLength(8192);
  });

  it("never writes a shadow row for a declined command with no exitCode/output — the fields are simply omitted, not written as garbage", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "rm -rf /" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "rm -rf /", status: "declined" } } });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(1);
    expect(shadowLog.writes[0]?.item).toEqual({ turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "rm -rf /" });
  });

  it("writes nothing when no shadowLog was supplied (undefined stays a no-op, never throws)", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const events = await runTurn(server, engine);
    expect(events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
  });
});

describe("CodexEngine — shadow counters ignore foreign/stale item/completed (W7 HIGH-1)", () => {
  it("a stale item/completed from an earlier turn of the SAME thread does not tick the counters or move the anchor", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    // Trailing item/completed of a PREVIOUS, already-finished turn of the same
    // thread (e.g. an interrupted turn's late notification arriving after the
    // next turn/start) — threadId matches, turnId does not. Phase B (deliver)
    // does not filter by turnId today, so this ticks nativeVisibleCompleted.
    server.stream.push({
      method: "item/completed",
      params: { threadId: THREAD, turnId: "stale-turn-id", item: { type: "agentMessage", id: "stale-msg", text: "leftover" } },
    });
    await tick();

    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi" } } });
    server.stream.push({
      method: "item/completed",
      params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } },
    });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(1);
    expect(shadowLog.writes[0]?.item.positionInTurn).toBe(0);
    expect(shadowLog.writes[0]?.item.seqInTurn).toBe(0);
  });

  it("a foreign-thread item/completed does not tick the counters or move the anchor", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    server.stream.push({
      method: "item/completed",
      params: { threadId: "other-thread", turnId: server.turnId, item: { type: "agentMessage", id: "foreign-msg", text: "leftover" } },
    });
    await tick();

    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi" } } });
    server.stream.push({
      method: "item/completed",
      params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } },
    });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(1);
    expect(shadowLog.writes[0]?.item.positionInTurn).toBe(0);
    expect(shadowLog.writes[0]?.item.seqInTurn).toBe(0);
  });
});

describe("CodexEngine — per-turn item-id dedupe stops a re-delivered terminal notification from moving the anchor (W7 HIGH-2 / W8 MEDIUM-1)", () => {
  it("a duplicate terminal item/completed for the same commandExecution id never moves the anchor — the counters tick only once, but BOTH deliveries write (the second enriches, W8 MEDIUM-1)", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    // agent(before) -> command(cmd) -> agent(after) -> duplicate command(cmd)
    // (reviewer's exact repro).
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", id: "before", text: "before" } } });
    await tick();
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "cmd", command: "echo hi" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "cmd", command: "echo hi", status: "completed", exitCode: 0 } } });
    await tick();
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", id: "after", text: "after" } } });
    await tick();
    // Re-delivered terminal notification for the SAME command id.
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "cmd", command: "echo hi", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed");
    await turn.done;

    // W8 MEDIUM-1: the redelivery is no longer skipped entirely — it writes
    // again (payload enrichment, see the dedicated describe block below) —
    // but the ANCHOR (positionInTurn/seqInTurn) it writes with is identical
    // to the first delivery's, exactly the W7 HIGH-2 invariant this test
    // guards: a re-delivered notification must never move a command past
    // where its FIRST delivery placed it.
    expect(shadowLog.writes).toHaveLength(2);
    expect(shadowLog.writes[0]?.item).toMatchObject({ positionInTurn: 1, seqInTurn: 1 });
    expect(shadowLog.writes[1]?.item).toMatchObject({ positionInTurn: 1, seqInTurn: 1 });
  });

  it("an item/completed with no string id is never dedup'd — it ticks the counters on every delivery, as before", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    // Two id-less agentMessage completions (malformed, but must not be
    // conflated as "the same item" by an id-based dedupe).
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", text: "one" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", text: "two" } } });
    await tick();
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(1);
    // Both id-less completions ticked nativeVisibleCompleted (agentMessage is
    // NATIVE_PERSISTED) — the command anchors at positionInTurn 2, not 0.
    expect(shadowLog.writes[0]?.item.positionInTurn).toBe(2);
    expect(shadowLog.writes[0]?.item.seqInTurn).toBe(2);
  });
});

describe("CodexEngine — a re-delivered item/completed enriches the shadow row's payload without moving its anchor (W8 MEDIUM-1)", () => {
  it("a sparse-then-rich redelivery of the same commandExecution id keeps the FIRST anchor but enriches the row with the later payload", async () => {
    // W7's fix (per-turn Set<string> of seen item ids) swung the pendulum too
    // far: it made the ANCHOR immovable by skipping the whole block on
    // redelivery — including the write itself. If the FIRST terminal
    // notification for a command arrived sparse (exitCode/aggregatedOutput
    // both nullable per the pinned contract) and a LATER redelivery of the
    // SAME item id carries the real exitCode/output, that enrichment must
    // not be silently dropped — only the anchor (positionInTurn/seqInTurn)
    // must stay pinned to the first delivery.
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);
    const turn = drive(engine, "run it", new AbortController().signal);
    await tick();

    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "cmd-1", command: "echo hi" } } });
    // First (terminal) delivery: sparse — no exitCode/aggregatedOutput.
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "cmd-1", command: "echo hi" } } });
    await tick();
    // An unrelated native completion moves the counters on in between.
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "agentMessage", id: "msg-1", text: "still working" } } });
    await tick();
    // Re-delivered terminal notification for the SAME item id, now rich.
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "cmd-1", command: "echo hi", status: "completed", exitCode: 0, aggregatedOutput: "hi\n" } } });
    server.completeTurn("completed");
    await turn.done;

    expect(shadowLog.writes).toHaveLength(2);
    const [first, second] = shadowLog.writes;
    // Both writes anchor at the FIRST delivery's counters — the redelivery
    // must never move positionInTurn/seqInTurn (W7 HIGH-2, unchanged).
    expect(first?.item).toMatchObject({ positionInTurn: 0, seqInTurn: 0 });
    expect(second?.item).toMatchObject({ positionInTurn: 0, seqInTurn: 0 });
    // The FIRST write carries no exitCode/outputHead (sparse).
    expect(first?.item.exitCode).toBeUndefined();
    expect(first?.item.outputHead).toBeUndefined();
    // The SECOND write enriches the SAME row with the later payload.
    expect(second?.item.exitCode).toBe(0);
    expect(second?.item.outputHead).toBe("hi\n");
  });
});

/**
 * Class-killer composition test (W6): the interleave invariant may ONLY be
 * asserted through composition — never hand-authored `positionInTurn` values
 * (forbidden pattern: the OLD history-projection.test.ts:334, now relabelled
 * as a mechanics-only unit test). Both halves are REAL:
 *
 *  - The shadow row comes from running the REAL writer (`CodexEngine.runTurn`,
 *    the `deliver` closure) over a REAL captured live app-server stream —
 *    contract/fixtures/w0-command-accept.jsonl — one gpt-5-codex turn whose
 *    live order is `user -> reasoning -> agent -> commandExecution -> agent`
 *    (the exact shape the adversarial reviewer proved against codex-cli
 *    0.144.3 drifts on resume).
 *  - The native side comes from a REAL `thread/resume` + `thread/read`
 *    capture of THE SAME SESSION — contract/fixtures/w0-command-accept-resume-read.jsonl
 *    (captured 2026-07-14 by resuming thread
 *    019f554d-16be-7b21-b55e-e9ce5b023a52, the exact thread w0-command-accept.jsonl
 *    ran; no paired read capture for that session existed before this — see
 *    the sibling meta.json for the capture record). It confirms L4 directly:
 *    `thread/read` hands back `[userMessage, agentMessage, agentMessage]` —
 *    `reasoning` and `commandExecution` are both simply gone.
 *  - The merge is the REAL end-to-end path: `resumeNativeCodexSession` ->
 *    `asThreadRead` -> `projectCodexHistory` -> `mergeTurnItems`. Nothing
 *    about the expected interleave is hand-picked; only the OUTPUT sequence
 *    is asserted.
 */
describe("CodexEngine + resumeNativeCodexSession — real interleave composition (W6 class-killer)", () => {
  const LIVE_THREAD_ID = "019f554d-16be-7b21-b55e-e9ce5b023a52";
  const LIVE_TURN_ID = "019f554d-16fb-7493-bc52-fe8403dbd61c";

  it("domain-drift sentinel: every item type the paired thread/read capture returns is inside NATIVE_PERSISTED", () => {
    const read = lastFixtureResult("w0-command-accept-resume-read.jsonl") as {
      thread: { turns?: Array<{ items?: Array<{ type: string }> }> };
    };
    const types = (read.thread.turns ?? []).flatMap((turn) => (turn.items ?? []).map((item) => item.type));
    // Not vacuous: this session really did run a reasoning item and a command
    // live (w0-command-accept.jsonl) — if thread/read had persisted either,
    // this fixture would carry a type outside NATIVE_PERSISTED and the loop
    // below would need to catch it; the length check proves the loop runs.
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(
        NATIVE_PERSISTED.has(type),
        `thread/read persisted a "${type}" item — NATIVE_PERSISTED (history-projection.ts) is stale and must be ` +
          `re-evidenced by a live probe against the current codex-cli before this type can be trusted native-side`,
      ).toBe(true);
    }
  });

  it(
    "reproduces the real user->reasoning->agent->CMD->agent resume interleave " +
      "(RED at 7bce5e9: the reviewer's exact defect — the command jumping to the end of the turn)",
    async () => {
      // Step 1 — the REAL writer over the REAL live stream.
      const liveStream = loadFixtureNotifications("w0-command-accept.jsonl");
      const writeShadowLog = new RecordingShadowLog();
      const writer = new CodexEngine(
        new ReplayClient(liveStream, LIVE_TURN_ID),
        LIVE_THREAD_ID,
        undefined,
        undefined,
        undefined,
        writeShadowLog,
        0,
      );
      for await (const _event of writer.runTurn(
        "Run exactly: sh -c 'echo w0-command > w0-command-sentinel.txt'. Then state whether it succeeded.",
        { signal: new AbortController().signal },
      )) {
        // Draining is the point — only the shadow-log side effect matters here.
      }
      expect(writeShadowLog.writes).toHaveLength(1);
      const shadowRow = writeShadowLog.writes[0]!.item;

      // Step 2 — the REAL merge path, fed the REAL paired thread/read capture
      // of the SAME session plus the shadow row the REAL writer just produced.
      const server = new FakeAppServer();
      server.threadReadResult = lastFixtureResult("w0-command-accept-resume-read.jsonl");
      const resumeShadowLog = new RecordingShadowLog();
      resumeShadowLog.listResult = [shadowRow];
      const connected = await resumeNativeCodexSession(
        server,
        "/work",
        "persisted-thread",
        undefined,
        undefined,
        undefined,
        resumeShadowLog,
      );

      const sequence = connected.engine.historyItems().map((item) => {
        if (item.message.role !== "assistant") return item.message.role;
        const part = item.message.content[0];
        return part?.type === "tool_call" ? "assistant:tool_call" : "assistant:text";
      });

      // THE GOLDEN ASSERTION: the command sits strictly BETWEEN the two agent
      // messages — matching the real live order — never at the end of the turn.
      expect(sequence).toEqual(["user", "assistant:text", "assistant:tool_call", "tool", "assistant:text"]);
    },
  );
});

/**
 * W18: the same composition discipline as the W6 class-killer above (the
 * REAL writer, over a REAL notification stream, merged through the REAL
 * `resumeNativeCodexSession` -> `projectCodexHistory` -> `mergeTurnItems`
 * path — no hand-authored `positionInTurn`), but for a turn with TWO
 * shadow-logged commands and ZERO reasoning items anywhere. This proves the
 * W6 anchor (codex-engine.ts's `nativeVisibleCompleted`) holds the order on
 * its own arithmetic, not on a reasoning item's dropped-completion offset
 * happening to save it — the live model's choice to think out loud or not
 * must never be load-bearing for transcript order.
 *
 * RED-first (verified by hand, then reverted): a local revert of
 * codex-engine.ts:933's anchor expression from `nativeVisibleCompleted` back
 * to `seqInTurn` sinks the second command to the tail. With zero dropped
 * items in this turn, `positionInTurn` and `seqInTurn` coincide for the
 * FIRST command (both count 1 prior completion — A1), but diverge for the
 * SECOND: the fix anchors C2 at `nativeVisibleCompleted` 2 (A1+A2 native
 * completions), while the revert anchors it at `seqInTurn` 3 (A1+C1+A2 — EVERY
 * completion, shadow included) — 3 >= native.length (3), so the merge walk
 * never places it before any native item and it falls into the orphan tail:
 * [A1, C1, A2, A3, C2] instead of [A1, C1, A2, C2, A3].
 */
describe("CodexEngine + resumeNativeCodexSession — resume-merge holds the W6 order with ZERO reasoning items (W18)", () => {
  const SYNTH_THREAD_ID = "w18-synthetic-thread";
  const SYNTH_TURN_ID = "w18-synthetic-turn";

  function agentMessageNotifications(id: string, text: string): JsonRpcNotification[] {
    return [
      { method: "item/started", params: { threadId: SYNTH_THREAD_ID, turnId: SYNTH_TURN_ID, item: { type: "agentMessage", id } } },
      { method: "item/completed", params: { threadId: SYNTH_THREAD_ID, turnId: SYNTH_TURN_ID, item: { type: "agentMessage", id, text } } },
    ];
  }

  function commandNotifications(id: string, command: string): JsonRpcNotification[] {
    return [
      { method: "item/started", params: { threadId: SYNTH_THREAD_ID, turnId: SYNTH_TURN_ID, item: { type: "commandExecution", id, command } } },
      {
        method: "item/completed",
        params: {
          threadId: SYNTH_THREAD_ID,
          turnId: SYNTH_TURN_ID,
          item: { type: "commandExecution", id, command, status: "completed", aggregatedOutput: `${id}-out`, durationMs: 0 },
        },
      },
    ];
  }

  it("reproduces [A1, C1, A2, C2, A3] from a turn with two commands and no reasoning items at all", async () => {
    // Step 1 — the REAL writer over a REAL (synthetic, but wire-shaped)
    // notification stream: agentMessage, command, agentMessage, command,
    // agentMessage — no reasoning item anywhere in this turn.
    const liveStream: JsonRpcNotification[] = [
      ...agentMessageNotifications("a1", "A1"),
      ...commandNotifications("c1", "echo c1"),
      ...agentMessageNotifications("a2", "A2"),
      ...commandNotifications("c2", "echo c2"),
      ...agentMessageNotifications("a3", "A3"),
      { method: "turn/completed", params: { threadId: SYNTH_THREAD_ID, turn: { id: SYNTH_TURN_ID, status: "completed" } } },
    ];
    const writeShadowLog = new RecordingShadowLog();
    const writer = new CodexEngine(
      new ReplayClient(liveStream, SYNTH_TURN_ID),
      SYNTH_THREAD_ID,
      undefined,
      undefined,
      undefined,
      writeShadowLog,
      0,
    );
    for await (const _event of writer.runTurn("run two independent commands", { signal: new AbortController().signal })) {
      // Draining is the point — only the shadow-log side effect matters here.
    }
    expect(writeShadowLog.writes).toHaveLength(2);

    // Step 2 — the REAL merge path, fed a `thread/read` result with the
    // NATIVE side only (3 agentMessage items — thread/read never persists
    // commandExecution, cut §2(e) L4) plus the shadow rows the REAL writer
    // above just produced.
    const server = new FakeAppServer();
    server.threadReadResult = {
      thread: {
        id: "persisted-thread",
        turns: [
          {
            id: "resume-turn-0",
            startedAt: 0,
            items: [
              { type: "agentMessage", id: "a1", text: "A1" },
              { type: "agentMessage", id: "a2", text: "A2" },
              { type: "agentMessage", id: "a3", text: "A3" },
            ],
          },
        ],
      },
    };
    const resumeShadowLog = new RecordingShadowLog();
    resumeShadowLog.listResult = writeShadowLog.writes.map((write) => write.item);
    const connected = await resumeNativeCodexSession(
      server,
      "/work",
      "persisted-thread",
      undefined,
      undefined,
      undefined,
      resumeShadowLog,
    );

    const sequence = connected.engine.historyItems().map((item) => {
      if (item.message.role !== "assistant") return item.message.role;
      const part = item.message.content[0];
      return part?.type === "tool_call" ? "assistant:tool_call" : "assistant:text";
    });

    // [A1, C1, A2, C2, A3] — each "C" expands to its own tool_call/tool_result pair.
    expect(sequence).toEqual([
      "assistant:text",
      "assistant:tool_call",
      "tool",
      "assistant:text",
      "assistant:tool_call",
      "tool",
      "assistant:text",
    ]);
  });
});

import { vi } from "vitest";
import type { JsonRpcNotification, JsonRpcServerRequest } from "./protocol.js";
import type { CodexClient } from "./codex-engine.js";

export const THREAD = "native-thread";

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
export class FakeAppServer implements CodexClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly observers = new Set<(notification: JsonRpcNotification) => void>();
  readonly stream = new Notifications(this.observers);
  threadId = THREAD;
  readonly serverRequests: JsonRpcServerRequest[] = [];
  serverRequestHandler?: (request: JsonRpcServerRequest) => Promise<void>;
  async serverRequest(request: JsonRpcServerRequest): Promise<void> {
    this.serverRequests.push(request);
    if (!this.serverRequestHandler) throw new Error("no server request handler");
    await this.serverRequestHandler(request);
  }
  closeCount = 0;
  /** EVERY `turn/interrupt` the server received, rejected ones included. */
  interrupts = 0;
  turnStartMode: TurnStartMode = "immediate";
  /** "complete": the interrupted turn settles; "silent": the server never settles it. */
  interruptSettles: "complete" | "silent" = "complete";
  /**
   * How many `turn/interrupt` calls are rejected with JSON-RPC `-32600`
   * ("no active turn to interrupt") before one is accepted — the LIVE reject
   * window measured on codex-cli 0.144.3: an interrupt sent in the
   * first ~10-25ms of a turn's life is refused even though `turn/start` has
   * already returned a real turn id. 0 (the default) reproduces the previous
   * fake exactly: the first interrupt is accepted.
   */
  interruptRejections = 0;
  /**
   * `code`/message of every rejected `turn/interrupt` (W14): broken out
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
  /** Undefined = the field is absent on the wire, matching most live responses. */
  requiresOpenaiAuth: boolean | undefined = undefined;
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
          inputModalities: ["text", "image"],
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
          inputModalities: ["text"],
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "…" }],
        },
      ],
      nextCursor: null,
    },
  };
  /** `model/list` failure mode: the boot must survive it (empty catalog, no model override). */
  modelListFails = false;
  /**
   * `account/rateLimits/read` result (codex-profiles cut §6.1 boot pull). The
   * default mirrors the LIVE W0-R1 probe shape: one populated window,
   * `secondary` present-but-null, single-bucket `byLimitId` duplicate.
   */
  rateLimitsResult: unknown = {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_784_791_993 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "plus",
      rateLimitReachedType: null,
    },
  };
  /** Quota pull failure mode: the boot must survive it (no quota block, session usable). */
  rateLimitsReadFails = false;
  /**
   * `windowsSandbox/readiness` result. The default
   * mirrors a Windows boot that never had a setup — the probe-only status the
   * engine turns into a boot notice (never a boot failure).
   */
  windowsReadinessResult: unknown = { status: "notConfigured" };
  /** Readiness failure mode: an old binary without the method (request rejects). */
  windowsReadinessFails = false;
  /** The effective-settings echo appended to thread/start and thread/resume responses. */
  threadEcho: Record<string, unknown> = {
    approvalPolicy: "on-request",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    reasoningEffort: "high",
  };
  threadStartParams: unknown = undefined;
  /** `thread/read`'s response (resume-history hydration); default has zero turns — an empty resumed thread. */
  threadReadResult: unknown = { thread: { id: "persisted-thread", turns: [] } };
  compactResponse: Promise<unknown> = Promise.resolve({});
  compactCalls = 0;
  startCompact(id = "compact-native"): void {
    this.currentTurnId = id;
    this.stream.push({ method: "turn/started", params: { threadId: THREAD, turn: { id, status: "inProgress" } } });
  }
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

  notify: (method: string, params?: unknown) => void = vi.fn();

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
    this.stream.push({ method: "turn/completed", params: { threadId: this.threadId, turn: { id: turnId, status } } });
  }

  private answer<T>(method: string, params?: unknown): Promise<T> {
    if (method === "account/read") {
      return Promise.resolve({
        account: this.account,
        ...(this.requiresOpenaiAuth !== undefined ? { requiresOpenaiAuth: this.requiresOpenaiAuth } : {}),
      } as T);
    }
    if (method === "account/rateLimits/read") {
      if (this.rateLimitsReadFails) return Promise.reject(new Error("app-server request failed: rate limits unavailable"));
      return Promise.resolve(this.rateLimitsResult as T);
    }
    if (method === "windowsSandbox/readiness") {
      if (this.windowsReadinessFails) return Promise.reject(new Error("app-server request failed: readiness unavailable"));
      return Promise.resolve(this.windowsReadinessResult as T);
    }
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
    if (method === "thread/compact/start") { this.compactCalls++; return this.compactResponse as Promise<T>; }
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


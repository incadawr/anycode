import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, SessionSubagentPort } from "@anycode/core";
import { NodeFileSystemAdapter, SqlitePersistenceAdapter } from "@anycode/core";
import type { HostToUiMessage } from "../../../shared/protocol.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import { CodexApprovalBridge } from "./approval-bridge.js";
import type { CodexPatchAutoApprovalPolicy } from "./patch-auto-approval.js";
import type { JsonRpcNotification, JsonRpcServerRequest } from "./protocol.js";
import { decodeWindowsSandboxReadiness } from "./protocol.js";
import { projectCodexHistory, NATIVE_PERSISTED, type ShadowCommandItem } from "./history-projection.js";
import type { CodexShadowLogPort } from "./shadow-log.js";
import {
  CODEX_NOT_SIGNED_IN,
  CodexEngine,
  WINDOWS_SANDBOX_NOT_CONFIGURED_MESSAGE,
  WINDOWS_SANDBOX_UPDATE_REQUIRED_MESSAGE,
  createNativeCodexSession,
  initializeAndVerifyAccount,
  resumeNativeCodexSession,
  startCodexEngine,
  resumeCodexEngine,
  windowsSandboxNotice,
  type CodexClient,
} from "./codex-engine.js";

import { CodexDynamicToolBridge, ANYCODE_AGENT_TOOL, ANYCODE_AGENT_STATUS_TOOL } from "./dynamic-tool-bridge.js";
import { createEngineBrowserBridge } from "../browser-bridge.js";

const childPath = fileURLToPath(new URL("./test-child.mjs", import.meta.url));
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
   * TASK.185 / Taskana 4139: `windowsSandbox/readiness` result. The default
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
  /** `thread/read`'s response (TASK.42 resume-history hydration); default has zero turns — an empty resumed thread. */
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
    // Codex-profiles cut §6.1: the quota pull runs AFTER the thread exists.
    expect(server.calls.map((call) => call.method)).toEqual([
      "initialize",
      "account/read",
      "model/list",
      "thread/start",
      "account/rateLimits/read",
    ]);
    // Params discipline (amendment §A3.7, schema-mandated, live-verified):
    // `account/read` REQUIRES `params: {}`; `account/rateLimits/read` is called
    // WITHOUT a params key at all. Never "unified".
    expect(server.calls.find((call) => call.method === "account/read")?.params).toEqual({});
    expect(server.calls.find((call) => call.method === "account/rateLimits/read")?.params).toBeUndefined();

    server.calls.length = 0;
    const resumed = await resumeNativeCodexSession(server, "/work", "persisted-thread");
    expect(resumed).toMatchObject({ threadId: "persisted-thread", model: "gpt-resumed" });
    expect(server.calls.map((call) => call.method)).toEqual([
      "initialize",
      "account/read",
      "model/list",
      "thread/resume",
      "thread/read",
      "account/rateLimits/read",
    ]);
    expect(server.calls.find((call) => call.method === "thread/resume")?.params).toEqual({ threadId: "persisted-thread", cwd: "/work" });
  });

  it("captures the native context notification during resume", async () => {
    const server = new FakeAppServer();
    const request = server.request.bind(server);
    server.request = <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }) => {
      if (method === "thread/read") {
        server.stream.push({ method: "thread/tokenUsage/updated", params: { threadId: "other", tokenUsage: { last: { totalTokens: 1 }, modelContextWindow: 2 } } });
        server.stream.push({ method: "thread/tokenUsage/updated", params: { threadId: "persisted-thread", tokenUsage: { last: { totalTokens: 13500 }, modelContextWindow: 353400 } } });
        server.stream.push({ method: "thread/tokenUsage/updated", params: { threadId: "persisted-thread", tokenUsage: { last: { totalTokens: -1 }, modelContextWindow: 0 } } });
      }
      return request<T>(method, params, opts);
    };
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread");
    expect(connected.initialContextUsage).toEqual({ estimatedTokens: 13500, budgetTokens: 353400, source: "provider" });
    await connected.engine.dispose("session-close");
  });

  it("accepts a GCP account returned by Codex 0.165", async () => {
    const server = new FakeAppServer();
    server.account = { type: "gcp" };
    await expect(createNativeCodexSession(server, "/work")).resolves.toMatchObject({ threadId: "fresh-thread" });
  });

  it("accepts a ChatGPT account with a workspace name", async () => {
    const server = new FakeAppServer();
    server.account = { type: "chatgpt", workspaceName: "Workspace" };
    await expect(createNativeCodexSession(server, "/work")).resolves.toMatchObject({ threadId: "fresh-thread" });
  });

  it("refuses a signed-out account before native thread creation", async () => {
    const server = new FakeAppServer();
    server.account = null;
    await expect(createNativeCodexSession(server, "/work")).rejects.toThrow(CODEX_NOT_SIGNED_IN);
    expect(server.calls.map((call) => call.method)).toEqual(["initialize", "account/read"]);
  });

  it("H4: a null account with requiresOpenaiAuth:false is a READY api-key/bedrock profile (doctor row 7), not signed-out", async () => {
    const server = new FakeAppServer();
    server.account = null;
    server.requiresOpenaiAuth = false;
    const created = await createNativeCodexSession(server, "/work");
    expect(created).toMatchObject({ threadId: "fresh-thread" });
  });

  it("H4: a null account WITHOUT requiresOpenaiAuth still refuses (row 8, fail-closed)", async () => {
    const server = new FakeAppServer();
    server.account = null;
    server.requiresOpenaiAuth = undefined;
    await expect(createNativeCodexSession(server, "/work")).rejects.toThrow(CODEX_NOT_SIGNED_IN);
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

describe("CodexEngine — Windows sandbox readiness probe (Taskana 4139 / TASK.185)", () => {
  it("windowsSandboxNotice stays silent on non-win32 platforms and on a ready sandbox", () => {
    expect(windowsSandboxNotice("darwin", "notConfigured")).toBeNull();
    expect(windowsSandboxNotice("linux", undefined)).toBeNull();
    expect(windowsSandboxNotice("win32", "ready")).toBeNull();
    // Old binary — the probe could not be answered; no false alarm.
    expect(windowsSandboxNotice("win32", undefined)).toBeNull();
  });

  it("windowsSandboxNotice warns on win32 with the exact notConfigured/updateRequired messages", () => {
    expect(windowsSandboxNotice("win32", "notConfigured")).toEqual({
      type: "engine_notice",
      level: "warning",
      message: WINDOWS_SANDBOX_NOT_CONFIGURED_MESSAGE,
    });
    expect(windowsSandboxNotice("win32", "updateRequired")).toEqual({
      type: "engine_notice",
      level: "warning",
      message: WINDOWS_SANDBOX_UPDATE_REQUIRED_MESSAGE,
    });
  });

  it("decodeWindowsSandboxReadiness decodes the three statuses and degrades to undefined on junk", () => {
    expect(decodeWindowsSandboxReadiness({ status: "ready" })).toBe("ready");
    expect(decodeWindowsSandboxReadiness({ status: "notConfigured" })).toBe("notConfigured");
    expect(decodeWindowsSandboxReadiness({ status: "updateRequired" })).toBe("updateRequired");
    expect(decodeWindowsSandboxReadiness({ status: "weird" })).toBeUndefined();
    expect(decodeWindowsSandboxReadiness({})).toBeUndefined();
    expect(decodeWindowsSandboxReadiness(null)).toBeUndefined();
    expect(decodeWindowsSandboxReadiness("string")).toBeUndefined();
  });

  it("initializeAndVerifyAccount probes readiness on win32 and RETURNS a non-ready status (never fails the boot)", async () => {
    const server = new FakeAppServer();
    server.windowsReadinessResult = { status: "notConfigured" };
    await expect(initializeAndVerifyAccount(server, 1000, false, "win32")).resolves.toBe("notConfigured");
    expect(server.calls.map((call) => call.method)).toEqual(["initialize", "account/read", "windowsSandbox/readiness"]);

    const update = new FakeAppServer();
    update.windowsReadinessResult = { status: "updateRequired" };
    await expect(initializeAndVerifyAccount(update, 1000, false, "win32")).resolves.toBe("updateRequired");

    const ready = new FakeAppServer();
    ready.windowsReadinessResult = { status: "ready" };
    await expect(initializeAndVerifyAccount(ready, 1000, false, "win32")).resolves.toBe("ready");
  });

  it("initializeAndVerifyAccount stays silent when the probe cannot be answered (old binary) and skips it entirely on darwin", async () => {
    const failing = new FakeAppServer();
    failing.windowsReadinessFails = true;
    await expect(initializeAndVerifyAccount(failing, 1000, false, "win32")).resolves.toBeUndefined();
    expect(failing.calls.map((call) => call.method)).toEqual(["initialize", "account/read", "windowsSandbox/readiness"]);

    const darwin = new FakeAppServer();
    darwin.windowsReadinessResult = { status: "notConfigured" };
    await expect(initializeAndVerifyAccount(darwin, 1000, false, "darwin")).resolves.toBeUndefined();
    expect(darwin.calls.map((call) => call.method)).toEqual(["initialize", "account/read"]);
    expect(darwin.calls.some((call) => call.method === "windowsSandbox/readiness")).toBe(false);
  });

  it("a win32 boot with a notConfigured sandbox still connects and surfaces the warning on the first turn", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const server = new FakeAppServer();
      server.windowsReadinessResult = { status: "notConfigured" };
      const { engine } = await createNativeCodexSession(server, "/work");
      expect(server.calls.map((call) => call.method)).toContain("windowsSandbox/readiness");
      const first = noticeEvents(await runTurn(server, engine));
      expect(first).toContainEqual({ type: "engine_notice", level: "warning", message: WINDOWS_SANDBOX_NOT_CONFIGURED_MESSAGE });
      expect(notices(await runTurn(server, engine, "second"))).not.toContain(WINDOWS_SANDBOX_NOT_CONFIGURED_MESSAGE);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("a default (darwin) boot sends NO readiness RPC — the exact 5-method create sequence is unchanged", async () => {
    const server = new FakeAppServer();
    server.windowsReadinessResult = { status: "notConfigured" };
    const created = await createNativeCodexSession(server, "/work");
    expect(created).toMatchObject({ threadId: "fresh-thread" });
    expect(server.calls.map((call) => call.method)).toEqual([
      "initialize",
      "account/read",
      "model/list",
      "thread/start",
      "account/rateLimits/read",
    ]);
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

  it("sends validated attachments as native image data URLs beside the text input", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const turn = (async () => {
      for await (const _event of engine.runTurn("describe it", {
        signal: new AbortController().signal,
        attachments: [
          { mediaType: "image/png", data: "UE5H" },
          { mediaType: "image/webp", data: "V0VCUA==" },
        ],
      })) {
        // Drain the turn exactly as Session does.
      }
    })();
    await tick();
    server.completeTurn("completed");
    await turn;

    expect(server.calls[0]).toEqual({
      method: "turn/start",
      params: {
        threadId: THREAD,
        input: [
          { type: "text", text: "describe it" },
          { type: "image", url: "data:image/png;base64,UE5H" },
          { type: "image", url: "data:image/webp;base64,V0VCUA==" },
        ],
      },
    });
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

  /**
   * Codex-profiles cut §6.4 red-proof: quota pushes (`account/rateLimits/
   * updated`, account-scoped — NO threadId on the wire) and `remoteControl/
   * status/changed` (amendment §A3.8 benign list) must be dropped BEFORE the
   * PRE_TURN_NOTIFICATION_LIMIT counter. Rolled back to a shape that buffers/
   * counts threadless notifications, 300 pushes exceed the 256 limit and this
   * turn terminates with "exceeded the pre-turn notification limit" — the
   * no-error assertions below go red.
   */
  it("never counts quota pushes or remoteControl chatter toward the pre-turn limit (cut §6.4)", async () => {
    const server = new FakeAppServer();
    server.turnStartMode = "deferred";
    const engine = new CodexEngine(server, THREAD);
    const turn = drive(engine, "hi", new AbortController().signal);
    // Phase A has no active turn yet (turn/start is deferred), so this waits
    // on the raw parked flag rather than waitForParkedIterator.
    const parked = async (): Promise<void> => {
      for (let i = 0; i < 500; i += 1) {
        if (server.stream.parked) return;
        await tick(1);
      }
      throw new Error("the phase-A consumer never re-parked");
    };
    await parked();

    // Every push waits until the phase-A consumer has actually PROCESSED it
    // (the iterator re-parked). Without this, pushes outpace the loop, queue
    // past phase A into phase B, and the >LIMIT count never traverses the
    // filter under test — the red-proof would be blunt.
    for (let i = 0; i < 300; i += 1) {
      server.stream.push({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: i % 100 } } } });
      await parked();
      server.stream.push({ method: "remoteControl/status/changed", params: { status: "disabled" } });
      await parked();
    }
    server.releaseTurnStart();
    await tick();
    server.completeTurn("completed");
    await turn.done;

    expect(turn.events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
    expect(turn.events.some((event) => event.type === "error")).toBe(false);
  });
});

describe("CodexEngine — capabilities (C-bug-1, cut §5.2)", () => {
  it("advertises provider-fed context usage but NOT a per-category breakdown", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    // The engine's translator genuinely reports provider usage from
    // thread/tokenUsage/updated — the false flag was the whole defect: data
    // flowed and the renderer gate killed it.
    expect(engine.capabilities.supportsContextUsage).toBe(true);
    // Codex has no per-category breakdown; advertising one would make the
    // popover render a skeleton it can never fill (cut §5.2.2 keeps it false).
    expect(engine.capabilities.supportsContextBreakdown).toBe(false);
    expect(engine.capabilities.costAccounting).toBe(false);
  });

  it("advertises image infrastructure but gates it by the selected native model", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      origin: "draft",
    });

    expect(engine.capabilities.supportsImages).toBe(true);
    expect(engine.imageInputEnabled()).toBe(true);
    expect(engine.selectModel("gpt-5.4-mini")).toMatchObject({ ok: true });
    expect(engine.imageInputEnabled()).toBe(false);

    const events: AgentEvent[] = [];
    for await (const event of engine.runTurn("look", {
      signal: new AbortController().signal,
      attachments: [{ mediaType: "image/png", data: "UE5H" }],
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(server.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
  });
});

describe("CodexEngine — subscription quota (TASK.51, cut §6)", () => {
  it("seeds the session quota from the boot pull and exposes it for EnginePresentation.quota", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    expect(engine.quotaSnapshot()).toMatchObject({
      primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_784_791_993 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "plus",
      observedAt: expect.any(String),
    });
  });

  it("boots WITHOUT quota when the pull fails — quota is additive, never boot-fatal", async () => {
    const server = new FakeAppServer();
    server.rateLimitsReadFails = true;
    const { engine } = await createNativeCodexSession(server, "/work");
    expect(engine.quotaSnapshot()).toBeNull();
  });

  it("resume pulls the quota too (cut §5.4: quotas are available immediately, the ctx meter is not)", async () => {
    const server = new FakeAppServer();
    const { engine } = await resumeNativeCodexSession(server, "/work", "persisted-thread");
    expect(engine.quotaSnapshot()).toMatchObject({ planType: "plus" });
  });

  it("a live sparse push during a turn emits engine_quota with the MERGED snapshot and advances quotaSnapshot()", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work");
    const engine = connected.engine;
    const turn = drive(engine, "hi", new AbortController().signal);
    await tick();

    // The push carries ONLY a fresher primary; planType/credits are omitted —
    // the sparse merge must keep them from the boot pull (cut §6.3). A
    // translator building the snapshot from the push alone loses them: red.
    server.stream.push({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 41, windowDurationMins: 10_080 } } } });
    await tick();
    // completeTurn() addresses the bare-test THREAD constant; this engine
    // booted the fake's "fresh-thread", so the terminal line is pushed directly.
    server.stream.push({ method: "turn/completed", params: { threadId: connected.threadId, turn: { id: server.turnId, status: "completed" } } });
    await turn.done;

    const quotaEvents = turn.events.filter((event) => event.type === "engine_quota");
    expect(quotaEvents).toHaveLength(1);
    expect(quotaEvents[0]).toMatchObject({
      type: "engine_quota",
      quota: {
        primary: { usedPercent: 41 },
        planType: "plus",
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
    });
    expect(engine.quotaSnapshot()).toMatchObject({ primary: { usedPercent: 41 }, planType: "plus" });
  });

  it("a quota push BETWEEN turns advances quotaSnapshot() — not frozen until the next in-turn push (R2-M1)", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    // Boot pull seeded primary=35%. NO turn is active, so the per-turn
    // TurnTranslator — today's only tracker writer — does not exist; and the
    // push is account-scoped (no threadId), so it never survives the per-turn
    // queue's this-thread filter either. It must STILL advance the session
    // tracker off the transport tap, or the ui_ready snapshot stays stale until
    // a push happens to land mid-turn (cut §6.1 "advanced by every live push").
    expect(engine.quotaSnapshot()).toMatchObject({ primary: { usedPercent: 35 }, planType: "plus" });

    server.stream.push({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 77, windowDurationMins: 10_080 } } } });
    await tick();

    // Sparse merge keeps planType from the boot pull; primary advanced to the push.
    expect(engine.quotaSnapshot()).toMatchObject({ primary: { usedPercent: 77 }, planType: "plus" });
  });

  it("quota pushes AFTER a turn completes still advance the tracker; the last of several wins (R2-M1)", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work");
    const engine = connected.engine;

    // Run one full turn so the engine returns to the between-turns state — and,
    // critically, so the Phase-B loop leaves a waiter armed on the notification
    // queue (codex-engine.ts re-arms `next` BEFORE delivering each event). That
    // orphaned waiter swallows the FIRST post-turn notification bytes-and-all.
    const turn = drive(engine, "hi", new AbortController().signal);
    await tick();
    server.stream.push({ method: "turn/completed", params: { threadId: connected.threadId, turn: { id: server.turnId, status: "completed" } } });
    await turn.done;

    // Two pushes arrive back-to-back with no turn active: the first is eaten by
    // the orphaned waiter, the second merely buffers unread — yet the tracker
    // must reflect the LAST, because the transport tap sees BOTH regardless of
    // the queue. On today's code it stays frozen on the boot value: RED.
    server.stream.push({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 60, windowDurationMins: 10_080 } } } });
    await tick();
    server.stream.push({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 88, windowDurationMins: 10_080 } } } });
    await tick();

    expect(engine.quotaSnapshot()).toMatchObject({ primary: { usedPercent: 88 }, planType: "plus" });
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

/** The RAW engine_notice events — level assertions need the whole event, not just the message. */
function noticeEvents(events: AgentEvent[]): Array<{ type: string; level: string; message: string }> {
  return events.filter((event) => event.type === "engine_notice") as Array<{ type: string; level: string; message: string }>;
}

describe("CodexEngine — boot version warning (owner decision 10.10)", () => {
  const BOOT_WARNING = "Codex 0.150.0 is newer than the verified range — not verified, running anyway.";

  it("emits the boot warning exactly once as a warning engine_notice on the first turn (create), never repeated", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, [{ type: "engine_notice", level: "warning", message: BOOT_WARNING }]);
    const first = noticeEvents(await runTurn(server, engine));
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({ type: "engine_notice", level: "warning", message: BOOT_WARNING });
    // A subsequent turn must not repeat the boot warning (drained once).
    expect(notices(await runTurn(server, engine, "second"))).toHaveLength(0);
  });

  it("emits the boot warning exactly once on resume too", async () => {
    const server = new FakeAppServer();
    const { engine } = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, undefined, undefined, undefined, [{ type: "engine_notice", level: "warning", message: BOOT_WARNING }]);
    const first = noticeEvents(await runTurn(server, engine));
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({ type: "engine_notice", level: "warning", message: BOOT_WARNING });
    expect(notices(await runTurn(server, engine, "second"))).toHaveLength(0);
  });

  it("emits no notice when no boot warning was supplied", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    expect(notices(await runTurn(server, engine))).toHaveLength(0);
  });
});

describe("TASK.39 — model catalog + initial values", () => {
  it("carries a validated draft model and the draft preset's policy into thread/start", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.4-mini",
      presetId: "approve-for-me",
      origin: "draft",
    });

    expect(server.threadStartParams).toEqual({
      cwd: "/work",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      model: "gpt-5.4-mini",
    });
    // DoD-2: the value shown/persisted is the one the SERVER confirmed, not the ask.
    expect(connected.model).toBe("gpt-5.4-mini");
    expect(connected.presetId).toBe("approve-for-me");
    expect(connected.engine.snapshot()).toEqual({ model: "gpt-5.4-mini", activePresetId: "approve-for-me", effort: "medium" });
  });

  it("defaults to the `ask` preset and the server's own model when no draft was made", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work");

    expect(server.threadStartParams).toEqual({ cwd: "/work", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" });
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
    expect(connected.engine.presets().map((preset) => preset.id)).toEqual(["ask", "approve-for-me", "full-access"]);

    const events = await runTurn(server, connected.engine);
    expect(notices(events)[0]).toContain("could not be verified");
    const [turnStart] = server.turnStartParams();
    expect(turnStart).not.toHaveProperty("model");
    // Even with no catalog, the posture is asserted.
    expect(turnStart).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "user" });
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
    expect(server.threadStartParams).toEqual({ cwd: "/work", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/work"] },
    });
    expect(JSON.stringify(server.calls)).not.toContain('"sandbox":"danger-full-access"');
  });

  // TASK.241 evidence chain: an explicit Sol pick present in the catalog rides
  // thread/start, the server-confirmed echo, AND the first turn/start — the
  // first actual turn is on the model the UI displayed and the wire sent.
  it("TASK.241: an explicit gpt-5.6-sol present in the catalog reaches thread/start, connected.model, and the FIRST turn/start", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      origin: "draft",
    });

    expect(server.threadStartParams).toMatchObject({ model: "gpt-5.6-sol" });
    // DoD-2: the value shown/persisted is the one the SERVER confirmed.
    expect(connected.model).toBe("gpt-5.6-sol");

    const events = await runTurn(server, connected.engine);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
    expect(notices(events)).toEqual([]);
    expect(server.turnStartParams()[0]).toMatchObject({ model: "gpt-5.6-sol" });
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
      presetId: "approve-for-me",
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
      approvalsReviewer: "auto_review",
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
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite" },
    });

    expect(engine.selectPreset("full-access")).toEqual({ ok: true, model: "gpt-native", activePresetId: "full-access" });
    // Not a single RPC is made by the change itself — it rides the next turn.
    expect(server.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);

    await runTurn(server, engine, "second");
    expect(server.turnStartParams()[1]).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
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

  it("attributes usage to the applied model until the next turn accepts a pending selection", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, { model: "gpt-5.6-sol", origin: "draft" });
    expect(engine.usageModel()).toBe("gpt-5.6-sol");
    expect(engine.selectModel("gpt-5.4-mini")).toMatchObject({ ok: true });
    expect(engine.usageModel()).toBe("gpt-5.6-sol");
    await runTurn(server, engine);
    expect(engine.usageModel()).toBe("gpt-5.4-mini");
  });

  it("re-resolves the effort for the switched-to model and restores the remembered value when switching back", async () => {
    const server = new FakeAppServer();
    // gpt-5.4-mini advertises ONLY "medium"; the thread's effective effort is "high".
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      origin: "draft",
    });
    expect(engine.selectEffort("high")).toMatchObject({ ok: true, effort: "high" });
    expect(engine.selectModel("gpt-5.4-mini")).toMatchObject({ ok: true, effort: "medium" });

    await runTurn(server, engine);
    expect(server.turnStartParams()[0]).toMatchObject({ model: "gpt-5.4-mini", effort: "medium" });

    expect(engine.selectModel("gpt-5.6-sol")).toMatchObject({ ok: true, effort: "high" });
    await runTurn(server, engine, "again");
    expect(server.turnStartParams()[1]).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("accepts only catalog-advertised Codex effort and carries it on the next turn", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      origin: "draft",
    });
    expect(engine.selectEffort("high")).toMatchObject({ ok: true, effort: "high" });
    expect(engine.selectEffort("ultra")).toEqual({
      ok: false,
      reason: 'Codex effort "ultra" is not available for model "gpt-5.6-sol".',
    });
    await runTurn(server, engine);
    expect(server.turnStartParams()[0]).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  // A model the built-in catalog has never heard of, advertising a level range
  // that includes `xhigh`: the selected level must reach the ACTUAL turn/start
  // parameters, on the first turn and on every later one (the override is
  // re-asserted per turn), never just the settings observable.
  it("sends selected xhigh on the first and subsequent turns", async () => {
    const server = new FakeAppServer();
    server.modelPages[""]!.data = [
      {
        id: "gpt-6.1-terra",
        displayName: "GPT-6.1 Terra",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
        ],
      },
    ];
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-6.1-terra",
      origin: "draft",
    });
    expect(engine.selectEffort("xhigh")).toMatchObject({ ok: true, effort: "xhigh" });

    await runTurn(server, engine);
    await runTurn(server, engine, "again");

    const starts = server.turnStartParams();
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ model: "gpt-6.1-terra", effort: "xhigh" });
    expect(starts[1]).toMatchObject({ model: "gpt-6.1-terra", effort: "xhigh" });
  });

  it("rejects an unsupported effort without issuing a turn", async () => {
    const server = new FakeAppServer();
    server.modelPages[""]!.data = [
      {
        id: "gpt-6.1-terra",
        displayName: "GPT-6.1 Terra",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "xhigh" }],
      },
    ];
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-6.1-terra",
      origin: "draft",
    });
    const applied = engine.snapshot();
    const callsBefore = server.calls.length;

    expect(engine.selectEffort("turbo")).toEqual({
      ok: false,
      reason: 'Codex effort "turbo" is not available for model "gpt-6.1-terra".',
    });
    // Nothing was recorded, nothing became pending, and no wire call was made.
    expect(engine.snapshot()).toEqual(applied);
    expect(engine.pendingSnapshot()).toBeNull();
    expect(server.calls).toHaveLength(callsBefore);
    expect(server.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
  });

  // Profile `effort:` frontmatter rides the selection (draft `--engine-effort`):
  // the requested tier wins when the model supports it, and the actual
  // turn/start transport request carries the resolved tier — not just the
  // settings observable. An unsupported tier degrades to the resolved default
  // with a warning.
  it("a requested selection effort that the model supports reaches the actual turn/start request", async () => {
    const server = new FakeAppServer();
    // gpt-5.6-sol advertises low/medium/high; request "high".
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.6-sol",
      effort: "high",
      origin: "draft",
    });
    expect(connected.engine.snapshot().effort).toBe("high");
    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({ effort: "high" });
  });

  it("a requested selection effort unsupported by the model warns and uses the resolved default", async () => {
    const server = new FakeAppServer();
    // gpt-5.4-mini advertises ONLY "medium"; request "high".
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      model: "gpt-5.4-mini",
      effort: "high",
      origin: "draft",
    });
    expect(connected.engine.snapshot().effort).toBe("medium");
    const events = await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({ model: "gpt-5.4-mini", effort: "medium" });
    // The boot warning is flushed into the first turn's event stream.
    expect(notices(events)).toContainEqual(
      expect.stringContaining('Requested effort "high" is unavailable'),
    );
  });

  it("acks a change only once a turn/start has actually carried it", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    const applied: { model: string; activePresetId: string }[] = [];
    engine.onSettingsApplied((snapshot) => applied.push(snapshot));

    expect(engine.selectPreset("approve-for-me")).toMatchObject({ ok: true });
    // Phase 1: nothing is applied yet — the server has not been told anything.
    expect(applied).toEqual([]);

    await runTurn(server, engine);
    expect(applied).toEqual([{ model: "gpt-native", activePresetId: "approve-for-me" }]);

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
    engine.selectPreset("full-access");

    server.turnStartMode = "never";
    const turn = drive(engine, "hi", new AbortController().signal);
    await turn.done; // bounded by the turn/start timeout

    expect(applied).toEqual([]);
    // Still pending: the next successful turn/start will carry it and ack then.
    // `snapshot()` is the APPLIED posture (W3-review): a change no turn/start
    // ever carried is NOT active, however much the user asked for it — that is
    // the whole meaning of the two-phase ack. It is reported as pending instead.
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "ask" });
    expect(engine.pendingSnapshot()).toEqual({ model: "gpt-native", activePresetId: "full-access" });
  });

  // W3-review: display truth vs enforcement. Enforcement is NOT in question —
  // every turn/start re-asserts the chosen preset (asserted above) — but until
  // one has, the UI must not present the choice as active.
  it("keeps a chosen-but-unapplied change OUT of snapshot() while still enforcing it on the next turn", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, { presetId: "approve-for-me", origin: "draft" });
    const engine = connected.engine;

    expect(engine.selectPreset("full-access")).toMatchObject({ ok: true, activePresetId: "full-access" });
    // Displayed: still the old posture. Pending: the new one.
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "approve-for-me" });
    expect(engine.pendingSnapshot()).toEqual({ model: "gpt-native", activePresetId: "full-access" });

    await runTurn(server, engine);

    // The turn CARRIED the new posture (enforcement, untouched) and only now is
    // it applied — and therefore only now displayed as active.
    expect(server.turnStartParams()[0]).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" } });
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "full-access" });
    expect(engine.pendingSnapshot()).toBeNull();
  });

  it("treats picking back to the applied value as nothing pending", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, { presetId: "ask", origin: "draft" });
    const engine = connected.engine;

    engine.selectPreset("full-access");
    expect(engine.pendingSnapshot()).not.toBeNull();

    engine.selectPreset("ask");
    expect(engine.pendingSnapshot()).toBeNull();
    expect(engine.snapshot()).toEqual({ model: "gpt-native", activePresetId: "ask" });
  });
});

describe("Taskana 4078 — child boots untrusted (TASK.179)", () => {
  it("carries the child-ask preset's untrusted posture on thread/start", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "child-ask",
      origin: "draft",
    });

    expect(server.threadStartParams).toEqual({
      cwd: "/work",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    expect(connected.presetId).toBe("child-ask");
  });

  it("re-asserts the untrusted posture on every turn (self-healing against the L8 echo)", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "child-ask",
      origin: "draft",
    });

    await runTurn(server, connected.engine);
    await runTurn(server, connected.engine, "again");

    const expected = {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
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
    expect(starts[1]).toMatchObject(expected);
  });

  it("still degrades an unknown preset id to the DEFAULT ask posture, with exactly one notice", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "child-ask-v2-typo",
      origin: "draft",
    });

    expect(server.threadStartParams).toEqual({
      cwd: "/work",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });

    const events = await runTurn(server, connected.engine);
    expect(notices(events).filter((message) => message.includes("unknown"))).toHaveLength(1);
  });

  it("selectPreset round-trips the child id in-session (strictly narrower than ask)", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");

    expect(engine.selectPreset("child-ask")).toEqual({ ok: true, model: "gpt-native", activePresetId: "child-ask" });
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

    expect(connected.engine.snapshot()).toEqual({ model: "gpt-resumed", activePresetId: "read-only", effort: "high" });
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
    expect(server.turnStartParams()[0]).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "user" });
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

describe("Taskana 4682 — excludeTmpRoots rides selection into every turn/start", () => {
  it("carries BOTH tmp flags true on every turn/start, and threads nothing at boot", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "ask",
      origin: "draft",
      excludeTmpRoots: true,
    });

    // The coarse thread/start string carries no flags — boot stays byte-identical.
    expect(server.threadStartParams).toEqual({
      cwd: "/work",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });

    await runTurn(server, connected.engine);
    await runTurn(server, connected.engine, "again");

    const expected = {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/work"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    };
    const starts = server.turnStartParams();
    expect(starts).toHaveLength(2);
    // Self-healing per turn: the second turn re-asserts the identical policy.
    expect(starts[0]).toMatchObject(expected);
    expect(starts[1]).toMatchObject(expected);
  });

  it("without the flag the tmp roots stay writable (explicit false on the wire)", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "ask",
      origin: "draft",
    });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/work"],
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it("survives resume: the flag rides the selection into the resumed thread's turns", async () => {
    const server = new FakeAppServer();
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, {
      presetId: "ask",
      origin: "persisted",
      excludeTmpRoots: true,
    });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/work"],
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
  });

  it("is moot under full-access: dangerFullAccess is sent verbatim, no smuggled flags", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "full-access",
      origin: "draft",
      excludeTmpRoots: true,
    });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" } });
    expect(JSON.stringify(server.turnStartParams()[0])).not.toContain("excludeSlashTmp");
  });
});

describe("Taskana 4682 rework — childTempDir rides the selection into writableRoots", () => {
  it("the private dir is appended to writableRoots on EVERY turn/start, alongside the exclusion", async () => {
    const server = new FakeAppServer();
    const privateDir = "/Users/me/.anycode/tmp/018f-child";
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "ask",
      origin: "draft",
      excludeTmpRoots: true,
      childTempDir: privateDir,
    });

    // Boot stays byte-identical: the coarse thread/start string carries none
    // of this (the thread's sandbox mode is re-asserted per turn below).
    expect(server.threadStartParams).toEqual({
      cwd: "/work",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });

    await runTurn(server, connected.engine);
    await runTurn(server, connected.engine, "again");

    const expected = {
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/work", privateDir],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    };
    const starts = server.turnStartParams();
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject(expected);
    expect(starts[1]).toMatchObject(expected);
  });

  it("survives resume: the dir rides the selection into the resumed thread's turns", async () => {
    const server = new FakeAppServer();
    const privateDir = "/Users/me/.anycode/tmp/018f-resumed";
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, {
      presetId: "ask",
      origin: "persisted",
      excludeTmpRoots: true,
      childTempDir: privateDir,
    });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/work", privateDir],
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
  });

  it("without childTempDir the policy is byte-identical to a54b2f6d's exclusion-only form (owner tabs)", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "ask",
      origin: "draft",
      excludeTmpRoots: true,
    });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/work"],
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    expect(JSON.stringify(server.turnStartParams()[0])).not.toContain(".anycode/tmp");
  });

  it("is moot under full-access: no writableRoots to decorate", async () => {
    const server = new FakeAppServer();
    const connected = await createNativeCodexSession(server, "/work", undefined, undefined, {
      presetId: "full-access",
      origin: "draft",
      excludeTmpRoots: true,
      childTempDir: "/Users/me/.anycode/tmp/018f-full",
    });

    await runTurn(server, connected.engine);
    expect(server.turnStartParams()[0]).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" } });
    expect(JSON.stringify(server.turnStartParams()[0])).not.toContain("writableRoots");
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

// ─────────────────────────────────────────────────────────────────────────────
// TASK.143 — readTranscript(): the live, on-demand counterpart to the frozen
// historyItems() boot snapshot. This is the whole point of the fix: a child
// session's flush must see turns that ran AFTER boot, which historyItems()
// (built once, at construction) can never reflect.
// ─────────────────────────────────────────────────────────────────────────────

describe("CodexEngine — readTranscript() live flush-time re-read (TASK.143)", () => {
  it("reflects a turn that landed AFTER boot — unlike historyItems(), which stays frozen at the boot snapshot", async () => {
    const server = new FakeAppServer();
    // Boot: a fresh thread has nothing to hydrate (createNativeCodexSession
    // never even calls thread/read — see codex-engine.ts's fresh-thread path).
    const created = await createNativeCodexSession(server, "/work");
    expect(created.engine.historyItems()).toEqual([]);

    // Simulate what the real app-server would now report after a live turn
    // ran on this launch: thread/read's SAME endpoint, a DIFFERENT answer.
    server.threadReadResult = {
      thread: {
        id: "fresh-thread",
        turns: [
          {
            id: "turn-a",
            startedAt: 200,
            items: [
              { type: "userMessage", id: "u1", content: [{ type: "text", text: "post-boot question" }] },
              { type: "agentMessage", id: "a1", text: "post-boot answer" },
            ],
          },
        ],
      },
    };

    const live = await created.engine.readTranscript();
    // historyItems() is UNCHANGED — the frozen boot snapshot never moves.
    expect(created.engine.historyItems()).toEqual([]);
    const items = live.filter((item) => item.kind !== "compact_summary");
    expect(items).toEqual([
      { id: "turn-a:u1", createdAt: 200000, message: { role: "user", content: "post-boot question" } },
      { id: "turn-a:a1", createdAt: 200001, message: { role: "assistant", content: [{ type: "text", text: "post-boot answer" }] } },
    ]);
  });

  it("merges the shadow log's CURRENT rows too, not just whatever was there at boot", async () => {
    const server = new FakeAppServer();
    server.threadReadResult = { thread: { id: "persisted-thread", turns: [{ id: "turn-a", startedAt: 0, items: [] }] } };
    const shadowLog = new RecordingShadowLog();
    // Boot sees zero shadow rows.
    const connected = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, shadowLog);
    expect(connected.engine.historyItems().some((item) => item.message.content !== undefined && JSON.stringify(item).includes("echo shadow"))).toBe(false);

    // A command completes live during the launch; the shadow log now has a row.
    shadowLog.listResult = [{ turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo shadow", exitCode: 0, outputHead: "shadow\n" }];

    const items = await connected.engine.readTranscript();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ message: { content: [{ type: "tool_call", toolName: "Bash", input: { command: "echo shadow" } }] } });
    expect(items[1]).toMatchObject({ message: { role: "tool", content: [{ status: "success", text: "shadow\n" }] } });
  });

  it("fails loudly (rejects) instead of silently returning an empty transcript when the engine is already disposed", async () => {
    const server = new FakeAppServer();
    const created = await createNativeCodexSession(server, "/work");
    await created.engine.dispose("session-close");
    await expect(created.engine.readTranscript()).rejects.toThrow(/disposed/i);
    // The dispose-guard fires BEFORE any RPC — thread/read must never even be attempted on a dead transport.
    expect(server.calls.some((call) => call.method === "thread/read")).toBe(false);
  });

  it("fails loudly (rejects, does not swallow) when the live thread/read RPC itself fails", async () => {
    const server = new FakeAppServer();
    const created = await createNativeCodexSession(server, "/work");
    const realRequest = server.request.bind(server);
    server.request = (<T,>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> => {
      if (method === "thread/read") return Promise.reject(new Error("app-server request failed: transport closed"));
      return realRequest<T>(method, params, opts);
    }) as typeof server.request;

    await expect(created.engine.readTranscript()).rejects.toThrow(/transport closed/);
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

  it("an image turn advances the native ordinal only after its native turn starts (LOW1)", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, shadowLog, 0);

    const turn = (async () => {
      for await (const _event of engine.runTurn("look at this", {
        signal: new AbortController().signal,
        attachments: [{ mediaType: "image/png", data: "AA==" }],
      })) {
        // Drain the first, native image turn.
      }
    })();
    await tick();
    server.stream.push({ method: "item/started", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi" } } });
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "exec-1", command: "echo hi", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed");
    await turn;

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

  it("persists captured native request usage without inventing a Codex price", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "codex", workspace: "/work", model: "m", mode: "build" });
    const writer = new CodexEngine(new ReplayClient(loadFixtureNotifications("w0-command-accept.jsonl"), LIVE_TURN_ID), LIVE_THREAD_ID);
    const pending: Promise<void>[] = [];
    let step = 0;
    writer.onUsage((usage) => pending.push(db.recordProviderUsage({ ...usage, sessionId: "codex", turnId: "turn", step: ++step, createdAt: step, finishReason: "unknown", transportRetries: 0 })));
    for await (const _event of writer.runTurn("test", { signal: new AbortController().signal })) { /* drain the captured turn */ }
    await Promise.all(pending);
    const records = await db.listProviderUsage("codex");
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toMatchObject({ inputTokens: expect.any(Number), cachedInputTokens: expect.any(Number), outputTokens: expect.any(Number) });
    expect(records.every((row) => row.costUsd === undefined)).toBe(true);
    await db.close();
  });

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

describe("CodexEngine — AnyCode dynamic tool integration", () => {
  const catalog = [{ name: "glm-lead", model: "glm-5.3", description: "Plan and review", systemPrompt: "" }];
  const completed = { status: "completed" as const, finalText: "done", turns: 1, toolCalls: 0, truncated: false, durationMs: 1,
    childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "call-1" };

  it("advertises experimental tools at creation AND resume, retains the native resume ref", async () => {
    const bridge = new CodexDynamicToolBridge(catalog, { run: vi.fn().mockResolvedValue(completed), send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) });
    const server = new FakeAppServer();
    await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, bridge);
    expect(server.calls.find((c) => c.method === "initialize")?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(server.threadStartParams).toMatchObject({ dynamicTools: [expect.objectContaining({ name: ANYCODE_AGENT_TOOL }), expect.objectContaining({ name: ANYCODE_AGENT_STATUS_TOOL })] });
    server.calls.length = 0;
    await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, undefined, bridge);
    // 4764 review F17: the resume carries the same declarations thread/start
    // did — the fresh app-server has no memory of the previous launch's tools.
    expect(server.calls.find((c) => c.method === "thread/resume")?.params).toMatchObject({
      threadId: "persisted-thread",
      cwd: "/work",
      dynamicTools: [expect.objectContaining({ name: ANYCODE_AGENT_TOOL }), expect.objectContaining({ name: ANYCODE_AGENT_STATUS_TOOL })],
    });
  });

  it("streams child events during a parked native turn and isolates trailing events on reuse", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const first = drive(engine, "first", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    const firstOwner = engine.activeTurnDetails;
    engine.pushBridgeEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Agent", input: {} }, firstOwner);
    await tick();
    expect(first.events).toContainEqual(expect.objectContaining({ type: "tool_execution_start", toolCallId: "call-1" }));
    server.completeTurn("completed");
    await first.done;
    const second = drive(engine, "second", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    engine.pushBridgeEvent({ type: "tool_result", outcome: { toolCallId: "call-1", toolName: "Agent", status: "success", modelText: "late", durationMs: 1, result: { ok: true } } }, firstOwner);
    server.completeTurn("completed");
    await second.done;
    expect(second.events.some((e) => e.type === "tool_result")).toBe(false);
  });

  it("Stop cancels a pending dynamic call, closes its card and still permits a new turn", async () => {
    const server = new FakeAppServer();
    const run = vi.fn<SessionSubagentPort["run"]>();
    let childSignal: AbortSignal | undefined;
    let finish!: (value: typeof completed) => void;
    run.mockImplementation((_request, options) => {
      childSignal = options?.signal;
      return new Promise((resolve) => { finish = resolve; });
    });
    const bridge = new CodexDynamicToolBridge(catalog, { run, send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) });
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, undefined, 0, [], undefined, bridge);
    const controller = new AbortController();
    const turn = drive(engine, "delegate", controller.signal);
    await waitForParkedIterator(server, engine);
    const owner = engine.activeTurnDetails;
    const response = { result: vi.fn(), error: vi.fn() };
    const handled = bridge.handle({ id: 1, method: "item/tool/call", params: {
      threadId: THREAD, turnId: server.turnId, callId: "call-1", tool: ANYCODE_AGENT_TOOL,
      arguments: { agent_type: "glm-lead", description: "small task", prompt: "do it" },
    } }, response, owner, (event) => engine.pushBridgeEvent(event, owner));
    controller.abort();
    await handled;
    await turn.done;
    expect(childSignal?.aborted).toBe(true);
    expect(response.result).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(turn.events).toContainEqual(expect.objectContaining({ type: "tool_result", outcome: expect.objectContaining({ status: "cancelled" }) }));
    finish(completed);
    const next = drive(engine, "continue", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    server.completeTurn("completed");
    await next.done;
    expect(next.events.some((e) => e.type === "tool_result")).toBe(false);
  });

  // TASK.226 release blocker (GUI evidence 226-cancel-failure.json): Stop
  // cancels the native turn AND the bridged child, but the child's REAL
  // terminal outcome (cancelled status + child-session target + subagent card
  // metadata) settles asynchronously — the abort rejection wins the bridge's
  // Promise.race, so the immediate cancelled tool_result carries NO
  // presentation, and the real outcome only arrives AFTER the interrupt's
  // `turn/completed` (the session-tier port never resolves on abort; only
  // main's eventual terminal does). The pre-fix engine emitted turn_end/
  // loop_end the moment the native turn/completed arrived and tore the owner
  // down, so the real outcome was dropped by pushBridgeEvent's strict owner
  // guard — the live parent card stayed "running"/final null until reload,
  // while the durable AgentCardLog persisted the cancelled snapshot with its
  // child-session target. Deterministic mock order: native turn/completed at
  // ~0ms (the fake settles the interrupted turn on interrupt accept), child
  // outcome at +30ms — strictly after the native terminal.
  it("Stop settles a child that settles asynchronously BEFORE loop_end — card closes cancelled with its child target", async () => {
    const server = new FakeAppServer();
    const run = vi.fn<SessionSubagentPort["run"]>();
    run.mockImplementation((request, options) => {
      options?.onProgress?.({ kind: "start", agentType: request.agentType, description: request.description, model: request.model });
      options?.onProgress?.({ kind: "progress", turns: 0, toolCalls: 0 });
      return new Promise((resolve) => {
        const onAbort = () => {
          // Deterministic late settlement: 30ms AFTER the abort — by then the
          // fake's own turn/completed (setTimeout 0, fired at interrupt
          // accept) has already been delivered, so the pre-fix engine has
          // already emitted loop_end and cleared the turn owner.
          setTimeout(() => {
            resolve({ status: "cancelled", finalText: "child unwound", truncated: false, turns: 1, toolCalls: 0, durationMs: 100,
              childSessionId: "child-226", parentSessionId: "parent-226", spawnToolCallId: "call-226" });
          }, 30);
        };
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const log = { record: vi.fn(), list: vi.fn(async () => new Map()), flush: vi.fn(async () => {}) };
    const bridge = new CodexDynamicToolBridge(catalog, { run, send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) }, log);
    const engine = new CodexEngine(server, THREAD, undefined, { postInterruptSettleMs: 500, bridgeSettleMs: 500 }, undefined, undefined, 0, [], undefined, bridge, log);
    const controller = new AbortController();
    const turn = drive(engine, "delegate", controller.signal);
    await waitForParkedIterator(server, engine);
    const owner = engine.activeTurnDetails;
    const response = { result: vi.fn(), error: vi.fn() };
    const handled = bridge.handle({ id: 1, method: "item/tool/call", params: {
      threadId: THREAD, turnId: server.turnId, callId: "call-226", tool: ANYCODE_AGENT_TOOL,
      arguments: { agent_type: "glm-lead", description: "226 task", prompt: "do it" },
    } }, response, owner, (event) => engine.pushBridgeEvent(event, owner));
    // Give the synchronous prefix (tool_call/tool_execution_start/subagent_start)
    // time to queue before Stop lands.
    await tick();
    controller.abort();
    await handled;
    await turn.done;

    expect(turn.events.at(-1)).toMatchObject({ type: "loop_end", reason: "cancelled", turns: 1 });
    const loopEndAt = turn.events.findIndex((event) => event.type === "loop_end");
    // THE ORDERING ASSERTION: the child's REAL cancelled outcome — the
    // tool_result carrying the subagent presentation with the child-session
    // target — is delivered BEFORE loop_end. Pre-fix it never arrived in the
    // turn at all (dropped after owner teardown), leaving the live card
    // running with final null while the durable log had the snapshot.
    const resultsBeforeEnd = turn.events.slice(0, loopEndAt).filter((event) => event.type === "tool_result");
    expect(resultsBeforeEnd.length).toBeGreaterThanOrEqual(1);
    const terminal = resultsBeforeEnd.at(-1);
    expect(terminal).toMatchObject({
      type: "tool_result",
      outcome: expect.objectContaining({
        toolCallId: "call-226",
        status: "cancelled",
        result: { ok: false, error: expect.any(String),
          presentation: { subagent: expect.objectContaining({
            final: expect.objectContaining({ status: "cancelled" }),
            target: { kind: "session", childSessionId: "child-226", parentSessionId: "parent-226", spawnToolCallId: "call-226" },
          }) } },
      }),
    });
    // Nothing terminal leaks AFTER loop_end — the card closes inside the turn.
    expect(turn.events.slice(loopEndAt).some((event) => event.type === "tool_result")).toBe(false);
    // The Stop stayed immediate: exactly one interrupt, no orphan children
    // (the child controller aborted), the server settled the native turn.
    expect(server.interrupts).toBe(1);
    expect(server.closeCount).toBe(0);
    expect(turn.events.some((event) => event.type === "error")).toBe(false);
    // The durable card log persisted the cancelled snapshot with its target.
    expect(log.record).toHaveBeenCalledWith("call-226", expect.objectContaining({ subagent: expect.objectContaining({
      final: expect.objectContaining({ status: "cancelled" }),
      target: { kind: "session", childSessionId: "child-226", parentSessionId: "parent-226", spawnToolCallId: "call-226" },
    }) }));
    // And a LATER turn is insulated from any late bridge chatter (strict
    // old-owner guard preserved).
    const next = drive(engine, "continue", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    server.completeTurn("completed");
    await next.done;
    expect(next.events.some((e) => e.type === "tool_result")).toBe(false);
  });

  // TASK.226 review defect 2: the transport-close-under-Stop path yielded
  // translator.finishTerminal BEFORE the finally drained, so the child's late
  // terminal card event still landed AFTER loop_end. Same deterministic mock
  // order as the main regression (native side closes, child settles at
  // +30ms); the turn must end cancelled with the real card event BEFORE
  // loop_end and nothing after it.
  it("transport close under Stop still delivers the child's cancelled card before loop_end", async () => {
    const server = new FakeAppServer();
    const run = vi.fn<SessionSubagentPort["run"]>();
    run.mockImplementation((request, options) => {
      options?.onProgress?.({ kind: "start", agentType: request.agentType, description: request.description, model: request.model });
      return new Promise((resolve) => {
        const onAbort = () => {
          setTimeout(() => {
            resolve({ status: "cancelled", finalText: "child unwound", truncated: false, turns: 1, toolCalls: 0, durationMs: 100,
              childSessionId: "child-close", parentSessionId: "parent-close", spawnToolCallId: "call-close" });
          }, 30);
        };
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const bridge = new CodexDynamicToolBridge(catalog, { run, send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) });
    const engine = new CodexEngine(server, THREAD, undefined, { postInterruptSettleMs: 500, bridgeSettleMs: 500 }, undefined, undefined, 0, [], undefined, bridge);
    const controller = new AbortController();
    const turn = drive(engine, "delegate", controller.signal);
    await waitForParkedIterator(server, engine);
    const owner = engine.activeTurnDetails;
    void bridge.handle({ id: 1, method: "item/tool/call", params: {
      threadId: THREAD, turnId: server.turnId, callId: "call-close", tool: ANYCODE_AGENT_TOOL,
      arguments: { agent_type: "glm-lead", description: "close task", prompt: "do it" },
    } }, { result: vi.fn(), error: vi.fn() }, owner, (event) => engine.pushBridgeEvent(event, owner));
    await tick();
    controller.abort();
    // The native transport dies while the Stop is pending — before the server
    // ever settles the interrupted turn and before the child settles.
    server.stream.close();
    await turn.done;

    expect(turn.events.at(-1)).toMatchObject({ type: "loop_end", reason: "cancelled", turns: 1 });
    const loopEndAt = turn.events.findIndex((event) => event.type === "loop_end");
    const before = turn.events.slice(0, loopEndAt).filter((event) => event.type === "tool_result");
    // The immediate acknowledgement AND the real cancelled outcome (with the
    // child target) are both inside the turn, before loop_end.
    const terminal = before.at(-1);
    expect(terminal).toBeDefined();
    const outcome = (terminal as { outcome: { status: string; result?: { presentation?: { subagent?: { final?: { status?: string }; target?: unknown } } } } }).outcome;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.result?.presentation?.subagent?.final?.status).toBe("cancelled");
    expect(outcome.result?.presentation?.subagent?.target).toEqual({ kind: "session", childSessionId: "child-close", parentSessionId: "parent-close", spawnToolCallId: "call-close" });
    // No bridge card event lands after loop_end on the transport-close path.
    expect(turn.events.slice(loopEndAt).some((event) => event.type === "tool_result")).toBe(false);
  });

  // TASK.226 review defect 3: the error catch likewise yielded its terminal
  // pair before the finally drained. A turn that errors under Stop (here: the
  // post-interrupt settle deadline fires because the server never settles)
  // must still drain the child's cancelled outcome BEFORE its terminal pair,
  // with nothing after loop_end.
  it("the error path still drains the child's cancelled card before its terminal pair", async () => {
    const server = new FakeAppServer();
    server.interruptSettles = "silent";
    const run = vi.fn<SessionSubagentPort["run"]>();
    run.mockImplementation((request, options) => {
      options?.onProgress?.({ kind: "start", agentType: request.agentType, description: request.description, model: request.model });
      return new Promise((resolve) => {
        const onAbort = () => {
          setTimeout(() => {
            resolve({ status: "cancelled", finalText: "child unwound", truncated: false, turns: 1, toolCalls: 0, durationMs: 100,
              childSessionId: "child-err", parentSessionId: "parent-err", spawnToolCallId: "call-err" });
          }, 10);
        };
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const bridge = new CodexDynamicToolBridge(catalog, { run, send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) });
    const engine = new CodexEngine(server, THREAD, undefined, { postInterruptSettleMs: 300, bridgeSettleMs: 300 }, undefined, undefined, 0, [], undefined, bridge);
    const controller = new AbortController();
    const turn = drive(engine, "delegate", controller.signal);
    await waitForParkedIterator(server, engine);
    const owner = engine.activeTurnDetails;
    void bridge.handle({ id: 1, method: "item/tool/call", params: {
      threadId: THREAD, turnId: server.turnId, callId: "call-err", tool: ANYCODE_AGENT_TOOL,
      arguments: { agent_type: "glm-lead", description: "err task", prompt: "do it" },
    } }, { result: vi.fn(), error: vi.fn() }, owner, (event) => engine.pushBridgeEvent(event, owner));
    await tick();
    controller.abort();
    // The server never settles the interrupted turn: the settle deadline
    // fires and the turn ends as an error — AFTER the bounded child drain.
    await turn.done;

    expect(turn.events.at(-1)).toMatchObject({ type: "loop_end", reason: "error", turns: 1 });
    const loopEndAt = turn.events.findIndex((event) => event.type === "loop_end");
    const before = turn.events.slice(0, loopEndAt).filter((event) => event.type === "tool_result");
    const terminal = before.at(-1);
    expect(terminal).toBeDefined();
    const outcome = (terminal as { outcome: { status: string; result?: { presentation?: { subagent?: { final?: { status?: string }; target?: unknown } } } } }).outcome;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.result?.presentation?.subagent?.final?.status).toBe("cancelled");
    expect(outcome.result?.presentation?.subagent?.target).toEqual({ kind: "session", childSessionId: "child-err", parentSessionId: "parent-err", spawnToolCallId: "call-err" });
    // No bridge card event lands after loop_end on the error path.
    expect(turn.events.slice(loopEndAt).some((event) => event.type === "tool_result")).toBe(false);
    // The wedged server still released the child (bounded backstop intact).
    expect(server.closeCount).toBe(1);
  });

  // The bounded half of the same fix: the native turn settles but the child
  // IGNORES cancellation — the pre-terminal join must give up within its
  // bridgeSettleMs grace and still end the turn cancelled. Bounded teardown,
  // no hang, no orphan.
  it("a child that ignores cancellation never wedges the turn — the bounded settle still ends it cancelled", async () => {
    const server = new FakeAppServer();
    const run = vi.fn<SessionSubagentPort["run"]>().mockImplementation(() => new Promise(() => {}));
    const bridge = new CodexDynamicToolBridge(catalog, { run, send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) });
    const engine = new CodexEngine(server, THREAD, undefined, { postInterruptSettleMs: 500, bridgeSettleMs: 25 }, undefined, undefined, 0, [], undefined, bridge);
    const controller = new AbortController();
    const turn = drive(engine, "delegate", controller.signal);
    await waitForParkedIterator(server, engine);
    const owner = engine.activeTurnDetails;
    void bridge.handle({ id: 1, method: "item/tool/call", params: {
      threadId: THREAD, turnId: server.turnId, callId: "call-wedge", tool: ANYCODE_AGENT_TOOL,
      arguments: { agent_type: "glm-lead", description: "wedge task", prompt: "do it" },
    } }, { result: vi.fn(), error: vi.fn() }, owner, (event) => engine.pushBridgeEvent(event, owner));
    await tick();
    controller.abort();
    await turn.done;
    expect(turn.events.at(-1)).toMatchObject({ type: "loop_end", reason: "cancelled", turns: 1 });
    // The immediate abort acknowledgment still closed the call inside the turn.
    expect(turn.events.some((event) => event.type === "tool_result")).toBe(true);
    expect(turn.events.some((event) => event.type === "error")).toBe(false);
    expect(server.interrupts).toBe(1);
    expect(server.closeCount).toBe(0);
  });
});

describe("Codex dynamic Agent metadata at graceful shutdown", () => {
  it("rejects a queued Agent request after disposal begins even while the previous turn still owns an identity", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const turn = drive(engine, "work", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    const before = engine.activeTurnDetails;
    expect(before).not.toBeNull();
    const disposal = engine.dispose("host-shutdown");
    expect(engine.activeTurnDetails).toBeNull();
    const run = vi.fn<SessionSubagentPort["run"]>();
    const bridge = new CodexDynamicToolBridge([{ name: "glm-lead", model: "glm-5.3", description: "Review", systemPrompt: "" }], { run, send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) });
    const response = { result: vi.fn(), error: vi.fn() };
    await bridge.handle({ id: 1, method: "item/tool/call", params: {
      threadId: THREAD, turnId: before!.turnId, callId: "late-call", tool: ANYCODE_AGENT_TOOL,
      arguments: { agent_type: "glm-lead", description: "tiny task", prompt: "do it" },
    } }, response, engine.activeTurnDetails, () => {});
    expect(run).not.toHaveBeenCalled();
    expect(response.result).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    await disposal;
    await turn.done;
  });

  it("keeps Stop immediate but joins a delayed real child terminal and flushes its card before dispose returns", async () => {
    const server = new FakeAppServer();
    let finish!: (value: Awaited<ReturnType<SessionSubagentPort["run"]>>) => void;
    const run = vi.fn<SessionSubagentPort["run"]>((request, options) => {
      options?.onProgress?.({ kind: "start", agentType: request.agentType, description: request.description, model: request.model });
      return new Promise((resolve) => { finish = resolve; });
    });
    const log = { record: vi.fn(), list: vi.fn(async () => new Map()), flush: vi.fn(async () => {}) };
    const bridge = new CodexDynamicToolBridge([{ name: "glm-lead", model: "glm-5.3", description: "Review", systemPrompt: "" }], { run, send: async () => ({ ok: false as const, reason: "unavailable" as const, message: "fake port: send is not exercised by this test" }) }, log);
    const engine = new CodexEngine(server, THREAD, undefined, undefined, undefined, undefined, 0, [], undefined, bridge, log);
    const abort = new AbortController();
    const turn = drive(engine, "delegate", abort.signal);
    await waitForParkedIterator(server, engine);
    const owner = engine.activeTurnDetails;
    const response = { result: vi.fn(), error: vi.fn() };
    const handled = bridge.handle({ id: 1, method: "item/tool/call", params: {
      threadId: THREAD, turnId: server.turnId, callId: "delayed-call", tool: ANYCODE_AGENT_TOOL,
      arguments: { agent_type: "glm-lead", description: "tiny task", prompt: "do it" },
    } }, response, owner, (event) => engine.pushBridgeEvent(event, owner));
    abort.abort();
    await handled;
    await turn.done;
    expect(response.result).toHaveBeenCalledTimes(1);
    expect(log.record).not.toHaveBeenCalled();
    let disposed = false;
    const disposal = engine.dispose("host-shutdown").then(() => { disposed = true; });
    await tick();
    expect(disposed).toBe(false);
    expect(log.flush).not.toHaveBeenCalled();
    finish({ status: "cancelled", finalText: "cancelled", truncated: false, turns: 1, toolCalls: 0, durationMs: 100,
      childSessionId: "child-delayed", parentSessionId: "parent", spawnToolCallId: "delayed-call" });
    await disposal;
    expect(log.record).toHaveBeenCalledWith("delayed-call", expect.objectContaining({ subagent: expect.objectContaining({
      target: { kind: "session", childSessionId: "child-delayed", parentSessionId: "parent", spawnToolCallId: "delayed-call" },
      final: expect.objectContaining({ status: "cancelled" }),
    }) }));
    expect(log.flush).toHaveBeenCalledTimes(1);
    expect(log.record.mock.invocationCallOrder[0]).toBeLessThan(log.flush.mock.invocationCallOrder[0]!);
    expect(response.result).toHaveBeenCalledTimes(1);
  });
});

describe("TASK.239 owned active-turn steering", () => {
  it("uses expectedTurnId on the same app-server without interrupting pending work", async () => {
    const server = new FakeAppServer();
    const originalRequest = server.request.bind(server);
    server.request = <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> => {
      if (method === "turn/steer") {
        server.calls.push({ method, params });
        return Promise.resolve({ turnId: engine.activeTurnDetails!.turnId } as T);
      }
      return originalRequest<T>(method, params, opts);
    };
    const engine = new CodexEngine(server, THREAD);
    const controller = new AbortController(); const turn = drive(engine, "Keep child running", controller.signal);
    await waitForParkedIterator(server, engine);
    const active = engine.activeTurnDetails!;
    expect(await engine.steer("Supervisor clarification")).toEqual({ turnId: active.turnId });
    expect(server.calls.find((c) => c.method === "turn/steer")?.params).toEqual({ threadId: THREAD, expectedTurnId: active.turnId, input: [{ type: "text", text: "Supervisor clarification" }] });
    expect(server.interrupts).toBe(0); expect(controller.signal.aborted).toBe(false);
    server.completeTurn("completed"); await turn.done;
    await expect(engine.steer("too late")).rejects.toThrow("No active Codex turn");
    expect(server.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    await engine.dispose("session-close");
  });
  it("preserves explicit stale-turn refusal and never falls back to turn/start", async () => {
    const server = new FakeAppServer(); const originalRequest = server.request.bind(server);
    server.request = <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> => method === "turn/steer" ? Promise.reject(Object.assign(new Error("expectedTurnId mismatch"), { code: -32600 })) : originalRequest<T>(method, params, opts);
    const engine = new CodexEngine(server, THREAD); const turn = drive(engine, "run", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    await expect(engine.steer("clarification")).rejects.toMatchObject({ code: -32600 });
    expect(server.interrupts).toBe(0); expect(server.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    server.completeTurn("completed"); await turn.done; await engine.dispose("session-close");
  });
  it("reports unknown delivery for timeout instead of claiming native rejection", async () => {
    const server = new FakeAppServer(); const originalRequest = server.request.bind(server);
    server.request = <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> => method === "turn/steer" ? Promise.reject(new Error("timeout after input sent")) : originalRequest<T>(method, params, opts);
    const engine = new CodexEngine(server, THREAD); const turn = drive(engine, "run", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    await expect(engine.steer("clarification")).rejects.toMatchObject({ deliveryState: "unknown" });
    expect(server.interrupts).toBe(0);
    server.completeTurn("completed"); await turn.done; await engine.dispose("session-close");
  });
});

// TASK.180: a codex child's profile budget is NOT enforced — the supplied
// boot notice is surfaced once, as a visible engine_notice warning on the
// FIRST turn only, and no native Codex budget field is ever sent.
describe("CodexEngine — boot notices (TASK.180: maxTurns not enforced)", () => {
  const BUDGET_NOTICE: AgentEvent = {
    type: "engine_notice",
    level: "warning",
    message: "Profile maxTurns (12) is not enforced for the codex engine; the child is bounded only by its time/stall limits.",
  };

  it("the supplied budget warning appears as engine_notice level warning on the first turn, exactly once across two turns", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, [BUDGET_NOTICE]);
    const turn1 = await runTurn(server, engine, "first");
    const notices1 = turn1.filter((e): e is Extract<AgentEvent, { type: "engine_notice" }> => e.type === "engine_notice" && e.message.includes("maxTurns (12)"));
    expect(notices1).toHaveLength(1);
    expect(notices1[0]).toMatchObject({ type: "engine_notice", level: "warning", message: expect.stringContaining("not enforced") });

    const turn2 = await runTurn(server, engine, "second");
    expect(turn2.filter((e): e is Extract<AgentEvent, { type: "engine_notice" }> => e.type === "engine_notice" && e.message.includes("maxTurns (12)"))).toHaveLength(0);
  });

  it("no notice at all without a supplied boot notice", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    const turn = await runTurn(server, engine, "hi");
    expect(turn.filter((e) => e.type === "engine_notice")).toHaveLength(0);
  });

  it("no native Codex budget field is sent on thread/start or turn/start", async () => {
    const server = new FakeAppServer();
    await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, [BUDGET_NOTICE]);
    const startParams = JSON.stringify(server.calls.find((call) => call.method === "thread/start")?.params ?? {});
    expect(startParams).not.toMatch(/maxTurns|max_turns|max-turns/i);
    const { engine } = await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, [BUDGET_NOTICE]);
    await runTurn(server, engine, "hi");
    const turnParams = JSON.stringify(server.calls.find((call) => call.method === "turn/start")?.params ?? {});
    expect(turnParams).not.toMatch(/maxTurns|max_turns|max-turns/i);
  });

  it("the resume path seeds the same notice queue", async () => {
    const server = new FakeAppServer();
    const { engine } = await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, undefined, undefined, undefined, [BUDGET_NOTICE]);
    const turn = await runTurn(server, engine, "again");
    expect(turn.filter((e) => e.type === "engine_notice" && e.message.includes("maxTurns (12)"))).toHaveLength(1);
  });
});

// TASK.180 (rework): the PUBLIC wrappers startCodexEngine/resumeCodexEngine
// must forward options.bootNotices into the native session's notices queue —
// a native-function test cannot catch a wrapper dropping the argument. Runs
// against the REAL AppServerClient with the test-child.mjs fake app-server
// (answers the boot RPCs), so the full wrapper -> client -> native path is
// exercised. The notices surface on the FIRST runTurn as engine_notice
// warnings, exactly once.
describe("startCodexEngine/resumeCodexEngine — bootNotices forwarding (TASK.180)", () => {
  const BUDGET_NOTICE: AgentEvent = {
    type: "engine_notice",
    level: "warning",
    message: "Profile maxTurns (12) is not enforced for the codex engine; the child is bounded only by its time/stall limits.",
  };

  function wrapperOptions(bootNotices?: AgentEvent[]): Parameters<typeof startCodexEngine>[0] {
    return {
      binaryPath: process.execPath,
      binaryArgs: [childPath],
      cwd: process.cwd(),
      sourceEnv: { HOME: "/home/test", PATH: process.env.PATH, CODEX_HOME: "/codex-home" },
      binaryTrust: () => null,
      bootstrap: { adopt: () => {} } as never,
      broker: new IpcPermissionBroker(() => {}),
      workspace: "/work",
      ...(bootNotices !== undefined ? { bootNotices } : {}),
    } as Parameters<typeof startCodexEngine>[0];
  }

  async function firstTurnEvents(engine: CodexEngine): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const turn = (async () => {
      for await (const event of engine.runTurn("hi", { signal: new AbortController().signal })) {
        events.push(event);
      }
    })();
    // The fake app-server never completes the turn on its own; terminate the
    // stream after the boot notices have been dispatched.
    await tick();
    await engine.dispose("session-close");
    await turn.catch(() => {});
    return events;
  }

  it.each(["start", "resume"] as const)("%s forwards startup failure notifications during boot", async (mode) => {
    const seen: JsonRpcNotification[] = [];
    const opts = { ...wrapperOptions(), mcpForward: { servers: { broken: { command: "missing" } } }, onMcpNotification: (notification: JsonRpcNotification) => seen.push(notification) };
    const connected = mode === "start" ? await startCodexEngine(opts) : await resumeCodexEngine({ ...opts, externalSessionRef: "thread-180" });
    try {
      expect(seen).toContainEqual(expect.objectContaining({ method: "mcpServer/startupStatus/updated", params: expect.objectContaining({ name: "broken", status: "failed", error: "spawn failed" }) }));
    } finally { await connected.engine.dispose("session-close"); }
  });

  it("startCodexEngine forwards bootNotices — the warning appears once on the first turn", async () => {
    const connected = await startCodexEngine(wrapperOptions([BUDGET_NOTICE]));
    try {
      const events = await firstTurnEvents(connected.engine);
      const notices = events.filter((event): event is Extract<AgentEvent, { type: "engine_notice" }> => event.type === "engine_notice" && event.message.includes("maxTurns (12)"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ type: "engine_notice", level: "warning", message: expect.stringContaining("not enforced") });
    } finally {
      await connected.engine.dispose("session-close").catch(() => {});
    }
  });

  it("resumeCodexEngine forwards bootNotices to the resumed native session", async () => {
    const connected = await resumeCodexEngine({ ...wrapperOptions([BUDGET_NOTICE]), externalSessionRef: "thread-180" });
    try {
      const events = await firstTurnEvents(connected.engine);
      expect(events.filter((event): event is Extract<AgentEvent, { type: "engine_notice" }> => event.type === "engine_notice" && event.message.includes("maxTurns (12)"))).toHaveLength(1);
    } finally {
      await connected.engine.dispose("session-close").catch(() => {});
    }
  });

  it("without bootNotices the first turn carries no engine_notice at all", async () => {
    const connected = await startCodexEngine(wrapperOptions());
    try {
      const events = await firstTurnEvents(connected.engine);
      expect(events.filter((event) => event.type === "engine_notice")).toHaveLength(0);
    } finally {
      await connected.engine.dispose("session-close").catch(() => {});
    }
  });
});

// ── Taskana 4265 / cross-review M2: the PRODUCTION patchAutoApproval wiring ──
//
// The unit tests inject `CodexPatchAutoApprovalContext` straight into the
// bridge, so nothing pinned the closure `startCodexEngine` itself builds:
// `{...options.patchAutoApproval, workspace: options.workspace,
// activePresetId: () => engine?.snapshot().activePresetId ?? null}`. These
// run the REAL wrapper over the REAL AppServerClient + test-child.mjs (same
// rig as the TASK.180 bootNotices tests — a live child process, real fd
// transport, real initialize handshake, a real driven turn), so a future
// refactor that drops `workspace`, freezes the preset at boot, or keys the
// closure to a dead engine fails here instead of passing silently. Verified
// by mutation: dropping `workspace` from the closure and reading the preset
// from a dead closure both fail the accept test; a lying fs port fails it
// too (containment genuinely runs through the supplied FileSystemPort).
describe("startCodexEngine — patchAutoApproval wiring (Taskana 4265, cross-review M2)", () => {
  let WS = "";
  let OUTSIDE = "";

  beforeEach(async () => {
    WS = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "p4265-wire-")));
    OUTSIDE = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "p4265-wire-out-")));
    await fsp.writeFile(join(WS, "a.ts"), "a\n", "utf8");
  });

  afterEach(async () => {
    for (const dir of [WS, OUTSIDE]) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * One wrapped boot plus the live-wire pieces a file-change approval needs:
   * the REAL `startCodexEngine` (real AppServerClient, real test-child.mjs
   * process, real initialize handshake), a REAL broker whose parked ask the
   * test settles, and one driven turn whose native id and item index the
   * approval correlates against.
   */
  async function bootWired(patchAutoApproval: Partial<CodexPatchAutoApprovalPolicy> = {}) {
    const emitted: HostToUiMessage[] = [];
    const broker = new IpcPermissionBroker((message) => emitted.push(message), 60_000);
    const connected = await startCodexEngine({
      binaryPath: process.execPath,
      binaryArgs: [childPath],
      cwd: process.cwd(),
      sourceEnv: { HOME: "/home/test", PATH: process.env.PATH, CODEX_HOME: "/codex-home" },
      binaryTrust: () => null,
      bootstrap: { adopt: () => {} } as never,
      broker,
      workspace: WS,
      patchAutoApproval: {
        fs: new NodeFileSystemAdapter(),
        workspaceWritesAllowed: true,
        rules: null,
        ...patchAutoApproval,
      },
    } as Parameters<typeof startCodexEngine>[0]);
    const engine = connected.engine;
    // The CodexClient the engine was built on IS the spawned AppServerClient.
    const client = (engine as unknown as { client: CodexClient }).client;

    return { connected, engine, client, broker, emitted };
  }

  /**
   * Drives one file-change approval through the REAL transport: starts a turn
   * (test-child answers turn/start with a real native id), streams the
   * `item/started` (fileChange) the approval correlates with — live order,
   * w1-p3: the item precedes the approval — then has the fake app-server emit
   * the approval REQUEST as a live server request. Resolves once the wrapper
   * ANSWERED it: `{accepted:true}` (auto-accept; no ask anywhere) or
   * `{asked:true}` (the bridge parked a broker ask the caller must settle).
   *
   * How the answer is observed: the wrapped bridge writes its JSON-RPC
   * response (`{id:88, result:{decision:"accept"}}`) to the child's stdin;
   * the child latches it and replays it on the `read-approval-answer` RPC,
   * so the test reads the REAL wire answer without touching host internals.
   * The broker's ask is polled in parallel, so both outcomes are covered
   * without hanging.
   */
  async function driveFileChangeApproval(
    rig: Awaited<ReturnType<typeof bootWired>>,
    itemId: string,
    path: string,
    kindType: "add" | "update",
  ): Promise<{ accepted?: boolean; asked?: boolean }> {
    const { engine, client, emitted } = rig;
    const turn = (async () => {
      for await (const _event of engine.runTurn("wire", { signal: new AbortController().signal })) {
        void _event;
      }
    })();
    // Phase A: wait for the engine to own the native turn the approval names.
    let turnId = "";
    for (let i = 0; i < 600 && turnId === ""; i += 1) {
      const active = engine.activeTurnDetails;
      if (active !== null) turnId = active.turnId;
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (turnId === "") throw new Error("the turn never started (no active native turn)");

    // item/started BEFORE the approval (live wire order). The engine's
    // transport tap indexes it synchronously at dispatch; poll the engine's
    // own active-turn index until it holds the item, so the approval cannot
    // race a line still in flight.
    client.notify("emit-notification", {
      method: "item/started",
      params: {
        threadId: engine.threadId,
        turnId,
        item: { type: "fileChange", id: itemId, status: "inProgress", changes: [{ path, kind: { type: kindType }, diff: "x" }] },
      },
    });
    for (let i = 0; i < 600; i += 1) {
      if (engine.activeTurnDetails?.items?.get(itemId) !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (engine.activeTurnDetails?.items?.get(itemId) === undefined) {
      throw new Error("the fileChange item was never indexed");
    }

    // The approval request, exactly the live w1-p3 shape, emitted by the fake
    // app-server as a LIVE server request with THIS turn's identity.
    client.request("emit-server-request-file", {
      method: "item/fileChange/requestApproval",
      params: { threadId: engine.threadId, turnId, itemId, startedAtMs: 1, reason: null, grantRoot: null },
    }).catch(() => {});

    // Bounded wait for whichever outcome arrives first: the auto-accept
    // answer on the wire, or the parked broker ask.
    const outcome = await new Promise<{ accepted?: boolean; asked?: boolean }>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("the wrapper neither accepted nor asked within 10s")), 10_000);
      const askPoll = setInterval(() => {
        if (emitted.some((message) => message.type === "permission_request")) {
          clearInterval(askPoll);
          clearInterval(acceptPoll);
          clearTimeout(deadline);
          resolve({ asked: true });
        }
      }, 10);
      const acceptPoll = setInterval(() => {
        client
          .request("read-approval-answer", {})
          .then((answer) => {
            const decision = (answer as { decision?: unknown } | null)?.decision;
            if (decision === "accept") {
              clearInterval(askPoll);
              clearInterval(acceptPoll);
              clearTimeout(deadline);
              resolve({ accepted: true });
            }
          })
          .catch(() => {});
      }, 25);
    });
    void turn;
    return outcome;
  }

  // Live-process boot + a driven turn: needs a wider budget than the 5 s unit default.
  it("accepts a provably in-workspace add without asking — the wiring carries workspace + live preset", { timeout: 30_000 }, async () => {
    const rig = await bootWired();
    try {
      // The wrapper booted the default preset and the engine APPLIED it — the
      // gate the closure reads must see exactly this value.
      expect(rig.connected.presetId).toBe("ask");
      expect(rig.engine.snapshot().activePresetId).toBe("ask");

      const outcome = await driveFileChangeApproval(rig, "wire-add", join(WS, "wire.ts"), "add");

      // THE assertion: the wrapped bridge auto-accepted a contained add —
      // the closure carried the real workspace, the real fs port, and the
      // live applied preset. And no ask ever reached the UI.
      expect(outcome).toEqual({ accepted: true });
      expect(rig.emitted.filter((message) => message.type === "permission_request")).toHaveLength(0);
      expect(rig.broker.pendingCount).toBe(0);
    } finally {
      await rig.engine.dispose("session-close").catch(() => {});
    }
  });

  it("asks for a patch outside the wired workspace — the closure carried the REAL workspace", { timeout: 30_000 }, async () => {
    const rig = await bootWired();
    try {
      const outcome = await driveFileChangeApproval(rig, "wire-out", join(OUTSIDE, "x.ts"), "add");

      // An out-of-workspace patch MUST park an ask (never a silent accept,
      // never a scoped error) — the ask is the proof the closure's `workspace`
      // is the real one and containment ran through the REAL fs port.
      expect(outcome).toEqual({ asked: true });
      const ask = rig.emitted.find((message) => message.type === "permission_request");
      expect(ask).toMatchObject({ toolName: "CodexApplyPatch" });
      if (ask && ask.type === "permission_request") rig.broker.handleResponse(ask.requestId, "deny");
    } finally {
      await rig.engine.dispose("session-close").catch(() => {});
    }
  });
});

// ── TASK.182 / Taskana 4136: config.mcp_servers on thread/start + thread/resume ──

describe("CodexEngine — native session MCP thread config (TASK.182)", () => {
  const SAMPLE_MAP: Record<string, unknown> = {
    alpha: { command: "npx", args: ["-y", "alpha"], env: { TOKEN: "SECRET_SENTINEL_ABC" }, cwd: "/srv/alpha" },
    remote: { url: "https://remote.example/mcp", http_headers: { Authorization: "Bearer SECRET_SENTINEL_ABC" } },
  };

  function threadParams(server: FakeAppServer, method: string): Record<string, unknown> {
    return server.calls.find((call) => call.method === method)?.params as Record<string, unknown>;
  }

  it("sends config.mcp_servers on thread/start with the resolved map", async () => {
    const server = new FakeAppServer();
    const created = await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      servers: SAMPLE_MAP,
    });
    expect(created.threadId).toBe("fresh-thread");
    const params = threadParams(server, "thread/start");
    expect(params.config).toEqual({ mcp_servers: SAMPLE_MAP });
  });

  it("sends config.mcp_servers on thread/resume too (fresh app-server has no memory)", async () => {
    const server = new FakeAppServer();
    await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      servers: SAMPLE_MAP,
    });
    const params = threadParams(server, "thread/resume");
    expect(params.config).toEqual({ mcp_servers: SAMPLE_MAP });
    expect(params.threadId).toBe("persisted-thread");
  });

  it("OMITS config entirely when the map is empty (no resurrected forward)", async () => {
    const server = new FakeAppServer();
    await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      servers: {},
    });
    expect(threadParams(server, "thread/start").config).toBeUndefined();

    server.calls.length = 0;
    await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      servers: {},
    });
    expect(threadParams(server, "thread/resume").config).toBeUndefined();
  });

  it("keeps the map absent and byte-identical params when no mcpForward is given", async () => {
    const server = new FakeAppServer();
    await createNativeCodexSession(server, "/work");
    expect(threadParams(server, "thread/start").config).toBeUndefined();
  });

  it("notices still drain on the first turn even with NO servers (all-skipped case)", async () => {
    const server = new FakeAppServer();
    const created = await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      notices: [{ type: "engine_notice", level: "warning", message: "Some configured MCP servers could not be loaded and were skipped." }],
    });
    const notices = await drainEngineNotices(created.engine);
    expect(notices.some((event) => event.type === "engine_notice" && event.message.includes("could not be loaded"))).toBe(true);
    const params = threadParams(server, "thread/start");
    expect(params.config).toBeUndefined();
  });

  it("boot notices and the sample map ride together without leaking env/header values into notices", async () => {
    const server = new FakeAppServer();
    const created = await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      servers: SAMPLE_MAP,
      notices: [{ type: "engine_notice", level: "warning", message: "MCP server \"x\" sets a working directory, which this engine does not support for MCP servers; the server was skipped." }],
    });
    const notices = await drainEngineNotices(created.engine);
    const joined = JSON.stringify(notices);
    expect(joined).not.toContain("SECRET_SENTINEL_ABC");
    expect(threadParams(server, "thread/start").config).toEqual({ mcp_servers: SAMPLE_MAP });
  });

  /** Drains the engine's boot notices — they ride the FIRST turn's stream (drainNotices seam). */
  async function drainEngineNotices(engine: import("./codex-engine.js").CodexEngine): Promise<AgentEvent[]> {
    const notices: AgentEvent[] = [];
    for await (const event of engine.runTurn("first turn", { signal: new AbortController().signal })) {
      if ((event as { type?: string }).type === "engine_notice") {
        notices.push(event as AgentEvent);
        // one notice is enough — ending mid-turn is fine for the drain seam
        break;
      }
    }
    return notices;
  }
});

describe("TASK.95 — engine-owned collab correlation across parent turns", () => {
  const spawnItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "collabAgentToolCall",
    id: "spawn-1",
    tool: "spawnAgent",
    senderThreadId: THREAD,
    receiverThreadIds: ["child-1"],
    status: "inProgress",
    prompt: "do work",
    model: "gpt-native",
    agentsStates: { "child-1": { status: "running" } },
    ...overrides,
  });
  const waitItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "collabAgentToolCall",
    id: "wait-1",
    tool: "wait",
    senderThreadId: THREAD,
    receiverThreadIds: ["child-1"],
    status: "completed",
    agentsStates: { "child-1": { status: "completed", message: "done" } },
    ...overrides,
  });

  it("one engine correlates a spawn in turn 1 with a terminal child observation in turn 2 (same card id), and leaks nothing to another engine", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");

    const turn1 = drive(engine, "spawn someone", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    const t1 = server.turnId;
    server.stream.push({ method: "item/started", params: { threadId: engine.threadId, turnId: t1, item: spawnItem() } });
    server.stream.push({ method: "item/completed", params: { threadId: engine.threadId, turnId: t1, item: spawnItem({ status: "completed" }) } });
    await tick();
    // completeTurn() addresses the bare-test THREAD constant; this engine booted
    // the fake's own thread id, so the terminal line is pushed directly.
    server.stream.push({ method: "turn/completed", params: { threadId: engine.threadId, turn: { id: t1, status: "completed" } } });
    await turn1.done;

    expect((turn1.events.find((event) => event.type === "subagent_start") as { toolCallId?: string } | undefined)?.toolCallId).toBe("spawn-1");
    // The call completed while the child was still running — no child terminal.
    expect(turn1.events.some((event) => event.type === "subagent_end")).toBe(false);

    const turn2 = drive(engine, "wait for it", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    const t2 = server.turnId;
    server.stream.push({ method: "item/completed", params: { threadId: engine.threadId, turnId: t2, item: waitItem() } });
    await tick();
    server.stream.push({ method: "turn/completed", params: { threadId: engine.threadId, turn: { id: t2, status: "completed" } } });
    await turn2.done;

    // The ORIGINAL turn-1 card id is patched in turn 2 …
    expect(turn2.events.some((event) => event.type === "subagent_activity" && (event as { toolCallId?: string }).toolCallId === "spawn-1")).toBe(true);
    const end = turn2.events.find((event) => event.type === "subagent_end") as { toolCallId?: string; model?: string } | undefined;
    expect(end?.toolCallId).toBe("spawn-1");
    expect(end?.model).toBe("gpt-native");
    // … and wait still has its OWN visible generic card.
    expect(turn2.events.some((event) => event.type === "tool_call" && (event as { toolCall?: { name?: string } }).toolCall?.name === "codex:collab:wait")).toBe(true);

    // A DIFFERENT engine has its own index: the same wait must not find spawn-1.
    const otherServer = new FakeAppServer();
    const { engine: other } = await createNativeCodexSession(otherServer, "/work");
    const otherTurn = drive(other, "wait", new AbortController().signal);
    await waitForParkedIterator(otherServer, other);
    const ot = otherServer.turnId;
    otherServer.stream.push({ method: "item/completed", params: { threadId: other.threadId, turnId: ot, item: waitItem() } });
    await tick();
    otherServer.stream.push({ method: "turn/completed", params: { threadId: other.threadId, turn: { id: ot, status: "completed" } } });
    await otherTurn.done;
    expect(otherTurn.events.some((event) => event.type === "subagent_activity" || event.type === "subagent_end")).toBe(false);
  });

  it("disposal clears the correlation index without manufacturing a child completion", async () => {
    const server = new FakeAppServer();
    const { engine } = await createNativeCodexSession(server, "/work");
    const turn1 = drive(engine, "spawn", new AbortController().signal);
    await waitForParkedIterator(server, engine);
    const t1 = server.turnId;
    server.stream.push({ method: "item/started", params: { threadId: engine.threadId, turnId: t1, item: spawnItem() } });
    await tick();
    server.stream.push({ method: "turn/completed", params: { threadId: engine.threadId, turn: { id: t1, status: "completed" } } });
    await turn1.done;

    const index = (engine as unknown as { collabIndex: { get(id: string): unknown } }).collabIndex;
    expect(index.get("spawn-1")).toBeDefined();
    await engine.dispose("session-close");
    expect(index.get("spawn-1")).toBeUndefined();
    expect(turn1.events.some((event) => event.type === "subagent_end")).toBe(false);
  });
});


// Taskana 4764 X2/X3/X14: dynamicTools carry the browser declarations for a
// root boot WITHOUT any agent profile; thread/resume still sends none; a
// dynamicToolCall item projects nothing (no double count).
describe("CodexEngine — Taskana 4764 browser dynamicTools", () => {
  function browserOnlyBridge(): CodexDynamicToolBridge {
    const browser = createEngineBrowserBridge({
      preview: {
        open: async () => ({ ok: true, value: { previewId: "p1", url: "u" } }),
        read: async () => ({ ok: true, value: { text: "t" } }),
        screenshot: async () => ({ ok: true, value: { previewId: "p1", url: "u", mediaType: "image/png", data: "ZA==", width: 1, height: 1 } }),
        control: async () => ({ ok: true, value: { previewId: "p1", url: "u", text: "ok" } }),
      } as never,
      fullAccess: () => false,
      broker: { requestPermission: async () => ({ behavior: "allow" }) } as never,
      cwd: "/work",
    });
    return new CodexDynamicToolBridge([], undefined, undefined, undefined, browser);
  }

  it("X2: with NO agent profile the thread/start dynamicTools are the 10 browser decls and initialize negotiates the experimental API", async () => {
    const bridge = browserOnlyBridge();
    const server = new FakeAppServer();
    await createNativeCodexSession(server, "/work", undefined, undefined, undefined, undefined, bridge);
    expect(server.calls.find((c) => c.method === "initialize")?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    const start = server.calls.find((c) => c.method === "thread/start")?.params as { dynamicTools?: Array<{ name: string }> } | undefined;
    expect(start?.dynamicTools).toHaveLength(10);
    expect(start?.dynamicTools?.map((d) => d.name)).toEqual([
      "anycode_browser_open", "anycode_browser_read", "anycode_browser_screenshot",
      "anycode_browser_navigate", "anycode_browser_snapshot", "anycode_browser_click",
      "anycode_browser_type", "anycode_browser_wait_for", "anycode_browser_console", "anycode_browser_eval",
    ]);
  });

  it("X3: thread/resume carries the same dynamicTools declarations as thread/start (review F17)", async () => {
    const bridge = browserOnlyBridge();
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, shadowLog, bridge);
    const resume = server.calls.find((c) => c.method === "thread/resume")?.params as { dynamicTools?: Array<{ name: string }> } | undefined;
    expect(resume?.dynamicTools).toHaveLength(10);
    expect(resume?.dynamicTools?.map((d) => d.name)).toEqual([
      "anycode_browser_open", "anycode_browser_read", "anycode_browser_screenshot",
      "anycode_browser_navigate", "anycode_browser_snapshot", "anycode_browser_click",
      "anycode_browser_type", "anycode_browser_wait_for", "anycode_browser_console", "anycode_browser_eval",
    ]);
    // The shape matches thread/start's declarations byte-for-byte (same bridge).
    const startBridge = browserOnlyBridge();
    const startServer = new FakeAppServer();
    await createNativeCodexSession(startServer, "/work", undefined, undefined, undefined, undefined, startBridge);
    expect(resume?.dynamicTools).toEqual((startServer.calls.find((c) => c.method === "thread/start")?.params as { dynamicTools?: unknown }).dynamicTools);
  });

  it("X3b: thread/resume with NO bridge still sends no dynamicTools key", async () => {
    const server = new FakeAppServer();
    const shadowLog = new RecordingShadowLog();
    await resumeNativeCodexSession(server, "/work", "persisted-thread", undefined, undefined, undefined, shadowLog, undefined);
    expect(server.calls.find((c) => c.method === "thread/resume")?.params).toEqual({ threadId: "persisted-thread", cwd: "/work" });
  });

  it("X14: a dynamicToolCall item for anycode_browser_click projects nothing (no double count)", async () => {
    const server = new FakeAppServer();
    const engine = new CodexEngine(server, THREAD);
    const turn = drive(engine, "look", new AbortController().signal);
    await tick();
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "dynamicToolCall", id: "e1", callId: "dc-1", tool: "anycode_browser_click", status: "completed" } } });
    server.completeTurn("completed");
    await turn.done;
    expect(turn.events.filter((e) => e.type === "tool_call" || e.type === "tool_execution_start" || e.type === "tool_result")).toHaveLength(0);
  });
});


function driveCompact(engine: CodexEngine, signal = new AbortController().signal) {
  const events: AgentEvent[] = [];
  const done = (async () => { for await (const event of engine.compactNow!({ signal })) events.push(event); })();
  return { events, done };
}

describe("Codex manual compaction", () => {
  function setup(overrides: Partial<import("./codex-engine.js").CodexEngineTimeouts> = {}, log?: RecordingShadowLog) {
    const server = new FakeAppServer();
    server.threadReadResult = { thread: { id: THREAD, turns: [] } };
    const engine = new CodexEngine(server, THREAD, undefined, { compactUsageWaitMs: 10, turnStartMs: 100, postInterruptSettleMs: 100, interruptRetryDelaysMs: [1, 1], ...overrides }, undefined, log, 0, [], undefined, undefined, undefined);
    return { server, engine };
  }
  const item = (server: FakeAppServer, id = "compact-native", threadId = THREAD) => server.stream.push({ method: "item/completed", params: { threadId, turnId: id, item: { type: "contextCompaction", id: `${id}-item` } } });
  const usage = (server: FakeAppServer, count: unknown = 8000, id = "compact-native", window: unknown = 100000) => server.stream.push({ method: "thread/tokenUsage/updated", params: { threadId: THREAD, turnId: id, tokenUsage: { last: { totalTokens: count }, total: { inputTokens: 50000, outputTokens: 1000, totalTokens: 51000 }, modelContextWindow: window } } });
  const finish = (server: FakeAppServer, id = "compact-native", status: "completed" | "interrupted" = "completed") => { item(server, id); server.completeTurn(status, id); };
  async function normal(server: FakeAppServer, engine: CodexEngine, count = 47000) {
    const run = drive(engine, "hello", new AbortController().signal);
    await tick(40);
    server.stream.push({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: server.turnId, itemId: "following-message", delta: "Next chat message" } });
    usage(server, count, server.turnId); server.completeTurn("completed"); await run.done;
    return run;
  }
  it("advertises manual compact for fresh and resumed sessions", async () => {
    for (const resume of [false, true]) for (const bridged of [false, true]) {
      const server = new FakeAppServer();
      const bridge = bridged ? new CodexApprovalBridge({} as never) : undefined;
      const result = resume ? await resumeNativeCodexSession(server, "/work", "persisted-thread", bridge) : await createNativeCodexSession(server, "/work", bridge);
      expect(result.engine.capabilities.supportsManualCompact).toBe(true);
      expect(typeof result.engine.compactNow).toBe("function");
    }
  });
  it("runs manual compact without creating an ordinary turn", async () => {
    const { server, engine } = setup(); await normal(server, engine);
    const run = driveCompact(engine); await tick(40); server.startCompact(); item(server); usage(server); finish(server); await run.done;
    expect(server.calls.filter(c => c.method === "thread/compact/start")).toEqual([{ method: "thread/compact/start", params: { threadId: THREAD } }]);
    expect(types(run.events)).toEqual(["compaction_start", "engine_session_tokens", "compaction_end"]);
    expect(run.events.find(e => e.type === "compaction_end")).toMatchObject({ ok: true, preTokens: 47000 });
  });
  it("waits for native completion after the empty compact acknowledgement", async () => {
    const { server, engine } = setup(); const run = driveCompact(engine); await tick(40);
    expect(types(run.events)).toEqual(["compaction_start"]); server.startCompact(); await tick();
    expect(run.events.some(e => e.type === "compaction_end")).toBe(false); finish(server); await run.done;
    expect(run.events.find(e => e.type === "compaction_end")).toMatchObject({ ok: true });
  });
  it("handles lifecycle notifications before the compact acknowledgement", async () => {
    const { server, engine } = setup(); let ack!: (v: unknown) => void; server.compactResponse = new Promise(resolve => { ack = resolve; });
    const run = driveCompact(engine); await tick(40); server.startCompact(); item(server); usage(server); finish(server); await tick(40);
    expect(run.events.some(e => e.type === "compaction_end")).toBe(false); ack({}); await run.done;
    expect(run.events.at(-1)).toMatchObject({ type: "compaction_end", ok: true });
  });
  it("correlates completed-only compact items and ignores stale or foreign notifications", async () => {
    const { server, engine } = setup(); server.threadReadResult = { thread: { id: THREAD, turns: [{ id: "old" }] } };
    const run = driveCompact(engine); await tick(40);
    server.startCompact("old"); item(server, "old"); server.completeTurn("completed", "old"); item(server, "foreign", "foreign-thread"); usage(server, 999, "old");
    item(server); usage(server); server.completeTurn("completed", "compact-native"); await run.done;
    expect(run.events.at(-1)).toMatchObject({ type: "compaction_end", ok: true });
  });
  it("deduplicates compact lifecycle notifications", async () => {
    const { server, engine } = setup(); const run = driveCompact(engine); await tick(40);
    server.startCompact(); server.startCompact(); item(server); item(server); usage(server); server.completeTurn("completed"); server.completeTurn("completed"); await run.done;
    expect(types(run.events).filter(t => t === "compaction_start")).toHaveLength(1); expect(types(run.events).filter(t => t === "compaction_end")).toHaveLength(1); expect(types(run.events).filter(t => t === "context_usage")).toHaveLength(0);
  });
  it.each(["pre", "yield", "read"])("cancels before sending compact without native work: %s", async mode => {
    const { server, engine } = setup(); const controller = new AbortController();
    if (mode === "pre") controller.abort();
    if (mode === "read") { const original = server.request.bind(server); server.request = (m, p, o) => m === "thread/read" ? new Promise(() => {}) : original(m, p, o); }
    const iterator = engine.compactNow!({ signal: controller.signal })[Symbol.asyncIterator](); const events = [(await iterator.next()).value];
    const done = (async () => { for (;;) { const n = await iterator.next(); if (n.done) break; events.push(n.value); } })();
    controller.abort(); await done;
    expect(events.at(-1)).toMatchObject({ type: "compaction_end", ok: false, error: "cancelled" }); expect(server.compactCalls).toBe(0); expect(server.interrupts).toBe(0);
  });
  it("latches Stop until the native compact turn id arrives", async () => {
    const { server, engine } = setup(); const controller = new AbortController(); const run = driveCompact(engine, controller.signal); await tick(40); controller.abort(); await tick(); expect(server.interrupts).toBe(0);
    server.startCompact(); await run.done; expect(server.interrupts).toBe(1); expect(server.calls.find(c => c.method === "turn/interrupt")?.params).toEqual({ threadId: THREAD, turnId: "compact-native" }); expect(run.events.at(-1)).toMatchObject({ ok: false, error: "cancelled" });
  });
  it("interrupts compact while the notification reader is parked", async () => {
    const { server, engine } = setup(); const controller = new AbortController(); const run = driveCompact(engine, controller.signal); await tick(40); server.startCompact(); await tick(40); expect(server.stream.parked).toBe(true); controller.abort(); await run.done;
    expect(run.events.at(-1)).toMatchObject({ ok: false, error: "cancelled" }); expect((await normal(server, engine)).events.at(-1)).toMatchObject({ type: "loop_end" });
  });
  it.each([-32600, -32000])("retries only rejected early compact interrupts and never repeats an accepted interrupt: %s", async code => {
    const { server, engine } = setup(); server.interruptRejections = 1; server.interruptRejectionCode = code;
    const controller = new AbortController(); const run = driveCompact(engine, controller.signal); await tick(40); server.startCompact(); await tick(); controller.abort(); controller.abort(); await run.done;
    expect(server.interrupts).toBe(code === -32600 ? 2 : 1); if (code === -32000) expect(server.closeCount).toBe(1);
  });
  it.each(["ack", "identity", "settlement"])("bounds compact startup and interrupted settlement failures: %s", async mode => {
    const { server, engine } = setup({ turnStartMs: 25, postInterruptSettleMs: 25 }); const controller = new AbortController();
    if (mode === "ack") server.compactResponse = new Promise(() => {});
    const run = driveCompact(engine, controller.signal); await tick(40);
    if (mode === "settlement") { server.interruptSettles = "silent"; server.startCompact(); await tick(); controller.abort(); }
    await run.done; expect(run.events.at(-1)).toMatchObject({ ok: false }); expect(server.closeCount).toBe(1);
    const before = server.calls.length; await driveCompact(engine).done; expect(server.calls).toHaveLength(before);
  });
  it.each([-32601, -32000])("reports explicit compact rejection without killing ordinary turns: %s", async code => {
    const { server, engine } = setup(); server.compactResponse = Promise.reject(Object.assign(new Error("denied"), { code }));
    const run = driveCompact(engine); await run.done; expect(run.events.at(-1)).toMatchObject({ ok: false }); expect(server.closeCount).toBe(0);
    if (code === -32601) {
      expect(run.events.at(-1)).toMatchObject({ error: "Manual compaction is unavailable for this Codex app-server. Update Codex and start a new session." });
      expect(engine.capabilities.supportsManualCompact).toBe(false);
      expect(engine.compactNow).toBeUndefined();
      expect(server.compactCalls).toBe(1);
    } else expect(engine.capabilities.supportsManualCompact).toBe(true);
    expect(types((await normal(server, engine)).events)).toContain("loop_end");
  });
  it.each(["before", "during", "ack"])("pairs compact start on transport and decoding failures: %s", async mode => {
    const { server, engine } = setup(); if (mode === "ack") server.compactResponse = Promise.resolve(null);
    const run = driveCompact(engine); await tick(40); if (mode === "during") server.startCompact(); if (mode !== "ack") server.stream.close(); await run.done;
    expect(types(run.events)).toEqual(["compaction_start", "compaction_end"]); expect(run.events.at(-1)).toMatchObject({ ok: false });
  });
  it.each(["unconfirmed", "failed", "interrupted", "completed"])("requires compaction confirmation and respects the native terminal verdict: %s", async status => {
    const { server, engine } = setup(); const controller = new AbortController(); const run = driveCompact(engine, controller.signal); await tick(40); server.startCompact(); if (status !== "unconfirmed") item(server);
    server.stream.push({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "compact-native", status: status === "unconfirmed" ? "completed" : status, error: { message: "native failure" } } } });
    if (status === "completed") controller.abort(); await run.done; expect(run.events.find(e => e.type === "compaction_end")).toMatchObject({ ok: status === "completed" });
  });
  it.each(["failed", "interrupted"])("retains accounting for an unsuccessful compact turn: %s", async status => {
    const { server, engine } = setup(); await normal(server, engine);
    const observer = vi.fn(); engine.onUsage(observer);
    const run = driveCompact(engine); await tick(40); server.startCompact(); item(server); usage(server, 8000);
    server.stream.push({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "compact-native", status } } });
    await run.done;
    expect(run.events).toContainEqual(expect.objectContaining({ type: "engine_session_tokens" }));
    expect(observer).toHaveBeenCalledOnce();
    expect(run.events.find(e => e.type === "compaction_end")).toMatchObject({ ok: false, preTokens: 47000 });
    expect(run.events.find(e => e.type === "compaction_end")).not.toHaveProperty("postTokens");
    expect(types(run.events)).not.toContain("context_usage");
    const next = driveCompact(engine); await tick(40); server.startCompact("next"); finish(server, "next"); await next.done;
    expect(next.events.find(e => e.type === "compaction_end")).toMatchObject({ preTokens: 47000 });
  });
  it("keeps compact request usage in accounting without treating it as the new context", async () => {
    const { server, engine } = setup(); await normal(server, engine, 18723);
    const observer = vi.fn(); engine.onUsage(observer);
    const run = driveCompact(engine); await tick(40); server.startCompact(); item(server);
    usage(server, 21875); server.completeTurn("completed"); await run.done;
    const end = run.events.find(e => e.type === "compaction_end");
    expect(end).toMatchObject({ ok: true, preTokens: 18723 });
    expect(end).not.toHaveProperty("postTokens");
    expect(types(run.events)).not.toContain("context_usage");
    expect(run.events).toContainEqual(expect.objectContaining({ type: "engine_session_tokens" }));
    expect(observer).toHaveBeenCalled();
    const chat = await normal(server, engine, 9000);
    expect(chat.events).toContainEqual(expect.objectContaining({ type: "context_usage", estimatedTokens: 9000 }));
    const next = driveCompact(engine); await tick(40); server.startCompact("next"); finish(server, "next"); await next.done;
    expect(next.events.find(e => e.type === "compaction_end")).toMatchObject({ preTokens: 9000 });
  });
  it("publishes the replacement estimate from the observed compact sequence and then the next request", async () => {
    const { server, engine } = setup(); await normal(server, engine, 40536);
    const run = driveCompact(engine); await tick(40); server.startCompact();
    server.stream.push({ method: "thread/tokenUsage/updated", params: { threadId: THREAD, turnId: "compact-native", tokenUsage: {
      last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 46509 },
      total: { inputTokens: 118381, cachedInputTokens: 77312, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 118401 }, modelContextWindow: 475000,
    } } });
    item(server); server.completeTurn("completed", "compact-native"); await run.done;
    expect(run.events).toContainEqual({ type: "context_usage", estimatedTokens: 46509, budgetTokens: 475000, source: "provider" });
    expect(run.events.find(e => e.type === "compaction_end")).toMatchObject({ ok: true, preTokens: 40536 });
    const chat = await normal(server, engine, 42710);
    expect(chat.events).toContainEqual(expect.objectContaining({ type: "context_usage", estimatedTokens: 42710 }));
  });
  it.each(["completed", "interrupted"] as const)("handles a late replacement estimate after %s compaction", async status => {
    const { server, engine } = setup(); const late: AgentEvent[] = []; engine.onMaintenanceEvent(event => late.push(event));
    const run = driveCompact(engine); await tick(40); server.startCompact(); finish(server, "compact-native", status); await run.done;
    server.stream.push({ method: "thread/tokenUsage/updated", params: { threadId: THREAD, turnId: "compact-native", tokenUsage: {
      last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 46509 },
      total: { inputTokens: 118381, cachedInputTokens: 77312, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 118401 }, modelContextWindow: 475000,
    } } });
    expect(late.some(event => event.type === "context_usage")).toBe(status === "completed");
  });
  it("accounts for late compact usage without changing context", async () => {
    const { server, engine } = setup(); const late: AgentEvent[] = []; const observer = vi.fn();
    engine.onUsage(observer); engine.onMaintenanceEvent(event => late.push(event));
    const run = driveCompact(engine); await tick(40); server.startCompact(); finish(server); await run.done;
    usage(server, 8000);
    expect(late).toContainEqual(expect.objectContaining({ type: "engine_session_tokens" }));
    expect(late.some(event => event.type === "context_usage")).toBe(false);
    expect(observer).toHaveBeenCalled();
  });
  it("does not reuse a stale baseline after a successful compaction", async () => {
    const { server, engine } = setup(); await normal(server, engine);
    const first = driveCompact(engine); await tick(40); server.startCompact(); finish(server); await first.done;
    const next = driveCompact(engine); await tick(40); server.startCompact("next"); finish(server, "next"); await next.done;
    expect(next.events.find(e => e.type === "compaction_end")).not.toHaveProperty("preTokens");
  });
  it("does not steer or approve a manual compact turn", async () => {
    const { server, engine } = setup(); const run = driveCompact(engine); await tick(40); server.startCompact(); await tick(40);
    expect(engine.activeTurnDetails).toBeNull(); expect(engine.steeringStatus().ready).toBe(false); await expect(engine.steer("bad")).rejects.toThrow(); expect(server.calls.some(c => c.method === "turn/steer")).toBe(false);
    finish(server); await run.done;
  });
  it("preserves notifications across normal turns and repeated compactions", async () => {
    const { server, engine } = setup(); await normal(server, engine);
    for (const id of ["compact-one", "compact-two"]) {
      const run = driveCompact(engine); await tick(40); server.startCompact(id); item(server, id); usage(server, 8000, id); finish(server, id); await run.done;
      const chat = await normal(server, engine); expect(types(chat.events)).toContain("context_usage"); expect(types(chat.events)).toContain("loop_end"); expect(chat.events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "Next chat message" }));
    }
  });
  it.each([false, true])("refreshes native shadow ordinals after manual compaction: %s", async persisted => {
    const log = new RecordingShadowLog(); const { server, engine } = setup({}, log); await normal(server, engine);
    const compact = driveCompact(engine); await tick(40); server.startCompact(); finish(server); await compact.done;
    const turns = [{ id: "native-turn-1" }, ...(persisted ? [{ id: "compact-native" }] : [])]; server.threadReadResult = { thread: { id: THREAD, turns } };
    const chat = drive(engine, "command", new AbortController().signal); await tick(40);
    server.stream.push({ method: "item/completed", params: { threadId: THREAD, turnId: server.turnId, item: { type: "commandExecution", id: "command-after-compact", command: "echo ok", aggregatedOutput: "ok", status: "completed", exitCode: 0 } } });
    server.completeTurn("completed"); await chat.done; expect(log.writes.at(-1)?.item.turnOrdinal).toBe(turns.length);
    const projected = projectCodexHistory({ thread: { id: THREAD, turns: [...turns, { id: server.turnId, items: [{ id: "after-command", type: "agentMessage", text: "after command" }] }] } }, log.writes.map(row => row.item), { maxItems: 100 });
    const toolAt = projected.findIndex(row => row.message.role === "assistant" && Array.isArray(row.message.content) && row.message.content.some(part => part.type === "tool_call"));
    expect(toolAt).toBeGreaterThanOrEqual(0);
    expect(projected.at(-1)?.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "after command" }] });
  });
  it("reserves compact ownership before the first yield and releases it when the consumer returns", async () => {
    const { server, engine } = setup();
    const first = engine.compactNow!({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    expect((await first.next()).value).toMatchObject({ type: "compaction_start" });
    const second = driveCompact(engine); await second.done;
    expect(second.events).toEqual([expect.objectContaining({ type: "compaction_end", ok: false, error: "Codex engine is busy" })]);
    expect(server.compactCalls).toBe(0); await first.return?.();
    const retry = driveCompact(engine); await tick(40); server.startCompact(); finish(server); await retry.done;
    expect(retry.events.find(e => e.type === "compaction_end")).toMatchObject({ ok: true });
  });
  it.each(["identity", "parked"])("shares the interrupt latch when compact Stop races disposal: %s", async mode => {
    const { server, engine } = setup(); const controller = new AbortController(); const run = driveCompact(engine, controller.signal); await tick(40);
    if (mode === "parked") { server.startCompact(); await tick(40); }
    controller.abort(); await tick(); await engine.dispose("session-close"); await run.done;
    expect(server.interrupts).toBe(mode === "parked" ? 1 : 0);
    expect(run.events.filter(e => e.type === "compaction_end")).toHaveLength(1);
    expect(engine.activeTurnDetails).toBeNull();
  });
  it("keeps warnings on the maintenance rail and ignores foreign warning identities", async () => {
    const { server, engine } = setup(); const run = driveCompact(engine); await tick(40);
    server.stream.push({ method: "warning", params: { threadId: THREAD, message: "Native maintenance notice" } });
    server.stream.push({ method: "warning", params: { threadId: "foreign", message: "foreign warning" } });
    server.startCompact(); finish(server); await run.done;
    expect(run.events).toContainEqual({ type: "engine_notice", level: "warning", message: "Native maintenance notice" });
    expect(JSON.stringify(run.events)).not.toContain("foreign warning");
  });
  it("sends no new native work when the compaction correlation baseline cannot be read", async () => {
    const { server, engine } = setup(); server.threadReadResult = {}; const bad = driveCompact(engine); await bad.done; expect(server.compactCalls).toBe(0); expect(bad.events.at(-1)).toMatchObject({ ok: false });
    server.threadReadResult = { thread: { id: THREAD, turns: [] } }; const retry = driveCompact(engine); await tick(40); server.startCompact(); finish(server); await retry.done; expect(retry.events.find(e => e.type === "compaction_end")).toMatchObject({ ok: true });
  });
});

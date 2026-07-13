/**
 * The small, native Codex session runtime. It intentionally does not compose
 * AnyCode's AgentLoop or any of its tools: the app-server owns those policies.
 *
 * Turn lifecycle (TASK.38, cut §2(b)) — the two invariants that make Stop safe:
 *
 *  1. ONE abort-promise is raced into EVERY await of the turn, so an abort that
 *     lands while `notifications().next()` is parked is observed immediately.
 *     Polling `signal.aborted` between awaits (the previous shape) never fires
 *     while the iterator sits idle, which left the turn `running` forever.
 *  2. `sendInterruptOnce()` is latched per turn. A repeated `turn/interrupt` is
 *     a live black hole — the second call does not answer while the turn is
 *     settling (L9) — so "exactly once" is a correctness requirement, not an
 *     optimization. Every interrupt is additionally bounded by
 *     CODEX_TURN_INTERRUPT_TIMEOUT_MS.
 *
 * Aborting before the `turn/start` response exists cannot interrupt anything
 * yet (there is no native turn id), so the intent is latched and the interrupt
 * is sent the instant the id arrives. Afterwards the notification stream is
 * drained — bounded by CODEX_POST_INTERRUPT_SETTLE_MS — to the terminal
 * `turn/completed`, which the translator maps to `loop_end:cancelled`.
 */

import type { AgentEvent, PermissionMode, ReasoningEffort } from "@anycode/core";
import {
  CODEX_BOOT_RPC_TIMEOUT_MS,
  CODEX_POST_INTERRUPT_SETTLE_MS,
  CODEX_TURN_INTERRUPT_TIMEOUT_MS,
  CODEX_TURN_START_TIMEOUT_MS,
} from "../../../shared/codex-timeouts.js";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "../session-engine.js";
import type { IpcPermissionBroker } from "../../permission-broker.js";
import { CodexApprovalBridge, type ActiveCodexTurn } from "./approval-bridge.js";
import { AppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import { TurnTranslator } from "./event-translator.js";
import { TurnItemIndex } from "./turn-item-index.js";
import type { JsonRpcNotification } from "./protocol.js";

export const CODEX_NOT_SIGNED_IN = "Codex is not signed in — run `codex login` in a terminal, then start a new Codex session.";

/**
 * Backstop only. Notifications addressed to a foreign thread (or to no thread
 * at all — `mcpServer/startupStatus/updated`, `remoteControl/status/changed`)
 * are dropped before this counter, so ordinary between-turn chatter can never
 * false-terminate a turn (cut §1.6 hazard).
 */
const PRE_TURN_NOTIFICATION_LIMIT = 256;

export const CODEX_ENGINE_CAPABILITIES: EngineCapabilities = {
  supportsCorePermissions: false,
  supportsRewind: false,
  supportsWorkflow: false,
  supportsGitMutations: false,
  supportsContextUsage: false,
  supportsContextBreakdown: false,
  supportsInteractiveApprovals: false,
  costAccounting: false,
  supportsModelSelection: false,
  supportsReasoningEffort: false,
  supportsImages: false,
  supportsTasks: false,
  supportsFileSnapshots: false,
};

const CODEX_BRIDGED_CAPABILITIES: EngineCapabilities = {
  ...CODEX_ENGINE_CAPABILITIES,
  supportsInteractiveApprovals: true,
};

/** Every bound is frozen in shared/codex-timeouts.ts; overrides exist for tests only. */
export interface CodexEngineTimeouts {
  bootRpcMs: number;
  turnStartMs: number;
  interruptMs: number;
  postInterruptSettleMs: number;
}

export const DEFAULT_CODEX_ENGINE_TIMEOUTS: CodexEngineTimeouts = {
  bootRpcMs: CODEX_BOOT_RPC_TIMEOUT_MS,
  turnStartMs: CODEX_TURN_START_TIMEOUT_MS,
  interruptMs: CODEX_TURN_INTERRUPT_TIMEOUT_MS,
  postInterruptSettleMs: CODEX_POST_INTERRUPT_SETTLE_MS,
};

function timeouts(overrides?: Partial<CodexEngineTimeouts>): CodexEngineTimeouts {
  return { ...DEFAULT_CODEX_ENGINE_TIMEOUTS, ...overrides };
}

type ThreadResult = { thread?: { id?: unknown }; model?: unknown };
type AccountResult = { account?: unknown };
type TurnResult = { turn?: { id?: unknown } };

export interface CodexEngineConnectOptions {
  client: AppServerClient;
  workspace: string;
}

export interface ConnectedCodexEngine {
  engine: CodexEngine;
  threadId: string;
  model: string;
}

/** Narrow transport seam keeps lifecycle tests independent from a real child. */
export interface CodexClient {
  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): void;
  notifications(): AsyncIterable<JsonRpcNotification>;
  /**
   * Optional synchronous tap on the raw notification stream, invoked in wire
   * order at dispatch time. The pull-based `notifications()` iterator is driven
   * by the UI consumer and can therefore lag behind an approval request that
   * the transport dispatches in the same stdout chunk; the approval modal must
   * still be able to describe the item (see TurnItemIndex), so item details are
   * indexed here, ahead of the consumer.
   */
  observeNotifications?(observe: (notification: JsonRpcNotification) => void): () => void;
  close(): Promise<void>;
}

export interface CodexEngineCreateOptions extends Omit<AppServerClientOptions, "bootstrap" | "onServerRequest"> {
  bootstrap: EngineBootstrap;
  workspace: string;
  broker: IpcPermissionBroker;
  timeouts?: Partial<CodexEngineTimeouts>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function nativeThread(result: ThreadResult, operation: string): { threadId: string; model: string } {
  const threadId = result.thread?.id;
  const model = result.model;
  if (typeof threadId !== "string" || threadId.length === 0 || typeof model !== "string" || model.length === 0) {
    throw new Error(`Codex ${operation} returned no usable thread id and model`);
  }
  return { threadId, model };
}

/** Resolves once on abort and never rejects; the listener is always removed. */
function watchAbort(signal: AbortSignal): { promise: Promise<void>; dispose(): void } {
  if (signal.aborted) return { promise: Promise.resolve(), dispose: () => {} };
  let listener: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    listener = () => resolve();
    signal.addEventListener("abort", listener, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", listener) };
}

interface SettleDeadline {
  promise: Promise<{ kind: "settle-timeout" }>;
  cancel(): void;
}

function deadline(ms: number): SettleDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{ kind: "settle-timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "settle-timeout" }), ms);
  });
  return { promise, cancel: () => { if (timer !== undefined) clearTimeout(timer); } };
}

async function initializeAndVerifyAccount(client: CodexClient, timeoutMs: number): Promise<void> {
  await client.request("initialize", {
    clientInfo: { name: "anycode", title: "AnyCode", version: "0.0.0" },
    capabilities: { experimentalApi: false },
  }, { timeoutMs });
  client.notify("initialized");
  const account = await client.request<AccountResult>("account/read", {}, { timeoutMs });
  if (account.account === null || account.account === undefined) throw new Error(CODEX_NOT_SIGNED_IN);
}

/** Testable native ordering: handshake/account are complete before a thread exists. */
export async function createNativeCodexSession(
  client: CodexClient,
  workspace: string,
  approvals?: CodexApprovalBridge,
  overrides?: Partial<CodexEngineTimeouts>,
): Promise<ConnectedCodexEngine> {
  const bounds = timeouts(overrides);
  await initializeAndVerifyAccount(client, bounds.bootRpcMs);
  const result = await client.request<ThreadResult>("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
  }, { timeoutMs: bounds.bootRpcMs });
  const native = nativeThread(result, "thread/start");
  return { engine: new CodexEngine(client, native.threadId, approvals, overrides), ...native };
}

/** Strict native resume: the stored ref is used verbatim and never replaced. */
export async function resumeNativeCodexSession(
  client: CodexClient,
  workspace: string,
  externalSessionRef: string,
  approvals?: CodexApprovalBridge,
  overrides?: Partial<CodexEngineTimeouts>,
): Promise<ConnectedCodexEngine> {
  const bounds = timeouts(overrides);
  await initializeAndVerifyAccount(client, bounds.bootRpcMs);
  const resumed = await client.request<ThreadResult>("thread/resume", {
    threadId: externalSessionRef,
    cwd: workspace,
  }, { timeoutMs: bounds.bootRpcMs });
  const native = nativeThread(resumed, "thread/resume");
  if (native.threadId !== externalSessionRef) {
    throw new Error("Codex thread/resume returned a different native thread");
  }
  await client.request("thread/read", { threadId: native.threadId, includeTurns: true }, { timeoutMs: bounds.bootRpcMs });
  return { engine: new CodexEngine(client, native.threadId, approvals, overrides), ...native };
}

/** Starts a new native thread before anything is persisted. */
export async function startCodexEngine(options: CodexEngineCreateOptions): Promise<ConnectedCodexEngine> {
  let engine: CodexEngine | null = null;
  const approvals = new CodexApprovalBridge({
    broker: options.broker,
    activeTurn: () => engine?.activeTurnDetails ?? null,
  });
  const client = new AppServerClient({ ...options, bootstrap: options.bootstrap, onServerRequest: approvals.handle });
  try {
    await client.start();
    const connected = await createNativeCodexSession(client, options.workspace, approvals, options.timeouts);
    engine = connected.engine;
    return connected;
  } catch (error) {
    // Any bounded boot RPC that times out lands here: the child is released.
    await client.close();
    throw error;
  }
}

/** Resumes one exact persisted native thread. It deliberately never falls back to a new thread. */
export async function resumeCodexEngine(options: CodexEngineCreateOptions & { externalSessionRef: string }): Promise<ConnectedCodexEngine> {
  let engine: CodexEngine | null = null;
  const approvals = new CodexApprovalBridge({
    broker: options.broker,
    activeTurn: () => engine?.activeTurnDetails ?? null,
  });
  const client = new AppServerClient({ ...options, bootstrap: options.bootstrap, onServerRequest: approvals.handle });
  try {
    await client.start();
    const connected = await resumeNativeCodexSession(client, options.workspace, options.externalSessionRef, approvals, options.timeouts);
    engine = connected.engine;
    return connected;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export class CodexEngine implements SessionEngine {
  readonly id = "codex" as const;
  readonly capabilities: EngineCapabilities;
  private readonly bounds: CodexEngineTimeouts;
  private readonly unobserve: () => void;
  private turnNumber = 0;
  private activeTurn: ActiveCodexTurn | null = null;
  /** Item index of the turn currently being started/run; written by the transport tap. */
  private activeItems: TurnItemIndex | null = null;
  /** Per-turn latch: exactly one `turn/interrupt` may ever be sent for one turn. */
  private interruptSent = false;
  private terminalError: Error | null = null;
  private disposed = false;

  constructor(
    private readonly client: CodexClient,
    readonly threadId: string,
    private readonly approvals?: CodexApprovalBridge,
    overrides?: Partial<CodexEngineTimeouts>,
  ) {
    // Interactive approval is advertised only after the exact W0 bridge is
    // installed; direct/test-only engines retain the fail-closed capability.
    this.capabilities = approvals === undefined ? CODEX_ENGINE_CAPABILITIES : CODEX_BRIDGED_CAPABILITIES;
    this.bounds = timeouts(overrides);
    this.unobserve = this.client.observeNotifications?.((notification) => this.indexItem(notification)) ?? (() => {});
  }

  get activeTurnDetails(): ActiveCodexTurn | null {
    return this.activeTurn;
  }

  mode(): PermissionMode {
    // Existing wire vocabulary has no native-policy projection yet. `build`
    // is display-only: Session capability gates prevent it becoming a core
    // permission policy or a mutable Codex setting.
    return "build";
  }

  reasoningEffort(): ReasoningEffort | undefined {
    return undefined;
  }

  setReasoningEffort(_effort: ReasoningEffort | undefined): void {
    // Model/effort policy is intentionally deferred to a later Codex slice.
  }

  historyItems(): [] {
    return [];
  }

  async *runTurn(input: string, options: RunTurnOptions): AsyncIterable<AgentEvent> {
    const turn = ++this.turnNumber;
    if (this.terminalError !== null || this.disposed) {
      yield* this.terminalEvents(turn, this.terminalError ?? new Error("Codex engine is closed"));
      return;
    }
    if (options.attachments?.length) {
      yield* this.terminalEvents(turn, new Error("Codex engine does not support image attachments"));
      return;
    }

    yield { type: "turn_start", turn };

    const abort = watchAbort(options.signal);
    const items = new TurnItemIndex();
    // The tap must be armed BEFORE turn/start is written: an `item/started` can
    // reach the transport in the same chunk as the approval request that names it.
    this.activeItems = items;
    this.interruptSent = false;
    let abortObserved = false;
    let settle: SettleDeadline | null = null;

    /** Latched Stop: settle any parked approval as `cancel`, then interrupt exactly once. */
    const beginInterrupt = (): void => {
      settle ??= deadline(this.bounds.postInterruptSettleMs);
      this.approvals?.denyAll("Codex turn was cancelled", "turn_cancelled");
      void this.sendInterruptOnce();
    };
    /** Armed only after an interrupt: the bounded drain to `turn/completed`. */
    const settleRacers = (): Promise<{ kind: "settle-timeout" }>[] => (settle === null ? [] : [settle.promise]);
    const cancelSettle = (): void => settle?.cancel();

    const iterator = this.client.notifications()[Symbol.asyncIterator]();
    const request = this.client.request<TurnResult>("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
    }, { timeoutMs: this.bounds.turnStartMs });
    let next = iterator.next();
    const buffered: JsonRpcNotification[] = [];

    try {
      // Phase A — wait for the native turn id. An abort here cannot interrupt
      // anything yet, so it only latches the intent; the response itself is
      // bounded, so a wedged server cannot park Session as busy forever.
      let result: TurnResult | null = null;
      while (result === null) {
        const raced = await Promise.race([
          request.then((value) => ({ kind: "response" as const, value })),
          next.then((value) => ({ kind: "notification" as const, value })),
          ...(abortObserved ? [] : [abort.promise.then(() => ({ kind: "abort" as const }))]),
        ]);
        if (raced.kind === "abort") {
          abortObserved = true;
          continue;
        }
        if (raced.kind === "response") {
          result = raced.value;
          break;
        }
        if (raced.value.done) {
          // The transport went away while a Stop was already pending (e.g. Stop
          // immediately followed by closing the tab): that is the cancellation
          // the user asked for, not an engine error.
          if (abortObserved) {
            yield* this.cancelledEvents(turn);
            return;
          }
          throw this.terminalError ?? new Error("Codex app-server closed while starting a turn");
        }
        // Only this thread's notifications can belong to the turn being started;
        // foreign/threadless chatter is dropped uncounted.
        if (this.addressesThisThread(raced.value.value)) {
          buffered.push(raced.value.value);
          if (buffered.length > PRE_TURN_NOTIFICATION_LIMIT) {
            throw new Error("Codex app-server exceeded the pre-turn notification limit");
          }
        }
        next = iterator.next();
      }

      const turnId = result.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) throw new Error("Codex turn/start returned no turn id");
      this.activeTurn = { threadId: this.threadId, turnId, items };
      const translator = new TurnTranslator({ threadId: this.threadId, turnId, turn, items });
      let terminal = false;
      const deliver = function* (notification: JsonRpcNotification): Generator<AgentEvent> {
        for (const event of translator.onNotification(notification)) {
          if (event.type === "loop_end") terminal = true;
          yield event;
        }
      };

      // The native id now exists, so a Stop latched during phase A fires here.
      if (abortObserved) beginInterrupt();

      for (const notification of buffered) {
        if (terminal) break;
        yield* deliver(notification);
      }

      // Phase B — stream. Once interrupted, the abort is no longer raced (it has
      // fired) and the bounded settle deadline replaces it: we drain to the
      // server's terminal `turn/completed`, which carries status "interrupted".
      while (!terminal) {
        const raced = await Promise.race([
          next.then((value) => ({ kind: "notification" as const, value })),
          ...(abortObserved ? [] : [abort.promise.then(() => ({ kind: "abort" as const }))]),
          ...settleRacers(),
        ]);
        if (raced.kind === "abort") {
          abortObserved = true;
          beginInterrupt();
          continue;
        }
        if (raced.kind === "settle-timeout") {
          throw new Error(`Codex did not settle the interrupted turn within ${this.bounds.postInterruptSettleMs}ms`);
        }
        if (raced.value.done) {
          // Transport closed under a pending Stop (teardown of an interrupted
          // turn): close the UI turn as cancelled, pairing every open card,
          // rather than reporting an engine error the user did not cause.
          if (abortObserved) {
            for (const event of translator.finishTerminal("cancelled")) yield event;
            return;
          }
          throw this.terminalError ?? new Error("Codex app-server closed during a turn");
        }
        next = iterator.next();
        yield* deliver(raced.value.value);
      }
    } catch (error) {
      const terminalError = this.terminalError ?? (error instanceof Error ? error : new Error(String(error)));
      this.terminalError = terminalError;
      this.approvals?.denyAll("Codex app-server failed", "turn_cancelled");
      // A turn that timed out or lost its transport releases the child: a
      // bounded RPC must never leave a live app-server behind (TASK.38 §6).
      void this.client.close().catch(() => {});
      yield { type: "error", error: terminalError };
      yield* this.terminalEvents(turn, terminalError, false);
    } finally {
      this.activeTurn = null;
      this.activeItems = null;
      cancelSettle();
      abort.dispose();
    }
  }

  dispose(_reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposed = true;
    this.unobserve();
    this.approvals?.denyAll("Codex engine is shutting down", "shutdown");
    void this.sendInterruptOnce();
    return this.client.close();
  }

  /**
   * The whole point of the latch: a repeated `turn/interrupt` does not answer
   * while the turn settles (L9), so a second call could only ever add an
   * unanswerable pending request. Failures are swallowed — the caller's bounded
   * settle deadline (or close()) is the backstop, and a rejected interrupt must
   * not itself fail an otherwise-healthy turn.
   */
  private async sendInterruptOnce(): Promise<void> {
    const active = this.activeTurn;
    if (active === null || this.interruptSent) return;
    this.interruptSent = true;
    try {
      await this.client.request(
        "turn/interrupt",
        { threadId: active.threadId, turnId: active.turnId },
        { timeoutMs: this.bounds.interruptMs },
      );
    } catch {
      // bounded settle / close() remain the terminal backstops.
    }
  }

  private addressesThisThread(notification: JsonRpcNotification): boolean {
    return record(notification.params)?.threadId === this.threadId;
  }

  /** Transport-ordered writer of the approval-correlation index (see CodexClient). */
  private indexItem(notification: JsonRpcNotification): void {
    if (notification.method !== "item/started" || this.activeItems === null) return;
    const params = record(notification.params);
    if (params === null || params.threadId !== this.threadId) return;
    this.activeItems.record(params.item);
  }

  /** Terminal closure of a turn the user cancelled before any native turn existed. */
  private *cancelledEvents(turn: number): Generator<AgentEvent> {
    yield { type: "turn_end", turn, finishReason: "other" };
    yield { type: "loop_end", reason: "cancelled", turns: turn };
  }

  private *terminalEvents(turn: number, error: Error, includeError = true): Generator<AgentEvent> {
    if (includeError) yield { type: "error", error };
    yield { type: "turn_end", turn, finishReason: "error" };
    yield { type: "loop_end", reason: "error", turns: turn };
  }
}

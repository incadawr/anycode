/**
 * The small, native Codex session runtime. It intentionally does not compose
 * AnyCode's AgentLoop or any of its tools: the app-server owns those policies.
 */

import type { AgentEvent, PermissionMode, ReasoningEffort } from "@anycode/core";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "../session-engine.js";
import type { IpcPermissionBroker } from "../../permission-broker.js";
import { CodexApprovalBridge, type ActiveCodexTurn } from "./approval-bridge.js";
import { AppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import { TurnTranslator } from "./event-translator.js";
import type { JsonRpcNotification } from "./protocol.js";

export const CODEX_NOT_SIGNED_IN = "Codex is not signed in — run `codex login` in a terminal, then start a new Codex session.";
export const CODEX_TERMINAL_DENIAL_GRACE_MS = 400;
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
  close(): Promise<void>;
}

export interface CodexEngineCreateOptions extends Omit<AppServerClientOptions, "bootstrap" | "onServerRequest"> {
  bootstrap: EngineBootstrap;
  workspace: string;
  broker: IpcPermissionBroker;
}

function nativeThread(result: ThreadResult, operation: string): { threadId: string; model: string } {
  const threadId = result.thread?.id;
  const model = result.model;
  if (typeof threadId !== "string" || threadId.length === 0 || typeof model !== "string" || model.length === 0) {
    throw new Error(`Codex ${operation} returned no usable thread id and model`);
  }
  return { threadId, model };
}

async function initializeAndVerifyAccount(client: CodexClient): Promise<void> {
  await client.request("initialize", {
    clientInfo: { name: "anycode", title: "AnyCode", version: "0.0.0" },
    capabilities: { experimentalApi: false },
  });
  client.notify("initialized");
  const account = await client.request<AccountResult>("account/read", {});
  if (account.account === null || account.account === undefined) throw new Error(CODEX_NOT_SIGNED_IN);
}

/** Testable native ordering: handshake/account are complete before a thread exists. */
export async function createNativeCodexSession(
  client: CodexClient,
  workspace: string,
  approvals?: CodexApprovalBridge,
): Promise<ConnectedCodexEngine> {
  await initializeAndVerifyAccount(client);
  const result = await client.request<ThreadResult>("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
  });
  const native = nativeThread(result, "thread/start");
  return { engine: new CodexEngine(client, native.threadId, approvals), ...native };
}

/** Strict native resume: the stored ref is used verbatim and never replaced. */
export async function resumeNativeCodexSession(
  client: CodexClient,
  workspace: string,
  externalSessionRef: string,
  approvals?: CodexApprovalBridge,
): Promise<ConnectedCodexEngine> {
  await initializeAndVerifyAccount(client);
  const resumed = await client.request<ThreadResult>("thread/resume", {
    threadId: externalSessionRef,
    cwd: workspace,
  });
  const native = nativeThread(resumed, "thread/resume");
  if (native.threadId !== externalSessionRef) {
    throw new Error("Codex thread/resume returned a different native thread");
  }
  await client.request("thread/read", { threadId: native.threadId, includeTurns: true });
  return { engine: new CodexEngine(client, native.threadId, approvals), ...native };
}

/** Starts a new native thread before anything is persisted. */
export async function startCodexEngine(options: CodexEngineCreateOptions): Promise<ConnectedCodexEngine> {
  let engine: CodexEngine | null = null;
  const approvals = new CodexApprovalBridge({
    broker: options.broker,
    activeTurn: () => engine?.activeTurnDetails ?? null,
    onTerminalDenial: (reason) => engine?.beginTerminalDenial(reason),
  });
  const client = new AppServerClient({ ...options, bootstrap: options.bootstrap, onServerRequest: approvals.handle });
  try {
    await client.start();
    const connected = await createNativeCodexSession(client, options.workspace, approvals);
    engine = connected.engine;
    return connected;
  } catch (error) {
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
    onTerminalDenial: (reason) => engine?.beginTerminalDenial(reason),
  });
  const client = new AppServerClient({ ...options, bootstrap: options.bootstrap, onServerRequest: approvals.handle });
  try {
    await client.start();
    const connected = await resumeNativeCodexSession(client, options.workspace, options.externalSessionRef, approvals);
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
  private turnNumber = 0;
  private activeTurn: { threadId: string; turnId: string } | null = null;
  private terminalError: Error | null = null;
  private disposed = false;
  private terminalDenialTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: CodexClient,
    readonly threadId: string,
    private readonly approvals?: CodexApprovalBridge,
    private readonly terminalDenialGraceMs = CODEX_TERMINAL_DENIAL_GRACE_MS,
  ) {
    // Interactive approval is advertised only after the exact W0 bridge is
    // installed; direct/test-only engines retain the fail-closed capability.
    this.capabilities = approvals === undefined ? CODEX_ENGINE_CAPABILITIES : CODEX_BRIDGED_CAPABILITIES;
  }

  get activeTurnDetails(): ActiveCodexTurn | null {
    return this.activeTurn;
  }

  /** Called only after a valid active native approval was denied or failed. */
  beginTerminalDenial(reason: string): void {
    if (this.terminalDenialTimer !== null || this.disposed) return;
    this.terminalDenialTimer = setTimeout(() => {
      this.terminalDenialTimer = null;
      if (this.activeTurn === null) return;
      this.terminalError ??= new Error(`${reason}; Codex did not complete the turn`);
      void this.client.close().catch(() => {});
    }, this.terminalDenialGraceMs);
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
    const iterator = this.client.notifications()[Symbol.asyncIterator]();
    const request = this.client.request<TurnResult>("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
    });
    const buffered: JsonRpcNotification[] = [];
    let next = iterator.next();
    let result: TurnResult;
    try {
      while (true) {
        const raced = await Promise.race([
          request.then((value) => ({ kind: "response" as const, value })),
          next.then((value) => ({ kind: "notification" as const, value })),
        ]);
        if (raced.kind === "response") {
          result = raced.value;
          break;
        }
        if (raced.value.done) throw this.terminalError ?? new Error("Codex app-server closed while starting a turn");
        buffered.push(raced.value.value);
        if (buffered.length > PRE_TURN_NOTIFICATION_LIMIT) {
          throw new Error("Codex app-server exceeded the pre-turn notification limit");
        }
        next = iterator.next();
      }
      const turnId = result.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) throw new Error("Codex turn/start returned no turn id");
      this.activeTurn = { threadId: this.threadId, turnId };
      const translator = new TurnTranslator({ threadId: this.threadId, turnId, turn });
      let terminal = false;
      const deliver = function* (notification: JsonRpcNotification): Generator<AgentEvent> {
        const events = translator.onNotification(notification);
        for (const event of events) {
          if (event.type === "loop_end") terminal = true;
          yield event;
        }
      };
      for (const notification of buffered) yield* deliver(notification);
      while (!terminal) {
        if (options.signal.aborted) await this.interruptActiveTurn();
        const current = await next;
        if (current.done) throw this.terminalError ?? new Error("Codex app-server closed during a turn");
        next = iterator.next();
        yield* deliver(current.value);
      }
    } catch (error) {
      const terminalError = this.terminalError ?? (error instanceof Error ? error : new Error(String(error)));
      this.terminalError = terminalError;
      this.approvals?.denyAll("Codex app-server failed", "turn_cancelled");
      yield { type: "error", error: terminalError };
      yield* this.terminalEvents(turn, terminalError, false);
    } finally {
      this.activeTurn = null;
      this.clearTerminalDenial();
    }
  }

  dispose(_reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposed = true;
    this.clearTerminalDenial();
    this.approvals?.denyAll("Codex engine is shutting down", "shutdown");
    void this.interruptActiveTurn();
    return this.client.close();
  }

  private async interruptActiveTurn(): Promise<void> {
    const active = this.activeTurn;
    if (active === null) return;
    try {
      await this.client.request("turn/interrupt", active);
    } catch {
      // close() remains the terminal disposal backstop.
    }
  }

  private clearTerminalDenial(): void {
    if (this.terminalDenialTimer !== null) {
      clearTimeout(this.terminalDenialTimer);
      this.terminalDenialTimer = null;
    }
  }

  private *terminalEvents(turn: number, error: Error, includeError = true): Generator<AgentEvent> {
    if (includeError) yield { type: "error", error };
    yield { type: "turn_end", turn, finishReason: "error" };
    yield { type: "loop_end", reason: "error", turns: turn };
  }
}

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

import type { AgentEvent, HistoryItem, PermissionMode, ReasoningEffort } from "@anycode/core";
import {
  CODEX_BOOT_RPC_TIMEOUT_MS,
  CODEX_POST_INTERRUPT_SETTLE_MS,
  CODEX_TURN_INTERRUPT_TIMEOUT_MS,
  CODEX_TURN_START_TIMEOUT_MS,
} from "../../../shared/codex-timeouts.js";
import type { EngineModelChoice, EnginePermissionPreset } from "../../../shared/protocol.js";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "../session-engine.js";
import type { IpcPermissionBroker } from "../../permission-broker.js";
import { CodexApprovalBridge, type ActiveCodexTurn } from "./approval-bridge.js";
import { AppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import { CodexModelCatalog } from "./catalog.js";
import { TurnTranslator } from "./event-translator.js";
import { NATIVE_PERSISTED, projectCodexHistory, type CodexThreadRead } from "./history-projection.js";
import {
  DEFAULT_CODEX_PRESET,
  codexPresetChoices,
  findCodexPreset,
  isEffectivePostureWeaker,
  type CodexPermissionPresetDefinition,
} from "./presets.js";
import type { CodexShadowLogPort } from "./shadow-log.js";
import { TurnItemIndex } from "./turn-item-index.js";
import type { JsonRpcNotification } from "./protocol.js";

/** Resume-history projection cap (cut §2(e)); pagination of `thread/read` beyond this is a documented residual. */
export const CODEX_HISTORY_MAX_ITEMS = 200;
/** Cap on a shadow-logged command's captured output (cut §2(e): outputHead capped at 8 KiB). */
const SHADOW_OUTPUT_HEAD_CAP = 8192;

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
  // TASK.39: a Codex session now selects among the app-server's OWN models
  // (`model/list`), validated host-side against that catalog. This flag means
  // "this engine can switch model", NOT "AnyCode's provider catalog applies" —
  // the provider catalog is never consulted for a Codex session.
  supportsModelSelection: true,
  // The effort axis stays engine-internal: Codex efforts are free-form strings
  // per model (low…ultra), not core's fixed ReasoningEffort union, so no core
  // effort selector is exposed. The engine still re-asserts the thread's own
  // effective effort on every turn (see turnSettingsOverride).
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

type ThreadResult = {
  thread?: { id?: unknown };
  model?: unknown;
  /** Effective-settings echo (cut §2(k).2) — consulted ONLY for the drift check, never reverse-mapped to a preset. */
  approvalPolicy?: unknown;
  sandbox?: unknown;
  reasoningEffort?: unknown;
};
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
  /** The preset the session is running under; the host persists it verbatim in the session `mode` column (cut §2(k).4). */
  presetId: string;
}

/**
 * The model/preset the session should boot with: the draft argv choice for a new
 * session, the persisted row for a resumed one. Both are UNVALIDATED opaque
 * strings at this point (they come from the renderer / an older DB row); every
 * one of them is checked here, host-side, before any RPC carries it.
 */
export interface CodexSessionSelection {
  model?: string;
  presetId?: string;
  /** A resumed session's stored ids predate this slice; an unrecognized one is a silent default, not a user error. */
  origin?: "draft" | "persisted";
}

/** Result of a host-side settings change request. `ok:false` never reaches the wire — it becomes a recoverable UI error. */
export type CodexSettingsChange =
  | { ok: true; model: string; activePresetId: string }
  | { ok: false; reason: string };

/** Everything the engine needs to re-assert the full effective posture on every turn (cut §2(k).1). */
interface CodexEngineSettings {
  workspace: string;
  catalog: CodexModelCatalog;
  model: string;
  preset: CodexPermissionPresetDefinition;
  /** Free-form Codex effort string (NOT core's ReasoningEffort); undefined -> `effort` is omitted from the override. */
  effort?: string;
  /** Boot-time warnings (unusable draft model, posture drift) — flushed into the first turn's event stream. */
  notices: AgentEvent[];
}

function warning(message: string): AgentEvent {
  return { type: "engine_notice", level: "warning", message };
}

/**
 * Resolves the preset id a session boots with. An unknown id can only come from
 * a stale renderer or a pre-TASK.39 session row (whose `mode` column holds a
 * CORE permission mode such as "build") — neither is a user-visible error, so
 * both quietly become the default posture. A DRAFT id the user actually chose is
 * different: if it does not exist, the user is told.
 */
function resolvePreset(selection: CodexSessionSelection | undefined, notices: AgentEvent[]): CodexPermissionPresetDefinition {
  const fallback = findCodexPreset(DEFAULT_CODEX_PRESET)!;
  const requested = selection?.presetId;
  if (requested === undefined) return fallback;
  const preset = findCodexPreset(requested);
  if (preset !== undefined) return preset;
  if (selection?.origin === "draft") {
    notices.push(warning(`Codex permission preset "${requested}" is unknown; using "${fallback.label}" instead.`));
  }
  return fallback;
}

/**
 * Resolves the model id to put on `thread/start`. Returns undefined whenever the
 * choice cannot be POSITIVELY validated against the live catalog — the server's
 * own default model is then used. This is the L7 fail-closed rule: an id that
 * cannot be proven to exist is never sent, because the server would accept it,
 * burn a turn on it, and fail late.
 */
function resolveModel(
  catalog: CodexModelCatalog,
  selection: CodexSessionSelection | undefined,
  notices: AgentEvent[],
): string | undefined {
  const requested = selection?.model;
  if (requested === undefined) return undefined;
  if (!catalog.available) {
    notices.push(warning(`Codex could not read its model list, so "${requested}" could not be verified; the default model is used.`));
    return undefined;
  }
  if (!catalog.has(requested)) {
    notices.push(warning(`Codex model "${requested}" is no longer available; the default model is used.`));
    return undefined;
  }
  return requested;
}

/** Effective settings from the thread echo — the ONLY server-side statement about posture (there is no `thread/settings/updated`, L6). */
function effectiveSettings(result: ThreadResult): { approvalPolicy?: unknown; sandbox?: unknown; effort?: string } {
  const effort = typeof result.reasoningEffort === "string" && result.reasoningEffort.length > 0 ? result.reasoningEffort : undefined;
  return {
    approvalPolicy: result.approvalPolicy,
    sandbox: result.sandbox,
    ...(effort !== undefined ? { effort } : {}),
  };
}

/** One warning, at most, when the server's posture is genuinely weaker than the preset promises (cut §2(k).2). */
function driftNotice(preset: CodexPermissionPresetDefinition, result: ThreadResult, notices: AgentEvent[]): void {
  if (!isEffectivePostureWeaker(preset, effectiveSettings(result))) return;
  notices.push(
    warning(
      `Codex reports a weaker sandbox than the "${preset.label}" preset; the preset is re-applied on the next turn.`,
    ),
  );
}

/** Boot-time settings assembly, shared by the fresh-start and resume paths. */
function buildSettings(
  workspace: string,
  catalog: CodexModelCatalog,
  preset: CodexPermissionPresetDefinition,
  result: ThreadResult,
  model: string,
  notices: AgentEvent[],
): CodexEngineSettings {
  driftNotice(preset, result, notices);
  // The model is the SERVER-CONFIRMED one from the thread echo, so the effort is
  // resolved against what the thread actually runs, not against what was asked for.
  const effort = catalog.resolveEffort(model, effectiveSettings(result).effort);
  return {
    workspace,
    catalog,
    model,
    preset,
    ...(effort !== undefined ? { effort } : {}),
    notices,
  };
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
  /** Draft (new session) or persisted (resume) model/preset choice; validated host-side, never trusted. */
  selection?: CodexSessionSelection;
  /** Host-owned shadow command log (cut §2(e)); absent only in tests that do not exercise resume-history. */
  shadowLog?: CodexShadowLogPort;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** The `item.type` of an `item/completed` notification, or undefined for a malformed one. */
function completedItemType(notification: JsonRpcNotification): string | undefined {
  const item = record(record(notification.params)?.item);
  return typeof item?.type === "string" ? item.type : undefined;
}

function nativeThread(result: ThreadResult, operation: string): { threadId: string; model: string } {
  const threadId = result.thread?.id;
  const model = result.model;
  if (typeof threadId !== "string" || threadId.length === 0 || typeof model !== "string" || model.length === 0) {
    throw new Error(`Codex ${operation} returned no usable thread id and model`);
  }
  return { threadId, model };
}

/**
 * Defensively coerces a raw `thread/read` response into `CodexThreadRead`
 * (cut §2(l) tolerant-decoder convention — an unexpected shape degrades to
 * "no history", never a boot-time throw). `turns` on the raw value is used
 * verbatim when present and array-shaped; every item's own field access is
 * ALREADY duck-typed/optional in history-projection.ts.
 */
function asThreadRead(value: unknown, fallbackThreadId: string): CodexThreadRead {
  const root = record(value);
  const thread = record(root?.thread);
  const id = typeof thread?.id === "string" && thread.id.length > 0 ? thread.id : fallbackThreadId;
  const turns = Array.isArray(thread?.turns) ? (thread.turns as CodexThreadRead["thread"]["turns"]) : [];
  return { thread: { id, turns } };
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

/**
 * Testable native ordering: handshake/account are complete before a thread
 * exists, and the model catalog is read before the FIRST id ever reaches the
 * wire — a draft model that no longer exists is caught here, not by a burned
 * turn (L7). The `thread/start` response is what confirms the initial values
 * (TASK.39 DoD-2): the model reported back by the server is the one the session
 * runs and persists, whatever was asked for.
 */
export async function createNativeCodexSession(
  client: CodexClient,
  workspace: string,
  approvals?: CodexApprovalBridge,
  overrides?: Partial<CodexEngineTimeouts>,
  selection?: CodexSessionSelection,
  shadowLog?: CodexShadowLogPort,
): Promise<ConnectedCodexEngine> {
  const bounds = timeouts(overrides);
  await initializeAndVerifyAccount(client, bounds.bootRpcMs);
  const catalog = await CodexModelCatalog.load(client);
  const notices: AgentEvent[] = [];
  const preset = resolvePreset(selection, notices);
  const model = resolveModel(catalog, selection, notices);
  const result = await client.request<ThreadResult>("thread/start", {
    cwd: workspace,
    approvalPolicy: preset.threadParams.approvalPolicy,
    sandbox: preset.threadParams.sandbox,
    ...(model !== undefined ? { model } : {}),
  }, { timeoutMs: bounds.bootRpcMs });
  const native = nativeThread(result, "thread/start");
  const settings = buildSettings(workspace, catalog, preset, result, native.model, notices);
  return {
    // A fresh thread has zero prior turns: no history to hydrate, and the
    // FIRST turn this launch runs is native turn ordinal 0 (cut §2(e)).
    engine: new CodexEngine(client, native.threadId, approvals, overrides, settings, shadowLog, 0, []),
    ...native,
    presetId: preset.id,
  };
}

/**
 * Strict native resume: the stored ref is used verbatim and never replaced.
 * Posture survives the resume through the PERSISTED preset id (cut §2(k).4), not
 * through the server echo — L8 makes the echo unusable as a source of truth
 * (`untrusted` comes back as `on-request`). The posture is then re-asserted in
 * full on the next `turn/start`, so a resumed thread converges regardless of
 * what the server currently believes.
 */
export async function resumeNativeCodexSession(
  client: CodexClient,
  workspace: string,
  externalSessionRef: string,
  approvals?: CodexApprovalBridge,
  overrides?: Partial<CodexEngineTimeouts>,
  selection?: CodexSessionSelection,
  shadowLog?: CodexShadowLogPort,
): Promise<ConnectedCodexEngine> {
  const bounds = timeouts(overrides);
  await initializeAndVerifyAccount(client, bounds.bootRpcMs);
  const catalog = await CodexModelCatalog.load(client);
  const notices: AgentEvent[] = [];
  const preset = resolvePreset(selection, notices);
  const resumed = await client.request<ThreadResult>("thread/resume", {
    threadId: externalSessionRef,
    cwd: workspace,
  }, { timeoutMs: bounds.bootRpcMs });
  const native = nativeThread(resumed, "thread/resume");
  if (native.threadId !== externalSessionRef) {
    throw new Error("Codex thread/resume returned a different native thread");
  }
  // The resume-history hydration (cut §2(e)) runs exactly here, ONCE, before
  // any new turn: `thread/read` is the only call that ever carries the full
  // native `turns[]` array (`thread/resume`'s own response does not).
  const rawRead = await client.request<unknown>(
    "thread/read",
    { threadId: native.threadId, includeTurns: true },
    { timeoutMs: bounds.bootRpcMs },
  );
  const threadRead = asThreadRead(rawRead, native.threadId);
  const shadow = shadowLog !== undefined ? await shadowLog.list(native.threadId) : [];
  const historyItems = projectCodexHistory(threadRead, shadow, {
    maxItems: CODEX_HISTORY_MAX_ITEMS,
    // A thread with turns but zero shadow rows is either pre-slice or
    // resumed on another machine (cut §2(e) degradation (a)) — the fallback
    // marker documents the gap rather than silently showing an incomplete
    // transcript. A brand-new thread (zero turns) has nothing to lose either way.
    shadowMissing: shadow.length === 0 && (threadRead.thread.turns?.length ?? 0) > 0,
  });
  // The live turns THIS launch runs continue the native turns[] sequence —
  // its current length is exactly the ordinal the next turn will occupy.
  const baseTurnOrdinal = threadRead.thread.turns?.length ?? 0;
  // A model that vanished from the catalog between sessions must not silently
  // ride the next turn/start override: fall back to the thread's own model and
  // say so (recoverable, TASK.39 DoD-2), rather than burning the user's turn.
  const stored = resolveModel(catalog, selection, notices);
  const model = stored ?? native.model;
  const settings = buildSettings(workspace, catalog, preset, resumed, model, notices);
  return {
    engine: new CodexEngine(client, native.threadId, approvals, overrides, settings, shadowLog, baseTurnOrdinal, historyItems),
    threadId: native.threadId,
    model,
    presetId: preset.id,
  };
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
    const connected = await createNativeCodexSession(client, options.workspace, approvals, options.timeouts, options.selection, options.shadowLog);
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
    const connected = await resumeNativeCodexSession(
      client,
      options.workspace,
      options.externalSessionRef,
      approvals,
      options.timeouts,
      options.selection,
      options.shadowLog,
    );
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
  /**
   * Count of native turns THIS launch has actually started, incremented ONLY
   * once `turn/start` has returned a real turn id (LOW1 fix) — never at the
   * top of `runTurn()` alongside `turnNumber`. `turnNumber` is burned by an
   * early return (closed engine, unsupported attachments) before any native
   * turn exists; anchoring shadow rows to it would silently skip an ordinal
   * and misalign every later shadow row's `turnOrdinal` against the resumed
   * thread's real `turns[]` indexing. This counter cannot drift that way: a
   * turn that never reaches a confirmed turn id never advances it.
   */
  private nativeTurnCount = 0;
  private activeTurn: ActiveCodexTurn | null = null;
  /** Item index of the turn currently being started/run; written by the transport tap. */
  private activeItems: TurnItemIndex | null = null;
  /** Per-turn latch: exactly one `turn/interrupt` may ever be sent for one turn. */
  private interruptSent = false;
  private terminalError: Error | null = null;
  private disposed = false;
  /** Model/preset/effort state; absent only for the bare test-constructed engine (no boot, no catalog). */
  private readonly settings: CodexEngineSettings | undefined;
  /**
   * A validated model/preset change that no `turn/start` has carried yet. There
   * is NO server-side ack channel (L6: `thread/settings/updated` never arrives),
   * so an accepted `turn/start` IS the ack — this holds the snapshot to confirm
   * when that happens (cut §2(k).3).
   */
  private pendingSettings: { model: string; activePresetId: string } | null = null;
  /**
   * DISPLAY TRUTH: the settings a `turn/start` has actually carried — what the
   * UI may legitimately call "active". `this.settings` holds the CHOSEN values
   * (mutated the instant the user picks one, and the sole source of
   * `turnSettingsOverride()` + persistence); the two differ exactly while a
   * change is pending, which is the whole point of the two-phase ack (cut
   * §2(k).3). Conflating them made `snapshot()` report a never-applied choice as
   * active on every renderer reload.
   *
   * At construction chosen === applied BY DESIGN (cut §2(k).1): a respawn boots
   * from the PERSISTED posture, which the very first `turn/start` re-asserts, so
   * there is nothing pending about it.
   */
  private applied: { model: string; activePresetId: string };
  private readonly appliedListeners = new Set<(snapshot: { model: string; activePresetId: string }) => void>();

  constructor(
    private readonly client: CodexClient,
    readonly threadId: string,
    private readonly approvals?: CodexApprovalBridge,
    overrides?: Partial<CodexEngineTimeouts>,
    settings?: CodexEngineSettings,
    /** Host-owned shadow command log (cut §2(e)); undefined only for bare test-constructed engines. */
    private readonly shadowLog?: CodexShadowLogPort,
    /** This thread's turn count as of boot (0 for a fresh thread) — the ordinal the FIRST live turn of this launch occupies. */
    private readonly baseTurnOrdinal = 0,
    /** The one-shot resume-history projection (cut §2(e)); `[]` for a fresh session. */
    private readonly bootHistoryItems: readonly HistoryItem[] = [],
  ) {
    // Interactive approval is advertised only after the exact W0 bridge is
    // installed; direct/test-only engines retain the fail-closed capability.
    this.capabilities = approvals === undefined ? CODEX_ENGINE_CAPABILITIES : CODEX_BRIDGED_CAPABILITIES;
    this.bounds = timeouts(overrides);
    this.settings = settings;
    this.applied = this.chosen();
    this.unobserve = this.client.observeNotifications?.((notification) => this.indexItem(notification)) ?? (() => {});
  }

  get activeTurnDetails(): ActiveCodexTurn | null {
    return this.activeTurn;
  }

  mode(): PermissionMode {
    // Existing wire vocabulary has no native-policy projection yet. `build`
    // is display-only: Session capability gates prevent it becoming a core
    // permission policy or a mutable Codex setting. Codex posture lives in its
    // OWN preset vocabulary (presets.ts) and never touches core's permission
    // engine or its always-allow rules (TASK.39 §5).
    return "build";
  }

  reasoningEffort(): ReasoningEffort | undefined {
    return undefined;
  }

  setReasoningEffort(_effort: ReasoningEffort | undefined): void {
    // Codex efforts are per-model free-form strings, not core's fixed union;
    // the thread's effective effort is re-asserted from the catalog instead
    // (turnSettingsOverride), never set from core's effort vocabulary.
  }

  /** The resume projection built ONCE at boot (cut §2(e)) — `[]` for a fresh session. Session hydrates `bootHistory` from exactly this. */
  historyItems(): readonly HistoryItem[] {
    return this.bootHistoryItems;
  }

  // ── engine-owned settings seam (host/session.ts `engineSettings`) ──────────
  // Session speaks to these structurally; it never imports this class.

  /**
   * Display truth = our OWN state, never the server echo (L8 makes the echo
   * un-mappable) — and specifically the APPLIED state, never the merely chosen
   * one. A pending change is reported through `pendingSnapshot()` and the
   * `state:"pending"` message, never by pretending it is already active.
   */
  snapshot(): { model: string; activePresetId: string } {
    return { ...this.applied };
  }

  /** The values the user has CHOSEN: what the next `turn/start` will carry and what persistence records. */
  private chosen(): { model: string; activePresetId: string } {
    return { model: this.settings?.model ?? "", activePresetId: this.settings?.preset.id ?? DEFAULT_CODEX_PRESET };
  }

  /**
   * The un-applied delta, or null when chosen === applied. Session re-asserts
   * this on every `ui_ready` (cut §2(k).3): the pending message that announced
   * the change is a one-shot in the replay ring, and a renderer that reloads
   * after it was evicted — or that folds it away because it compares equal to a
   * wrongly-advanced "current" — would otherwise show the change as active.
   */
  pendingSnapshot(): { model: string; activePresetId: string } | null {
    return this.pendingSettings === null ? null : { ...this.pendingSettings };
  }

  models(): EngineModelChoice[] {
    return this.settings?.catalog.choices() ?? [];
  }

  presets(): EnginePermissionPreset[] {
    // The preset table is a compile-time constant: it is offered even when the
    // model catalog could not be read, because posture must never depend on the
    // model list being reachable.
    return this.settings === undefined ? [] : codexPresetChoices();
  }

  /**
   * Host-side model validation (cut §2(j)) — the whole reason catalog.ts exists.
   * NOTHING is sent to the server here: the change is recorded and the next
   * `turn/start` carries it. An id the catalog does not contain is refused
   * before any RPC, so an unsupported/removed model can never burn a turn (L7).
   */
  selectModel(id: string): CodexSettingsChange {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Codex model selection is unavailable for this session." };
    if (!settings.catalog.available) {
      return { ok: false, reason: "Codex could not read its model list; start a new session to retry." };
    }
    if (!settings.catalog.has(id)) {
      return { ok: false, reason: `Codex model "${id}" is not available for this account.` };
    }
    settings.model = id;
    // The held effort may not exist on the new model; the catalog re-resolves it
    // (falling back to that model's own default) so the override stays valid.
    const effort = settings.catalog.resolveEffort(id, settings.effort);
    if (effort === undefined) delete settings.effort;
    else settings.effort = effort;
    return this.markPending();
  }

  /** Membership in the frozen preset table is the ONLY way a posture is expressible — no raw policy/config from the renderer. */
  selectPreset(id: string): CodexSettingsChange {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Codex permission presets are unavailable for this session." };
    const preset = findCodexPreset(id);
    if (preset === undefined) {
      return { ok: false, reason: `Unknown Codex permission preset "${id}".` };
    }
    settings.preset = preset;
    return this.markPending();
  }

  /** Fires when a `turn/start` has actually carried a pending change (the two-phase "applied" ack). */
  onSettingsApplied(listener: (snapshot: { model: string; activePresetId: string }) => void): () => void {
    this.appliedListeners.add(listener);
    return () => this.appliedListeners.delete(listener);
  }

  /**
   * Pending is a DELTA, not a flag: choosing a value back to what is already
   * applied leaves nothing pending (the user undid their own change before it
   * ever rode a turn). The returned change always carries the CHOSEN values —
   * that is what the `state:"pending"` message announces.
   */
  private markPending(): CodexSettingsChange {
    const chosen = this.chosen();
    this.pendingSettings =
      chosen.model === this.applied.model && chosen.activePresetId === this.applied.activePresetId ? null : chosen;
    return { ok: true, ...chosen };
  }

  /**
   * The full effective posture, re-derived from the persisted preset and put on
   * EVERY `turn/start` — not merely on the first turn after a change (cut
   * §2(k).1). The override is documented as applying to "this turn and
   * subsequent turns" and is idempotent (L3), so re-asserting it costs nothing
   * and makes the posture self-healing: whatever the server echoes back (L8:
   * `untrusted` degrades to `on-request`, `writableRoots` empties), the thread is
   * put back under the user's chosen posture at the start of every single turn.
   *
   * `model` rides the override ONLY when the live catalog positively contains it
   * (L7 fail-closed): an unverifiable id — catalog unreadable, or a thread whose
   * server-side model has since been removed — is omitted so the server keeps
   * using its own, rather than accepting ours and failing the turn late.
   */
  private turnSettingsOverride(): Record<string, unknown> {
    const settings = this.settings;
    if (settings === undefined) return {};
    const override = settings.preset.turnOverride(settings.workspace);
    const verifiedModel = settings.catalog.has(settings.model) ? settings.model : undefined;
    return {
      ...(verifiedModel !== undefined ? { model: verifiedModel } : {}),
      ...(verifiedModel !== undefined && settings.effort !== undefined ? { effort: settings.effort } : {}),
      approvalPolicy: override.approvalPolicy,
      sandboxPolicy: override.sandboxPolicy,
    };
  }

  /** Boot-time warnings (unusable draft model, posture drift) are delivered inside the first turn's stream — the only channel an AgentEvent has. */
  private drainNotices(): AgentEvent[] {
    const settings = this.settings;
    if (settings === undefined || settings.notices.length === 0) return [];
    return settings.notices.splice(0, settings.notices.length);
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
    // Boot-time notices (drift / unusable draft model) have no wire of their own:
    // an AgentEvent only travels inside a turn, so they are flushed here, once.
    for (const notice of this.drainNotices()) yield notice;

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
    // Captured BEFORE the request is written: this exact set is what the server
    // is about to be told, so it is also exactly what an "applied" ack may claim.
    const applying = this.pendingSettings;
    const request = this.client.request<TurnResult>("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
      ...this.turnSettingsOverride(),
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
      // A native turn now unambiguously exists — this is the ONLY point that
      // may advance nativeTurnCount (LOW1 fix): this launch's live turns
      // continue the thread's own turns[] sequence (cut §2(e)), so the
      // ordinal shadow rows anchor to must track turns that actually
      // happened, not `runTurn()` invocations (some of which return before a
      // native turn ever starts).
      const turnOrdinal = this.baseTurnOrdinal + this.nativeTurnCount;
      this.nativeTurnCount += 1;
      // Phase 2 of the ack (cut §2(k).3): the server ACCEPTED a turn/start that
      // carried the new posture. That acceptance — not a notification, of which
      // there is none — is the confirmation. A turn/start that errored or timed
      // out never reaches here, so `pending` correctly stays pending.
      if (applying !== null && this.pendingSettings === applying) {
        this.pendingSettings = null;
        // The server accepted a turn/start carrying these values: they are now
        // — and only now — the APPLIED posture the UI may display as active.
        this.applied = applying;
        for (const listener of this.appliedListeners) listener(applying);
      }
      this.activeTurn = { threadId: this.threadId, turnId, items };
      const translator = new TurnTranslator({ threadId: this.threadId, turnId, turn, items });
      let terminal = false;
      // Two independent per-turn counters, both reset to 0 for every turn
      // (W6 fix — cut §2(e) errata): `seqInTurn` is the raw live-completion
      // order (every `item/completed`, dropped items included — the OLD,
      // sole counter, merely renamed). `nativeVisibleCompleted` counts only
      // completions whose item type is in NATIVE_PERSISTED — the exact subset
      // `thread/read` will hand back on resume. A shadow row's
      // `positionInTurn` must be expressed in the SECOND counter's space, not
      // the first: the merge (history-projection.ts) walks the native array
      // `thread/read` actually returns, and a `reasoning` item (or any other
      // dropped type) between two native items must not shift a command's
      // anchor relative to them.
      let seqInTurn = 0;
      let nativeVisibleCompleted = 0;
      // Captured (not `this`-bound): `deliver` stays a plain generator
      // function so `yield*` delegation below is unchanged from before this
      // shadow-write hook existed.
      const engine = this;
      const deliver = function* (notification: JsonRpcNotification): Generator<AgentEvent> {
        if (notification.method === "item/completed") {
          const itemType = completedItemType(notification);
          // Recorded with BOTH counters' values BEFORE this notification's own
          // effect is applied — a command itself is never NATIVE_PERSISTED, so
          // recording before vs. after nativeVisibleCompleted's own (absent)
          // increment is equivalent, but seqInTurn's pre-increment value is
          // load-bearing (matches every other row's "my own position", not
          // "the next row's position").
          engine.recordShadowItem(notification, turnId, turnOrdinal, nativeVisibleCompleted, seqInTurn);
          seqInTurn += 1;
          if (itemType !== undefined && NATIVE_PERSISTED.has(itemType)) nativeVisibleCompleted += 1;
        }
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
    this.appliedListeners.clear();
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

  /**
   * Shadow command log writer (cut §2(e), errata W6): the ONLY host-side
   * write of a `commandExecution` completion, from the SAME `item/completed`
   * notification the live translator already consumes. `positionInTurn` is
   * `nativeVisibleCompleted`'s value at the moment this command completed —
   * the count of NATIVE_PERSISTED completions so far this turn, i.e. the
   * native array index this row must be inserted before on resume
   * (history-projection.ts's `mergeTurnItems`). `seqInTurn` is the raw
   * live-completion order (both counters live in `deliver`, `runTurn()`).
   * Fire-and-forget: `shadowLog.record` never blocks or fails a live turn.
   */
  private recordShadowItem(
    notification: JsonRpcNotification,
    turnId: string,
    turnOrdinal: number,
    positionInTurn: number,
    seqInTurn: number,
  ): void {
    if (this.shadowLog === undefined) return;
    const params = record(notification.params);
    if (params === null || params.threadId !== this.threadId || params.turnId !== turnId) return;
    const item = record(params.item);
    if (item === null || item.type !== "commandExecution" || typeof item.id !== "string") return;
    if (typeof item.command !== "string") return;
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
    const aggregated = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
    this.shadowLog.record(this.threadId, item.id, {
      turnOrdinal,
      positionInTurn,
      seqInTurn,
      command: item.command,
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(aggregated !== undefined ? { outputHead: aggregated.slice(0, SHADOW_OUTPUT_HEAD_CAP) } : {}),
    });
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

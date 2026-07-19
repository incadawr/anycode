/**
 * The native Claude Code session runtime (cut §1.4). Like the Codex engine it
 * composes none of AnyCode's AgentLoop or tools: the `claude` CLI owns those
 * policies, and this class only drives its turn lifecycle and projects its
 * stream through event-translator.ts.
 *
 * Turn lifecycle — the invariants that make Stop safe here:
 *
 *  1. ONE abort promise is raced into EVERY await of the turn, so a Stop that
 *     lands while the notification iterator is parked is observed immediately
 *     (a `signal.aborted` poll between awaits never fires while idle — the
 *     defect this shape exists to prevent).
 *  2. `interrupt` is latched per turn. The CLI answers it with a receipt
 *     (`{still_queued:[]}` when it lands before dispatch, `w0-03-interrupt-early`)
 *     and then terminates the turn with `result{terminal_reason:"aborted_streaming"}`,
 *     which the translator maps to `loop_end:"cancelled"`.
 *  3. A Stop while an approval is PARKED needs no cancel bookkeeping from us:
 *     the CLI withdraws its own `can_use_tool` via `control_cancel_request`
 *     (`w0-03-interrupt-pending`), and ClaudeClient's pairing rule turns our
 *     late answer into a no-op. We only settle the broker so the modal closes.
 *
 * The context meter is pulled from `get_context_usage` AFTER the terminal
 * `result` ($0) — never summed out of `result.usage` (cut §0.3-5). The codex
 * C-bug-1 lesson is that a plausible self-made meter is worse than none: the
 * model's context window is a fact the CLI knows and we do not.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, HistoryItem, PermissionMode, ReasoningEffort } from "@anycode/core";
import { CLAUDE_POST_INTERRUPT_SETTLE_MS } from "../../../shared/claude-timeouts.js";
import type { EngineModelChoice, EnginePermissionPreset } from "../../../shared/protocol.js";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "../session-engine.js";
import type { IpcPermissionBroker } from "../../permission-broker.js";
import { ClaudeApprovalBridge } from "./approval-bridge.js";
import { ClaudeClient, type ClaudeClientOptions } from "./claude-client.js";
import { ClaudeTurnTranslator } from "./event-translator.js";
import { ClaudeModelCatalog, isClaudeEffortLevel } from "./models.js";
import {
  permissionModeToFlag,
  type ClaudeResultMessage,
  type ClaudeStreamMessage,
  type ClaudeSystemInitMessage,
  type PermissionMode as ClaudeWirePermissionMode,
} from "./protocol.js";
import {
  CLAUDE_PERMISSION_PRESETS,
  DEFAULT_CLAUDE_PRESET,
  claudePresetChoices,
  findClaudePreset,
  findClaudePresetByMode,
  type ClaudePermissionPresetDefinition,
} from "./presets.js";
import { decodeClaudeUsage, quotaNotice, type ClaudeQuotaSnapshot } from "./quota.js";

export const CLAUDE_NOT_SIGNED_IN =
  "Claude Code is not signed in — run `claude auth login` in a terminal, then start a new Claude session.";

// Mirrors `isClaudeSignedIn` in main/claude-doctor.ts (host cannot import across
// the main/** boundary). A signed-in subscription profile's `initialize` response
// omits `tokenSource` entirely (live handshake, binary 2.1.215) — the fallback to
// `subscriptionType` is what distinguishes that case from a genuinely signed-out one.
function isClaudeSignedIn(account: { tokenSource?: string; subscriptionType?: string }): boolean {
  if (typeof account.tokenSource === "string") return account.tokenSource !== "none";
  return account.subscriptionType !== undefined;
}

export const CLAUDE_ENGINE_CAPABILITIES: EngineCapabilities = {
  supportsCorePermissions: false,
  supportsRewind: false,
  supportsWorkflow: false,
  supportsGitMutations: false,
  // Real provider-fed usage from `get_context_usage` (cut §4). The codex
  // C-bug-1 lesson is baked in: flag, gate, and live path are asserted together.
  supportsContextUsage: true,
  // A SCOPE decision, not missing data: `get_context_usage.categories[]` does
  // carry a 7-category breakdown live; mapping it onto core's ContextBreakdown
  // is CC-E work, and the flag flips there with zero wire change.
  supportsContextBreakdown: false,
  supportsInteractiveApprovals: false,
  // `total_cost_usd` rides every `result`. Displayed as an ESTIMATE for a
  // subscription account — real billing is Anthropic's side.
  costAccounting: true,
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  // R-W0-9: live image delivery was DISPROVEN (the model answered "no attached
  // image data" for a user frame that demonstrably carried the image block).
  // False honestly closes the Composer's attach path until that is re-probed.
  supportsImages: false,
  supportsTasks: false,
  supportsFileSnapshots: false,
};

const CLAUDE_BRIDGED_CAPABILITIES: EngineCapabilities = {
  ...CLAUDE_ENGINE_CAPABILITIES,
  supportsInteractiveApprovals: true,
};

export interface ClaudeEngineTimeouts {
  postInterruptSettleMs: number;
}

export const DEFAULT_CLAUDE_ENGINE_TIMEOUTS: ClaudeEngineTimeouts = {
  postInterruptSettleMs: CLAUDE_POST_INTERRUPT_SETTLE_MS,
};

/** The narrow transport seam, so lifecycle tests need no real child process. */
export interface ClaudeTransport {
  initialize(): Promise<{ commands: unknown[]; models: unknown[]; account: { tokenSource?: string; subscriptionType?: string } }>;
  controlRequest<T>(subtype: string, request?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  getContextUsage(): Promise<Record<string, unknown>>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  sendUserMessage(content: string | unknown[]): void;
  notifications(): AsyncIterable<ClaudeStreamMessage>;
  close(): Promise<void>;
}

/** Draft (new session) or persisted (resume) selection; both are UNVALIDATED opaque strings at this point. */
export interface ClaudeSessionSelection {
  model?: string;
  presetId?: string;
  /**
   * Initial effort (TASK.75). Unlike `model`/`presetId`, this has no
   * "persisted, trust the origin distinction" branch: the model catalog that
   * would validate it against a specific model is not known pre-spawn either
   * way, so both a draft pick and a resumed row are validated the same way,
   * against the fixed `CLAUDE_EFFORT_LEVELS` vocabulary (`resolveEffort`).
   */
  effort?: string;
  origin?: "draft" | "persisted";
}

export interface ConnectedClaudeEngine {
  engine: ClaudeEngine;
  /** The native session id we assigned at spawn (`--session-id`) — persisted as `externalSessionRef`. */
  sessionRef: string;
  model: string;
  presetId: string;
}

interface ClaudeEngineSettings {
  catalog: ClaudeModelCatalog;
  /** The catalog `value` currently selected; "" when the catalog was unreadable. */
  model: string;
  preset: ClaudePermissionPresetDefinition;
  effort?: string;
  /**
   * Remembered effort per model id (TASK.60 shape, mirrors
   * `CodexEngineSettings.effortsByModel`), restored on `selectModel`. In-RAM
   * only, scoped to this one live engine instance — same as Codex's own
   * memory, which likewise never reaches a durable store.
   */
  effortsByModel: Map<string, string>;
  /** Boot-time warnings (unusable draft model, quota pressure) flushed into the first turn's stream. */
  notices: AgentEvent[];
}

function warning(message: string): AgentEvent {
  return { type: "engine_notice", level: "warning", message };
}

/**
 * Resolves the preset a session boots with. An unknown id can only come from a
 * stale renderer or an older session row — neither is a user-visible error, so
 * both quietly become the default. A DRAFT id the user actually picked is
 * different: if it does not exist, they are told.
 */
function resolvePreset(selection: ClaudeSessionSelection | undefined, notices: AgentEvent[]): ClaudePermissionPresetDefinition {
  const fallback = findClaudePreset(DEFAULT_CLAUDE_PRESET)!;
  const requested = selection?.presetId;
  if (requested === undefined) return fallback;
  const preset = findClaudePreset(requested);
  if (preset !== undefined) return preset;
  if (selection?.origin === "draft") {
    notices.push(warning(`Claude permission preset "${requested}" is unknown; using "${fallback.label}" instead.`));
  }
  return fallback;
}

/**
 * Resolves the model id to spawn with. Returns undefined whenever the choice
 * cannot be POSITIVELY validated against the live catalog — the CLI's own
 * default is then used. Fail-closed: an unverifiable id would be accepted at
 * spawn and fail the turn late.
 */
function resolveModel(
  catalog: ClaudeModelCatalog,
  selection: ClaudeSessionSelection | undefined,
  notices: AgentEvent[],
): string | undefined {
  const requested = selection?.model;
  if (requested === undefined) return undefined;
  if (!catalog.available) {
    notices.push(warning(`Claude could not read its model list, so "${requested}" could not be verified; the default model is used.`));
    return undefined;
  }
  if (!catalog.has(requested)) {
    notices.push(warning(`Claude model "${requested}" is not available for this account; the default model is used.`));
    return undefined;
  }
  return requested;
}

/**
 * Resolves the effort to spawn with. Validated against the fixed
 * `CLAUDE_EFFORT_LEVELS` vocabulary only — the model catalog that would
 * validate a level against a SPECIFIC model is not readable until after
 * `initialize`, exactly the constraint `resolveModel` documents for model
 * ids, except here the closed 5-value CLI vocabulary makes a useful
 * pre-spawn check possible where the open-ended model catalog offers none.
 * A model that ends up not supporting this level is the server's own
 * rejection to make (TASK.75 open question #4); `connectClaudeEngine`
 * re-validates against the confirmed model once the catalog is known and
 * only then records a local `settings.effort`.
 */
function resolveEffort(selection: ClaudeSessionSelection | undefined, notices: AgentEvent[]): string | undefined {
  const requested = selection?.effort;
  if (requested === undefined) return undefined;
  if (!isClaudeEffortLevel(requested)) {
    if (selection?.origin === "draft") {
      notices.push(warning(`Claude effort "${requested}" is not a recognized level; the default effort is used.`));
    }
    return undefined;
  }
  return requested;
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
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export interface ClaudeEngineCreateOptions extends Omit<ClaudeClientOptions, "bootstrap" | "onControlRequest" | "permissionModeFlag" | "model" | "effort" | "sessionId" | "resume"> {
  bootstrap: EngineBootstrap;
  broker: IpcPermissionBroker;
  selection?: ClaudeSessionSelection;
  timeouts?: Partial<ClaudeEngineTimeouts>;
}

/**
 * Shared boot path for a fresh spawn (`--session-id <uuid>`) and a resume
 * spawn (`--resume <ref>`, CC-D) — the two differ ONLY in which of
 * `ClaudeClient`'s two mutually-exclusive spawn fields is set
 * (`buildClaudeSpawnArgs` prefers `sessionId`, cut §1.3). Everything else —
 * handshake ordering, model/preset resolution, quota seed, bounded release on
 * a failed boot step — is identical: the handshake proves the CLI answers AND
 * that the profile is signed in, and the model catalog is read from that same
 * `initialize` response, so a draft/persisted model that no longer exists is
 * caught here, before any turn is burned.
 */
async function connectClaudeEngine(
  options: ClaudeEngineCreateOptions,
  spawn: { sessionId: string } | { resume: string },
): Promise<ConnectedClaudeEngine> {
  const notices: AgentEvent[] = [];
  const resuming = !("sessionId" in spawn);
  const preset = resolvePreset(options.selection, notices);
  const requestedEffort = resolveEffort(options.selection, notices);
  const sessionRef = "sessionId" in spawn ? spawn.sessionId : spawn.resume;
  let engine: ClaudeEngine | null = null;
  const approvals = new ClaudeApprovalBridge({
    broker: options.broker,
    activePresetId: () => engine?.activePresetId ?? preset.id,
  });
  // The catalog is not known until after the handshake, so a draft model cannot
  // ride the spawn argv. It is applied right after `initialize` via `set_model`
  // — live-proven to apply immediately, with a rejection being a clean no-op.
  //
  // On RESUME neither posture is applied here (cut §1.5 hazard (б)): the native
  // session kept its OWN model and permissionMode across process death (probe
  // #4), and our persisted row may have drifted from them. Sending
  // `--permission-mode`/`set_model` before the first `system/init` would
  // overwrite the surviving truth with a stale row — the exact failure where a
  // row saying `workspace` silently re-widens a session the CLI left at `ask`.
  // The persisted values stay a PROVISIONAL display until that init arrives and
  // `reconcileFromInit` replaces them with the native fact.
  //
  // Effort is deliberately NOT held back the way model/permissionMode are:
  // `system/init` carries no effort field at all (contract §1), so there is
  // no native state a resend could clobber on resume — unlike model, where a
  // stale row could overwrite a session's own surviving choice, an omitted
  // `--effort` here would simply forget ours for no benefit.
  const client = new ClaudeClient({
    ...options,
    ...(resuming ? {} : { permissionModeFlag: permissionModeToFlag(preset.mode) }),
    ...(requestedEffort !== undefined ? { effort: requestedEffort } : {}),
    ...spawn,
    bootstrap: options.bootstrap,
    onControlRequest: approvals.handle,
  });
  try {
    await client.start();
    const initialized = await client.initialize();
    if (!isClaudeSignedIn(initialized.account)) {
      throw new Error(CLAUDE_NOT_SIGNED_IN);
    }
    const catalog = ClaudeModelCatalog.fromInitialize(initialized.models);
    let model: string;
    if (resuming) {
      // Provisional only — never sent. The resumed session's own model is
      // reported by its first `system/init` and adopted there
      // (`reconcileFromInit`). A persisted id the catalog no longer knows
      // degrades silently, exactly as `resolvePreset` does for a stale preset:
      // it is not a choice the user just made, so it is not a user-visible error.
      const persisted = options.selection?.model;
      model = persisted !== undefined && catalog.has(persisted) ? persisted : catalog.defaultValue() ?? "";
    } else {
      const requested = resolveModel(catalog, options.selection, notices);
      model = requested ?? catalog.defaultValue() ?? "";
      if (requested !== undefined) {
        try {
          await client.controlRequest("set_model", { model: requested });
        } catch {
          // A rejected set_model is a clean no-op live (`w0-16-setmodel.jsonl`) —
          // the prior model survives, so the session boots on the CLI default.
          notices.push(warning(`Claude refused the model "${requested}"; the default model is used.`));
          model = catalog.defaultValue() ?? "";
        }
      }
    }
    // The value actually sent at spawn is only known-good against the fixed
    // vocabulary (`resolveEffort` above), not against THIS model — the
    // catalog didn't exist yet. Re-validate now that both are known, so the
    // local record never claims an effort the confirmed model doesn't
    // support (same fail-closed discipline `resolveModel` applies to ids).
    const effort = catalog.resolveEffort(model, requestedEffort);
    const effortsByModel = new Map<string, string>();
    if (effort !== undefined) effortsByModel.set(model, effort);
    const settings: ClaudeEngineSettings = { catalog, model, preset, effortsByModel, notices, ...(effort !== undefined ? { effort } : {}) };
    engine = new ClaudeEngine(client, sessionRef, approvals, settings, options.timeouts);
    // $0 quota snapshot, seeded before the first turn so a user already at
    // their limit learns it from the first reply rather than a failed turn.
    await engine.refreshQuota();
    return { engine, sessionRef, model, presetId: preset.id };
  } catch (error) {
    // Any bounded boot step that fails releases the child — a failed boot must
    // never leave a live `claude` process behind.
    await client.close();
    throw error;
  }
}

/**
 * Boots a fresh native Claude session. The native session id is OURS:
 * `--session-id <uuid>` is passed at spawn, so the resumable ref exists at
 * boot time. `system/init` (turn-scoped, probe #1) later confirms it, but
 * nothing waits for it.
 */
export async function startClaudeEngine(options: ClaudeEngineCreateOptions): Promise<ConnectedClaudeEngine> {
  return connectClaudeEngine(options, { sessionId: randomUUID() });
}

/**
 * Resumes one exact persisted native session via `--resume <ref>` (CC-D-min,
 * cut §1.5, probe #4: `session_id`/model/`permissionMode` all survive process
 * death). It deliberately never falls back to a fresh session — a resume
 * whose native side has expired (retention, test-hazard в) surfaces as a
 * boot failure, not a silent new session under the old id. The engine's own
 * `model`/`presetId` here are the DRAFT/persisted request only — the ACTUAL
 * settled posture is confirmed later, from the resumed session's first
 * observed `system/init` (`resolvedModel()`/`resolvedPermissionMode()`), NOT
 * from this connect step, because `--resume` never re-emits `system/init` at
 * handshake time (probe #1/#4).
 */
export async function resumeClaudeEngine(
  options: ClaudeEngineCreateOptions & { externalSessionRef: string },
): Promise<ConnectedClaudeEngine> {
  return connectClaudeEngine(options, { resume: options.externalSessionRef });
}

export class ClaudeEngine implements SessionEngine {
  readonly id = "claude" as const;
  readonly capabilities: EngineCapabilities;
  private readonly bounds: ClaudeEngineTimeouts;
  private turnNumber = 0;
  /** Per-turn latch: exactly one `interrupt` control request may be sent for one turn. */
  private interruptSent = false;
  private turnActive = false;
  private terminalError: Error | null = null;
  private disposed = false;
  /** Live engine state from the most recent `system/init` (re-emitted every turn). */
  private sessionId: string | null = null;
  private liveModel: string | null = null;
  /** The wire-level permission mode the CLI is ACTUALLY running (CC-D resume settle, cut §1.5 hazard (б)) — distinct from `activePresetId`, which is our own requested posture. */
  private livePermissionMode: ClaudeWirePermissionMode | null = null;
  /** Latch + one-shot observers for the FIRST turn-scoped `system/init` (`onFirstSystemInit`). */
  private firstInitSeen = false;
  private readonly firstInitListeners = new Set<
    (init: { sessionId: string; model: string; permissionMode: ClaudeWirePermissionMode }) => void
  >();
  private quota: ClaudeQuotaSnapshot | null = null;
  /** Cumulative `result.total_cost_usd` for this session (capability `costAccounting`). */
  private totalCostUsd = 0;

  constructor(
    private readonly client: ClaudeTransport,
    /** The native session ref we assigned at spawn — CC-D resumes with it. */
    readonly sessionRef: string,
    private readonly approvals?: ClaudeApprovalBridge,
    private readonly settings?: ClaudeEngineSettings,
    overrides?: Partial<ClaudeEngineTimeouts>,
  ) {
    // Interactive approval is advertised only once the real bridge is installed
    // (the codex CODEX_BRIDGED_CAPABILITIES precedent); a bare test engine keeps
    // the fail-closed capability.
    this.capabilities = approvals === undefined ? CLAUDE_ENGINE_CAPABILITIES : CLAUDE_BRIDGED_CAPABILITIES;
    this.bounds = { ...DEFAULT_CLAUDE_ENGINE_TIMEOUTS, ...overrides };
  }

  get activePresetId(): string {
    return this.settings?.preset.id ?? DEFAULT_CLAUDE_PRESET;
  }

  /** Display-only. A Claude session never consults core's permission engine — posture lives in presets.ts. */
  mode(): PermissionMode {
    return "build";
  }

  /**
   * Claude's effort vocabulary is per-model and free-form
   * (`supportedEffortLevels`), not core's fixed ReasoningEffort union, so no
   * core effort value is reported. The engine's own effort lives in `settings`.
   */
  reasoningEffort(): ReasoningEffort | undefined {
    return undefined;
  }

  setReasoningEffort(_effort: ReasoningEffort | undefined): void {
    // Core's effort vocabulary is not Claude's; `selectEffort` is the real path.
  }

  /** CC-C has no resume source; the shadow transcript that populates this is CC-D. */
  historyItems(): readonly HistoryItem[] {
    return [];
  }

  models(): EngineModelChoice[] {
    return this.settings?.catalog.choices() ?? [];
  }

  presets(): EnginePermissionPreset[] {
    return this.settings === undefined ? [] : claudePresetChoices();
  }

  snapshot(): { model: string; activePresetId: string; effort?: string } {
    return {
      model: this.settings?.model ?? "",
      activePresetId: this.activePresetId,
      ...(this.settings?.effort !== undefined ? { effort: this.settings.effort } : {}),
    };
  }

  /** Cumulative estimated cost of this session, in USD (never logged or persisted — custody §0.2-2). */
  sessionCostUsd(): number {
    return this.totalCostUsd;
  }

  quotaSnapshot(): ClaudeQuotaSnapshot | null {
    return this.quota;
  }

  /**
   * Pulls a fresh `get_usage` snapshot ($0, ~770ms). Deliberately NOT in the
   * turn hot path: called at boot and on demand. A `warning`/`critical`
   * severity queues an `engine_notice` for the next turn's stream.
   */
  async refreshQuota(): Promise<ClaudeQuotaSnapshot | null> {
    try {
      const snapshot = decodeClaudeUsage(await this.client.controlRequest<unknown>("get_usage", {}));
      if (snapshot === null) return this.quota;
      this.quota = snapshot;
      const notice = quotaNotice(snapshot);
      if (notice !== null && this.settings !== undefined) {
        this.settings.notices.push({ type: "engine_notice", level: notice.level, message: notice.message });
      }
      return snapshot;
    } catch {
      // Quota is additive presentation data: a failed pull never fails a boot
      // or a turn, it just leaves the snapshot as it was.
      return this.quota;
    }
  }

  /**
   * Host-side model validation before the wire (models.ts is why it exists):
   * an id the catalog does not contain is refused without any control request.
   * A refusal that DOES reach the CLI is a clean no-op live — the prior model
   * survives — so the local record is only advanced after a successful ack.
   */
  async selectModel(id: string): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Claude model selection is unavailable for this session." };
    if (!settings.catalog.available) {
      return { ok: false, reason: "Claude could not read its model list; start a new session to retry." };
    }
    if (!settings.catalog.has(id)) {
      return { ok: false, reason: `Claude model "${id}" is not available for this account.` };
    }
    try {
      await this.client.controlRequest("set_model", { model: id });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Claude refused the model change." };
    }
    // Each model keeps its own remembered effort (TASK.60 shape, mirrors
    // `CodexEngine.selectModel`): the outgoing model's current effort is
    // stashed before switching, and the incoming model's own remembered (or
    // no longer supported) effort is restored.
    this.rememberCurrentModelEffort();
    settings.model = id;
    const effort = this.resolveEffortForModel(id);
    if (effort === undefined) {
      delete settings.effort;
    } else {
      settings.effort = effort;
      try {
        await this.client.controlRequest("apply_flag_settings", { effortLevel: effort });
      } catch {
        // Best-effort re-assertion of the remembered effort on the now-live
        // model. The memory itself is unaffected by this failing — it stays
        // available to restore on a later switch back — but the user is told
        // the live process may not actually be running it.
        settings.notices.push(warning(`Claude could not re-apply the remembered effort "${effort}" for model "${id}".`));
      }
    }
    return { ok: true, model: id };
  }

  /** Remembers the current model's effective effort before switching away. */
  private rememberCurrentModelEffort(): void {
    const settings = this.settings;
    if (settings === undefined) return;
    if (settings.effort === undefined) settings.effortsByModel.delete(settings.model);
    else settings.effortsByModel.set(settings.model, settings.effort);
  }

  /** Restores the target model's remembered effort, normalizing it through the catalog. */
  private resolveEffortForModel(modelId: string): string | undefined {
    const settings = this.settings;
    if (settings === undefined) return undefined;
    const effort = settings.catalog.resolveEffort(modelId, settings.effortsByModel.get(modelId));
    if (effort === undefined) settings.effortsByModel.delete(modelId);
    else settings.effortsByModel.set(modelId, effort);
    return effort;
  }

  /** Mid-session posture change: `set_permission_mode` (its success ack echoes `{"mode":…}`). */
  async selectPreset(id: string): Promise<{ ok: true; presetId: string } | { ok: false; reason: string }> {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Claude permission presets are unavailable for this session." };
    const preset = findClaudePreset(id);
    if (preset === undefined) return { ok: false, reason: `Unknown Claude permission preset "${id}".` };
    try {
      await this.client.controlRequest("set_permission_mode", { mode: preset.mode });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Claude refused the permission-mode change." };
    }
    settings.preset = preset;
    return { ok: true, presetId: preset.id };
  }

  /** Mid-session effort change via `apply_flag_settings{effortLevel}` (live-accepted, $0 — probe #14). */
  async selectEffort(effort: string): Promise<{ ok: true; effort: string } | { ok: false; reason: string }> {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Claude reasoning effort is unavailable for this session." };
    if (!settings.catalog.supportsEffort(settings.model, effort)) {
      return { ok: false, reason: `Claude effort "${effort}" is not available for model "${settings.model}".` };
    }
    try {
      await this.client.controlRequest("apply_flag_settings", { effortLevel: effort });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Claude refused the effort change." };
    }
    settings.effort = effort;
    settings.effortsByModel.set(settings.model, effort);
    return { ok: true, effort };
  }

  async *runTurn(input: string, options: RunTurnOptions): AsyncIterable<AgentEvent> {
    const turn = ++this.turnNumber;
    if (this.terminalError !== null || this.disposed) {
      yield* this.terminalEvents(turn, this.terminalError ?? new Error("Claude engine is closed"));
      return;
    }
    if (options.attachments?.length) {
      // supportsImages is false (R-W0-9): re-checked at the wire boundary, not
      // only at the Composer gate.
      yield* this.terminalEvents(turn, new Error("Claude sessions do not support image attachments yet"));
      return;
    }
    yield { type: "turn_start", turn };
    for (const notice of this.drainNotices()) yield notice;

    const abort = watchAbort(options.signal);
    const translator = new ClaudeTurnTranslator({
      turn,
      onInit: (init) => this.onSystemInit(init),
      onResult: (result) => this.onResult(result),
    });
    this.interruptSent = false;
    this.turnActive = true;
    let abortObserved = false;
    let settle: SettleDeadline | null = null;
    let terminal = false;

    /** Latched Stop: settle any parked approval, then interrupt exactly once. */
    const beginInterrupt = (): void => {
      settle ??= deadline(this.bounds.postInterruptSettleMs);
      // The CLI withdraws its own pending `can_use_tool` via
      // `control_cancel_request` (hazard (д)); this only closes OUR modal.
      this.approvals?.denyAll("Claude turn was cancelled", "turn_cancelled");
      void this.sendInterruptOnce();
    };
    const settleRacers = (): Promise<{ kind: "settle-timeout" }>[] => (settle === null ? [] : [settle.promise]);
    // Read through a closure: `settle` is only ever assigned inside
    // `beginInterrupt`, which control-flow analysis cannot see, so a direct
    // `settle?.cancel()` in `finally` narrows to `never`.
    const cancelSettle = (): void => settle?.cancel();

    const iterator = this.client.notifications()[Symbol.asyncIterator]();
    let next = iterator.next();

    try {
      // A turn IS a user message on the shared stdin — one process, one
      // session, many turns (probe #1). There is no per-turn request/response.
      this.client.sendUserMessage(input);
      // An abort that arrives before anything streamed still has a live
      // session to interrupt, so it fires immediately rather than latching.
      if (options.signal.aborted) {
        abortObserved = true;
        beginInterrupt();
      }

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
          throw new Error(`Claude did not settle the interrupted turn within ${this.bounds.postInterruptSettleMs}ms`);
        }
        if (raced.value.done) {
          // Transport closed under a pending Stop (e.g. Stop then tab close):
          // that is the cancellation the user asked for, not an engine error.
          if (abortObserved) {
            for (const event of translator.finishTerminal("cancelled")) yield event;
            return;
          }
          throw this.terminalError ?? new Error("Claude exited during a turn");
        }
        next = iterator.next();
        for (const event of translator.onMessage(raced.value.value)) {
          if (event.type === "loop_end") terminal = true;
          yield event;
        }
      }

      // The ctx meter, AFTER the terminal result and only for a turn that
      // actually ran (cut §1.4 table: "result -> turn_end + loop_end; следом
      // ctx-метр"). Session drains the full iterable, so an event yielded
      // after loop_end still reaches the UI.
      const usage = await this.readContextUsage();
      if (usage !== null) yield usage;
    } catch (error) {
      const terminalError = this.terminalError ?? (error instanceof Error ? error : new Error(String(error)));
      this.terminalError = terminalError;
      this.approvals?.denyAll("Claude transport failed", "turn_cancelled");
      // A turn that lost its transport releases the child.
      void this.client.close().catch(() => {});
      yield { type: "error", error: terminalError };
      yield* this.terminalEvents(turn, terminalError, false);
    } finally {
      this.turnActive = false;
      cancelSettle();
      abort.dispose();
    }
  }

  dispose(_reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposed = true;
    this.approvals?.denyAll("Claude engine is shutting down", "shutdown");
    void this.sendInterruptOnce();
    return this.client.close();
  }

  /**
   * The $0 context read (`get_context_usage`) that feeds the meter. Its
   * `totalTokens`/`maxTokens` are the CLI's OWN accounting of the model's
   * window — the one thing a host-side sum of `result.usage` can never get
   * right (the window size is not on the result frame at all).
   */
  private async readContextUsage(): Promise<AgentEvent | null> {
    try {
      const usage = await this.client.getContextUsage();
      const totalTokens = usage.totalTokens;
      const maxTokens = usage.maxTokens;
      if (typeof usage.model === "string") this.liveModel = usage.model;
      if (
        typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0 ||
        typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0
      ) {
        return null;
      }
      return { type: "context_usage", estimatedTokens: totalTokens, budgetTokens: maxTokens, source: "provider" };
    } catch {
      // A failed read leaves the meter at its last value rather than painting a
      // wrong one; it is never a turn failure.
      return null;
    }
  }

  /** `system/init` arrives on EVERY turn (probe #1) — repeated inits refresh state silently. */
  private onSystemInit(init: ClaudeSystemInitMessage): void {
    this.sessionId = init.session_id;
    this.liveModel = init.model;
    this.livePermissionMode = init.permissionMode;
    this.reconcileFromInit(init);
    if (!this.firstInitSeen) {
      this.firstInitSeen = true;
      for (const listener of this.firstInitListeners) {
        try {
          listener({ sessionId: init.session_id, model: init.model, permissionMode: init.permissionMode });
        } catch {
          // A first-init observer is a side-channel (row materialization,
          // resume settle); it can never fail a turn.
        }
      }
      this.firstInitListeners.clear();
    }
  }

  /**
   * Adopts the CLI's OWN posture into the engine's settings (cut §1.5 hazard
   * (б): the first `system/init` of a resumed session is the truth, not our
   * persisted row). Runs on every init, which is a no-op for a fresh session
   * that already spawned under exactly this posture.
   *
   * The model comparison is deliberately RESOLVED-vs-RESOLVED. `init.model` is
   * a resolved id (`claude-opus-4-8[1m]`) while the catalog value we hold is
   * the selectable alias (`opus[1m]`), and several aliases DO share one
   * resolved id live (`default` and `opus[1m]` both resolve to
   * `claude-opus-4-8[1m]`) — so adopting on every init would flip a perfectly
   * correct `opus[1m]` selection to whichever alias is listed first. The
   * current selection is therefore kept whenever it already resolves to what
   * the CLI reports; only a genuine divergence adopts a new entry, and
   * `selectableForResolved` then picks a concrete alias over `default`.
   */
  private reconcileFromInit(init: ClaudeSystemInitMessage): void {
    const settings = this.settings;
    if (settings === undefined) return;
    if (!settings.catalog.readBackMatches(settings.model, init.model)) {
      const entry = settings.catalog.selectableForResolved(init.model);
      if (entry !== undefined) settings.model = entry.value;
    }
    const preset = findClaudePresetByMode(init.permissionMode);
    if (preset !== undefined) settings.preset = preset;
  }

  /**
   * Fires ONCE, on the first turn-scoped `system/init` this engine observes —
   * the moment the native session provably materialized (probe #1: init is
   * emitted per TURN, never at handshake, so nothing before this proves a
   * resumable native session exists). The host uses it for native-first row
   * creation and the resume settle-patch (cut §1.5 hazard (а)/(б)). A listener
   * registered after the first init has already been seen is invoked
   * immediately with the latched values.
   */
  onFirstSystemInit(listener: (init: { sessionId: string; model: string; permissionMode: ClaudeWirePermissionMode }) => void): void {
    if (this.firstInitSeen) {
      if (this.sessionId !== null && this.liveModel !== null && this.livePermissionMode !== null) {
        listener({ sessionId: this.sessionId, model: this.liveModel, permissionMode: this.livePermissionMode });
      }
      return;
    }
    this.firstInitListeners.add(listener);
  }

  private onResult(result: ClaudeResultMessage): void {
    if (typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd)) {
      this.totalCostUsd += result.total_cost_usd;
    }
  }

  /** The CLI's own session id, once a turn has produced a `system/init`. */
  nativeSessionId(): string | null {
    return this.sessionId;
  }

  /** The model the CLI reports it is actually running (a RESOLVED id — compare via the catalog, never by string equality with the request). */
  resolvedModel(): string | null {
    return this.liveModel;
  }

  /** The wire-level permission mode the CLI reports it is actually running (CC-D resume settle). */
  resolvedPermissionMode(): ClaudeWirePermissionMode | null {
    return this.livePermissionMode;
  }

  /**
   * Queues a notice for the NEXT turn's stream (same drain path boot notices
   * use — an `AgentEvent` only travels inside a turn). Used by the
   * Claude-settings-seam glue (CC-D-min, cut §1.5) to surface an async
   * set_model/set_permission_mode ack-failure that happens BETWEEN turns,
   * when there is no live stream to emit it on directly.
   */
  queueNotice(notice: AgentEvent): void {
    this.settings?.notices.push(notice);
  }

  /**
   * Exactly one `interrupt` per turn. A second one could only add an
   * unanswerable pending request while the turn settles; the bounded settle
   * deadline in `runTurn` remains the terminal backstop.
   */
  private async sendInterruptOnce(): Promise<void> {
    if (this.interruptSent || !this.turnActive) return;
    this.interruptSent = true;
    try {
      await this.client.interrupt();
    } catch {
      // The receipt is best-effort: the turn's own terminal `result` (or the
      // settle deadline) still closes the turn.
    }
  }

  /** Boot-time notices have no wire of their own — an AgentEvent only travels inside a turn, so they are flushed here, once. */
  private drainNotices(): AgentEvent[] {
    const settings = this.settings;
    if (settings === undefined || settings.notices.length === 0) return [];
    return settings.notices.splice(0, settings.notices.length);
  }

  private *terminalEvents(turn: number, error: Error, includeError = true): Generator<AgentEvent> {
    if (includeError) yield { type: "error", error };
    yield { type: "turn_end", turn, finishReason: "error" };
    yield { type: "loop_end", reason: "error", turns: turn };
  }
}

/** Every preset id the frozen table exposes — used by the renderer's draft mirror and by host-side validation. */
export const CLAUDE_PRESET_IDS = CLAUDE_PERMISSION_PRESETS.map((preset) => preset.id);

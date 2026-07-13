/**
 * Host session: the protocol server tying the UI wire to the core agent loop
 * (design §2/§3/§4/§5). One workspace, one session, one turn at a time.
 *
 * Responsibilities:
 *  - Outbound: sanitize + serialize-safe post of every HostToUiMessage, plus a
 *    bounded replay ring buffer re-sent on every `ui_ready` (survives a renderer
 *    reload / crash — the model history lives in AgentLoop, the transcript here).
 *  - Resume hydration (design §3.3): on every `ui_ready`, AFTER host_ready and
 *    BEFORE replay(), emit `session_history` (the boot snapshot of persisted
 *    history projected to WireHistoryItem, last 500) when a resumed session
 *    boots with prior history.
 *  - Session-meta persistence (design §4.2, via an injected narrow callback):
 *    derive the title from the first user message (once), persist mode on
 *    a between-turns set_mode so a resume restores it.
 *  - Turn lifecycle: busy gate (a second user_message while a turn is running ->
 *    turn_rejected "busy"), per-turn AbortController + turnId, turn_started.
 *  - Stream bridge: for await (loop.runTurn) -> agent_event{turnId} with error
 *    sanitization; a successful Write/Edit tool_result triggers an "after"
 *    file_snapshot (the "before" one comes from the PreToolUse snapshot hook).
 *  - Cancel: cancel_turn -> abort the turn AND broker.denyAll("turn cancelled")
 *    so parked asks release; the loop then ends the turn as cancelled.
 *  - Routing: zod-validate incoming UiToHostMessage (garbage dropped with warn),
 *    dispatch ui_ready / user_message / cancel_turn / permission_response /
 *    set_mode (mode change only allowed between turns).
 *  - Always-allow remember (slice 2.2.3, design §5): a `permission_response`
 *    carrying `remember` on an "allow" adds a rule to the session's
 *    `SessionPermissionRules` (the same store the RuleAwarePermissionEngine
 *    wrapping ctx.permissionEngine reads) BEFORE the response is applied to the
 *    broker, so a subsequent matching call in THIS session auto-allows without
 *    another ask. toolName is read from the broker's still-pending ask (its
 *    `pendingToolName` accessor) — `handleResponse` settles and removes the
 *    entry, so the lookup must happen first. Only "allow" adds a rule: the
 *    engine only ever downgrades an "ask" ruling to "allow" (never touches
 *    "deny"), so a plan-mode / hook denial stays a hard deny regardless of any
 *    stored rule — remembering on "deny" would be a no-op for THIS call and
 *    nonsensical for future ones, so it is simply ignored.
 */

import type {
  AgentEvent,
  BackgroundTaskNotice,
  BackgroundTaskSnapshot,
  CheckpointMeta,
  CommandHookDeclaration,
  FileSystemPort,
  HistoryItem,
  ImageAttachment,
  LspServerStatus,
  PermissionMode,
  ReasoningEffort,
  RewindResult,
  RewindScope,
  SessionPermissionRules,
  TelemetryStatus,
  ToolCallOutcome,
} from "@anycode/core";
import { SESSION_TITLE_MAX_LENGTH, deriveSessionTitle, sanitizeTitleSource, withBackgroundTaskNotices } from "@anycode/core";
import { randomUUID } from "node:crypto";
import type {
  HostToUiMessage,
  EnginePresentation,
  UiToHostMessage,
  WireCheckpointMeta,
  WireEnvStatus,
  WireHistoryItem,
  WirePort,
} from "../shared/protocol.js";
import { uiToHostMessageSchema } from "../shared/protocol.js";
import type { GitUiBridge } from "./git-bridge.js";
import type { IpcPermissionBroker } from "./permission-broker.js";
import { extractSnapshotPath, isSnapshotTool, readSnapshot } from "./snapshot-hook.js";
import { describeError, sanitizeAgentEvent } from "./serialize.js";
import type { SessionEngine } from "./engines/session-engine.js";

/** Cap on the replay ring buffer; older messages roll off (design §3). */
export const REPLAY_BUFFER_CAP = 5_000;

/** Cap on hydrated `session_history` items; only the last N are shipped (design §3.3). */
export const SESSION_HISTORY_MAX_ITEMS = 500;

/** Defensive reply for an engine that does not expose core context accounting. */
const ZERO_CONTEXT_BREAKDOWN = {
  messagesTokens: 0,
  systemToolsTokens: 0,
  mcpToolsTokens: 0,
  skillsTokens: 0,
  systemPromptTokens: 0,
  metaTokens: 0,
  totalEstimatedTokens: 0,
};

/** Only external engines carry this additive wire projection; core stays byte-identical. */
function enginePresentation(engine: SessionEngine): EnginePresentation | undefined {
  if (engine.id === "core") return undefined;
  const capabilities = engine.capabilities;
  return {
    id: engine.id,
    capabilities: {
      supportsCorePermissions: capabilities.supportsCorePermissions,
      supportsRewind: capabilities.supportsRewind,
      supportsWorkflow: capabilities.supportsWorkflow,
      supportsGitMutations: capabilities.supportsGitMutations,
      supportsContextUsage: capabilities.supportsContextUsage,
      supportsContextBreakdown: capabilities.supportsContextBreakdown,
      supportsInteractiveApprovals: capabilities.supportsInteractiveApprovals,
      costAccounting: capabilities.costAccounting,
      supportsModelSelection: capabilities.supportsModelSelection,
      supportsReasoningEffort: capabilities.supportsReasoningEffort,
      supportsImages: capabilities.supportsImages,
      supportsTasks: capabilities.supportsTasks,
      supportsFileSnapshots: capabilities.supportsFileSnapshots,
    },
  };
}

function isGitMutation(command: Extract<UiToHostMessage, { type: "git_command" }>["command"]): boolean {
  return !["refresh", "branches", "log", "diff"].includes(command.op);
}

// SESSION_TITLE_MAX_LENGTH and deriveSessionTitle moved to
// packages/core/src/context/session-title.ts (Phase 4 slice 4.4-T, for CLI
// parity) and are re-exported below, byte-identical, so existing importers of
// "./session.js" (e.g. host/resume.test.ts) keep working unchanged.
export { SESSION_TITLE_MAX_LENGTH, deriveSessionTitle };

/**
 * Buffered, serialize-safe sender for host -> UI messages. Records into a bounded
 * ring buffer (for replay) and posts to the currently attached WirePort. The

 * message is replaced by a `fatal` rather than crashing the host.
 */
export class Outbound {
  private readonly buffer: HostToUiMessage[] = [];
  private port: WirePort | null = null;

  constructor(private readonly cap: number = REPLAY_BUFFER_CAP) {}

  /** Retargets the sink to a new port (initial connect or renderer reload). */
  attach(port: WirePort): void {
    this.port = port;
  }

  /** Buffered send: recorded for replay and posted to the current port. */
  emit(message: HostToUiMessage): void {
    this.buffer.push(message);
    if (this.buffer.length > this.cap) {
      this.buffer.shift();
    }
    this.write(message);
  }

  /** Un-buffered send, for handshake meta regenerated per connect (host_ready). */
  sendDirect(message: HostToUiMessage): void {
    this.write(message);
  }

  /** Re-posts the whole ring buffer to the current port (on ui_ready). */
  replay(): void {
    for (const message of this.buffer) {
      this.write(message);
    }
  }

  /**
   * Drops the entire replay ring (slice P7.26/R2, design §3 drift-flag-1). After a
   * conversation-restoring rewind the pre-rewind turn events (turn_started /
   * agent_event / …) must NOT resurrect on a renderer re-handshake via replay();
   * the truncated `session_history` is re-sent instead. `buffer` is private, so
   * this is the only eviction API — new post-rewind turns re-fill the emptied ring
   * normally.
   */
  clear(): void {
    this.buffer.length = 0;
  }

  private write(message: HostToUiMessage): void {
    if (!this.port) {
      return;
    }
    try {
      this.port.post(message);
    } catch (error) {

      // surface a fatal instead, and give up silently if even that cannot post.
      const fatal: HostToUiMessage = {
        type: "fatal",
        message: `non-serializable ${message.type} message dropped: ${describeError(error)}`,
      };
      try {
        this.port.post(fatal);
      } catch {
        // Nothing more we can safely do; the transport itself is broken.
      }
    }
  }
}

/**
 * Narrow persistence callback injected into Session (design §4.2): Session
 * persists session-meta patches (title on the first user message, mode on a
 * between-turns set_mode) WITHOUT ever receiving the whole PersistencePort.
 * Fire-and-forget — it must never throw into or block a turn.
 */
export interface SessionPersistence {
  touch(patch: { title?: string; mode?: PermissionMode }): void;
}

export interface SessionOptions {
  outbound: Outbound;
  /** The host-selected agent runtime; Session never imports an external engine. */
  engine: SessionEngine;
  broker: IpcPermissionBroker;
  /** Adapter for reading "after" snapshots (design §5). */
  fs: FileSystemPort;
  workspace: string;
  model: string;
  /** Persistence session id, known at boot; echoed in host_ready (design §3.3). */
  sessionId: string;
  /**
   * Boot snapshot of the persisted history (post-repair) for transcript
   * hydration of a resumed session; emitted as `session_history` on every
   * ui_ready (design §3.3). Empty for a fresh session -> no emission.
   */
  bootHistory?: ReturnType<SessionEngine["historyItems"]>;
  /** Whether the boot session already had a title -> skip title derivation (design §4.2). */
  hasTitle?: boolean;
  /** Narrow persistence callback for title/mode patches (design §4.2). */
  persistence?: SessionPersistence;
  /**
   * Tier-2 LLM title refinement one-shot (Phase 4 slice 4.4-T, design

   * rather than read from `config.modelPort` directly so tests that don't pass
   * it (every pre-existing session/resume test, using ScriptedModelPort) never
   * see a refinement call consume one of their scripted steps. `host/index.ts`
   * wires the real implementation (`generateSessionTitle` + `config.modelPort`).
   */
  refineTitle?: (text: string) => Promise<string | null>;
  /**
   * The SAME `SessionPermissionRules` instance the caller wrapped into
   * `config.permissionEngine` (RuleAwarePermissionEngine) — Session adds a rule
   * to it on a `remember`ed allow (design §5, slice 2.2.3). Boot seeds it from
   * settings.json (host/boot.ts's `seedAlwaysAllowRules`); Session only ever
   * appends to it.
   */
  rules: SessionPermissionRules;
  /**
   * GitBridge seam (slice 5.7): the executor of the renderer's user-initiated
   * git commands. Absent in legacy tests -> a `git_command` falls into a no-op
   * (in production the bridge is always constructed — the boot gate is
   * unconditional). Session holds only the narrow `GitUiBridge` interface
   * (import type), mirroring the `SessionPersistence` narrow-seam posture (ruling

   */
  git?: GitUiBridge;
  /**
   * Background-task notice seam (slice 6.DP-2, 5.5-R2 host-half): drained at
   * the top of every ACCEPTED turn (strictly after the busy gate and the
   * raw-text title derivation, strictly before runTurn) and appended to the
   * turn input as a <system-reminder> block — the desktop's "next turn" seam,
   * mirroring cli/main.ts's REPL injection point byte-for-byte (the shared
   * withBackgroundTaskNotices). Absent in legacy tests -> turn input passes
   * through untouched (byte-identical to pre-6.DP-2).
   */
  tasks?: {
    drainNotices(): BackgroundTaskNotice[];
    list?(): BackgroundTaskSnapshot[];
    readOutput?(taskId: string): { snapshot: BackgroundTaskSnapshot; newOutput: string } | undefined;
    kill?(taskId: string): boolean;
  };
  /**
   * Renderer Panels sub-slice A: narrow read-only LSP status seam. Slice
   * P7.25/F3 adds an optional `onStatusChange` subscription so the host can
   * live-push `lsp_status` on every server state transition (coalesced upstream
   * in LspManager). Returns an unsubscribe fn; absent -> pull-only (legacy
   * tests/harness stay byte-identical, no live push).
   */
  lsp?: { status(): LspServerStatus[]; onStatusChange?(listener: () => void): () => void };
  /** Renderer Panels sub-slice B: static command-hook config list seam. */
  hooksList?: { list(): readonly CommandHookDeclaration[]; configError?: string };
  /**

   * telemetry + repo-map status seam, mirroring the `lsp` seam above. Absent
   * in legacy tests/harness -> `pushEnvStatus` is a no-op (zero new
   * `env_status` messages — byte-identical to pre-P7.8 for every caller that
   * doesn't wire this).
   */
  envStatus?: {
    telemetry(): TelemetryStatus | null;
    repoMap(): WireEnvStatus["repoMap"];
    /**
     * Codex-P2 fix (slice P7.8): waits for in-flight telemetry appends to
     * settle before the teardown push reads `written`/`dropped`, so the
     * panel reflects the turn that just finished rather than the previous
     * one. Optional -> absent seam / legacy harness stays a no-op.
     */
    flushTelemetry?(): Promise<void>;
  };
  /**
   * Slice P7.26/R2 (design §2.1): narrow read-only + rewind checkpoint seam,
   * mirroring the `tasks`/`lsp` seams above. Structurally satisfied by the
   * `ShadowGitCheckpoints` service R1 already builds (host passes the SAME
   * instance it threads into config.checkpoints). Absent seam (legacy tests / no
   * runBinary) -> `checkpoint_list` replies `{checkpoints:[]}` and a
   * `rewind_request` replies `{ok:false, reason:"checkpoints unavailable"}`
   * (fail-closed, DoD-5). The service never touches live history — Session owns
   * `loop.history.replaceAll` on a conversation restore (CLI-mirror).
   */
  checkpoints?: {
    list(opts?: { limit?: number }): Promise<CheckpointMeta[]>;
    rewind(id: string, opts: { scope: RewindScope; currentHistory: readonly HistoryItem[] }): Promise<RewindResult>;
  };
  /** Multimodal send-path capability gate, mirroring the CLI image staging guard. */
  imageInputEnabled?: () => boolean;
  /** Capability gate: false for a known catalog model without reasoning support. */
  reasoningSupported?: boolean;
  /** Effort levels the boot model supports (for the UI selector + set_reasoning_effort validation). */
  availableEffortLevels?: ReasoningEffort[];
  /**
   * Slice P7.15 (F14): the user-selected effort tier at boot (mirror of the CLI's
   * selectedReasoningEffort seed). Tracked across a model switch so switching to
   * a non-reasoning model and back restores the tier. set_reasoning_effort keeps
   * it in sync. Defaults to the resolved boot effort (or "off").
   */
  selectedEffort?: ReasoningEffort;
  /**
   * Slice P7.15 (F14, design §2.1): mid-session model-switch callback (mirror of
   * the CLI's deps.model.set). Runs the host-side re-budget recipe — setPort,
   * systemPromptEnv.modelId, context window / maxOutput / effort re-resolution,
   * repo-map re-render, loop.setContextWindow, touchSession — and returns the
   * re-resolved effort state for the `model_changed` emit. Absent in legacy
   * tests -> `set_model` is a silent no-op (no switch factory available).
   */
}

export class Session {
  private readonly outbound: Outbound;
  private readonly engine: SessionEngine;
  private readonly broker: IpcPermissionBroker;
  private readonly fs: FileSystemPort;
  private readonly workspace: string;
  // Slice P7.15 (F14): mutable — a mid-session set_model updates the live model.
  private model: string;
  private readonly sessionId: string;
  private readonly persistence: SessionPersistence | undefined;
  private readonly rules: SessionPermissionRules;
  private readonly git: GitUiBridge | undefined;
  private readonly tasks: SessionOptions["tasks"];
  private readonly lsp: SessionOptions["lsp"];
  private readonly hooksList: SessionOptions["hooksList"];
  private readonly envStatus: SessionOptions["envStatus"];
  /** Slice P7.26/R2: rewind/list seam (undefined -> checkpoints disabled, fail-closed). */
  private readonly checkpoints: SessionOptions["checkpoints"];
  private readonly imageInputEnabled: (() => boolean) | undefined;
  private readonly refineTitle: ((text: string) => Promise<string | null>) | undefined;
  // Slice P7.15 (F14): mutable — re-resolved per new model on a set_model switch.
  private reasoningSupported: boolean;
  private availableEffortLevels: ReasoningEffort[] | undefined;
  /** Slice P7.15 (F14): the user-selected effort tier, persisted across a model switch. */
  private selectedEffort: ReasoningEffort;

  /**
   * Prebuilt `session_history` payload (mapping + 500-cap applied once at
   * construction), re-sent verbatim on every ui_ready; null when the boot
   * history was empty (fresh session — nothing to hydrate). Slice P7.26/R2
   * (drift-flag-1): mutable — a conversation-restoring rewind REBUILDS this from
   * the truncated `loop.history.items` so a renderer re-handshake after a rewind
   * rehydrates the rewound-away transcript, not the dead pre-rewind one.
   */
  private sessionHistory: { items: WireHistoryItem[]; truncated: boolean } | null;

  /** Set once the session has a title (from boot meta or the first user message) — title is derived exactly once. */
  private titleSet: boolean;

  /**
   * The raw text of the user message the heuristic just titled, held until the
   * first turn's teardown so the tier-2 refinement can run over it exactly
   * once (Phase 4 slice 4.4-T, design §3). Null whenever there is nothing
   * pending: before the heuristic ever fires, and again immediately after the
   * refinement attempt consumes it — so a later turn can never re-trigger it.
   */
  private pendingTitleRefineText: string | null = null;

  /** Target file paths captured on tool_execution_start, consumed by the "after" snapshot. */
  private readonly snapshotPaths = new Map<string, string>();

  private busy = false;
  private abort: AbortController | null = null;
  private turnId: string | null = null;
  private currentTurn: Promise<void> | null = null;

  /**

   * The LSP live-push listener drops every fire before this — an unsolicited
   * push must never race a not-yet-mounted renderer (5.7-hostfix bind-race
   * lesson), and the ui_ready case itself pushes the current snapshot.
   */
  private uiReady = false;
  /** Slice P7.25/F3: unsubscribes the LSP status listener on shutdown (no leaked listener, no push-after-dispose). */
  private lspUnsubscribe: (() => void) | undefined;

  constructor(options: SessionOptions) {
    this.outbound = options.outbound;
    this.engine = options.engine;
    this.broker = options.broker;
    this.fs = options.fs;
    this.workspace = options.workspace;
    this.model = options.model;
    this.sessionId = options.sessionId;
    this.persistence = options.persistence;
    this.rules = options.rules;
    this.git = options.git;
    this.tasks = options.tasks;
    this.lsp = options.lsp;
    this.hooksList = options.hooksList;
    this.envStatus = options.envStatus;
    this.checkpoints = options.checkpoints;
    this.imageInputEnabled = options.imageInputEnabled;
    this.refineTitle = options.refineTitle;
    this.reasoningSupported = options.reasoningSupported ?? true;
    this.availableEffortLevels = options.availableEffortLevels;
    this.selectedEffort = options.selectedEffort ?? this.engine.reasoningEffort() ?? "off";
    this.titleSet = options.hasTitle ?? false;
    this.sessionHistory = buildSessionHistory(options.bootHistory ?? []);
    // Slice P7.25/F3: subscribe to live LSP status transitions. The listener is

    // ready; unsubscribe on shutdown prevents a leaked listener / push-after-
    // dispose. Absent seam (legacy tests) -> no subscription, pull-only.
    this.lspUnsubscribe = this.lsp?.onStatusChange?.(() => {
      if (this.uiReady) this.pushLspStatus();
    });
  }

  /** Attaches (or retargets) the UI wire: routes inbound messages, denies on close. */
  bindPort(port: WirePort): void {
    // Slice P7.25/F3 W1-FIX: a freshly (re)attached port is not-yet-ready by
    // definition — a renderer reconnect (reload/crash) calls bindPort with a
    // NEW port before it has sent its own ui_ready. Without this reset the

    // an LSP transition in that window pushes lsp_status onto the not-yet-
    // mounted new renderer — the same not-yet-mounted-renderer race class the
    // 5.7-hostfix git_status fix addressed (host/session.ts git_status push).
    this.uiReady = false;
    this.outbound.attach(port);
    port.onMessage((raw) => {
      this.route(raw);
    });
    port.onClose(() => {
      // No live client -> every parked ask fails closed (design §4). The turn
      // itself keeps running so a reconnect replays the completed transcript.
      this.broker.denyAll("ui disconnected", "disconnect");
    });
  }

  /** Graceful shutdown: abort the turn, release parked asks, await turn teardown. */
  async shutdown(): Promise<void> {
    // Slice P7.25/F3: release the LSP status subscription so no transition after
    // this point can push onto a shut-down session, and no listener reference
    // leaks past the session's life. (The host reaps lspManager BEFORE calling
    // shutdown, so the final "all disposed" snapshot already rode out as a valid
    // push; this guards everything strictly after teardown begins.) uiReady is
    // flipped false as a belt-and-braces gate for any in-flight microtask.
    this.uiReady = false;
    this.lspUnsubscribe?.();
    this.lspUnsubscribe = undefined;
    if (this.abort) {
      this.abort.abort();
    }
    this.broker.denyAll("shutting down", "shutdown");
    // Disposal starts before awaiting the turn. External engines may need this
    // escalation to make an abort-observing generator terminate within main's
    // host force-kill deadline.
    let disposal: Promise<void>;
    try {
      disposal = this.engine.dispose("host-shutdown");
    } catch (error) {
      // Engine adapters are required to return a bounded promise, but host
      // shutdown must remain fail-soft if a future adapter throws before it
      // can do so. The turn is still awaited below.
      console.error(`[host] engine dispose threw during shutdown: ${describeError(error)}`);
      disposal = Promise.resolve();
    }
    await Promise.allSettled([...(this.currentTurn ? [this.currentTurn] : []), disposal]);
  }

  private route(raw: unknown): void {
    const parsed = uiToHostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // Fail-closed: garbage can never grant a permission or start a turn.
      console.warn("[host] dropped invalid UI message:", parsed.error.issues);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "ui_ready":

        // status pushes are safe from here on. Set BEFORE the snapshot cascade
        // below (which already pushes the current lsp_status).
        this.uiReady = true;
        const presentation = enginePresentation(this.engine);
        this.outbound.sendDirect({
          type: "host_ready",
          workspace: this.workspace,
          mode: this.engine.mode(),
          model: this.model,
          sessionId: this.sessionId,
          reasoningEffort: this.engine.reasoningEffort() ?? "off",
          ...(this.availableEffortLevels !== undefined ? { availableEffortLevels: this.availableEffortLevels } : {}),
          ...(presentation !== undefined ? { engine: presentation } : {}),
        });
        // Phase-2 §3.3: session_history (transcript hydration of a resumed
        // session) is emitted AFTER host_ready and BEFORE replay(), only when
        // the boot history is non-empty. sendDirect (not buffered): the payload
        // is a fixed boot snapshot, re-sent on every ui_ready (idempotent across
        // renderer reloads). New-turn transcript rides Outbound.replay() below.
        if (this.sessionHistory) {
          this.outbound.sendDirect({
            type: "session_history",
            sessionId: this.sessionId,
            items: this.sessionHistory.items,
            truncated: this.sessionHistory.truncated,
          });
        }
        this.outbound.replay();
        // Slice 5.7-hostfix: the per-connect git_status snapshot fires HERE, not
        // at physical port bind — sendDirect is un-buffered, and a bind-time
        // post raced a not-yet-mounted renderer (lost with no recovery; R8 live
        // smoke). ui_ready is the renderer's proven-ready signal (same gate as
        // host_ready/replay above). Placed after replay() so the fresh snapshot
        // lands after any buffered turn-time git_status (freshest wins). Still
        // sendDirect inside the bridge — never enters the replay ring (ruling

        this.git?.pushSnapshot();
        this.pushLspStatus();
        this.pushHooksList();
        if (this.engine.capabilities.supportsTasks) this.pushTaskList();
        this.pushEnvStatus();
        break;
      case "user_message":
        this.onUserMessage(message.requestId, message.text, message.images);
        break;
      case "cancel_turn":
        this.onCancel();
        break;
      case "permission_response":
        if (!this.engine.capabilities.supportsInteractiveApprovals) {
          break;
        }
        if (this.engine.capabilities.supportsCorePermissions) {
          this.maybeRemember(message.requestId, message.behavior, message.remember);
        }
        this.broker.handleResponse(message.requestId, message.behavior, message.updatedInput);
        break;
      case "set_mode":
        this.onSetMode(message.mode);
        break;
      case "set_reasoning_effort":
        // Validate against the model's declared effort levels (when known) so a
        // stale renderer can't request an unsupported tier; "off" always allowed.
        if (
          !this.busy &&
          this.engine.capabilities.supportsReasoningEffort &&
          (message.effort === "off" || this.reasoningSupported) &&
          (this.availableEffortLevels === undefined || this.availableEffortLevels.includes(message.effort))
        ) {
          // Slice P7.15 (F14): remember the user-selected tier so a later model
          // switch re-resolves effort against it (a non-reasoning model drops it,
          // but switching back restores it).
          this.selectedEffort = message.effort;
          this.engine.setReasoningEffort(message.effort === "off" ? undefined : message.effort);
          this.outbound.emit({
            type: "reasoning_effort_changed",
            effort: message.effort,
            ...(this.availableEffortLevels !== undefined ? { availableEffortLevels: this.availableEffortLevels } : {}),
          });
        }
        break;
      case "set_model": {
        // Slice P7.15 (F14, design §2.1): mid-session model switch. Between-turns
        // guard mirrors set_reasoning_effort — a switch is accepted ONLY while
        // idle. Messages route sequentially, so a set_model arriving after an
        // accepted user_message observes busy=true and is silently dropped (the
        // authoritative host-side refusal; the renderer disables the row too, but
        // this is the guarantee). Mirror of the CLI /model ambiguity rules: a
        // non-empty trimmed id with no internal whitespace. No switch factory
        // wired (legacy tests) -> silent no-op. Every rejection is a silent drop
        // (no reply escape), exactly like set_reasoning_effort.
        const id = message.model.trim();
        if (
          this.busy ||
          !this.engine.capabilities.supportsModelSelection ||
          id.length === 0 ||
          /\s/.test(id) ||
          this.engine.switchModel === undefined
        ) {
          break;
        }
        // switchModel runs the full re-budget recipe host-side and returns the
        // effort state re-resolved for the NEW model. selectedEffort is unchanged
        // (the user's tier persists across the switch); only the effective effort
        // and effort-levels follow the new model's capability.
        const result = this.engine.switchModel(id, this.selectedEffort);
        this.model = result.model;
        this.availableEffortLevels = result.availableEffortLevels;
        this.reasoningSupported = result.availableEffortLevels !== undefined;
        this.outbound.emit({
          type: "model_changed",
          model: result.model,
          reasoningEffort: result.reasoningEffort,
          ...(result.availableEffortLevels !== undefined ? { availableEffortLevels: result.availableEffortLevels } : {}),
        });
        break;
      }
      case "git_command":
        // Slice 5.7: user-initiated git command. The bridge validates nothing
        // (the zod schema already ran in `route` above) and never throws into

        if (!isGitMutation(message.command) || this.engine.capabilities.supportsGitMutations) {
          this.git?.handleCommand(message);
        }
        break;
      case "lsp_status_request":
        this.pushLspStatus();
        break;
      case "context_breakdown_request":
        if (this.engine.capabilities.supportsContextBreakdown) this.pushContextBreakdown();
        break;
      case "task_list_request":
        if (this.engine.capabilities.supportsTasks) this.pushTaskList();
        break;
      case "task_output_request":
        if (this.engine.capabilities.supportsTasks) this.pushTaskOutput(message.taskId);
        break;
      case "task_kill_request":
        if (this.engine.capabilities.supportsTasks) this.onTaskKillRequest(message.requestId, message.taskId);
        break;
      case "checkpoint_list_request":
        if (this.engine.capabilities.supportsRewind) void this.pushCheckpointList();
        break;
      case "rewind_request":
        // Async (awaits store + git spawns); onRewind holds this.busy for its
        // duration so a concurrent user_message/set_mode/set_model hits the
        // existing busy gate (drift-flag-3). void: route() never awaits.
        void this.onRewind(message);
        break;
    }
  }

  private pushLspStatus(): void {
    this.outbound.sendDirect({ type: "lsp_status", servers: this.lsp?.status() ?? [] });
  }

  /**
   * Slice P7.17 (F12, design §2.2): mirror of pushLspStatus — a pure read served
   * on demand, even mid-turn (contextBreakdown() never touches history/model/
   * events, safe to call while busy). sendDirect, never buffered: this is a
   * request/response, not a replayed snapshot, so no byte-locked flow carries it.
   * The core ContextBreakdown is structurally the wire WireContextBreakdown
   * (flat numbers) — shipped as-is.
   */
  private pushContextBreakdown(): void {
    this.outbound.sendDirect({ type: "context_breakdown", breakdown: this.engine.contextBreakdown?.() ?? ZERO_CONTEXT_BREAKDOWN });
  }

  private pushHooksList(): void {
    const hooks = [...(this.hooksList?.list() ?? [])];
    this.outbound.sendDirect({
      type: "hooks_list",
      hooks,
      ...(this.hooksList?.configError !== undefined ? { configError: this.hooksList.configError } : {}),
    });
  }

  private pushTaskList(): void {
    this.outbound.sendDirect({ type: "task_list", tasks: this.tasks?.list?.() ?? [] });
  }

  /**

   * `pushLspStatus`'s `?? []` — no `envStatus` seam (legacy tests/harness)
   * means zero new `env_status` messages, protecting exact-sequence
   * assertions over the ui_ready cascade / turn teardown.
   */
  private pushEnvStatus(): void {
    if (!this.envStatus) return;
    this.outbound.sendDirect({
      type: "env_status",
      status: {
        telemetry: this.envStatus.telemetry(),
        repoMap: this.envStatus.repoMap(),
      },
    });
  }

  private pushTaskOutput(taskId: string): void {
    const result = this.tasks?.readOutput?.(taskId);
    this.outbound.sendDirect({
      type: "task_output",
      taskId,
      snapshot: result?.snapshot ?? null,
      newOutput: result?.newOutput ?? "",
    });
  }

  private onTaskKillRequest(requestId: string, taskId: string): void {
    const ok = this.tasks?.kill?.(taskId) ?? false;
    this.outbound.sendDirect({
      type: "task_kill_result",
      requestId,
      ok,
      ...(ok ? {} : { reason: "task is not running or does not exist" }),
    });
    this.pushTaskList();
  }

  /**
   * Slice P7.26/R2 (design §2.1): the checkpoint timeline snapshot, served on
   * demand — a pure store read (listCheckpoints), safe mid-turn like
   * pushContextBreakdown. sendDirect, never buffered: request/response, no
   * byte-locked flow carries it. Absent seam -> `{checkpoints:[]}` (fail-closed).
   * Maps core CheckpointMeta -> WireCheckpointMeta (drops sessionId/commitHash).
   */
  private async pushCheckpointList(): Promise<void> {
    const metas = (await this.checkpoints?.list()) ?? [];
    const checkpoints: WireCheckpointMeta[] = metas.map((meta) => ({
      id: meta.id,
      label: meta.label,
      createdAt: meta.createdAt,
      reason: meta.reason,
    }));
    this.outbound.sendDirect({ type: "checkpoint_list", checkpoints });
  }

  /**
   * Slice P7.26/R2 (design §1/§2.2/§2.3): rewind this session to a checkpoint.
   *
   * Guards (all reply with a rewind_result — the timeline needs a non-silent
   * refusal, unlike set_model's silent drop, DoD-5):
   *  - busy -> {ok:false, reason:"a turn is running"} (mirror set_model's check +
   *    task_kill_result's reply).
   *  - no checkpoints seam -> {ok:false, reason:"checkpoints unavailable"}.
   *
   * On an accepted rewind, HOLD this.busy for the whole async operation
   * (drift-flag-3) so a mid-rewind user_message/set_mode/set_model hits the busy
   * gate — restored in `finally`. The service writes the mandatory fail-closed
   * pre-rewind safety checkpoint + two-tree file restore internally; the host only
   * applies the returned conversation snapshot (`loop.history.replaceAll`, exactly
   * the CLI's /rewind path, cli/main.ts).
   *
   * Emit order on a conversation-restoring rewind (design §1 — in-order delivery,
   * same as the ui_ready cascade): rewind_result FIRST, then the truncated
   * `session_history` rebuilt from the now-restored history. Before emitting, the
   * re-handshake state is rebuilt (drift-flag-1): `sessionHistory` is regenerated
   * from the truncated history and the replay ring is dropped (`Outbound.clear()`),
   * so a renderer reload after a rewind rehydrates the truncated transcript with
   * no pre-rewind turn events.
   */
  private async onRewind(message: Extract<UiToHostMessage, { type: "rewind_request" }>): Promise<void> {
    const { requestId, checkpointId, scope } = message;
    if (this.busy) {
      this.outbound.sendDirect({
        type: "rewind_result",
        requestId,
        ok: false,
        reason: "a turn is running",
        conversationRestored: false,
        restoredPaths: null,
      });
      return;
    }
    if (!this.engine.capabilities.supportsRewind || this.checkpoints === undefined) {
      this.outbound.sendDirect({
        type: "rewind_result",
        requestId,
        ok: false,
        reason: "checkpoints unavailable",
        conversationRestored: false,
        restoredPaths: null,
      });
      return;
    }
    if (this.engine.replaceHistory === undefined) {
      this.outbound.sendDirect({
        type: "rewind_result",
        requestId,
        ok: false,
        reason: "rewind unavailable with this engine",
        conversationRestored: false,
        restoredPaths: null,
      });
      return;
    }
    // Hold busy for the whole rewind (drift-flag-3): concurrent turn-starting /
    // mode / model messages observe busy=true while the store+git spawns run.
    this.busy = true;
    try {
      const res = await this.checkpoints.rewind(checkpointId, {
        scope,
        currentHistory: [...this.engine.historyItems()],
      });
      if (!res.ok) {
        this.outbound.sendDirect({
          type: "rewind_result",
          requestId,
          ok: false,
          reason: res.reason,
          conversationRestored: false,
          restoredPaths: null,
        });
        return;
      }
      const conversationRestored = res.historyItems !== null;
      if (conversationRestored) {
        // Atomic swap feeding the write-behind sink (truncates persistence too),
        // exactly the CLI's /rewind conversation restore.
        this.engine.replaceHistory(res.historyItems!);
        // drift-flag-1: rebuild the re-handshake snapshot from the TRUNCATED
        // history and drop the pre-rewind replay ring BEFORE re-sending, so a
        // renderer reload never resurrects the rewound-away conversation.
        this.sessionHistory = buildSessionHistory([...this.engine.historyItems()]);
        this.outbound.clear();
      }
      this.outbound.sendDirect({
        type: "rewind_result",
        requestId,
        ok: true,
        conversationRestored,
        restoredPaths: res.restoredPaths,
        safetyCheckpointId: res.safetyCheckpointId,
      });
      // §1 ordering: the truncated session_history rides AFTER rewind_result on
      // the same port. Null when the rewound-to history is empty (rewind-to-empty
      // = correct empty transcript; the renderer's transcript-scoped clear already
      // emptied it) — skip the emit then.
      if (conversationRestored && this.sessionHistory) {
        this.outbound.sendDirect({
          type: "session_history",
          sessionId: this.sessionId,
          items: this.sessionHistory.items,
          truncated: this.sessionHistory.truncated,
        });
      }
    } catch (error) {
      // rewind() never throws by contract (fail-soft RewindResult), but routing
      // must never crash — surface a fail-closed reply if it ever does.
      this.outbound.sendDirect({
        type: "rewind_result",
        requestId,
        ok: false,
        reason: `rewind failed: ${describeError(error)}`,
        conversationRestored: false,
        restoredPaths: null,
      });
    } finally {
      this.busy = false;
    }
  }

  private onUserMessage(requestId: string, text: string, images?: ImageAttachment[]): void {
    if (this.busy) {
      // Protocol guard (the UI also blocks the composer): one turn at a time.
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "busy" });
      return;
    }
    const attachments = images?.length ? [...images] : undefined;
    if (attachments !== undefined && (!this.engine.capabilities.supportsImages || this.imageInputEnabled?.() !== true)) {
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "unsupported_images" });
      return;
    }
    // Title derivation (design §4.2): the first accepted user message in a
    // title-less session names it (the picker is useless without titles). Done
    // exactly once per session — the flag is set on the first attempt.
    this.maybeDeriveTitle(text);
    // Background-task completion notices (slice 6.DP-2, mirror of
    // cli/main.ts:1328-1340): drained (not peeked) so a notice is delivered
    // exactly once; injected strictly AFTER the raw-text title derivation above
    // (a notice never leaks into the title) and only on an ACCEPTED turn (the
    // busy gate already returned) — a rejected message drains nothing. A turn
    // with no notices keeps `turnInput === text`, byte-identical to pre-6.DP-2.
    let turnInput = text;
    if (this.engine.capabilities.supportsTasks && this.tasks) {
      const notices = this.tasks.drainNotices();
      if (notices.length > 0) {
        turnInput = withBackgroundTaskNotices(turnInput, notices);
      }
    }
    this.busy = true;
    this.currentTurn = this.runTurn(requestId, turnInput, attachments).finally(async () => {
      this.busy = false;
      this.abort = null;
      this.turnId = null;
      this.snapshotPaths.clear();
      // Tier-2 title refinement (design §3): fired after the FIRST turn's
      // teardown only (maybeRefineTitle no-ops once pendingTitleRefineText has
      // been consumed) — fire-and-forget, never awaited here.
      this.maybeRefineTitle();
      // Slice 5.7: push a fresh git_status after the turn so a file the turn
      // changed is reflected in the pill. Fire-and-forget — must NEVER block or
      // throw into the turn (the bridge coalesces + swallows failures internally).
      this.git?.refreshAfterTurn();
      if (this.engine.capabilities.supportsTasks) this.pushTaskList();
      // Codex-P2 fix (slice P7.8): wait for in-flight telemetry appends to
      // settle before reading written/dropped counters, otherwise the panel
      // shows the previous turn's counts (fail-soft: a flush error/timeout
      // must never block the teardown push).
      try {
        await this.envStatus?.flushTelemetry?.();
      } catch {
        // flushTelemetry never rejects by contract (node-telemetry.ts); this
        // guard exists only to keep teardown byte-identical if that changes.
      }
      // Slice P7.8: refresh written/dropped telemetry counters after each turn
      // (mirror of the pushTaskList refresh above) — seam-gated, no-op in
      // legacy tests/harness.
      this.pushEnvStatus();
      // Codex-P2 fix (slice P7.8 review): keep currentTurn non-null until the
      // flush+push above have actually run, so shutdown()'s `await
      // this.currentTurn` (session.ts:332-337) always waits for the full
      // teardown instead of finding it already nulled mid-flush.
      this.currentTurn = null;
    });
  }

  private async runTurn(requestId: string, text: string, attachments?: ImageAttachment[]): Promise<void> {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.turnId = turnId;
    this.abort = controller;
    this.outbound.emit({ type: "turn_started", requestId, turnId });

    try {
      for await (const event of this.engine.runTurn(text, {
        signal: controller.signal,
        ...(attachments?.length ? { attachments } : {}),
      })) {
        this.captureSnapshotPath(event);
        this.outbound.emit({ type: "agent_event", turnId, event: sanitizeAgentEvent(event) });
        if (event.type === "error") {
          // TASK.2 DoD-c: the raw provider failure reaches the process log
          // (stdio:"inherit" -> app log), not only the transcript block.
          console.error(`[host] provider stream error: ${describeError(event.error)}`);
        }
        if (event.type === "tool_result") {
          await this.emitAfterSnapshot(event.outcome);
        }
      }
    } catch (error) {
      // runTurn is designed never to throw (it maps failures to loop_end), so
      // this is a defensive net; the host must not crash on a rogue turn.
      this.outbound.emit({ type: "fatal", message: `turn failed: ${describeError(error)}` });
    }
  }

  private captureSnapshotPath(event: AgentEvent): void {
    if (this.engine.capabilities.supportsFileSnapshots && event.type === "tool_execution_start" && isSnapshotTool(event.toolName)) {
      const path = extractSnapshotPath(event.input);
      if (path !== null) {
        this.snapshotPaths.set(event.toolCallId, path);
      }
    }
  }

  private async emitAfterSnapshot(outcome: ToolCallOutcome): Promise<void> {
    const path = this.snapshotPaths.get(outcome.toolCallId);
    this.snapshotPaths.delete(outcome.toolCallId);
    if (!this.engine.capabilities.supportsFileSnapshots || !isSnapshotTool(outcome.toolName) || outcome.status !== "success" || path === undefined) {
      return;
    }
    try {
      const snapshot = await readSnapshot(this.fs, path);
      this.outbound.emit({
        type: "file_snapshot",
        toolCallId: outcome.toolCallId,
        path,
        phase: "after",
        content: snapshot.content,
        truncated: snapshot.truncated,
      });
    } catch {
      // The after-snapshot is best-effort diff data; never let it break a turn.
    }
  }

  /**
   * Adds a session rule when a `permission_response` carried `remember` on an
   * "allow" (design §5, slice 2.2.3). MUST run BEFORE `broker.handleResponse`:
   * `pendingToolName` reads the still-parked ask, which `handleResponse`
   * settles and removes. A "deny" (or no `remember`) is a no-op — the invariant
   * that a stored rule only ever escalates a future "ask" ruling to "allow"
   * (RuleAwarePermissionEngine, packages/core/src/permissions/rules.ts) is
   * preserved unconditionally here: this method never touches deny outcomes,
   * so plan-mode / hook denials stay denied regardless of any rule added.
   */
  private maybeRemember(
    requestId: string,
    behavior: "allow" | "deny",
    remember: { pattern?: string } | undefined,
  ): void {
    if (behavior !== "allow" || !remember) {
      return;
    }
    const toolName = this.broker.pendingToolName(requestId);
    if (toolName === undefined) {
      // Unknown/already-settled requestId: handleResponse below will also
      // ignore it (fail-quiet, first-response-wins) — nothing to remember.
      return;
    }
    this.rules.add(remember.pattern !== undefined ? { toolName, pattern: remember.pattern } : { toolName });
  }

  private onCancel(): void {
    if (this.abort) {
      this.abort.abort();
    }
    // Release parked asks so the dispatcher unblocks; the loop then ends the turn
    // as cancelled (design §4.4 — the broker gets no AbortSignal by contract).
    this.broker.denyAll("turn cancelled", "turn_cancelled");
  }

  private onSetMode(mode: PermissionMode): void {
    if (this.busy) {
      this.outbound.emit({
        type: "mode_change_rejected",
        reason: "cannot change mode during an active turn",
      });
      return;
    }
    if (!this.engine.capabilities.supportsCorePermissions || this.engine.setMode === undefined) {
      this.outbound.emit({
        type: "mode_change_rejected",
        reason: "permission modes are managed by this engine",
      });
      return;
    }
    this.engine.setMode(mode);
    // Persist the mode so a resume restores it (design §4.2); fire-and-forget.
    this.persistence?.touch({ mode });
    this.outbound.emit({ type: "mode_changed", mode });
  }

  /**
   * Derives the session title from the first user message's first line
   * (design §4.2; Phase 4 slice 4.4-T additionally sanitizes reminder tags
   * and emits `title_changed` + arms the tier-2 refinement). `sanitizeTitleSource`
   * is defensive here — the raw pre-hook text this is called with never
   * actually carries a `<hook-context>`/`<plan-mode-reminder>` tag (those are
   * injected later, inside the loop) — but it's cheap insurance against a
   * future caller that forwards already-wrapped text.
   */
  private maybeDeriveTitle(text: string): void {
    if (this.titleSet) {
      return;
    }
    // One attempt, regardless of outcome — never re-derive on later turns.
    this.titleSet = true;
    const title = deriveSessionTitle(sanitizeTitleSource(text));
    if (title.length > 0) {
      this.persistence?.touch({ title });
      this.outbound.emit({ type: "title_changed", title });
      // Arms the tier-2 refinement below, over the SAME raw text — only ever
      // set when this run's own heuristic just wrote a title.
      this.pendingTitleRefineText = text;
    }
  }

  /**

   * run from the first turn's teardown. Consumes `pendingTitleRefineText`
   * unconditionally so it can never fire twice, whether or not a `refineTitle`
   * callback was injected; a null/failed refinement leaves the heuristic title
   * standing (fail-soft — never surfaces in the transcript or crashes the turn).
   */
  private maybeRefineTitle(): void {
    if (this.pendingTitleRefineText === null) {
      return;
    }
    const text = this.pendingTitleRefineText;
    this.pendingTitleRefineText = null;
    if (!this.refineTitle) {
      return;
    }
    void this.refineTitle(text)
      .then((title) => {
        if (title) {
          this.persistence?.touch({ title });
          this.outbound.emit({ type: "title_changed", title });
        }
      })
      .catch(() => {
        // Fail-soft: a refinement error/timeout never surfaces; the heuristic
        // title written by maybeDeriveTitle above stands.
      });
  }
}

/**
 * Projects the boot history snapshot into the `session_history` payload (design
 * §3.3): HistoryItem -> WireHistoryItem (drop tokenEstimate), keeping only the
 * last SESSION_HISTORY_MAX_ITEMS (+truncated). Returns null for an empty
 * snapshot (nothing to hydrate).
 */
function buildSessionHistory(
  bootHistory: readonly HistoryItem[],
): { items: WireHistoryItem[]; truncated: boolean } | null {
  if (bootHistory.length === 0) {
    return null;
  }
  const truncated = bootHistory.length > SESSION_HISTORY_MAX_ITEMS;
  const kept = truncated ? bootHistory.slice(-SESSION_HISTORY_MAX_ITEMS) : bootHistory;
  const items: WireHistoryItem[] = kept.map((item) => ({
    id: item.id,
    createdAt: item.createdAt,
    ...(item.kind !== undefined ? { kind: item.kind } : {}),
    message: item.message,
  }));
  return { items, truncated };
}

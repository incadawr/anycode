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
  CodexRateLimitsWire,
  CommandHookDeclaration,
  FileSystemPort,
  FinalTextAccumulator,
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
import {
  SESSION_TITLE_MAX_LENGTH,
  SUBAGENT_ACTIVITY_MAX_EVENTS,
  appendFinalText,
  createFinalTextAccumulator,
  deriveSessionTitle,
  finalizeFinalText,
  fixateFinalText,
  resetFinalText,
  sanitizeTitleSource,
  summarizeChildToolCall,
  withBackgroundTaskNotices,
  withPlanModeReminder,
} from "@anycode/core";
import { randomUUID } from "node:crypto";
import type {
  EngineModelChoice,
  EnginePermissionPreset,
  HostToUiMessage,
  EnginePresentation,
  ShellCapabilitiesProjection,
  UiToHostMessage,
  WireCheckpointMeta,
  WireEnvStatus,
  WireHistoryItem,
  WirePort,
} from "../shared/protocol.js";
import { uiToHostMessageSchema } from "../shared/protocol.js";
import { CHILD_STEER_QUEUE_MAX, type ChildRunStatus } from "../shared/child-sessions.js";
import type { GitUiBridge } from "./git-bridge.js";
import type { IpcPermissionBroker } from "./permission-broker.js";
import { extractSnapshotPath, isSnapshotTool, readSnapshot } from "./snapshot-hook.js";
import { PreviewArtifactCollector } from "./preview-artifacts.js";
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

function worktreeExitSystemContext(projectRoot: string): string {
  return `Worktree exited. The session is now back in the main project at ${projectRoot}.`;
}

/** A provider-originated non-error event proves the augmented request reached the model stream. */
function isSuccessfulModelDeliveryEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case "start":
    case "text_start":
    case "text_delta":
    case "text_end":
    case "reasoning_start":
    case "reasoning_delta":
    case "reasoning_end":
    case "tool_input_start":
    case "tool_input_delta":
    case "tool_input_end":
    case "tool_call":
    case "finish":
      return true;
    default:
      return false;
  }
}

/**
 * The engine's OWN model/permission controls (TASK.39, cut §3.1/§2(d)), exposed
 * to Session as a narrow structural seam — exactly like `git`/`checkpoints`/
 * `tasks` above, and for the same reason: Session must never import an engine
 * implementation. Only a non-core engine that owns a native catalog and a native
 * policy vocabulary supplies one; core does not, so the core wire is unchanged.
 *
 * The contract that makes this safe (and is asserted by the tests):
 *  - `selectModel`/`selectPreset` are SYNCHRONOUS and send NOTHING. They only
 *    validate host-side and record the choice; the engine puts it on the next
 *    `turn/start`. A rejected choice therefore costs no RPC and no turn.
 *  - `snapshot()` is the engine's own persisted intent, never a server echo.
 *  - `onSettingsApplied` fires when a `turn/start` has actually carried the
 *    change — the only honest "applied" signal that exists (the app-server sends
 *    no settings-updated notification at all).
 */
export type EngineSettingsChange =
  | { ok: true; model: string; activePresetId: string; effort?: string }
  | { ok: false; reason: string };

export interface EngineSettingsSeam {
  models(): EngineModelChoice[];
  presets(): EnginePermissionPreset[];
  /** The APPLIED settings — what a `turn/start` actually carried. Never a merely-chosen value (see `pendingSnapshot`). */
  snapshot(): { model: string; activePresetId: string; effort?: string };
  selectModel(id: string): EngineSettingsChange;
  selectPreset(id: string): EngineSettingsChange;
  selectEffort?(effort: string): EngineSettingsChange;
  onSettingsApplied(listener: (snapshot: { model: string; activePresetId: string; effort?: string }) => void): () => void;
  /**
   * The chosen-but-not-yet-applied delta, or null. Re-asserted on every
   * `ui_ready` so a renderer reload cannot lose (or mis-fold) the pending badge:
   * the original `state:"pending"` message is a one-shot in the replay ring.
   * Optional — an engine with no two-phase ack simply has nothing pending.
   */
  pendingSnapshot?(): { model: string; activePresetId: string; effort?: string } | null;
  /**
   * True when the engine applies a settings change over its OWN acknowledged
   * control request instead of on the next `turn/start` (Claude, SLICE-CC
   * §1.5). Session then records the choice ONLY from `onSettingsApplied`.
   *
   * Accept-time persistence is correct for codex — nothing was sent, so the
   * choice cannot have been refused, and the engine re-asserts it on every
   * turn/start. It is UNSAFE for an immediate-apply engine: the control
   * request can be rejected or time out, leaving the CLI on its previous
   * posture while the row already holds the new one. A later resume then
   * spawns under a preset the engine never adopted — silently WIDENING
   * permissions (`ask` -> `workspace`). Retaining the prior row on failure is
   * therefore by construction here: the write simply never happens until the
   * ack lands.
   *
   * Absent/false keeps the pre-SLICE-CC accept-time path byte-identical.
   */
  persistsOnApply?: boolean;
  /**
   * The engine's latest merged subscription-quota snapshot (codex-profiles
   * cut §6.1), read into `EnginePresentation.quota` on every `ui_ready` — a
   * renderer reload gets the freshest snapshot without any bind-time push.
   * Optional/null — an engine without quota reporting keeps the projection
   * byte-identical (the field is simply absent).
   */
  quotaSnapshot?(): CodexRateLimitsWire | null;
}

/** Only external engines carry this additive wire projection; core stays byte-identical. */
function enginePresentation(engine: SessionEngine, settings?: EngineSettingsSeam): EnginePresentation | undefined {
  if (engine.id === "core") return undefined;
  const capabilities = engine.capabilities;
  // The two additive blocks (TASK.39) appear only when the engine actually has a
  // catalog/preset table: an engine without one keeps the pre-TASK.39 projection
  // byte-identical, and a renderer that sees no `model`/`permissions` hides the
  // pickers rather than guessing.
  const models = settings?.models() ?? [];
  const presets = settings?.presets() ?? [];
  const snapshot = settings?.snapshot();
  // Codex-profiles cut §3.5/§6.1: the starting quota snapshot (additive; live
  // updates ride `engine_quota` AgentEvents inside turns). Rebuilt on every
  // ui_ready, so a reconnecting renderer sees everything merged so far.
  const quota = settings?.quotaSnapshot?.() ?? null;
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
    ...(snapshot !== undefined && models.length > 0 ? { model: { current: snapshot.model, available: models, ...(snapshot.effort !== undefined ? { effort: snapshot.effort } : {}) } } : {}),
    ...(snapshot !== undefined && presets.length > 0
      ? { permissions: { presets, activePresetId: snapshot.activePresetId } }
      : {}),
    ...(quota !== null ? { quota } : {}),
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

// ── child-mode support (TASK.102 CUT-S2 §2.6.3, slice S2b B4) ──

/**
 * The child-mode terminal report Session hands to `ChildSessionOptions.
 * onTerminal` — everything `apps/desktop/src/host/index.ts`'s child branch
 * needs to build a `ChildTerminal` wire message (shared/child-sessions.ts),
 * minus the `type` discriminant: posting to `process.parentPort` is that
 * file's job, not Session's (Session never imports `process.parentPort`).
 */
export interface ChildTerminalReport {
  status: ChildRunStatus;
  finalText: string;
  truncated: boolean;
  turns: number;
  toolCalls: number;
  durationMs: number;
  /**
   * Count of eligible tool_result calls withheld past `SUBAGENT_ACTIVITY_MAX_EVENTS`
   * over the child's WHOLE turn chain (CUT-S2 §10.7 п.4, parity with
   * `runner.ts:573`'s inline `activitySuppressed`). Present only when >0.
   */
  activitySuppressed?: number;
}

/**
 * The child-mode activity/progress report Session hands to
 * `ChildSessionOptions.onProgress` (CUT-S2 §10.7 п.7) — mirrors
 * `ChildProgress`'s (shared/child-sessions.ts) "progress" and "activity"
 * variants minus the `type` discriminant, exactly like `ChildTerminalReport`
 * above mirrors `ChildTerminal`. "attention" is deliberately NOT a variant
 * here: that boundary is produced by the permission-tap (`tapChildPermissions`
 * below) wrapping the broker's `emit`, not by Session's turn-event loop.
 */
export type ChildProgressReport =
  | { kind: "progress"; turns: number; toolCalls: number; lastTool?: string }
  | { kind: "activity"; toolName: string; summary: string };

/**
 * Child-mode options (CUT-S2 §2.6.3). Presence of this option is what turns
 * an otherwise-ordinary `Session` into a child-mode one: title derivation
 * becomes a no-op (§5.14 — a child has no name), a `user_message` received
 * while busy is queued (bounded by `CHILD_STEER_QUEUE_MAX`) instead of
 * rejected, and `startProgrammaticTurn` becomes available to kick off the
 * child's one and only externally-triggered turn chain.
 */
export interface ChildSessionOptions {
  /**
   * Fires exactly once, on this session's FIRST `ui_ready` — never before
   * (the renderer/relay is not listening yet) and never again on a later
   * reconnect (CUT-S2 §2.6.3: "child-ready host шлёт на ПЕРВЫЙ ui_ready").
   */
  onReady: () => void;
  /**
   * Durably flushes the child's history sink (the SAME `flushChecked()` a
   * durable transcript read — CUT-S2 §0.5/§2.6.3's ordering guarantee: the
   * terminal report is handed to `onTerminal` ONLY after this resolves. A
   * rejection produces an `error` terminal instead (an honest failure beats
   * a "completed" card whose "Open" reads an empty transcript).
   */
  flushHistory: () => Promise<void>;
  /**
   * Invoked exactly once per host lifetime: after the steer queue has
   * fully drained (CUT-S2 §5.16 — a terminal published while the queue is
   * non-empty would make steering a dead facade) AND `flushHistory` has
   * resolved.
   */
  onTerminal: (report: ChildTerminalReport) => void;
  /**
   * Fires on every activity/progress boundary the child's turn-event loop
   * crosses (CUT-S2 §10.7 п.7) — a buffered `tool_execution_start`/
   * `tool_result` pair for "activity", and a leading-edge 1000ms-throttled
   * `tool_result`/`turn_end` boundary for "progress". REQUIRED, not
   * optional: §10.7 п.7 calls out that an easily-forgotten optional seam here
   * is the same defect class as the rejected `includeChildren?` (§0.4) — a
   * host that constructs a child Session and forgets to wire this would lose
   * the whole live activity/progress feed silently instead of a compile
   * error.
   */
  onProgress: (report: ChildProgressReport) => void;
  /**
   * DI clock for the progress throttle (CUT-S2 §10.7 п.3): defaults to
   * `Date.now`. Injected by tests for deterministic leading-edge 1000ms
   * boundary assertions; never used outside the progress-throttle path.
   */
  now?: () => number;
}

/**
 * Permission-tap for a child session's broker (CUT-S2 §0.8/§2.6.3): wraps
 * the `emit` closure an `IpcPermissionBroker` is constructed with (host/
 * index.ts's child branch does the wrapping, since that is where the
 * broker itself is built) so an "attention" signal reaches main — relayed
 * over `process.parentPort` as `ChildProgress{kind:"attention"}` — around
 * every permission ask: `true` right before a `permission_request` is
 * forwarded, `false` right before a `permission_settled` is. Every message
 * the broker ever emits (there are no other `HostToUiMessage` types an
 * `IpcPermissionBroker` produces) is forwarded to the wrapped `emit`
 * completely UNCHANGED — `onAttention` is a pure side effect that never
 * alters, drops, or reorders what the UI wire itself sees.
 */
export function tapChildPermissions(
  emit: (message: HostToUiMessage) => void,
  onAttention: (waiting: boolean) => void,
): (message: HostToUiMessage) => void {
  return (message: HostToUiMessage): void => {
    if (message.type === "permission_request") {
      onAttention(true);
    } else if (message.type === "permission_settled") {
      onAttention(false);
    }
    emit(message);
  };
}

/**
 * Narrow persistence callback injected into Session (design §4.2): Session
 * persists session-meta patches (title on the first user message, mode on a
 * between-turns set_mode) WITHOUT ever receiving the whole PersistencePort.
 * Fire-and-forget — it must never throw into or block a turn.
 */
export interface SessionPersistence {
  /**
   * `enginePreset` (TASK.39, cut §2(k).4) is deliberately its OWN field rather
   * than being smuggled through `mode`: a Codex preset id is not a core
   * PermissionMode, and the two vocabularies must not be conflated in the type
   * system even though they share the `mode` COLUMN in the session row (which
   * is a plain TEXT column — no migration, cut §2(k).4). The host maps it to
   * that column at the persistence boundary, where the cast is visible.
   */
  touch(patch: { title?: string; mode?: PermissionMode; model?: string; enginePreset?: string }): void;
}

export interface SessionOptions {
  outbound: Outbound;
  /** The host-selected agent runtime; Session never imports an external engine. */
  engine: SessionEngine;
  /**
   * TASK.39: the engine's own model catalog + permission presets. Absent for
   * core (and for any engine without native controls) -> `set_engine_preset` is
   * a no-op, `set_model` keeps its legacy core path, and `host_ready.engine`
   * carries no `model`/`permissions` block.
   */
  engineSettings?: EngineSettingsSeam;
  broker: IpcPermissionBroker;
  /** Adapter for reading "after" snapshots (design §5). */
  fs: FileSystemPort;
  workspace: string;
  /** Stable project identity while workspace may be a relocated worktree. */
  projectRoot?: string;
  /** Persisted worktree identity, emitted before any resumed continuation. */
  worktree?: import("../shared/protocol.js").WorktreeProjection;
  /** Durable boot token set by a terminal transition. */
  continuationPending?: boolean;
  continuationMode?: "model" | "none";
  /** Durable one-shot created only by the chrome's direct Exit Worktree action. */
  worktreeExitNoticePending?: boolean;
  /** Clears that durable marker after the augmented input reaches a core model stream. */
  consumeWorktreeExitNotice?: () => Promise<void>;
  /** Called once after host_ready, before the resumed model segment starts. */
  onContinuationReady?: () => Promise<void>;
  /** Clears the durable continuation claim only after its segment completes. */
  onContinuationComplete?: () => Promise<void>;
  /** Durability-gated handoff to desktop main. */
  onWorkspaceTransition?: (
    transition: import("@anycode/core").WorkspaceTransition,
  ) => Promise<void>;
  /** Same host-owned port used by ExitWorktree; chrome exposes auto/keep only. */
  worktreeControl?: import("@anycode/core").WorktreeControlPort;
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
   * Shell (AnyCode chrome) capability projection (design TASK.40 §2(f)):
   * independent of the active engine's own tool capabilities. Absent (core,
   * and any engine that hasn't wired one) defaults every shell feature to
   * enabled -- byte-identical to the pre-TASK.40 behavior, where a
   * user-initiated `git_command` mutation was gated on
   * `engine.capabilities.supportsGitMutations` (always `true` for `CoreEngine`).
   * That flag now describes ONLY the agent's own tool-mutation capability;
   * `shell.gitUserMutations` is the genuinely separate, host-computed gate
   * for the AnyCode-owned Review panel's user-initiated mutations (see the
   * `git_command` case in `route()` below). Echoed on `host_ready.shell`
   * ONLY alongside a present `engine` (never for core -- §3.2 contract).
   */
  shell?: ShellCapabilitiesProjection;
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
  /**
   * TASK.45 W11: reports a real request outcome for the connection this session
   * is pinned to (a runtime auth failure, rate limit, network/server error, or a
   * successful generation) so main can classify + persist advisory connection
   * health. `code` mirrors core's `ProviderFailureCode` (provider/failure.ts) as
   * a plain string — the SAME classification `classifyProviderFailure` already
   * attached to the event's `safe` field (never reclassified here). Host/index.ts
   * wires this ONLY for the core engine (Codex owns its own account, outside the
   * core provider catalog) by posting a `ProviderHealthEvent` on parentPort; main
   * (tabs.ts) resolves the CALLER's pinned connectionId, so Session itself stays
   * connection-agnostic. Absent in every legacy test -> a silent no-op.
   */
  reportProviderHealth?: (event: { kind: "success" } | { kind: "failure"; code: string }) => void;
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
  /**
   * Turn-end auto-open signal (night-track wave-1 cut §1(a)/§2.3, TASK.96
   * 96-E): posts a `PreviewArtifactsMessage` over the host<->main control
   * plane (`process.parentPort`, wired by host/index.ts mirroring
   * `sendPreviewRequest`/`sendCredentialRequest`) once per turn teardown, iff
   * the PreviewArtifactCollector captured at least one qualifying Write/Edit
   * this turn. Absent in every legacy test -> the collector still runs (zero
   * cost) but nothing is ever posted.
   */
  postPreviewArtifacts?: (paths: string[]) => void;
  /**
   * TASK.102 CUT-S2 §2.6.3: present ONLY for a child-mode host (host/index.ts's
   * child branch). Absent -> every child-only branch below is inert and this
   * Session is byte-identical to the pre-S2 root session (every legacy test
   * omits this field).
   */
  child?: ChildSessionOptions;
}

export class Session {
  private readonly outbound: Outbound;
  private readonly engine: SessionEngine;
  /** TASK.39: engine-native model/preset controls; undefined -> the engine has none. */
  private readonly engineSettings: EngineSettingsSeam | undefined;
  /** Releases the `onSettingsApplied` subscription at shutdown (no push-after-dispose). */
  private engineSettingsUnsubscribe: (() => void) | undefined;
  private readonly broker: IpcPermissionBroker;
  private readonly fs: FileSystemPort;
  private readonly workspace: string;
  private readonly projectRoot: string;
  private readonly worktree: import("../shared/protocol.js").WorktreeProjection | undefined;
  private continuationPending: boolean;
  private readonly continuationMode: "model" | "none";
  private worktreeExitNoticePending: boolean;
  private readonly consumeWorktreeExitNotice: (() => Promise<void>) | undefined;
  private readonly onContinuationReady: (() => Promise<void>) | undefined;
  private readonly onContinuationComplete: (() => Promise<void>) | undefined;
  private readonly onWorkspaceTransition: SessionOptions["onWorkspaceTransition"];
  private readonly worktreeControl: SessionOptions["worktreeControl"];
  /** TASK.45 W11: undefined for Codex / every legacy test -> no-op. */
  private readonly reportProviderHealth: SessionOptions["reportProviderHealth"];
  // Slice P7.15 (F14): mutable — a mid-session set_model updates the live model.
  private model: string;
  private readonly sessionId: string;
  private readonly persistence: SessionPersistence | undefined;
  private readonly rules: SessionPermissionRules;
  private readonly git: GitUiBridge | undefined;
  /** Design TASK.40 §2(f): shell capability projection; undefined -> every shell feature defaults to enabled. */
  private readonly shell: ShellCapabilitiesProjection | undefined;
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

  /** Turn-scoped auto-open collector (cut §1(a), 96-E) — drained at every turn teardown. */
  private readonly previewArtifacts = new PreviewArtifactCollector();
  /** Injected turn-end poster; undefined in legacy tests -> the collector still runs, nothing is ever sent. */
  private readonly sendPreviewArtifacts: SessionOptions["postPreviewArtifacts"];

  private busy = false;
  /** Permanent source-host latch once a durable relocation handoff begins. */
  private relocating = false;
  private abort: AbortController | null = null;
  private turnId: string | null = null;
  private currentTurn: Promise<void> | null = null;
  /**
   * TASK.102 CUT-S2 §10.12.1: flipped as the FIRST step of `shutdown()`,
   * strictly before `abort.abort()`/`denyAll`/`dispose` so any teardown woken
   * by the abort below already observes it. A SEMANTIC gate (distinct from
   * the reentrant `currentTurn` wait in `shutdown()` below, which is a
   * STRUCTURAL guarantee): once set, no NEW turn or tracked maintenance op
   * (worktree exit, rewind, continuation) may ever be admitted — enforced at
   * exactly four audited points: `route()`'s default-deny shutdown funnel
   * (every wire message, future types included by construction),
   * `startProgrammaticTurn`, and both child drain points
   * (`onChildTurnSettled`, `finalizeChildTerminal`'s healthy-path re-check).
   * Never cleared — a Session is never un-shut-down.
   */
  private shuttingDown = false;

  /**

   * The LSP live-push listener drops every fire before this — an unsolicited
   * push must never race a not-yet-mounted renderer (5.7-hostfix bind-race
   * lesson), and the ui_ready case itself pushes the current snapshot.
   */
  private uiReady = false;
  /** Slice P7.25/F3: unsubscribes the LSP status listener on shutdown (no leaked listener, no push-after-dispose). */
  private lspUnsubscribe: (() => void) | undefined;

  // ── child-mode state (TASK.102 CUT-S2 §2.6.3); every field below is inert
  // (never read or mutated) whenever `this.child === undefined`. ──

  private readonly child: ChildSessionOptions | undefined;
  /** Latches once `child.onReady()` has fired, so a later reconnect's ui_ready never fires it twice. */
  private childReadySent = false;
  /** Latches once `startProgrammaticTurn` has been called, so a second call is a refusal (one initial turn per host lifetime). */
  private programmaticTurnStarted = false;
  /** Host-side steer queue (§1.1/§2.6.3): a `user_message` received while busy is parked here instead of rejected, bounded by `CHILD_STEER_QUEUE_MAX`. */
  private readonly steerQueue: Array<{ requestId: string; text: string; images?: ImageAttachment[] }> = [];
  /** Final-text accumulator over the WHOLE child session's turn chain (packages/core/src/subagents/final-text.ts — the same reset/append/fixate semantics runner.ts applies to an inline subagent). */
  private childFinalText: FinalTextAccumulator = createFinalTextAccumulator();
  /** Cumulative turn count across every runTurn() call this child session has made (summed from each call's own loop_end.turns). */
  private childTurns = 0;
  /** Cumulative tool_result count across the whole child session's turn chain. */
  private childToolCalls = 0;
  /** The last loop_end's status (workspace_transition mapped to "error" — a child never actually relocates); undefined until the first loop_end. */
  private childLoopStatus: ChildRunStatus | undefined;
  /** Once-latch (F7): true once `finalizeChildTerminal` has actually invoked `child.onTerminal` (or handed off an error terminal) — guards its docstring's "exactly once" contract against a second concurrent call. */
  private childTerminalFinalized = false;
  /** Wall-clock start of the child's turn chain, set once by startProgrammaticTurn — the terminal report's durationMs baseline. */
  private childStartedAt = 0;
  /**
   * DI clock for the progress leading-edge throttle (CUT-S2 §10.7 п.3);
   * defaults to `Date.now`, overridable via `child.now` for deterministic
   * tests. Inert (never called) whenever `this.child === undefined`.
   */
  private readonly now: () => number;
  /**
   * Buffers a validated child tool call's name+input from
   * `tool_execution_start` until its paired `tool_result` arrives (mirrors
   * `runner.ts`'s `pendingChildCalls`, W1-FIX) — keyed by toolCallId so
   * multiple in-flight starts before any result cannot collide.
   */
  private readonly pendingChildCalls = new Map<string, { toolName: string; input: unknown }>();
  /** Per-child-session activity-event emission counter (CUT-S2 §10.7 п.3), capped at `SUBAGENT_ACTIVITY_MAX_EVENTS` over the WHOLE turn chain — never reset per turn. */
  private childActivityEmitted = 0;
  /** Count of eligible tool_result calls withheld past the activity cap (CUT-S2 §10.7 п.4) — reported on the terminal only when >0. */
  private childActivitySuppressed = 0;
  /** NEW counter (CUT-S2 §10.7 п.3): count of `turn_end` events over the whole turn chain — the progress report's `turns` field, mirroring inline's local `turnEndCount` (runner.ts). Distinct from `childTurns`, which sums `loop_end.turns`. */
  private childTurnEndCount = 0;
  /** The most recent tool_result's outcome.toolName, updated UNCONDITIONALLY (even on invalid_input) — mirrors `runner.ts:502`. */
  private childLastTool: string | undefined;
  /** Wall-clock (per `this.now`) of the last emitted progress report — `undefined` until the first boundary, so the first boundary always emits (leading edge). */
  private childLastProgressEmitAt: number | undefined;

  constructor(options: SessionOptions) {
    this.outbound = options.outbound;
    this.engine = options.engine;
    this.engineSettings = options.engineSettings;
    this.broker = options.broker;
    this.fs = options.fs;
    this.workspace = options.workspace;
    this.projectRoot = options.projectRoot ?? options.workspace;
    this.worktree = options.worktree;
    this.continuationPending = options.continuationPending ?? false;
    this.continuationMode = options.continuationMode ?? "model";
    this.worktreeExitNoticePending = options.worktreeExitNoticePending ?? false;
    this.consumeWorktreeExitNotice = options.consumeWorktreeExitNotice;
    this.onContinuationReady = options.onContinuationReady;
    this.onContinuationComplete = options.onContinuationComplete;
    this.onWorkspaceTransition = options.onWorkspaceTransition;
    this.worktreeControl = options.worktreeControl;
    this.reportProviderHealth = options.reportProviderHealth;
    this.model = options.model;
    this.sessionId = options.sessionId;
    this.persistence = options.persistence;
    this.rules = options.rules;
    this.git = options.git;
    this.shell = options.shell;
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
    this.sendPreviewArtifacts = options.postPreviewArtifacts;
    this.child = options.child;
    this.now = options.child?.now ?? Date.now;
    this.titleSet = options.hasTitle ?? false;
    this.sessionHistory = buildSessionHistory(options.bootHistory ?? []);
    // Slice P7.25/F3: subscribe to live LSP status transitions. The listener is

    // ready; unsubscribe on shutdown prevents a leaked listener / push-after-
    // dispose. Absent seam (legacy tests) -> no subscription, pull-only.
    this.lspUnsubscribe = this.lsp?.onStatusChange?.(() => {
      if (this.uiReady) this.pushLspStatus();
    });
    // Phase 2 of the settings ack (TASK.39, cut §2(k).3). This fires from inside
    // the engine's turn/start, i.e. always while a turn is running and therefore
    // always after ui_ready; it is `emit` (buffered), not sendDirect, so the ack
    // survives a renderer reload via replay rather than racing it.
    this.engineSettingsUnsubscribe = this.engineSettings?.onSettingsApplied((applied) => {
      this.model = applied.model;
      // SLICE-CC §1.5: for an immediate-apply seam THIS is the only honest
      // moment to persist — the engine has now acknowledged the change, so the
      // row can no longer describe a posture the CLI refused (see
      // `persistsOnApply`). A rejected/timed-out change never reaches here, so
      // the prior row simply stands.
      if (this.engineSettings?.persistsOnApply === true) {
        this.persistence?.touch({ model: applied.model, enginePreset: applied.activePresetId });
      }
      this.outbound.emit({
        type: "engine_settings_changed",
        model: applied.model,
        activePresetId: applied.activePresetId,
        ...(applied.effort !== undefined ? { effort: applied.effort } : {}),
        state: "applied",
        appliesFrom: "next_turn",
      });
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

  /**
   * TASK.102 CUT-S2 §10.14.3 BLOCKER-1: arms the admission funnel BEFORE the
   * rest of host teardown runs, closing the window between `handleShutdown`'s
   * first step and its eventual `shutdown()` call during which the funnel
   * (route()'s `this.shuttingDown` check) was ungated — a `rewind_request` or
   * `user_message` arriving mid-teardown was still admitted against managers
   * already being torn down. Idempotent with `shutdown()`'s own assignment
   * below: no code path early-returns on the flag, so the real teardown still
   * runs in full.
   */
  closeAdmissions(): void {
    this.shuttingDown = true;
  }

  /** Graceful shutdown: abort the turn, release parked asks, await turn teardown. */
  async shutdown(): Promise<void> {
    // TASK.102 CUT-S2 §10.11.1 N1: flipped FIRST, strictly before abort/
    // denyAll/dispose below, so teardown woken by the abort already sees it.
    this.shuttingDown = true;
    // Slice P7.25/F3: release the LSP status subscription so no transition after
    // this point can push onto a shut-down session, and no listener reference
    // leaks past the session's life. (The host reaps lspManager BEFORE calling
    // shutdown, so the final "all disposed" snapshot already rode out as a valid
    // push; this guards everything strictly after teardown begins.) uiReady is
    // flipped false as a belt-and-braces gate for any in-flight microtask.
    this.uiReady = false;
    this.lspUnsubscribe?.();
    this.lspUnsubscribe = undefined;
    this.engineSettingsUnsubscribe?.();
    this.engineSettingsUnsubscribe = undefined;
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
    // TASK.102 CUT-S2 §10.12.1/§10.12.2: a snapshot-await of `this.currentTurn`
    // (the pre-fix shape) misses a FRESH turn a drain synchronously
    // re-points it to (onChildTurnSettled / finalizeChildTerminal's
    // re-check) — that new turn's own teardown (including its own
    // finalizeChildTerminal/flushHistory) would run on the disposed engine,
    // unobserved. Reentrant wait instead: loop until the SAME promise is
    // observed twice in a row (or null). Termination: admission happens at
    // exactly four gated points (route() funnel / startProgrammaticTurn /
    // both drain points), so no NEW op is admitted after the flag is set;
    // `currentTurn` is the SINGLE wait primitive — it tracks turn teardown,
    // worktree exits, rewinds and continuations — so iterations are bounded
    // by ops admitted before the flag, plus one. The loop (vs a snapshot) is
    // the STRUCTURAL backstop for an admission point a future audit misses —
    // pinned by §10.12.2's white-box test.
    let seen: Promise<void> | null = null;
    while (this.currentTurn !== null && this.currentTurn !== seen) {
      seen = this.currentTurn;
      await Promise.allSettled([seen]);
    }
    await Promise.allSettled([disposal]);
  }

  private route(raw: unknown): void {
    const parsed = uiToHostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // Fail-closed: garbage can never grant a permission or start a turn.
      console.warn("[host] dropped invalid UI message:", parsed.error.issues);
      return;
    }
    const message = parsed.data;
    // TASK.102 CUT-S2 §10.12.1: the SINGLE admission funnel for every wire
    // message once shutdown has begun — default-deny: new message types are
    // shutdown-safe by construction, not by a per-case audit (the class of
    // bug this replaces: §10.11.1's own point-gates missed ui_ready's
    // continuation, exit_worktree, and rewind_request). Three carve-outs get
    // an honest reply (each starts trackable work the caller is owed an
    // answer about); everything else is a silent drop (the renderer is
    // attached to a dying host — replies to informational requests are moot).
    if (this.shuttingDown) {
      switch (message.type) {
        case "user_message":
          this.outbound.emit({ type: "turn_rejected", requestId: message.requestId, reason: "not_ready" });
          break;
        case "exit_worktree":
          this.outbound.sendDirect({
            type: "worktree_notice",
            message: "Cannot exit the worktree: the session is shutting down.",
          });
          break;
        case "rewind_request":
          this.outbound.sendDirect({
            type: "rewind_result",
            requestId: message.requestId,
            ok: false,
            reason: "shutting down",
            conversationRestored: false,
            restoredPaths: null,
          });
          break;
        default:
          break;
      }
      return;
    }
    switch (message.type) {
      case "ui_ready":

        // status pushes are safe from here on. Set BEFORE the snapshot cascade
        // below (which already pushes the current lsp_status).
        this.uiReady = true;
        // TASK.102 CUT-S2 §2.6.3: child-ready fires on the FIRST ui_ready only —
        // never before (nothing was listening yet) and never again on a later
        // reconnect (Open re-attaching to an already-running child).
        if (this.child !== undefined && !this.childReadySent) {
          this.childReadySent = true;
          this.child.onReady();
        }
        const presentation = enginePresentation(this.engine, this.engineSettings);
        this.outbound.sendDirect({
          type: "host_ready",
          workspace: this.workspace,
          ...(this.projectRoot !== this.workspace ? { projectRoot: this.projectRoot } : {}),
          ...(this.worktree !== undefined ? { worktree: this.worktree } : {}),
          mode: this.engine.mode(),
          model: this.model,
          sessionId: this.sessionId,
          reasoningEffort: this.engine.reasoningEffort() ?? "off",
          ...(this.availableEffortLevels !== undefined ? { availableEffortLevels: this.availableEffortLevels } : {}),
          // TASK.56 W2: live image-input verdict for the CURRENT model (the
          // seam is a closure over the active model, host/index.ts). Rides
          // beside the `engine` block — a model-level fact, not an engine
          // capability. Absent seam (legacy hosts/tests) -> field absent, so
          // the renderer applies no model-level attachment gating.
          ...(this.imageInputEnabled !== undefined ? { imageInput: this.imageInputEnabled() } : {}),
          ...(presentation !== undefined ? { engine: presentation } : {}),
          // Design TASK.40 §2(f)/§3.2: shell is emitted ONLY alongside a
          // present `engine` (never for core), so the core wire stays
          // byte-identical by construction.
          ...(presentation !== undefined && this.shell !== undefined ? { shell: this.shell } : {}),
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
        this.pushPendingEngineSettings();
        if (this.continuationPending) {
          this.continuationPending = false;
          this.currentTurn = this.startContinuation().catch((error) => {
            this.outbound.emit({ type: "fatal", message: `worktree continuation failed: ${describeError(error)}` });
          });
        }
        break;
      case "user_message":
        this.onUserMessage(message.requestId, message.text, message.images);
        break;
      case "cancel_turn":
        this.onCancel();
        break;
      case "exit_worktree":
        if (this.relocating) {
          this.outbound.sendDirect({
            type: "worktree_notice",
            message: "A workspace transition is already in progress.",
          });
          break;
        }
        if (this.busy) {
          this.outbound.sendDirect({
            type: "worktree_notice",
            message: "Cannot exit the worktree while the session is busy.",
          });
          break;
        }
        if (this.worktreeControl === undefined) {
          this.outbound.sendDirect({
            type: "worktree_notice",
            message: "Worktree exit is unavailable for this session.",
          });
          break;
        }
        this.busy = true;
        const controller = new AbortController();
        this.abort = controller;
        this.currentTurn = this.worktreeControl
          .exit({ cleanup: message.cleanup, continueAfterRehost: false }, { signal: controller.signal })
          .then(async (result) => {
            if (!result.ok) throw new Error(result.error);
            if (result.message !== undefined) {
              this.outbound.sendDirect({ type: "worktree_notice", message: result.message });
            }
            this.relocating = true;
            if (this.onWorkspaceTransition === undefined) throw new Error("workspace transition handoff is unavailable");
            await this.onWorkspaceTransition(result.transition);
          })
          .catch((error) => {
            this.relocating = false;
            this.outbound.emit({ type: "fatal", message: `exit worktree failed: ${describeError(error)}` });
          })
          .finally(() => {
            this.busy = false;
            this.abort = null;
            this.currentTurn = null;
          });
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
        if (this.busy || !this.engine.capabilities.supportsModelSelection || id.length === 0 || /\s/.test(id)) {
          break;
        }
        // TASK.39: an engine with its OWN catalog validates the id against it
        // (never against AnyCode's provider catalog) and answers on the engine
        // settings channel. Reusing `set_model` rather than inventing a second
        // ui->host message keeps one model-switch verb on the wire for every
        // engine; only the host-side handling differs.
        if (this.engineSettings !== undefined) {
          this.onEngineSettingsChange(this.engineSettings.selectModel(id), { model: id });
          break;
        }
        if (this.engine.switchModel === undefined) {
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
          // TASK.56 W2: the verdict re-read for the NEW model — switchModel has
          // already advanced the closure's current model above, so the push
          // reflects the switched-to model (upfront re-gate on vision -> non-
          // vision, mirror of the availableEffortLevels re-resolution).
          ...(this.imageInputEnabled !== undefined ? { imageInput: this.imageInputEnabled() } : {}),
        });
        break;
      }
      case "set_engine_preset":
        // TASK.39 (cut §2(d)/§3.3): the ONLY way a Codex permission posture is
        // expressible from the renderer — a preset id, checked for membership in
        // the engine's own frozen table. No sandbox object, no approvalPolicy, no
        // raw config JSON is accepted from the renderer, by construction of this
        // message (DoD-4). Between-turns discipline mirrors set_model.
        if (this.engineSettings === undefined) break;
        if (this.busy) {
          this.outbound.emit({
            type: "mode_change_rejected",
            reason: "cannot change permissions during an active turn",
          });
          break;
        }
        this.onEngineSettingsChange(this.engineSettings.selectPreset(message.presetId), { presetId: message.presetId });
        break;
      case "set_engine_effort":
        if (this.engineSettings === undefined || this.busy || this.engineSettings.selectEffort === undefined) break;
        this.onEngineSettingsChange(this.engineSettings.selectEffort(message.effort), { effort: message.effort });
        break;
      case "git_command":
        // Slice 5.7 / TASK.40 (design §2(f)): user-initiated git command. The
        // bridge validates nothing (the zod schema already ran in `route`
        // above) and never throws into the session. A MUTATION is gated on
        // the SHELL's own capability (`shell.gitUserMutations`) -- a
        // genuinely separate decision from `engine.capabilities.
        // supportsGitMutations`, which now describes only the active agent's
        // OWN tool-mutation capability and no longer gates the Review
        // panel's user-initiated mutations. Absent shell (core, or a future
        // engine that hasn't wired one) defaults to `true`, byte-identical
        // to the pre-TASK.40 unconditional-for-core routing (CoreEngine's
        // supportsGitMutations was always `true`).
        // TASK.102 CUT-S2 §10.14.3 BLOCKER-2(b): a MUTATION admitted after the
        // handoff has begun would write to the ABANDONED workspace main is
        // about to `git worktree remove` — gated the same way as the
        // gitUserMutations permission above (mutation branch only; read-only
        // ops stay admitted, they are harmless and the renderer is leaving
        // this workspace anyway). No git_result refusal reply exists at this
        // gate (git_result is only ever emitted deep inside GitBridge after a
        // command actually runs) — a silent drop mirrors the existing
        // gitUserMutations refusal on this exact line.
        if (!isGitMutation(message.command) || ((this.shell?.gitUserMutations ?? true) && !this.relocating)) {
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
   * (drift-flag-3) so a mid-rewind user_message/set_model hits the busy
   * gate — restored in `finally`. Since TASK.37, `set_mode` is no longer in
   * this list: it is accepted during a rewind too (D-S3-4a — harmless, a
   * rewind neither reads nor writes mode). The service writes the mandatory fail-closed
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
    // TASK.102 CUT-S2 §10.14.3 BLOCKER-2(a): a rewind after the handoff has
    // begun would restore the ABANDONED workspace main is about to `git
    // worktree remove` — `busy` alone does not catch this window (relocating
    // outlives the turn that set it; see onUserMessage's own gate above).
    if (this.relocating) {
      this.outbound.sendDirect({
        type: "rewind_result",
        requestId,
        ok: false,
        reason: "workspace transition in progress",
        conversationRestored: false,
        restoredPaths: null,
      });
      return;
    }
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
    // model messages observe busy=true while the store+git spawns run. Since
    // TASK.37, mode messages are no longer in this list (D-S3-4a).
    // TASK.102 CUT-S2 §10.12.1 (б): rewind is not abort-aware and a
    // destructive two-tree git-restore split in half by shutdown is worse
    // than one shutdown() awaits to completion — routed through
    // `currentTurn`, the session's single wait primitive, via a
    // self-managed deferred (no real turn promise exists to reuse here).
    // Assignment can PREEMPT `currentTurn` from the tail of a prior turn's
    // own teardown still in flight (the busy=false/tail-in-flight window) —
    // an accepted trade: an awaited telemetry tail becomes an awaited
    // destructive restore instead.
    this.busy = true;
    let release!: () => void;
    const op = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.currentTurn = op;
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
      if (this.currentTurn === op) this.currentTurn = null;
      release();
    }
  }

  private onUserMessage(requestId: string, text: string, images?: ImageAttachment[]): void {
    if (this.relocating) {
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "not_ready" });
      return;
    }
    // TASK.102 CUT-S2 §10.10.1 п.5: a completed child is READ-ONLY (§6) —
    // once the terminal has been dispatched there is no live turn chain left
    // for a late message to join. Checked BEFORE the busy gate below because
    // `busy` is already false by the time the terminal has committed (see
    // acceptUserMessage's finally) — without this gate a late message would
    // fall straight through into a real second turn whose result can never
    // reach anyone (the child tab is already gone/closing).
    if (this.child !== undefined && this.childTerminalFinalized) {
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "not_ready" });
      return;
    }
    if (this.busy) {
      // TASK.102 CUT-S2 §1.1/§2.6.3: a child session queues a busy-time
      // user_message (steer) instead of rejecting it — the composer of a live
      // child's own surface docks new instructions onto the running turn
      // chain rather than losing them.
      if (this.child !== undefined) {
        this.enqueueSteerMessage(requestId, text, images);
        return;
      }
      // Protocol guard (the UI also blocks the composer): one turn at a time.
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "busy" });
      return;
    }
    this.acceptUserMessage(requestId, text, images);
  }

  /**
   * Parks a busy-time user_message in the child's host-side steer queue
   * (CUT-S2 §1.1: the RENDERER prompt-queue is never used for a child
   * surface — steering must affect the sync-join result, so it lives here,
   * host-side, gating the terminal itself). Rejected exactly like a normal
   * busy user_message would be once the bound is reached (§2.3's
   * `CHILD_STEER_QUEUE_MAX`) or when the attachment isn't supported —
   * neither consumes a queue slot.
   */
  private enqueueSteerMessage(requestId: string, text: string, images?: ImageAttachment[]): void {
    const attachments = images?.length ? [...images] : undefined;
    if (attachments !== undefined && (!this.engine.capabilities.supportsImages || this.imageInputEnabled?.() !== true)) {
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "unsupported_images" });
      return;
    }
    if (this.steerQueue.length >= CHILD_STEER_QUEUE_MAX) {
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "busy" });
      return;
    }
    this.steerQueue.push(attachments !== undefined ? { requestId, text, images: attachments } : { requestId, text });
  }

  /**
   * Empties the steer queue with honest `turn_rejected "not_ready"` replies
   * (§10.11.1 N1, extracted from §10.10.1 O7б's flush-failure path so
   * `finalizeChildTerminal`'s shutdown branch can reuse it byte-identically):
   * every queued message gets a reply, never a silent drop — used on the two
   * paths that mean "no more turns will ever run against this child" (a
   * broken durable sink, or shutdown already in progress).
   */
  private rejectQueuedSteerMessages(): void {
    while (this.steerQueue.length > 0) {
      const queued = this.steerQueue.shift();
      if (queued !== undefined) {
        this.outbound.emit({ type: "turn_rejected", requestId: queued.requestId, reason: "not_ready" });
      }
    }
  }

  /**
   * Starts an ACCEPTED turn (the caller has already resolved relocating/busy
   * and, for a steer message, the queue-admission checks). Shared by the
   * direct `onUserMessage` path, the steer-queue drain (`onChildTurnSettled`),
   * and `startProgrammaticTurn` — a child's programmatic initial turn goes
   * through the EXACT same plan-mode-reminder/background-notices machinery a
   * real user message would (CUT-S2 §2.6.3: "plan-reminder — нужен: mode
   * может быть plan"), only title derivation is skipped for a child (§5.14 —
   * a child never gets a name, on neither its initial turn nor a steer one).
   *
   * Returns whether a turn actually started (§10.11.1 N7): `false` on the
   * `unsupported_images` refusal below — the ONLY way this can decline to
   * start a turn — lets a caller draining a queued message (`finalizeChildTerminal`)
   * tell "started, own `currentTurn` now covers it" apart from "refused, this
   * queued item is fully spent and produced nothing to wait on."
   */
  private acceptUserMessage(requestId: string, text: string, images?: ImageAttachment[]): boolean {
    const attachments = images?.length ? [...images] : undefined;
    if (attachments !== undefined && (!this.engine.capabilities.supportsImages || this.imageInputEnabled?.() !== true)) {
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "unsupported_images" });
      return false;
    }
    // Title derivation (design §4.2): the first accepted user message in a
    // title-less session names it (the picker is useless without titles). Done
    // exactly once per session — the flag is set on the first attempt. A
    // child session skips this unconditionally (CUT-S2 §5.14): it has no
    // name, on neither its programmatic initial turn nor a later steer one.
    if (this.child === undefined) {
      this.maybeDeriveTitle(text);
    }
    // Background-task completion notices (slice 6.DP-2, mirror of
    // cli/main.ts:1328-1340): drained (not peeked) so a notice is delivered
    // exactly once; injected strictly AFTER the raw-text title derivation above
    // (a notice never leaks into the title) and only on an ACCEPTED turn (the
    // busy gate already returned) — a rejected message drains nothing. A turn
    // with no notices keeps `turnInput === text`, byte-identical to pre-6.DP-2.
    let turnInput = text;
    // Plan-mode reminder (TASK.27, mirror of cli/main.ts's REPL branch): the
    // system prompt is static and shared, so the model is told it is in plan
    // mode — and that ExitPlanMode exists — once per plan-mode turn. Injected
    // AFTER the raw-text title derivation above (a reminder never leaks into
    // the title) and BEFORE the background notices below, matching the CLI's
    // plan -> notices tag order exactly.
    //
    // `engine.mode()` is the live source of truth: an approved ExitPlanMode
    // already advanced it mid-turn, so the very next turn drops the reminder
    // on its own. Gated on supportsCorePermissions because that is precisely
    // the set of engines whose plan mode WE run — Claude and Codex own their
    // own plan handling and must never be handed our tool's rules.
    if (this.engine.capabilities.supportsCorePermissions && this.engine.mode() === "plan") {
      turnInput = withPlanModeReminder(turnInput);
    }
    const carriesWorktreeExitNotice = this.worktreeExitNoticePending;
    if (this.engine.capabilities.supportsTasks && this.tasks) {
      const notices = this.tasks.drainNotices();
      if (notices.length > 0) {
        turnInput = withBackgroundTaskNotices(turnInput, notices);
      }
    }
    this.busy = true;
    const turn: Promise<void> = this.runTurn(requestId, turnInput, attachments, carriesWorktreeExitNotice).finally(
      async () => {
        // TASK.102 CUT-S2 §10.10.1 O1: `busy` means something different for a
        // root session than for a child, and that asymmetry is now explicit
        // instead of one flag doing two incompatible jobs. ROOT: `busy` means
        // "a model turn is in flight" and clears as the very FIRST step of
        // teardown, before any await below — the renderer's contract is
        // "input is accepted right after loop_end" (P7.14's pause-on-reject
        // exists for a genuine mid-stream anomaly, not for the host itself
        // holding the gate across its own telemetry/fs tail). CHILD `busy`
        // additionally guards the terminal-finalize window and is cleared by
        // the branch at the end of this callback instead — F7's "root half"
        // of holding busy across the whole teardown was overreach (STATE.md
        // only ever described the child-side pause) and is reverted here.
        if (this.child === undefined) {
          this.busy = false;
        }
        this.abort = null;
        this.turnId = null;
        this.snapshotPaths.clear();
        this.flushPreviewArtifacts();
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
        // CUT-S2 §10.10.1 O7/O2: a queued steer message is drained into a
        // brand-new turn (busy=true, a fresh currentTurn already assigned by
        // ITS OWN acceptUserMessage call) before this turn is allowed to be
        // "done" — publishing a terminal while the queue is non-empty would
        // make steering a dead facade (§5.16). `busy` clears here only when
        // finalizeChildTerminal actually committed a terminal ("terminal",
        // not "drained") — a drained turn already owns `busy` itself and this
        // callback must never clobber that back to false.
        if (this.child !== undefined) {
          const settling = this.onChildTurnSettled();
          if (settling !== undefined && (await settling) === "terminal") {
            this.busy = false;
          }
        }
        // Identity-guarded (§10.10.1 O2): only THIS turn's own promise clears
        // currentTurn — a plain unconditional null here (the naive fix the
        // architect explicitly rejected) would clobber the FRESH currentTurn
        // a synchronously-drained steer turn (onChildTurnSettled above)
        // already assigned to itself. Moved to the very end of teardown (was
        // the unconditional `this.currentTurn = null` ahead of the child
        // branch) so shutdown()'s `await this.currentTurn` (`:914`) now
        // covers the WHOLE teardown — including the child terminal
        // finalize/flushHistory above — not just runTurn() itself.
        if (this.currentTurn === turn) {
          this.currentTurn = null;
        }
      },
    );
    this.currentTurn = turn;
    return true;
  }

  /**
   * Starts a child session's ONE externally-triggered turn chain (CUT-S2
   * §2.6.3: main's `child-start`, released once `child-ready` was sent).
   * Guarded against a repeat call — a child gets exactly one initial turn
   * per host lifetime; any further input arrives as a steer message through
   * the normal `user_message` route instead. Goes through the SAME
   * plan-mode-reminder/background-notices machinery a real user message
   * would (`acceptUserMessage`); only title derivation differs, and that is
   * already unconditionally skipped for a child there.
   */
  startProgrammaticTurn(prompt: string): { ok: true } | { ok: false; reason: string } {
    if (this.child === undefined) {
      return { ok: false, reason: "not a child session" };
    }
    // TASK.102 CUT-S2 §10.11.1 N1: a child-start that lands after shutdown()
    // has begun must never start a turn on an engine already mid-dispose.
    if (this.shuttingDown) {
      return { ok: false, reason: "shutting down" };
    }
    if (this.programmaticTurnStarted) {
      return { ok: false, reason: "programmatic turn already started" };
    }
    if (this.busy) {
      return { ok: false, reason: "session is busy" };
    }
    this.programmaticTurnStarted = true;
    this.childStartedAt = Date.now();
    this.acceptUserMessage(randomUUID(), prompt);
    return { ok: true };
  }

  /**
   * TASK.102 CUT-S2 §10.12.3: shifts queued steer messages until one
   * actually STARTS a turn (`true` — the new turn owns busy/currentTurn) or
   * the queue runs out (`false`). A refusal from `acceptUserMessage`
   * (`unsupported_images` — it already emitted its own `turn_rejected`)
   * spends the message and moves on: this is the N7 discipline
   * ("a refusal from acceptUserMessage is never a live hand-off"), now
   * shared by BOTH drain sites (`onChildTurnSettled` and
   * `finalizeChildTerminal`'s healthy-path re-check) instead of duplicated.
   */
  private startNextQueuedSteerTurn(): boolean {
    let next = this.steerQueue.shift();
    while (next !== undefined) {
      if (this.acceptUserMessage(next.requestId, next.text, next.images)) return true;
      next = this.steerQueue.shift();
    }
    return false;
  }

  /**
   * Runs after EVERY turn a child session completes (the programmatic
   * initial one, and every steer-triggered one) — `acceptUserMessage`'s
   * finally calls this unconditionally when `this.child` is set. Chains the
   * next queued steer message if one is waiting; otherwise this IS the
   * terminal moment (CUT-S2 §5.16: publishing a terminal while the queue is
   * non-empty would make steering a dead facade — a message queued during
   * the LAST turn's run must always get its own turn before the child ever
   * reports done).
   *
   * F7 fix, return type widened under CUT-S2 §10.10.1 O7: returns `undefined`
   * when it drained a queued steer message (the new turn already set
   * `busy=true` itself — the caller must leave `busy` alone) and
   * `finalizeChildTerminal()`'s own `"terminal" | "drained"` promise
   * otherwise — `finalizeChildTerminal` can ALSO decide to drain (a message
   * queued strictly during its `flushHistory` await, arriving too late for
   * the top-level check right above), so the caller only clears `busy` when
   * the settled value is literally `"terminal"` (§10.10.1's call-site
   * contract), never on `"drained"`.
   *
   * §10.12.1/§10.12.3: the drain above only runs while `!this.shuttingDown`
   * — once shutdown has begun, no new turn may start (the engine is already
   * mid-dispose), so this goes straight to `finalizeChildTerminal()`, which
   * empties the queue with honest rejects instead (shutdown = the second
   * legal path to draining the queue, symmetric with the flush-failure path,
   * §10.10.1 O7б). `startNextQueuedSteerTurn()` (§10.12.3) is shared with
   * `finalizeChildTerminal`'s own re-check below, so a refusal from
   * `acceptUserMessage` here is spent and moved past exactly like it is
   * there — this call site used to invoke `acceptUserMessage` directly and
   * trust its return value blindly, which stranded the child forever
   * (`busy` held, no terminal ever published) the moment a queued message's
   * OWN admission was refused (e.g. images support revoked between enqueue
   * and drain) — the shared helper is what closes that hole on both sites.
   */
  private onChildTurnSettled(): Promise<"terminal" | "drained"> | undefined {
    if (!this.shuttingDown && this.startNextQueuedSteerTurn()) return undefined;
    return this.finalizeChildTerminal();
  }

  /**
   * The child-mode terminal tap (CUT-S2 §0.5/§2.6.3): flushes the durable
   * history sink BEFORE ever calling `onTerminal` — a durable "Open
   * completed" transcript is the whole reason a child terminal is trusted at
   * all — then hands off the accumulated final text/counters/status. A
   * flush failure produces an honest `error` terminal (never a "completed"
   * card whose durable transcript the flush never actually wrote).
   *
   * Healthy-path re-check (§10.10.1 O7): a steer message can arrive strictly
   * DURING the `flushHistory` await above — too late for `onChildTurnSettled`'s
   * own top-level queue check, and (pre-fix) past the once-latch too, so it
   * would sit in the queue forever, never drained, never rejected (a literal
   * facade of §5.16's "no terminal while the queue is non-empty"). Re-reading
   * the queue here, AFTER the flush but BEFORE committing to a terminal,
   * closes that window: non-empty ⇒ drain into a new turn and return
   * `"drained"` instead — cheap and idempotent, the next settle re-runs this
   * whole method (including `flushHistory`) from the top.
   *
   * §10.12.1: the re-check above only DRAINS while `!this.shuttingDown` —
   * once shutdown has begun no new turn may ever start (the engine is
   * already mid-dispose), so the queue is instead emptied with honest
   * `turn_rejected "not_ready"` replies via `rejectQueuedSteerMessages()`,
   * the SAME helper the flush-failure path below uses. Shutdown is therefore
   * a SECOND legal path to committing a terminal while the queue was
   * non-empty at some point — symmetric with the flush-failure path
   * (§10.10.1 O7б): both mean "no more turns will ever run against this
   * child," so both drain honestly instead of leaving messages stranded.
   *
   * §10.12.3: `acceptUserMessage` can itself refuse a queued message
   * (currently only `unsupported_images`) without ever starting a turn — it
   * already emitted its own `turn_rejected` for that one, but returning
   * `"drained"` on its say-so alone would leave `busy` held with nothing
   * left to ever clear it and no terminal ever published (the queued
   * message lost AND the terminal silently withheld forever). The SHARED
   * `startNextQueuedSteerTurn()` helper (both drain sites, §10.12.3) keeps
   * trying the REST of the queue until one message actually starts a turn
   * (a real `"drained"`) or the queue empties (falls through to committing
   * the terminal below, exactly like an already-empty queue) — this is what
   * makes `finalizeChildTerminal`'s "never reject" contract true: every path
   * either hands off a live turn or reaches a terminal, never neither.
   *
   * Once-latch (F7, moved under O7): `childTerminalFinalized` is set
   * SYNCHRONOUSLY, with no await in between, immediately before each
   * `onTerminal` call on both the healthy and flush-failure paths below —
   * required so the re-check above can decide to drain WITHOUT having
   * already committed to a terminal. `busy` spanning the whole child
   * teardown (this callback included) means a second settle cannot start
   * while this one is still in flight, so true concurrent re-entry no longer
   * exists by construction; the latch remains as defense against a call
   * arriving strictly AFTER the terminal already committed, not as a mutex
   * against a race that can no longer happen.
   *
   * O3: `onTerminal` never propagates a throw — wrapped in try/catch on both
   * paths (console.error, same discipline as the `flushTelemetry` guard
   * above) — since the real call site never wraps `await settling` in a try,
   * and by the time it runs `currentTurn` may already be nulled elsewhere;
   * an unguarded throw here becomes an unhandled rejection that kills the
   * host.
   */
  private async finalizeChildTerminal(): Promise<"terminal" | "drained"> {
    if (this.child === undefined || this.childTerminalFinalized) {
      return "terminal";
    }
    const { text: finalText, truncated } = finalizeFinalText(this.childFinalText);
    const durationMs = Date.now() - this.childStartedAt;
    try {
      await this.child.flushHistory();
    } catch (error) {
      // Flush-failure path (§10.10.1 O7б): the durable sink is broken, so
      // running more steer turns against it is pointless — every message
      // parked during the flush is rejected honestly instead of silently
      // lost (the O7 bug), and the error terminal publishes as-is.
      this.rejectQueuedSteerMessages();
      this.childTerminalFinalized = true;
      try {
        this.child.onTerminal({
          status: "error",
          finalText: `Child session history failed to persist durably: ${describeError(error)}`,
          truncated: false,
          turns: this.childTurns,
          toolCalls: this.childToolCalls,
          durationMs,
          ...(this.childActivitySuppressed > 0 ? { activitySuppressed: this.childActivitySuppressed } : {}),
        });
      } catch (onTerminalError) {
        console.error(`[host] child.onTerminal threw (error terminal): ${describeError(onTerminalError)}`);
      }
      return "terminal";
    }
    if (this.shuttingDown) {
      // §10.12.1: shutdown = the second legal drain path (see docstring
      // above) — reject-empty rather than start anything new.
      this.rejectQueuedSteerMessages();
    } else if (this.startNextQueuedSteerTurn()) {
      // §10.12.3: shared helper — a refusal from `acceptUserMessage` itself
      // must never be mistaken for a live hand-off (see docstring above).
      return "drained";
    }
    this.childTerminalFinalized = true;
    try {
      this.child.onTerminal({
        status: this.childLoopStatus ?? "error",
        finalText,
        truncated,
        turns: this.childTurns,
        toolCalls: this.childToolCalls,
        durationMs,
        ...(this.childActivitySuppressed > 0 ? { activitySuppressed: this.childActivitySuppressed } : {}),
      });
    } catch (error) {
      console.error(`[host] child.onTerminal threw: ${describeError(error)}`);
    }
    return "terminal";
  }

  /**
   * Feeds one turn event into the child-mode accumulators (CUT-S2 §2.6.3).
   * Called from `runTurn`'s event loop for every event, for a child session
   * only — mirrors runner.ts's own local `currentTurnText`/`finalText`/
   * `toolCalls`/`loopReason` bookkeeping (subagents/runner.ts), just spread
   * across possibly-many `runTurn()` calls instead of one.
   *
   * CUT-S2 §10.7 additions: `tool_execution_start` buffers name+input by
   * toolCallId; `tool_result` updates `childLastTool` UNCONDITIONALLY (even
   * on invalid_input, mirroring `runner.ts:502`), then crosses the
   * leading-edge-throttled progress boundary, then resolves the buffered
   * pair into an activity report (skipped for invalid_input, capped at
   * `SUBAGENT_ACTIVITY_MAX_EVENTS` over the whole turn chain); `turn_end`
   * increments the NEW `childTurnEndCount` (the progress report's `turns`,
   * distinct from `childTurns`) and crosses the same progress boundary.
   */
  private observeChildEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.childFinalText = resetFinalText(this.childFinalText);
        break;
      case "text_delta":
        this.childFinalText = appendFinalText(this.childFinalText, event.text);
        break;
      case "stream_retry":
        this.childFinalText = resetFinalText(this.childFinalText);
        break;
      case "tool_execution_start":
        this.pendingChildCalls.set(event.toolCallId, { toolName: event.toolName, input: event.input });
        break;
      case "tool_result":
        this.childToolCalls += 1;
        this.childLastTool = event.outcome.toolName;
        this.emitChildProgressBoundary();
        this.emitChildActivity(event.outcome.toolCallId, event.outcome.status);
        break;
      case "turn_end":
        this.childFinalText = fixateFinalText(this.childFinalText);
        this.childTurnEndCount += 1;
        this.emitChildProgressBoundary();
        break;
      case "loop_end":
        // A child config never receives a WorktreeControlPort (buildChildConfig
        // never sets `ports.worktrees`), so `workspace_transition` cannot
        // actually happen here; treated defensively as an error rather than
        // widening ChildRunStatus, mirroring runner.ts's own precedent.
        this.childLoopStatus = event.reason === "workspace_transition" ? "error" : event.reason;
        this.childTurns += event.turns;
        break;
      default:
        break;
    }
  }

  /**
   * Resolves a buffered `tool_execution_start` against its paired
   * `tool_result` into one activity report (CUT-S2 §10.7 п.3, 1:1 with
   * `runner.ts:516-529`). Skipped entirely — consuming no cap slot and never
   * incrementing `activitySuppressed` — when there was no matching start
   * (a call that never actually dispatched) or the outcome is
   * `invalid_input` (an SDK/dispatcher parse failure; the call never ran).
   * Past `SUBAGENT_ACTIVITY_MAX_EVENTS` (counted over the WHOLE turn chain,
   * never reset per turn), the event is withheld and `childActivitySuppressed`
   * increments instead — the terminal report surfaces that count honestly.
   */
  private emitChildActivity(toolCallId: string, status: ToolCallOutcome["status"]): void {
    const pending = this.pendingChildCalls.get(toolCallId);
    this.pendingChildCalls.delete(toolCallId);
    if (!pending || status === "invalid_input") {
      return;
    }
    if (this.childActivityEmitted < SUBAGENT_ACTIVITY_MAX_EVENTS) {
      this.childActivityEmitted += 1;
      this.child?.onProgress({
        kind: "activity",
        toolName: pending.toolName,
        summary: summarizeChildToolCall(pending.toolName, pending.input),
      });
    } else {
      this.childActivitySuppressed += 1;
    }
  }

  /**
   * Crosses a progress-report boundary (CUT-S2 §10.7 п.3: `tool_result` and
   * `turn_end`, mirroring the inline runner's own two `onProgress({kind:
   * "progress",…})` call sites, runner.ts:503/537). Leading-edge throttled
   * at 1000ms via the injected `this.now` — the FIRST boundary this session
   * ever crosses always emits (`childLastProgressEmitAt` starts `undefined`);
   * every later boundary within 1000ms of the last emission is silently
   * skipped (never a trailing timer — the next boundary, or the always-
   * authoritative terminal report, absorbs whatever a skip withheld, so no
   * count is ever lost, only delayed by at most ~1s). `turns` reads the NEW
   * `childTurnEndCount`, not `childTurns` (§10.7 п.3's explicit distinction).
   */
  private emitChildProgressBoundary(): void {
    const now = this.now();
    if (this.childLastProgressEmitAt !== undefined && now - this.childLastProgressEmitAt < 1000) {
      return;
    }
    this.childLastProgressEmitAt = now;
    this.child?.onProgress({
      kind: "progress",
      turns: this.childTurnEndCount,
      toolCalls: this.childToolCalls,
      ...(this.childLastTool !== undefined ? { lastTool: this.childLastTool } : {}),
    });
  }

  private async runTurn(
    requestId: string,
    text: string | undefined,
    attachments?: ImageAttachment[],
    carriesWorktreeExitNotice = false,
  ): Promise<void> {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.turnId = turnId;
    this.abort = controller;
    this.outbound.emit({ type: "turn_started", requestId, turnId });

    try {
      const options = {
        signal: controller.signal,
        ...(attachments?.length ? { attachments } : {}),
        ...(carriesWorktreeExitNotice
          ? { systemContext: worktreeExitSystemContext(this.projectRoot) }
          : {}),
      };
      const stream = text === undefined ? this.engine.continueTurn?.(options) : this.engine.runTurn(text, options);
      if (stream === undefined) {
        throw new Error("active engine cannot continue a relocated turn");
      }
      let noticeConsumeAttempted = false;
      for await (const event of stream) {
        if (
          carriesWorktreeExitNotice &&
          !noticeConsumeAttempted &&
          isSuccessfulModelDeliveryEvent(event)
        ) {
          noticeConsumeAttempted = true;
          try {
            await this.consumeWorktreeExitNotice?.();
            this.worktreeExitNoticePending = false;
          } catch (error) {
            // Keep the in-memory + durable marker for a later real turn. A
            // persistence outage must not discard the notice or kill this turn.
            console.error(`[host] worktree exit notice consume failed: ${describeError(error)}`);
          }
        }
        if (event.type === "workspace_transition") {
          this.relocating = true;
          try {
            if (this.onWorkspaceTransition === undefined) throw new Error("workspace transition handoff is unavailable");
            await this.onWorkspaceTransition(event.transition);
          } catch (error) {
            this.relocating = false;
            throw error;
          }
          continue;
        }
        this.captureSnapshotPath(event);
        this.previewArtifacts.observeStart(event);
        this.outbound.emit({ type: "agent_event", turnId, event: sanitizeAgentEvent(event) });
        if (this.child !== undefined) {
          this.observeChildEvent(event);
        }
        if (event.type === "error") {
          // TASK.2 DoD-c: the raw provider failure reaches the process log
          // (stdio:"inherit" -> app log), not only the transcript block.
          console.error(`[host] provider stream error: ${describeError(event.error)}`);
          // TASK.45 W11: relay the core loop's OWN classification (event.safe.code)
          // verbatim — never reclassified here. Absent `safe` (a legacy/foreign
          // producer) defaults to "unknown" rather than dropping the signal.
          this.reportProviderHealth?.({ kind: "failure", code: event.safe?.code ?? "unknown" });
        }
        if (event.type === "finish") {
          // TASK.45 W11: a model step that reached a finish reason completed a
          // real request against the pinned connection's credential/endpoint.
          this.reportProviderHealth?.({ kind: "success" });
        }
        if (event.type === "tool_result") {
          await this.emitAfterSnapshot(event.outcome);
          this.previewArtifacts.observeResult(event.outcome);
        }
      }
    } catch (error) {
      // runTurn is designed never to throw (it maps failures to loop_end), so
      // this is a defensive net; the host must not crash on a rogue turn.
      this.outbound.emit({ type: "fatal", message: `turn failed: ${describeError(error)}` });
    }
  }

  private async startContinuation(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.onContinuationReady?.();
      if (this.continuationMode === "model") {
        await this.runTurn(randomUUID(), undefined);
      }
      if (!this.relocating) {
        await this.onContinuationComplete?.();
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.turnId = null;
      this.snapshotPaths.clear();
      this.flushPreviewArtifacts();
      this.currentTurn = null;
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

  /**
   * Turn-end auto-open (cut §1(a)/§2.3, 96-E): drains the collector and posts
   * `PREVIEW_ARTIFACTS` iff a qualifying Write/Edit landed this turn. Runs in
   * EVERY teardown path (normal completion, provider error, AND
   * cancellation/abort alike — both call sites sit beside `snapshotPaths.clear()`,
   * which shares that exact "always runs" discipline) so a cancelled turn never
   * leaks a dangling collected path into the next one.
   */
  private flushPreviewArtifacts(): void {
    const paths = this.previewArtifacts.drain();
    if (paths.length > 0) {
      this.sendPreviewArtifacts?.(paths);
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

  /**
   * Phase 1 of the two-phase, host-authoritative settings ack (TASK.39, cut
   * §2(k).3). There IS no server-side ack channel — the app-server never sends a
   * settings-updated notification (L6) — so the host answers on its own:
   *
   *  - REJECT (an id absent from the engine's catalog/preset table) -> a
   *    `mode_change_rejected` notice. Nothing was sent to the server, so nothing
   *    has to be undone and no turn was burned (L7): the failure is recoverable
   *    and the session keeps running on its previous settings. This reuses the
   *    existing settings-refusal channel the renderer already surfaces as a
   *    toast, rather than minting a second rejection message.
   *  - ACCEPT -> `state:"pending"`, because the change is genuinely not in force
   *    yet: the engine applies it via the per-turn override, so it takes effect
   *    at the NEXT turn/start (`appliesFrom:"next_turn"`). The matching
   *    `state:"applied"` is emitted from the engine's onSettingsApplied hook when
   *    that turn/start is actually accepted.
   *
   * The choice is persisted at accept-time (not at apply-time) so that quitting
   * between the choice and the next turn still resumes under the chosen posture —
   * the re-assertion on every turn/start then makes it effective (cut §2(k).1).
   */
  /**
   * Re-asserts an un-applied model/preset delta on every ui_ready, AFTER
   * replay() (cut §2(k).3). `sendDirect`, exactly like the git_status snapshot
   * push above: it is regenerated per connect and must never enter the replay
   * ring. Without it a renderer reload shows a pending change as ACTIVE — the
   * announcing message is a one-shot that the ring can evict, and `host_ready`
   * carries only the applied snapshot. ZERO wire delta: this is the same
   * `engine_settings_changed{state:"pending"}` the change itself emits.
   */
  private pushPendingEngineSettings(): void {
    const pending = this.engineSettings?.pendingSnapshot?.();
    if (pending == null) return;
    this.outbound.sendDirect({
      type: "engine_settings_changed",
      model: pending.model,
      activePresetId: pending.activePresetId,
      ...(pending.effort !== undefined ? { effort: pending.effort } : {}),
      state: "pending",
      appliesFrom: "next_turn",
    });
  }

  private onEngineSettingsChange(result: EngineSettingsChange, intent: { model?: string; presetId?: string; effort?: string }): void {
    if (!result.ok) {
      this.outbound.emit({ type: "mode_change_rejected", reason: result.reason });
      return;
    }
    // An immediate-apply engine records the choice from its ack instead
    // (SLICE-CC §1.5) — writing it here would outlive a REJECTED change and
    // resume the session under a posture the engine never adopted.
    if (this.engineSettings?.persistsOnApply !== true) {
      if (intent.model !== undefined) {
        // `this.model` is the ACTIVE model echoed in host_ready — advancing it
        // here would present a merely-CHOSEN model as active on the next
        // handshake. It advances in the `onSettingsApplied` hook instead, when a
        // turn/start has actually carried it. Persistence is unchanged: the
        // choice is still recorded at ACCEPT time (cut §2(k).4), so quitting
        // before the next turn still resumes under the chosen posture.
        this.persistence?.touch({ model: result.model });
      }
      if (intent.presetId !== undefined) {
        this.persistence?.touch({ enginePreset: result.activePresetId });
      }
    }
    this.outbound.emit({
      type: "engine_settings_changed",
      model: result.model,
      activePresetId: result.activePresetId,
      ...(result.effort !== undefined ? { effort: result.effort } : {}),
      state: "pending",
      appliesFrom: "next_turn",
    });
  }

  /**
   * User-initiated permission-mode change (TASK.37): accepted while busy — the
   * mode is policy for the NEXT permission decision, which CoreEngine delivers
   * into the running loop (AgentLoop.setMode). An open permission ask is
   * untouched (snapshot semantics): it completes under the mode captured in
   * its PermissionRequest. Engines that manage their own permission posture
   * still reject regardless of busy state.
   */
  private onSetMode(mode: PermissionMode): void {
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
   * Mode advance driven by the LOOP, not the UI (TASK.27): the single
   * sanctioned mid-turn transition an approved ExitPlanMode performs, delivered
   * through `AgentLoopConfig.onModeChange`. It deliberately differs from
   * `onSetMode` above in both directions:
   *
   *  - it never calls `engine.setMode` — the loop already mutated `config.mode`
   *    before notifying, so setting it again would be a redundant second write;
   *  - it never consults `this.busy` — it fires from INSIDE a running turn
   *    (and since TASK.37, `onSetMode` accepts mid-turn changes too; the two
   *    paths still differ in who calls `engine.setMode` and who emits).
   *
   * Everything downstream is unchanged: the same `mode_changed` message the UI
   * store already handles (the mode chip recolors itself), and the same
   * persistence touch that lets a resume restore the mode.
   */
  notifyModeChanged(mode: PermissionMode): void {
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

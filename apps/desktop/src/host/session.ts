import { agentMessageText, type AgentEnvelope, type AgentDelivery, type SessionPublicResult } from "../shared/communication.js";
import { safeFailureMessage } from "./safe-failure.js";
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
  RecognizerEndpoint,
  RewindResult,
  RewindScope,
  SessionPermissionRules,
  TelemetryStatus,
  TokenUsage,
  ToolCallOutcome,
} from "@anycode/core";
import {
  SESSION_TITLE_MAX_LENGTH,
  SUBAGENT_ACTIVITY_MAX_EVENTS,
  SUBAGENT_WRAPUP_FAILED_NOTICE,
  appendFinalText,
  childTurnLimitNotice,
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
  WireBackgroundChild,
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
import { recordErrorDiagnostic } from "./error-diagnostics.js";
import { toWireToolMeta } from "./permission-broker.js";
import type { SessionEngine } from "./engines/session-engine.js";

/** Cap on the replay ring buffer; older messages roll off (design §3). */
export const REPLAY_BUFFER_CAP = 5_000;

/**
 * TASK.117 checkpoint: bound on `session_checkpoint.countedSteps`. A finish
 * older than the replay ring's capacity can never replay again, so carrying
 * more keys than the ring could hold is pure wire weight. Slightly above
 * REPLAY_BUFFER_CAP to cover handshakes/status sends interleaved between
 * finishes.
 */
const CHECKPOINT_COUNTED_STEPS_MAX = REPLAY_BUFFER_CAP + 512;

/** Cap on hydrated `session_history` items; only the last N are shipped (design §3.3). */
export const SESSION_HISTORY_MAX_ITEMS = 500;

/**
 * TASK.117 (2026-10-04 product defect): grace window between the CURRENT UI
 * port's close and the fail-closed denyAll("ui disconnected"). A renderer
 * reload closes the old port and main re-posts a fresh one on
 * did-finish-load (deliverAllTabPorts) — AFTER the close is observed — so
 * the window keeps a parked permission ask alive across that gap while the
 * ask's own authoritative TTL keeps applying. Bounded: expiry with no
 * successor denies exactly as before (origin "disconnect"). Sized to cover a
 * full dev-page reload cycle with margin (observed live: port re-post landed
 * ~1s after the close).
 */
export const UI_RECONNECT_GRACE_MS = 5_000;

/**
 * A manual compaction (TASK.146, `onCompact`) runs BETWEEN turns — no real
 * turn is ever opened for it (`this.turnId` is left untouched), but the
 * wire's `agent_event` envelope still requires a `turnId` string. This
 * sentinel fills it; the renderer's turn-scoped drop guard is taught to
 * exempt `compaction_start`/`compaction_end` by event type (store.ts, the
 * same exemption shape as `context_usage`/`preview_console`), so the literal
 * value here is never matched against the active turn — it only needs to
 * satisfy the wire schema. Mirror of `index.ts`'s `PREVIEW_CONSOLE_TURN_ID`.
 */
export const MANUAL_COMPACTION_TURN_ID = "manual-compaction";

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
   * TASK.117 acceptance defect 1: read-only view of the current ring, in
   * emission order (oldest first). Used ONLY by pushSessionCheckpoint to
   * compute, per open partial stream, how much of its delta text the ring
   * still holds (the replay suffix a reconnecting renderer is about to
   * receive again) — the buffer itself stays private; no mutation path.
   */
  ringView(): readonly HostToUiMessage[] {
    return this.buffer;
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
  /** Present only when the child's final turn_end carried finishReason "length" (output-token ceiling cut). */
  finalTurnFinishReason?: "length";
  /** TASK 4149: the last loop_end's ceiling verdict declared the work done. Present only when true. */
  declaredDoneAtCeiling?: boolean;
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
   * TASK.196 DI seam for the turn-limit wrap-up rescue. CORE-ONLY: a callback
   * exists only when the child runs the core loop with an in-process ModelPort
   * (host/index.ts wires it to core's runWrapUp). CLI-engine children
   * (codex/claude) have no core loop/model to run the tool-free wrap-up call
   * against, so they pass no callback and their empty max_turns terminal gets
   * the explicit childTurnLimitNotice fallback instead. Returns the rescue
   * report text; a blank/throwing result degrades to the failure notice.
   */
  wrapUpRescue?: () => Promise<string>;
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
  /**
   * TASK.117 (2026-10-04 product defect) TEST SEAM: overrides the
   * close→denyAll grace window (see Session.reconnectGraceTimer). Absent ->
   * production default; ONLY tests inject a value to pin the expiry path
   * without real-time waits. Never read from the environment.
   */
  reconnectGraceMs?: number;
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
  /**
   * Dev/automation-ONLY override for `SESSION_HISTORY_MAX_ITEMS` (TASK.188
   * S4): a replay recording needs a long session hydrated in full. Resolved
   * ONCE in the composition root (`host/index.ts`, `resolveSessionHistoryMaxItems`)
   * from `ANYCODE_SESSION_HISTORY_MAX_ITEMS` — `Session` inspects no runtime
   * environment variables itself. Defaults to `SESSION_HISTORY_MAX_ITEMS` when absent.
   */
  historyMaxItems?: number;
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
   * TASK.145 срез 3 §2/§3: narrow read/cancel seam onto the host's own
   * detached-children registry (host/child-session-port.ts's `ChildSessionPort`,
   * core-engine-only — absent for a claude/codex-master boot, which never wires
   * `config.sessionSubagents` at all, spec §5). Mirrors the `tasks`/`lsp`
   * seams above: Session holds only this narrow interface, never the whole
   * port. `onChange` is optional-but-present here (host/index.ts always wires
   * it when this seam exists), mirroring `lsp.onStatusChange`'s live-push
   * discipline: a child admitting or reaching its terminal live-pushes an
   * updated `background_children` snapshot to an already-`ui_ready` renderer,
   * not just on the next reconnect. `cancelAll` backs срез 3 §3 (session
   * shutdown explicitly sweeping every live background child — see
   * `shutdown()` below); it is a distinct, explicit call, never a side effect
   * of `this.abort.abort()`.
   */
  backgroundChildren?: {
    list(): WireBackgroundChild[];
    cancel(childSessionId: string): boolean;
    cancelAll(): void;
    onChange?(listener: () => void): () => void;
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
   * TASK.198 срез C (plan §1.3/§3/§4): live verdict for the vision fallback —
   * true exactly when a recognizer endpoint is currently configured for this
   * session, independent of `imageInputEnabled` above (a blind model can
   * still accept an attachment through the fallback). Re-evaluated per call,
   * same discipline as `imageInputEnabled`. Absent (codex/claude engine
   * boots, and every pre-existing test) is the fail-closed default — no
   * fallback — so the turn-accept gate below stays byte-identical to
   * pre-TASK.198 wherever this seam is not wired.
   */
  imageFallbackAvailable?: () => boolean;
  /**
   * TASK.198 срез C (plan §1.3): host-owned commit for a live recognizer-
   * config push (main's RecognizerConfigChanged, TASK.198 E1). Session's own
   * `applyRecognizerConfig` public method decides WHEN to call this (now, if
   * idle; deferred to the next busy->idle boundary, last-value-wins,
   * otherwise) — this callback decides HOW: swap the resolved
   * `RecognizerEndpoint`, (de)register InspectImage, and recompose the
   * system prompt when its registration actually changed (host/index.ts).
   * Absent (codex/claude engine boots, and every pre-existing test) makes
   * `applyRecognizerConfig` a no-op — the plan's "codex/claude НЕ задеты
   * (замыкание не установлено)".
   */
  applyRecognizerConfig?: (endpoint: RecognizerEndpoint | null) => void;
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
  /**
   * TASK.145 срез 2: the host-side pending-report queue seam
   * (child-report-queue.ts's `ChildReportQueue`, wired only where a
   * `sessionSubagents` port was also wired — host/index.ts, always the ROOT
   * engine construction site, never a child-mode one, mirroring the
   * non-recursion lock on `config.sessionSubagents` itself). Absent in every
   * legacy test/child-mode Session -> `ui_ready` and `child_report_ack` are
   * both silent no-ops for this concern, byte-identical to pre-срез-2.
   */
  pendingChildReports?: PendingChildReportsOptions;
  /**
   * TASK.159: the ONLY telemetry seam a foreign-engine (codex/claude) boot
   * has — those engines wrap their own CLI protocol and never instantiate
   * AgentLoop, so `AgentLoopConfig.eventTap` (the core path's telemetry
   * attachment point, records.ts's `buildTelemetryTap`) is physically
   * unreachable for them. Called for EVERY event `runTurn` observes,
   * including a `continueTurn` resumption (same for-await loop below) —
   * wrapped in try/catch so a throwing tap can never break a turn, mirroring
   * the observer contract AgentLoop's own eventTap already holds
   * (agent-loop.ts ~:455).
   *
   * INVARIANT — never pass this on the core-path boot: `boot()`'s core
   * branch (host/index.ts) already taps AgentLoopConfig.eventTap for every
   * AgentEvent the loop produces; passing BOTH here and there would record
   * every event twice into the same session file. Only `bootCodexSession`/
   * `bootClaudeSession` may wire this option — see the comment at their two
   * `new Session({...})` call sites.
   */
  eventTap?: (event: AgentEvent) => void;
}

/**
 * TASK.145 срез 2: Session's own narrow view of the host's pending
 * detached-child-report queue — mirrors the `SessionPersistence`/`tasks`/`lsp`
 * seam posture (a small closure-based interface, not the whole queue object)
 * so Session never needs to import `child-report-queue.ts` itself.
 */
export interface PendingChildReportsOptions {
  /**
   * Re-sends every still-unacknowledged detached-child report to the
   * (re)attached renderer. Called on every `ui_ready`, right after
   * `outbound.replay()` — the SAME "a fresh connect gets the full picture"
   * discipline every other post-ui_ready push in this class already follows
   * (session_history, git snapshot, lsp status, hooks list).
   */
  resendAll: () => void;
  /** Clears one report the renderer has confirmed it enqueued (wire: `child_report_ack.id`). */
  ack: (id: string) => void;
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
  /** TASK.145 срез 3 §2/§3: see SessionOptions.backgroundChildren's own doc. */
  private readonly backgroundChildren: SessionOptions["backgroundChildren"];
  private readonly lsp: SessionOptions["lsp"];
  private readonly hooksList: SessionOptions["hooksList"];
  private readonly envStatus: SessionOptions["envStatus"];
  /** Slice P7.26/R2: rewind/list seam (undefined -> checkpoints disabled, fail-closed). */
  private readonly checkpoints: SessionOptions["checkpoints"];
  private readonly imageInputEnabled: (() => boolean) | undefined;
  /** TASK.198 срез C: see SessionOptions.imageFallbackAvailable's own doc. */
  private readonly imageFallbackAvailable: (() => boolean) | undefined;
  /** TASK.198 срез C: see SessionOptions.applyRecognizerConfig's own doc. */
  private readonly applyRecognizerConfigImpl: ((endpoint: RecognizerEndpoint | null) => void) | undefined;
  /**
   * TASK.198 срез C (plan §1.3): the last recognizer-config push received
   * while `busy` — last-value-wins, applied at the very next busy->idle
   * boundary. `undefined` means nothing is pending (the initial state, and
   * the state right after a commit); wrapped in an object so `{endpoint:
   * null}` (an explicit disable) is distinguishable from "nothing pending".
   */
  private pendingRecognizerConfig: { endpoint: RecognizerEndpoint | null } | undefined;
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

  /**
   * Resolved cap for `sessionHistory` (TASK.188 S4): `options.historyMaxItems`
   * when the composition root supplied a dev/automation override, else
   * `SESSION_HISTORY_MAX_ITEMS`. Read by every `buildSessionHistory` call
   * (boot and post-rewind rebuild) so the two stay in lockstep.
   */
  private readonly historyMaxItems: number;

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
  /** Epoch ms the live turn began (host clock) — rides every turn_started, including the per-connect re-assertion. */
  private turnStartedAt: number | undefined = undefined;
  /**
   * TASK.117: the CURRENT outer turn's pending prompt, recorded by
   * `acceptUserMessage` the moment a turn is admitted (BEFORE runTurn) and
   * cleared on EVERY terminal boundary of that turn: the turn's own teardown
   * (finally), any pre-append refusal (unsupported_images / busy / not_ready
   * rejects below), cancel, shutdown, rewind success (the turn never
   * happened), and BEFORE a continuation or a new turn's first turn_start.
   * Owner-checked by turnId+requestId so a stale older child finalizer can
   * never clear a newer turn's prompt. Emits `pending_prompt` (sendDirect —
   * regenerated per ui_ready, never ring-buffered) so a reconnecting
   * renderer can render the in-flight prompt bubble ONLY while its turn is
   * genuinely live and no durable user item (turnId, step 0) exists yet.
   */
  private pendingPrompt: { turnId: string; requestId: string; text: string; images?: ImageAttachment[] } | null = null;
  /**
   * TASK.117: the CURRENT outer turn's inner request ordinal (core's
   * `turn_start.turn`, 1-based, reset per outer turn). Maintained inside
   * runTurn's event loop; undefined outside a turn / for foreign engines.
   */
  private currentStep: number | undefined;
  /**
   * TASK.117: the live outer turn's requestId (pair with this.turnId), kept
   * only while the turn is in flight — the ui_ready cascade re-asserts
   * `turn_started` as sendDirect handshake meta so a reconnecting renderer
   * opens the turn even when the ring's buffered copy has been evicted.
   */
  private lastTurnRequest: { requestId: string; turnId: string } | undefined;
  /**
   * TASK.117 control/accounting checkpoint: cumulative session token totals,
   * captured AT EMISSION TIME from every core `finish` AgentEvent (SUM
   * semantics mirroring the renderer's accumulateSessionTokens) because
   * durable history carries NO usage fields — once the replay ring evicts a
   * finish (REPLAY_BUFFER_CAP overflow), this is the ONLY record of what the
   * renderer's sessionTokens already counted. Null until the first finish.
   * A later session_checkpoint REPLACES the fresh store's value with exactly
   * this number (never re-adds), so live finishes after the reconnect stay
   * exactly-once on top of it. Core-engine events only (foreign engines own
   * their REPLACE-semantics engine_session_totals on the ring, untouched).
   */
  private checkpointSessionTokens: { input: number; output: number; total: number; latestCacheRead?: number; latestCacheInput?: number } | null = null;
  /**
   * TASK.117 checkpoint dedup: the fold keys (`${turnId}:${step}`) of every
   * core finish accumulated into checkpointSessionTokens, newest-first.
   * Shipped as `session_checkpoint.countedSteps` so the renderer can drop a
   * REPLAYED finish by exact key instead of by durability coverage — the
   * finish-yielded-before-append window (core yields finish BEFORE history.
   * append makes the step durable) means an uncovered replay is possible,
   * and coverage alone would re-add it on top of the REPLACE (double
   * count). Bounded: entries older than the ring capacity cannot still
   * replay, so the tail is trimmed to CHECKPOINT_COUNTED_STEPS_MAX.
   */
  private readonly checkpointCountedSteps: string[] = [];
  /**
   * TASK.117 control/accounting checkpoint: the LATEST core context_usage
   * reading (latest-wins scalar), captured at emission for the same reason
   * as checkpointSessionTokens above. Null until the first reading.
   */
  private checkpointContextUsage: { estimatedTokens: number; budgetTokens: number; source: "provider" | "estimate" } | null = null;
  /**
   * TASK.117 acceptance defect 1: the LIVE turn's currently-open partial
   * streams, folded at emission time from the raw stream events (BEFORE
   * sanitizeAgentEvent strips nothing here — text/reasoning stream ids are
   * wire-safe). Keyed `${turnId}:${step}:${streamId}` (SDK stream ids are
   * reused across steps of one outer turn — the same scope the renderer's
   * openStreamBlocks keys by); the value carries the FULL accumulated body
   * plus the block kind, and a `settled` flag set on stream END (text_end /
   * reasoning_end). TASK.117 acceptance defect 3: an ENDED stream is NOT
   * dropped at emission time — core appends the assistant item only after
   * the model stream's finish settles, so the end-to-append gap is exactly
   * the reconnect window where the streamed text exists NOWHERE else (the
   * ring may have evicted its start/deltas; the snapshot has no item yet).
   * pushSessionCheckpoint ships an ended entry ONLY while its (turnId,
   * step) is still missing from the engine's durable history; once the
   * append lands the entry stops riding. Turn teardown (`liveStreams.clear()`
   * beside snapshotPaths.clear()) bounds the lifetime from above, so cancel
   * and ownership never leak a partial past the turn. Core-engine events
   * only (captured under the same `engine.id === "core"` gate as the other
   * checkpoint fields — foreign engines ride the ring).
   */
  private readonly liveStreams = new Map<string, { turnId: string; step: number; streamId: string; kind: "text" | "reasoning"; text: string; settled?: boolean }>();
  /**
   * TASK.117 supervisor correction defect 1: the LIVE turn's tool calls whose
   * `tool_execution_start` has been emitted but whose `tool_result` has not
   * landed yet — keyed by toolCallId. Captured AT EMISSION TIME (before any
   * ring cap could evict the start event) for the same reason as the other
   * checkpoint fields: the assistant item carrying the tool_call IS durable
   * (core appends it BEFORE dispatch), so a fresh store hydrates the card as
   * `proposed`, and the ring-replayed `tool_execution_start` is the ONLY
   * thing that flips it to `running` — once the ring evicts that event the
   * card reads `proposed` forever with the tool genuinely executing. The
   * checkpoint ships this set so a reconnect restores `running`. Cleared per
   * settled result and wholesale at turn teardown (beside liveStreams.clear()).
   * Core-engine events only (captured under the same `engine.id === "core"`
   * gate); a permission-PARKED call is deliberately NOT here — its start has
   * not been emitted yet (dispatch is gated behind the ask), so its card is
   * honestly `proposed` until allowed.
   */
  private readonly runningTools = new Map<string, true>();
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
   * TASK.117 (2026-10-04 product defect): the port the UI wire is currently
   * bound to (the latest bindPort argument). Lets the onClose handler tell a
   * STALE predecessor port's late close (a successor is already bound — the
   * reload completed) apart from the CURRENT port dying. Identity is the
   * WirePort reference itself — the same production seam every teardown path
   * goes through; no new persistence identity.
   */
  private boundPort: WirePort | null = null;
  /**
   * TASK.117: armed when the CURRENT port closes with no successor bound —
   * a renderer reload closes the old port and main re-posts a fresh one on
   * did-finish-load (index.ts deliverAllTabPorts), i.e. AFTER the close is
   * observed here, so the close handler cannot know at that moment whether a
   * reconnect is in flight. The grace window holds the fail-closed deny;
   * bindPort (reload completed) and shutdown (terminal settlement owns it)
   * clear it. If no successor binds within the window the parked asks are
   * denied exactly as before (origin "disconnect") — fail-closed with a
   * bounded delay, never an indefinite permission.
   */
  private reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * TASK.117: the grace window's length. Default covers a renderer reload's
   * full cycle (old port close -> fresh page load -> did-finish-load port
   * re-post -> ui_ready) with margin; injectable ONLY as a test seam
   * (SessionOptions.reconnectGraceMs) so the expiry path stays pinned
   * without real-time waits. Production takes the default, never env-tunable.
   */
  private readonly reconnectGraceMs: number;

  /**

   * The LSP live-push listener drops every fire before this — an unsolicited
   * push must never race a not-yet-mounted renderer (5.7-hostfix bind-race
   * lesson), and the ui_ready case itself pushes the current snapshot.
   */
  private uiReady = false;
  /** Slice P7.25/F3: unsubscribes the LSP status listener on shutdown (no leaked listener, no push-after-dispose). */
  private lspUnsubscribe: (() => void) | undefined;
  /** TASK.145 срез 2: host's pending-report queue seam; undefined for a child-mode host/legacy test (doc on SessionOptions.pendingChildReports). */
  private readonly pendingChildReports: PendingChildReportsOptions | undefined;
  /** TASK.159: see SessionOptions.eventTap's own doc — undefined for core (byte-identical to pre-159). */
  private readonly eventTap: SessionOptions["eventTap"];
  /** TASK.145 срез 3 §2: unsubscribes the background-children live-push listener on shutdown (mirror of lspUnsubscribe). */
  private backgroundChildrenUnsubscribe: (() => void) | undefined;

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
  /** The last loop_end's `declaredDoneAtCeiling` (TASK 4149). */
  private childDeclaredDoneAtCeiling = false;
  private childSafeError: string | undefined;
  /** Once-latch (F7): true once `finalizeChildTerminal` has actually invoked `child.onTerminal` (or handed off an error terminal) — guards its docstring's "exactly once" contract against a second concurrent call. */
  private childTerminalFinalized = false;
  private childFinalTurnFinishReason: "length" | undefined;
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
    this.reconnectGraceMs = options.reconnectGraceMs ?? UI_RECONNECT_GRACE_MS;
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
    this.backgroundChildren = options.backgroundChildren;
    this.lsp = options.lsp;
    this.hooksList = options.hooksList;
    this.envStatus = options.envStatus;
    this.checkpoints = options.checkpoints;
    this.imageInputEnabled = options.imageInputEnabled;
    this.imageFallbackAvailable = options.imageFallbackAvailable;
    this.applyRecognizerConfigImpl = options.applyRecognizerConfig;
    this.refineTitle = options.refineTitle;
    this.reasoningSupported = options.reasoningSupported ?? true;
    this.availableEffortLevels = options.availableEffortLevels;
    this.selectedEffort = options.selectedEffort ?? this.engine.reasoningEffort() ?? "off";
    this.sendPreviewArtifacts = options.postPreviewArtifacts;
    this.child = options.child;
    this.pendingChildReports = options.pendingChildReports;
    this.eventTap = options.eventTap;
    this.now = options.child?.now ?? Date.now;
    this.titleSet = options.hasTitle ?? false;
    this.historyMaxItems = options.historyMaxItems ?? SESSION_HISTORY_MAX_ITEMS;
    this.sessionHistory = buildSessionHistory(options.bootHistory ?? [], this.historyMaxItems);
    const publicHistory = options.bootHistory ?? this.engine.historyItems();
    for (const item of [...publicHistory].reverse()) {
      if (item.message.role !== "assistant" || (item.kind !== undefined && item.kind !== "normal")) continue;
      const text = item.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (!text) continue;
      this.latestPublicResult = { source: "history_recovery", turnId: null, requestId: null, nativeTurnId: null, historyItemId: item.id, terminalReason: "unknown", publicAnswer: text.slice(0, 32000), truncated: text.length > 32000, completedAt: null };
      break;
    }
    // Slice P7.25/F3: subscribe to live LSP status transitions. The listener is

    // ready; unsubscribe on shutdown prevents a leaked listener / push-after-
    // dispose. Absent seam (legacy tests) -> no subscription, pull-only.
    this.lspUnsubscribe = this.lsp?.onStatusChange?.(() => {
      if (this.uiReady) this.pushLspStatus();
    });
    // TASK.145 срез 3 §2: live-push background_children on registry change
    // (a detached child admitted or reaching its terminal), mirroring the LSP
    // subscription immediately above. Absent seam (claude/codex-master boot,
    // or a legacy test) -> no subscription, ui_ready-only pull.
    this.backgroundChildrenUnsubscribe = this.backgroundChildren?.onChange?.(() => {
      if (this.uiReady) this.pushBackgroundChildren();
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
    // TASK.117 (2026-10-04 product defect): remember WHICH port is current so
    // a stale predecessor's late 'close' can be told apart from the CURRENT
    // port dying, and disarm any pending grace deny — a port arriving here
    // IS the successor of a completed renderer reload, so its predecessor's
    // close described the reload, not a dead session.
    this.boundPort = port;
    if (this.reconnectGraceTimer !== null) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
    }
    this.outbound.attach(port);
    port.onMessage((raw) => {
      this.route(raw);
    });
    port.onClose(() => {
      // TASK.117: the old unconditional denyAll here destroyed the parked
      // ask mid-reload (live S2: "ui disconnected" deny + no_pending_request
      // 1.3s after a Page.reload — the close is observed BEFORE main re-posts
      // the new port on did-finish-load, so at this instant the reload is
      // indistinguishable from a dead session). Two closes must NOT settle:
      //  - a STALE predecessor port (a successor is already bound): its
      //    close describes the completed reload, not a dead session;
      //  - a close during SHUTDOWN: shutdown() owns the terminal settlement
      //    (denyAll("shutting down", "shutdown")) — a disconnect-origin
      //    settle here would race it and misattribute the denial.
      if (this.shuttingDown || this.boundPort !== port) {
        return;
      }
      // Current port closed and no successor bound yet. The reload fix:
      // instead of settling NOW, arm the bounded grace window — bindPort of
      // a successor cancels it; expiry denies exactly as before (fail-closed
      // origin "disconnect"). The parked asks' own authoritative TTL still
      // applies throughout — the window never extends a permission.
      this.uiReady = false;
      if (this.reconnectGraceTimer === null) {
        this.reconnectGraceTimer = setTimeout(() => {
          this.reconnectGraceTimer = null;
          // Still no successor and not shutting down -> genuinely dead.
          this.broker.denyAll("ui disconnected", "disconnect");
        }, this.reconnectGraceMs);
      }
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
  private latestPublicResult: SessionPublicResult | null = null;
  private readonly messageTurns = new Map<string, { hostTurnId: string | null; nativeTurnId?: string }>();

  communicationResult() {
    const latest = this.latestPublicResult;
    const deliveredMessageIds = latest ? [...this.messageTurns.entries()].filter(([, identity]) =>
      (latest.turnId !== null && identity.hostTurnId === latest.turnId) ||
      (latest.nativeTurnId !== null && identity.nativeTurnId === latest.nativeTurnId)
    ).map(([id]) => id) : [];
    return {
      sessionId: this.sessionId,
      availability: this.busy ? "pending" : latest ? latest.source === "history_recovery" ? "recovered_unverified" : "available" : "unavailable",
      activeTurnId: this.busy ? this.turnId : null,
      latestResult: latest ? { ...latest, deliveredMessageIds, correlationMeaning: "transport_delivery_only" } : null,
      limitation: "Latest completed public text block only. History recovery cannot establish terminal status or turn/message correlation. Completion does not prove a message was applied.",
    };
  }

  private readonly agentInbox: AgentEnvelope[] = [];
  private readonly agentDeliveries = new Map<string, AgentDelivery>();

  communicationStatus(): { sessionId: string; engine: string; state: string; steering: { supported: boolean; ready: boolean; nativeTurnId?: string } } {
    return { sessionId: this.sessionId, engine: this.engine.id, state: this.shuttingDown ? "closing" : this.busy ? "running" : "idle", steering: this.engine.steeringStatus?.() ?? { supported: false, ready: false } };
  }

  private agentDeliveryObserver?: (delivery: AgentDelivery) => void;
  observeAgentDeliveries(observer: (delivery: AgentDelivery) => void): void { this.agentDeliveryObserver = observer; }

  private publishAgentDelivery(delivery: AgentDelivery): void {
    this.agentDeliveries.set(delivery.envelope.messageId, { ...delivery });
    this.outbound.emit({ type: "agent_message", delivery: { ...delivery } });
    try { this.agentDeliveryObserver?.({ ...delivery }); } catch { /* persistence observation cannot affect delivery */ }
  }

  async receiveAgentMessage(envelope: AgentEnvelope): Promise<AgentDelivery> {
    const existing = this.agentDeliveries.get(envelope.messageId);
    if (existing) return existing;
    if (envelope.recipientSessionId !== this.sessionId || this.shuttingDown || this.relocating || (this.child !== undefined && this.childTerminalFinalized)) {
      const delivery: AgentDelivery = { envelope, state: "rejected", detail: "Session unavailable" };
      this.publishAgentDelivery(delivery);
      return delivery;
    }
    const delivery: AgentDelivery = { envelope, state: "queued" };
    this.publishAgentDelivery(delivery);
    if (envelope.mode === "steer") {
      if (!this.busy || !this.engine.steer) {
        delivery.state = "rejected";
        delivery.detail = "Steering requires an active supported Codex turn; use next_turn";
      } else {
        try {
          const receivingTurnId = this.turnId;
          const ack = await this.engine.steer(agentMessageText(envelope));
          this.messageTurns.set(envelope.messageId, { hostTurnId: receivingTurnId, nativeTurnId: ack.turnId });
          delivery.state = "acknowledged";
          delivery.detail = `app-server accepted input for turn ${ack.turnId}; model application unverified`;
        } catch (error) {
          delivery.state = (error as { deliveryState?: string }).deliveryState === "unknown" ? "unknown" : "rejected";
          delivery.detail = describeError(error);
        }
      }
      this.publishAgentDelivery(delivery);
    } else if (this.agentInbox.length >= 32) {
      delivery.state = "rejected";
      delivery.detail = "Inbox full";
      this.publishAgentDelivery(delivery);
    } else {
      this.agentInbox.push(envelope);
      this.drainAgentInbox();
    }
    return this.agentDeliveries.get(envelope.messageId)!;
  }

  restoreAgentMessages(deliveries: AgentDelivery[]): void {
    for (const delivery of deliveries) {
      if (delivery.envelope.recipientSessionId === this.sessionId && !this.agentDeliveries.has(delivery.envelope.messageId)) this.publishAgentDelivery(delivery);
    }
  }

  agentMessageStatus(messageId: string): AgentDelivery | undefined {
    return this.agentDeliveries.get(messageId);
  }

  private drainAgentInbox(settledChild = false): boolean {
    if ((!settledChild && (this.busy || this.currentTurn !== null)) || this.shuttingDown || this.relocating || this.childTerminalFinalized) return false;
    const envelope = this.agentInbox.shift();
    if (!envelope) return false;
    if (settledChild) this.busy = false;
    const started = this.acceptUserMessage(envelope.messageId, agentMessageText(envelope), undefined, "system");
    if (started) this.messageTurns.set(envelope.messageId, { hostTurnId: this.turnId });
    this.publishAgentDelivery({ envelope, state: started ? "acknowledged" : "rejected", detail: started ? "Host started a next turn; model application unverified" : "Turn refused" });
    return started;
  }

  closeAdmissions(): void {
    this.shuttingDown = true;
    // TASK.117: same disarm as shutdown() — once admissions close, the
    // session is on its terminal path and the disconnect grace timer must
    // never fire past the real settlement.
    if (this.reconnectGraceTimer !== null) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
    }
    for (const envelope of this.agentInbox.splice(0)) this.publishAgentDelivery({ envelope, state: "rejected", detail: "Session closing before queued delivery" });
  }

  /** Graceful shutdown: abort the turn, release parked asks, await turn teardown. */
  async shutdown(): Promise<void> {
    // TASK.102 CUT-S2 §10.11.1 N1: flipped FIRST, strictly before abort/
    // denyAll/dispose below, so teardown woken by the abort already sees it.
    this.closeAdmissions();
    // TASK.117: shutdown is the terminal settlement — disarm the reconnect
    // grace window so its timer can never fire a disconnect-origin denyAll
    // after (or beside) the shutdown settlement below.
    if (this.reconnectGraceTimer !== null) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
    }
    // TASK.117: shutdown is a terminal boundary — the live turn's pending
    // prompt dies with it (a respawned host re-derives nothing). "cancelled":
    // an in-flight prompt's frame may never land; retire the bubble.
    this.pendingPrompt = null;
    this.pushPendingPrompt("cancelled");
    // Slice P7.25/F3: release the LSP status subscription so no transition after
    // this point can push onto a shut-down session, and no listener reference
    // leaks past the session's life. (The host reaps lspManager BEFORE calling
    // shutdown, so the final "all disposed" snapshot already rode out as a valid
    // push; this guards everything strictly after teardown begins.) uiReady is
    // flipped false as a belt-and-braces gate for any in-flight microtask.
    this.uiReady = false;
    this.lspUnsubscribe?.();
    this.lspUnsubscribe = undefined;
    this.backgroundChildrenUnsubscribe?.();
    this.backgroundChildrenUnsubscribe = undefined;
    this.engineSettingsUnsubscribe?.();
    this.engineSettingsUnsubscribe = undefined;
    // TASK.145 срез 3 §3: closing this session's tab is a deliberate decision
    // to give up on any detached background child it spawned — nobody
    // remains to receive an eventual report, and an orphaned child process is
    // worse than a lost report. This is now an EXPLICIT registry sweep, not a
    // side effect of `this.abort.abort()` below: срез 3 disarms a detached
    // child's abort listener at admit time (child-session-port.ts) precisely
    // so that Stop-cancelling the turn that spawned it no longer cancels the
    // child — shutdown is the one place that still deliberately does.
    this.backgroundChildren?.cancelAll();
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
        case "steer_message":
        void this.receiveAgentMessage({ messageId: message.requestId, sender: "local-supervisor-ui", recipientSessionId: this.sessionId, kind: "agent_message", payload: message.text, mode: "steer", createdAt: new Date().toISOString() });
        return;
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
          // TASK.198 срез C: the vision-fallback verdict, same additive-
          // optional discipline as imageInput above — absent seam (codex/
          // claude, legacy tests) -> field absent, no fallback-aware gating.
          ...(this.imageFallbackAvailable !== undefined ? { imageFallback: this.imageFallbackAvailable() } : {}),
          ...(presentation !== undefined ? { engine: presentation } : {}),
          // Design TASK.40 §2(f)/§3.2: shell is emitted ONLY alongside a
          // present `engine` (never for core), so the core wire stays
          // byte-identical by construction.
          ...(presentation !== undefined && this.shell !== undefined ? { shell: this.shell } : {}),
        });
        // Phase-2 §3.3: session_history (transcript hydration of a resumed
        // session) is emitted AFTER host_ready and BEFORE replay(). sendDirect
        // (not buffered). TASK.117: the snapshot is REBUILT from the engine's
        // current durable history on EVERY ui_ready — not the boot-frozen
        // snapshot from the constructor — so a renderer reconnecting after the
        // Outbound replay ring has overflowed still sees the latest persisted
        // transcript, not a stale host-start snapshot. The fresh snapshot is
        // coherent with the events replayed after it (those are only newer),
        // so no dedupe/watermarking of the ring is needed. CORE ONLY
        // (phase-1 defect 2): the causal-stamp fold is a core contract; a
        // native Codex/Claude host keeps the FIXED constructor boot snapshot
        // — COMPLETE later-completed replay rides the ring exactly as
        // before (native compat), and the rebuild gate must never touch
        // their history projection.
        if (this.engine.id === "core") {
          this.sessionHistory = buildSessionHistory([...this.engine.historyItems()], this.historyMaxItems);
        }
        if (this.sessionHistory) {
          this.outbound.sendDirect({
            type: "session_history",
            sessionId: this.sessionId,
            items: this.sessionHistory.items,
            truncated: this.sessionHistory.truncated,
          });
        }
        // TASK.117: the pending-prompt state rides the same per-connect
        // cascade — a reconnecting renderer re-renders the in-flight prompt
        // bubble (or clears it) BEFORE the replay ring's turn events land.
        this.pushPendingPrompt();
        // TASK.117: a LIVE outer turn's `turn_started` is re-asserted
        // per-connect as handshake meta (sendDirect, regenerated on every
        // ui_ready — never ring-buffered). Without it, a turn whose buffered
        // turn_started has been evicted from the replay ring (REPLAY_BUFFER_CAP
        // overflow) delivers its live agent_events to a fresh store that
        // never saw the turn open — the renderer's turn-scoped guard drops
        // every one, and the visible transcript freezes (the original
        // TASK.117 symptom). Idempotent on the renderer: the handler sets the
        // same running-turn state; the ring's own copy (if still present)
        // replays to the same effect. Emitted for ANY engine's live turn —
        // the wire contract for turn_started is engine-agnostic.
        if (this.turnId !== null && this.lastTurnRequest !== undefined) {
          this.outbound.sendDirect({
            type: "turn_started",
            requestId: this.lastTurnRequest.requestId,
            turnId: this.turnId,
            ...(this.turnStartedAt !== undefined ? { startedAt: this.turnStartedAt } : {}),
          });
        }
        // TASK.117 control/accounting checkpoint: re-assert the wire state
        // the ring may have evicted (cumulative finish totals, latest
        // context_usage, the parked permission ask) BEFORE replay() — the
        // fresh store's slots are then already correct, and any ring copy
        // that still replays is idempotent (permission set-slot, finish
        // once-per-step fold, context_usage latest-wins).
        this.pushSessionCheckpoint();
        this.outbound.replay();
        for (const delivery of this.agentDeliveries.values()) this.outbound.sendDirect({ type: "agent_message", delivery });
        // TASK.145 срез 2: re-post every still-unacknowledged detached-child
        // report to the just-(re)attached renderer — covers the race the
        // outer `sendDirect` at delivery time cannot: a renderer that was
        // reloading/disconnected exactly when the report was first sent. See
        // PendingChildReportsOptions.resendAll's own doc for ordering.
        this.pendingChildReports?.resendAll();
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
        // TASK.145 срез 3 §2: always pushed, unconditionally — unlike
        // pushTaskList's `supportsTasks` gate (an ENGINE capability), a
        // detached child is a CORE-engine-only feature (spec §5: claude/codex
        // masters have no Agent tool at all) already expressed by the seam's
        // own presence/absence (`this.backgroundChildren`, wired only for a
        // core-engine boot, host/index.ts). `?? []` makes this a no-op push
        // of an empty list for every other engine/legacy test.
        this.pushBackgroundChildren();
        if (this.continuationPending) {
          this.continuationPending = false;
          this.currentTurn = this.startContinuation().catch((error) => {
            this.outbound.emit({ type: "fatal", message: `worktree continuation failed: ${describeError(error)}` });
          });
        }
        break;
      case "steer_message":
        void this.receiveAgentMessage({ messageId: message.requestId, sender: "local-supervisor-ui", recipientSessionId: this.sessionId, kind: "agent_message", payload: message.text, mode: "steer", createdAt: new Date().toISOString() });
        return;
      case "user_message":
        // Typed input is proof that a human is at the screen (TASK.138): it
        // disarms the broker's unattended latch, so a session that went quiet
        // long enough to expire an ask starts asking again once its owner is back.
        //
        // TASK.145 срезы 2+3 (merged): `message.origin === "system"` marks a
        // `user_message` the renderer auto-drained from its own prompt queue
        // rather than a human actually typing (today: a detached child's
        // report, срез 1's `child_report` -> `enqueuePrompt` path). ONE field
        // carries both meanings the two slices needed independently: how the
        // block renders in the transcript (срез 2, threaded on to
        // `onUserMessage` below) and whether it counts as human presence
        // (срез 3, the gate here). A background wake-up is NOT proof anyone is
        // watching the screen, so it must not rearm TASK.138's unattended
        // latch on an autonomous run nobody is actually attending.
        if (message.origin !== "system") {
          this.broker.noteHumanPresent();
        }
        this.onUserMessage(message.requestId, message.text, message.images, message.origin);
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
        // TASK.144: no longer gated on `supportsCorePermissions`. That gate was
        // honest while a stored rule could only be honoured by
        // RuleAwarePermissionEngine — remembering in a session that had no such
        // engine wrote a rule nothing would ever read. The engine boots now hand
        // their rule store to the IpcPermissionBroker itself (host/index.ts), so
        // the store is consulted on BOTH paths and a remembered allow is
        // meaningful in every session that reaches here.
        this.maybeRemember(message.requestId, message.behavior, message.remember);
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
          // TASK.198 срез C: same additive-optional discipline as imageInput above.
          ...(this.imageFallbackAvailable !== undefined ? { imageFallback: this.imageFallbackAvailable() } : {}),
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
      case "compact_request":
        // TASK.146: same authoritative host-side silent-drop contract as
        // set_model (:1347-1356 above) — no reply escape, the renderer's row
        // disables itself too via the same truly-idle predicate. `relocating`
        // mirrors onRewind's BLOCKER-2(a) window; `child !== undefined` is
        // dropped because a child's context belongs to the parent Agent-tool
        // chain (TASK.102/145) — it is either busy (the whole chain is) or
        // terminal (read-only), so an accepted request here is impossible by
        // construction. `engine.compactNow === undefined` IS the engine gate:
        // only CoreEngine implements it (session-engine.ts), so a claude/codex
        // boot drops this unconditionally — no `if (engine === "claude")`
        // needed. void: onCompact holds `busy` across an await; route() itself
        // never awaits.
        if (this.busy || this.relocating || this.child !== undefined || this.engine.compactNow === undefined) break;
        void this.onCompact();
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
      case "child_report_ack":
        // TASK.145 срез 2: no reply of its own — the renderer already has
        // what it needs (the enqueued/deduped item). Undefined seam (child-
        // mode host, legacy test) -> silent no-op, same posture as every
        // other optional seam this switch reads.
        this.pendingChildReports?.ack(message.id);
        break;
      case "background_children_request":
        this.pushBackgroundChildren();
        break;
      case "background_child_cancel_request":
        this.onBackgroundChildCancelRequest(message.requestId, message.childSessionId);
        break;
    }
  }

  private pushLspStatus(): void {
    this.outbound.sendDirect({ type: "lsp_status", servers: this.lsp?.status() ?? [] });
  }

  /**
   * TASK.117: pushes the current pending-prompt state to the attached
   * renderer. sendDirect (never ring-buffered — regenerated on every
   * ui_ready). Only meaningful for a CORE host (its renderer owns the
   * pending-bubble/pending_prompt folding; the capture itself is core-gated
   * at admission, so a foreign engine never has a payload). `outcome`
   * rides only the TERMINAL clears (see the protocol type's doc) — the
   * per-connect state push carries none.
   */
  private pushPendingPrompt(outcome?: "settled" | "cancelled"): void {
    // TASK.117 phase-1 defect 1: the pending_prompt wire contract is CORE
    // ONLY — a foreign engine's renderer has no pending-bubble field at all,
    // so it must never receive even a bare field-clear (the per-connect
    // snapshot push below) or a terminal clear ("cancelled" would strip a
    // block by turnId on a store that never had the field). The capture gate
    // at admission already keeps pendingPrompt null on foreign engines; this
    // guard makes the METHOD itself core-exclusive so no call site can leak a
    // core-only message onto a native wire.
    if (this.engine.id !== "core") {
      return;
    }
    const pending = this.pendingPrompt;
    // TASK.117 phase-1 defect 2: `outcome` rides ONLY the terminal clears —
    // the per-connect state push is a pure snapshot and must never retire a
    // live bubble ("cancelled" removes the renderer's block). Foreign
    // engines have no payload ever (capture is core-gated), and a core host
    // with nothing in flight still sends the bare field-clear so a
    // reconnecting renderer cannot resurrect a stale pendingPrompt field.
    if (pending === null && outcome !== undefined) {
      this.outbound.sendDirect({ type: "pending_prompt", ...(outcome !== undefined ? { outcome } : {}) });
      return;
    }
    this.outbound.sendDirect({
      type: "pending_prompt",
      ...(pending !== null
        ? { turnId: pending.turnId, requestId: pending.requestId, text: pending.text, ...(pending.images?.length ? { images: pending.images } : {}) }
        : {}),
    });
  }

  /**
   * TASK.117: the ONE exact-owner terminal clear, extracted VERBATIM from
   * the turn teardown's `.finally` (behavior-identical: same owner equality
   * on the captured requestId + outer turn UUID pair, same
   * durability-derived outcome) so the regression for a stale older
   * finalizer can invoke the REAL production guard against a NEWER
   * admission-shaped pending record instead of a test replica. The owner
   * check makes a stale clear a no-op: only the exact holder (the admission
   * that minted the pair) may retire the slot; a NEWER turn's record always
   * survives an older turn's terminal.
   */
  clearPendingPromptIfOwner(
    requestId: string,
    turnId: string,
    outcome: "settled" | "cancelled",
  ): void {
    if (this.pendingPrompt !== null && this.pendingPrompt.requestId === requestId && this.pendingPrompt.turnId === turnId) {
      this.pendingPrompt = null;
      this.pushPendingPrompt(outcome);
    }
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

  /**
   * TASK.117 control/accounting checkpoint: ONE sendDirect snapshot re-sent
   * on EVERY ui_ready (never ring-buffered), carrying exactly the wire state
   * the replay ring may have evicted: cumulative finish totals, the latest
   * context_usage reading, and the broker's CURRENTLY-SHOWN parked ask.
   * CORE-ONLY by the capture gates (both checkpoint fields are written only
   * for core-engine events; a foreign host's engine_session_tokens REPLACE
   * semantics ride the ring untouched), so the whole push is core-gated
   * here too — a native host never receives core checkpoint semantics.
   * Additive-optional fields: whatever has not been captured yet is simply
   * absent from the message (an older renderer / nothing-in-flight changes
   * nothing). The permission re-assert re-sends the SAME
   * `permission_request` payload the broker originally presented — the
   * store's handler is idempotent (set-permission-slot), so a renderer that
   * DID see the original (ring intact) just re-sets the same value.
   */
  private pushSessionCheckpoint(): void {
    if (this.engine.id !== "core") {
      return;
    }
    const shown = this.broker.pendingShownRequest();
    // TASK.117 acceptance defect 1: for each open partial stream, count how
    // much of its delta text the ring STILL HOLDS — the exact suffix the
    // replay is about to redeliver to the fresh store. The fresh store's
    // checkpoint re-open carries the FULL partial; the replayed suffix must
    // not append again, so the ship carries `replayChars` = that suffix's
    // length and the renderer consumes exactly that many chars of replayed
    // deltas for this stream (see applyStreamDelta — an EXACT host-computed
    // count, not a renderer-side prefix guess, because the ring holds an
    // arbitrary SUFFIX of the stream, not its beginning).
    const ring = this.outbound.ringView();
    const replayCharsByKey = new Map<string, number>();
    for (const message of ring) {
      if (
        message.type === "agent_event" &&
        message.step !== undefined &&
        (message.event.type === "text_delta" || message.event.type === "reasoning_delta")
      ) {
        const key = `${message.turnId}:${message.step}:${message.event.id}`;
        replayCharsByKey.set(key, (replayCharsByKey.get(key) ?? 0) + message.event.text.length);
      }
    }
    // TASK.117 acceptance defect 3: a SETTLED stream (text_end/reasoning_end
    // seen, assistant append still pending behind the model finish) rides
    // the checkpoint ONLY while its step has no durable assistant item yet —
    // once the append lands the renderer re-opens from `session_history`
    // hydration (the hydrated block owns the rendering), so shipping the
    // settled partial would stack a twin block beside it. `settled === false`
    // (mid-stream) always rides: the step is still being written.
    const durableStepKeys = new Set<string>();
    for (const item of this.engine.historyItems()) {
      if (item.turnId !== undefined && item.step !== undefined && item.message.role === "assistant") {
        durableStepKeys.add(`${item.turnId}:${item.step}`);
      }
    }
    const streams = [...this.liveStreams.values()].filter(
      (stream) => stream.settled !== true || !durableStepKeys.has(`${stream.turnId}:${stream.step}`),
    );
    // TASK.117 acceptance defect 1 (strict ownership vs new turns): when the
    // last session_history was TRUNCATED, compute the set of turns it cut
    // away ENTIRELY — present in durable history, absent from the snapshot
    // the renderer holds, and not the live turn. The renderer's below-cut
    // guard uses this as the positive discriminator for events whose turnId
    // has no boundary entry (a NEW post-handshake turn is unknown to BOTH
    // sets and must render). Same history the snapshot was built from, read
    // at push time, so the two can never disagree.
    let cutTurnIds: string[] | undefined;
    if (this.sessionHistory?.truncated === true) {
      const snapshotted = new Set(
        this.sessionHistory.items.filter((item) => item.turnId !== undefined).map((item) => item.turnId as string),
      );
      const cut = new Set<string>();
      for (const item of this.engine.historyItems()) {
        if (item.turnId !== undefined && item.turnId !== this.turnId && !snapshotted.has(item.turnId)) {
          cut.add(item.turnId);
        }
      }
      // TASK.117 acceptance defect 1: on a truncated snapshot the field is
      // ALWAYS shipped — an EMPTY list is authoritative ("the cut landed
      // within turns; no whole turnId vanished") and must reach the renderer
      // distinctly from an OMITTED one (untruncated history / older host),
      // because the renderer's below-cut guard falls back to the LEGACY
      // suppress-unless-live rule when the field is absent. Pre-fix the
      // `cut.size > 0` gate made a truncated-but-no-whole-turn-cut
      // checkpoint indistinguishable from a legacy one, so a NEW turn
      // admitted after that handshake never rendered.
      cutTurnIds = [...cut];
    }
    this.outbound.sendDirect({
      type: "session_checkpoint",
      // TASK.117 acceptance defect 2: the authoritative live turn id — see
      // the protocol field's doc (the renderer's cut-replay guard exempts
      // exactly this id, never a ring-replayed turn_started's).
      ...(this.turnId !== null ? { liveTurnId: this.turnId } : {}),
      ...(cutTurnIds !== undefined ? { cutTurnIds } : {}),
      // TASK.117 acceptance defect 1: the currently-open partial streams ride
      // the same per-connect checkpoint — an EMPTY liveStreams (idle turn)
      // omits the field entirely, so an older renderer / an idle host sees a
      // byte-identical message to before.
      ...(streams.length > 0
        ? {
            streams: streams.map(({ turnId, step, streamId, kind, text }) => ({
              step,
              streamId,
              kind,
              text,
              replayChars: replayCharsByKey.get(`${turnId}:${step}:${streamId}`) ?? 0,
            })),
          }
        : {}),
      // TASK.117 supervisor correction defect 1: the currently-executing tool
      // calls — each id flips the reconnected store's hydrated `proposed`
      // card to `running` (the ring-replayed tool_execution_start is the only
      // other source, and a >CAP overflow evicts it). Absent when nothing is
      // executing (idle turn / older renderer changes nothing).
      ...(this.runningTools.size > 0 ? { runningTools: [...this.runningTools.keys()] } : {}),
      ...(this.checkpointSessionTokens !== null
        ? { sessionTokens: this.checkpointSessionTokens, ...(this.checkpointCountedSteps.length > 0 ? { countedSteps: [...this.checkpointCountedSteps] } : {}) }
        : {}),
      ...(this.checkpointContextUsage !== null ? { contextUsage: this.checkpointContextUsage } : {}),
      ...(shown !== null
        ? {
            permission: {
              requestId: shown.requestId,
              toolName: shown.request.toolName,
              input: shown.request.input,
              mode: shown.request.mode,
              metadata: toWireToolMeta(shown.request.metadata),
            },
          }
        : {}),
    });
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
   * TASK.145 срез 3 §2: mirror of pushTaskList/pushHooksList — a pure read of
   * the host's own detached-children registry. Pushed on ui_ready, in
   * response to a background_children_request, on registry change (the
   * `backgroundChildrenUnsubscribe` listener above), and after handling a
   * background_child_cancel_request (mirrors onTaskKillRequest's own
   * pushTaskList() call — an immediate refreshed snapshot beside the ack).
   */
  private pushBackgroundChildren(): void {
    this.outbound.sendDirect({ type: "background_children", children: this.backgroundChildren?.list() ?? [] });
  }

  /**
   * TASK.145 срез 3 §2(a): mirror of onTaskKillRequest. `ok:false` covers an
   * unknown/already-finished childSessionId — not a refusal on the merits,
   * same discipline as task_kill_result's own reason text.
   */
  private onBackgroundChildCancelRequest(requestId: string, childSessionId: string): void {
    const ok = this.backgroundChildren?.cancel(childSessionId) ?? false;
    this.outbound.sendDirect({
      type: "background_child_cancel_result",
      requestId,
      ok,
      ...(ok ? {} : { reason: "no such background child (already finished, or never existed)" }),
    });
    this.pushBackgroundChildren();
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
        this.sessionHistory = buildSessionHistory([...this.engine.historyItems()], this.historyMaxItems);
        this.outbound.clear();
        // TASK.117: rewind success retires any leftover pending prompt — the
        // rewound-to state owns the transcript tail now (rewind runs
        // between turns, so this is normally already null; belt-and-braces
        // for a rewind racing a just-admitted turn's early window).
        // "cancelled": the rewound-away turn never happened.
        this.pendingPrompt = null;
        this.pushPendingPrompt("cancelled");
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
      this.drainAgentInbox();
      release();
    }
  }

  /**
   * Manual compaction (TASK.146): mirrors `onRewind`'s busy-holding deferred
   * (a compaction is an inter-turn maintenance op, not a real turn) plus
   * `runTurn`'s AbortController (so `cancel_turn` -> `onCancel` ->
   * `this.abort.abort()` reaches `AgentLoop.compactNow` exactly like it
   * reaches a real turn). Deliberately does NOT touch `this.turnId` — no turn
   * is opened, so every `agent_event` this emits rides the
   * `MANUAL_COMPACTION_TURN_ID` sentinel instead of a real turn id.
   *
   * Re-checks the same gates `route()`'s `case "compact_request"` already
   * checked before calling here: messages route synchronously and
   * sequentially, so this is a defensive net (mirrors the CUT-S2 comment
   * pattern elsewhere in this file), not a race — `route()` never awaits
   * between the gate and this call.
   */
  private async onCompact(): Promise<void> {
    if (this.busy || this.relocating || this.child !== undefined || this.engine.compactNow === undefined) {
      return;
    }
    // Bound to `this.engine` (NOT extracted into a local const): CoreEngine's
    // compactNow reads `this.options.loop` internally — detaching the method
    // from its receiver would call it with `this` undefined.
    const engine = this.engine;
    this.busy = true;
    let release!: () => void;
    const op = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.currentTurn = op;
    const controller = new AbortController();
    this.abort = controller;
    try {
      for await (const event of engine.compactNow!({ signal: controller.signal })) {
        // `emit` (not `sendDirect`): a reconnect mid-compaction must replay
        // the start/end pair from the ring buffer exactly like a real turn's
        // events do — a fresh renderer attach should never see a half-open
        // "Compacting…" toast with no matching end.
        this.outbound.emit({ type: "agent_event", turnId: MANUAL_COMPACTION_TURN_ID, event: sanitizeAgentEvent(event) });
        // TASK.117 supervisor correction defect 2: the manual compaction's
        // post-swap context_usage is the LATEST session-scoped reading — fold
        // it into the emission-time checkpoint exactly like runTurn's loop
        // does, so a reconnect whose >CAP overflow evicted the ring copy
        // (sentinel-turnId event, plain emit) still restores the POST-swap
        // meter instead of a stale pre-compaction one. Latest-wins scalar,
        // same shape as checkpointContextUsage's other writers.
        if (this.engine.id === "core" && event.type === "context_usage") {
          this.checkpointContextUsage = {
            estimatedTokens: event.estimatedTokens,
            budgetTokens: event.budgetTokens,
            source: event.source,
          };
        }
      }
    } catch (error) {
      // compactNow (AgentLoop.compactNow) is designed never to throw — a
      // failed compaction is reported as compaction_end{ok:false} — so this
      // is a defensive net mirroring runTurn's own catch above.
      this.outbound.emit({ type: "fatal", message: `compaction failed: ${describeError(error)}` });
    } finally {
      this.busy = false;
      this.abort = null;
      if (this.currentTurn === op) this.currentTurn = null;
      this.drainAgentInbox();
      release();
    }
  }

  private onUserMessage(requestId: string, text: string, images?: ImageAttachment[], origin?: "system"): void {
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
    this.acceptUserMessage(requestId, text, images, origin);
  }

  /**
   * TASK.198 срез C (plan §3 gate table): the model-level half of the
   * image-attachment gate — true when the current model can see images
   * itself, OR the vision fallback is available (a recognizer is currently
   * configured for this session). `engine.capabilities.supportsImages` (the
   * ENGINE-level half) is checked separately by both call sites, unchanged.
   * `imageFallbackAvailable` absent (codex/claude, legacy tests) makes this
   * identical to the pre-TASK.198 `imageInputEnabled?.() === true` check.
   */
  private imagesAccepted(): boolean {
    return this.imageInputEnabled?.() === true || this.imageFallbackAvailable?.() === true;
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
    if (attachments !== undefined && (!this.engine.capabilities.supportsImages || !this.imagesAccepted())) {
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
    for (const envelope of this.agentInbox.splice(0)) this.publishAgentDelivery({ envelope, state: "rejected", detail: "Child session cannot accept queued delivery" });
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
  private acceptUserMessage(requestId: string, text: string, images?: ImageAttachment[], origin?: "system"): boolean {
    const attachments = images?.length ? [...images] : undefined;
    if (attachments !== undefined && (!this.engine.capabilities.supportsImages || !this.imagesAccepted())) {
      this.outbound.emit({ type: "turn_rejected", requestId, reason: "unsupported_images" });
      return false;
    }
    // TASK.117 phase-1 defect 3: the pending RAW prompt is captured HERE —
    // at admission, AFTER the unsupported_images refusal (a refused message
    // never becomes pending) and BEFORE the title derivation / hook /
    // notices awaits below — owned by the outer turn UUID + requestId pair
    // this method mints, so every later clear is an exact-owner check. CORE
    // ONLY by construction: a foreign engine's renderer has no pending
    // bubble contract, so it must never receive a payload-bearing
    // pending_prompt (the capture gate, not a renderer-side engine guard).
    // The RAW text is recorded — title/notices/plan-reminder augmentation is
    // model-facing, never what the user typed.
    const turnId = randomUUID();
    const pendingTurnIdHolder: { turnId: string } = { turnId };
    if (this.engine.id === "core") {
      this.pendingPrompt = {
        turnId,
        requestId,
        text,
        ...(attachments?.length ? { images: attachments } : {}),
      };
      this.pushPendingPrompt();
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
    const turn: Promise<void> = this.runTurn(requestId, turnInput, attachments, carriesWorktreeExitNotice, origin, pendingTurnIdHolder).finally(
      async () => {
        // TASK.117: clear the pending prompt at this turn's terminal via the
        // REAL exact-owner guard (`clearPendingPromptIfOwner` — extracted
        // verbatim from this teardown, behavior-identical, so the guard is
        // the one and only clear path). Outcome by DURABILITY, not by
        // loop_end reason: a seen inner turn_start (currentStep set) PROVES
        // the user frame was appended (core appends it before the first
        // model request), so the renderer keeps the bubble as the rendering
        // record ("settled") — without it the frame never landed and the
        // bubble must be retired ("cancelled"), whatever ended the turn.
        this.clearPendingPromptIfOwner(
          requestId,
          pendingTurnIdHolder.turnId,
          this.currentStep !== undefined ? "settled" : "cancelled",
        );
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
          // TASK.198 срез C (plan §1.3): the ONE pending recognizer-config
          // commit (if any), applied HERE — the exact "busy=false" boundary
          // the plan names, strictly before every teardown await below.
          // Last-value-wins: a push received while this turn ran overwrote
          // any earlier pending one (Session.applyRecognizerConfig), so
          // there is at most one commit per boundary regardless of how many
          // pushes arrived mid-turn.
          if (this.pendingRecognizerConfig !== undefined) {
            const pending = this.pendingRecognizerConfig;
            this.pendingRecognizerConfig = undefined;
            this.commitRecognizerConfig(pending.endpoint);
          }
        }
        this.abort = null;
        this.turnId = null;
        this.currentStep = undefined;
        this.lastTurnRequest = undefined;
        this.snapshotPaths.clear();
        // TASK.117 acceptance defect 1: the partial-stream checkpoint dies with
        // its turn — a settled turn's streams are finished (or dropped), so a
        // later reconnect's session_checkpoint must not re-open a block for a
        // stream nobody is emitting into anymore.
        this.liveStreams.clear();
        // TASK.117 supervisor correction defect 1: the running-tool set dies
        // with its turn — no call of a settled turn is executing anymore.
        this.runningTools.clear();
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
        this.drainAgentInbox();
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
    if (this.drainAgentInbox(true)) return true;
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
    const childResult = this.childLoopStatus === "error"
      ? { ...this.childFinalText, final: `${this.childSafeError ?? safeFailureMessage("unknown")}\n\n${this.childFinalText.final}` }
      : this.childFinalText;
    let { text: finalText, truncated } = finalizeFinalText(childResult);
    try {
      await this.child.flushHistory();
    } catch (error) {
      // Flush-failure path (§10.10.1 O7б): the durable sink is broken, so
      // running more steer turns against it is pointless — every message
      // parked during the flush is rejected honestly instead of silently
      // lost (the O7 bug), and the error terminal publishes as-is.
      const flushDurationMs = Date.now() - this.childStartedAt;
      this.rejectQueuedSteerMessages();
      this.childTerminalFinalized = true;
      try {
        this.child.onTerminal({
          status: "error",
          finalText: `Child session history failed to persist durably: ${describeError(error)}`,
          truncated: false,
          turns: this.childTurns,
          toolCalls: this.childToolCalls,
          durationMs: flushDurationMs,
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
    // TASK.196 turn-limit rescue: a max_turns child with at least one
    // completed turn and NO report text gets one bounded tool-free wrap-up
    // BEFORE the terminal is latched/published — placed AFTER the steer
    // drain above so a discarded terminal attempt never triggers a second
    // rescue. Never runs when shutting down (no model call may outlive the
    // host) and never revises status/counters.
    //
    // The rescue `await` OPENS a lifecycle gap: a user_message or shutdown
    // can arrive while it is pending, exactly like during `flushHistory`
    // above (§10.10.1 O7). The post-rescue re-check below closes that gap
    // with the SAME drain-or-reject behavior — a queued steer drains into a
    // live turn (returning "drained" discards the stale rescued report; the
    // next settle re-runs this whole method, including a fresh rescue, from
    // the top), and shutdown rejects the queue instead of starting anything.
    if (
      !this.shuttingDown &&
      this.childLoopStatus === "max_turns" &&
      this.childTurns > 0 &&
      finalText.trim().length === 0
    ) {
      const rescued = await this.rescueTurnLimitReport();
      if (rescued !== undefined) {
        const cappedRescue = finalizeFinalText(
          { ...this.childFinalText, final: rescued },
        );
        finalText = cappedRescue.text;
        truncated = cappedRescue.truncated;
      }
      // Post-rescue re-check (TASK.196): mirror of the pre-rescue handling
      // — never latch the terminal while the queue holds an undrained steer
      // or shutdown has begun mid-rescue.
      if (this.shuttingDown) {
        this.rejectQueuedSteerMessages();
      } else if (this.startNextQueuedSteerTurn()) {
        return "drained";
      }
    }
    // Measured AFTER the rescue so the reported duration includes it.
    const durationMs = Date.now() - this.childStartedAt;
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
        ...(this.childFinalTurnFinishReason !== undefined ? { finalTurnFinishReason: this.childFinalTurnFinishReason } : {}),
        ...(this.childDeclaredDoneAtCeiling && this.childLoopStatus === "max_turns" ? { declaredDoneAtCeiling: true } : {}),
      });
    } catch (error) {
      console.error(`[host] child.onTerminal threw: ${describeError(error)}`);
    }
    return "terminal";
  }

  /**
   * TASK.196: resolves the report text for a max_turns child that produced
   * no final text. With a `wrapUpRescue` callback (core-engine children:
   * host/index.ts wires it to core's runWrapUp), awaits it — non-whitespace
   * text is the report; a throw or blank result degrades to the shared
   * failure notice. Without a callback (CLI-engine children: no core loop,
   * no in-process model to run the tool-free wrap-up against), returns the
   * explicit turn-limit notice carrying the child's last activity.
   * Returning undefined is not part of the contract — every caller gets a
   * non-empty report.
   */
  private async rescueTurnLimitReport(): Promise<string> {
    const rescue = this.child?.wrapUpRescue;
    if (rescue === undefined) {
      return childTurnLimitNotice(this.childLastTool);
    }
    try {
      const text = await rescue();
      return text.trim().length > 0 ? text : SUBAGENT_WRAPUP_FAILED_NOTICE;
    } catch {
      return SUBAGENT_WRAPUP_FAILED_NOTICE;
    }
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
        this.childSafeError = undefined;
        break;
      case "error": {
        const wire = sanitizeAgentEvent(event);
        if (wire.type === "error") this.childSafeError = wire.error.message;
        break;
      }
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
        this.childFinalTurnFinishReason = event.finishReason === "length" ? "length" : undefined;
        this.emitChildProgressBoundary();
        break;
      case "loop_end":
        // A child config never receives a WorktreeControlPort (buildChildConfig
        // never sets `ports.worktrees`), so `workspace_transition` cannot
        // actually happen here; treated defensively as an error rather than
        // widening ChildRunStatus, mirroring runner.ts's own precedent.
        this.childLoopStatus = event.reason === "workspace_transition" ? "error" : event.reason;
        this.childTurns += event.turns;
        this.childDeclaredDoneAtCeiling = event.declaredDoneAtCeiling === true;
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
    origin?: "system",
    pendingTurnIdHolder?: { turnId: string },
  ): Promise<void> {
    // TASK.117 phase-1 defect 3: the outer turn UUID is minted by
    // `acceptUserMessage` at ADMISSION (captured there into pendingPrompt,
    // before any await) and threaded in via the holder — runTurn only
    // adopts it here. Continuations (no holder: startContinuation's direct
    // call) never carry a pending prompt.
    const turnId = pendingTurnIdHolder?.turnId ?? randomUUID();
    const controller = new AbortController();
    this.turnId = turnId;
    this.currentStep = undefined;
    this.abort = controller;
    this.turnStartedAt = Date.now();
    this.outbound.emit({ type: "turn_started", requestId, turnId, startedAt: this.turnStartedAt });
    // TASK.117: remember the live turn's requestId for the per-connect
    // turn_started re-assertion (see ui_ready) — the ring copy alone is not
    // survivable past REPLAY_BUFFER_CAP overflow.
    this.lastTurnRequest = { requestId, turnId };
    const publicText = new Map<string, { text: string; truncated: boolean }>();
    let lastCompletedText: { text: string; truncated: boolean } | null = null;
    let nativeTurnId: string | null = null;
    const recordResult = (terminalReason: SessionPublicResult["terminalReason"]) => {
      this.latestPublicResult = { source: "live_turn", turnId, requestId, nativeTurnId, terminalReason, publicAnswer: lastCompletedText?.text ?? null, truncated: lastCompletedText?.truncated ?? false, completedAt: Date.now() };
    };

    try {
      const options = {
        signal: controller.signal,
        ...(attachments?.length ? { attachments } : {}),
        ...(carriesWorktreeExitNotice
          ? { systemContext: worktreeExitSystemContext(this.projectRoot) }
          : {}),
        // TASK.145 срез 2: harmless on the `continueTurn` (text===undefined)
        // branch below — that path never appends a synthetic user frame at
        // all (its own doc comment), so AgentLoop.continueTurn's forwarded
        // `origin` is simply never read.
        ...(origin !== undefined ? { origin } : {}),
        // TASK.117 causal stamp: the outer turn UUID rides into CoreEngine ->
        // AgentLoop so every HistoryItem this turn appends (user frame step 0,
        // assistant/tool items per inner step ordinal, cancelled stragglers
        // included) carries {turnId, step}. Foreign engines ignore it.
        ...(this.engine.id === "core" ? { turnId } : {}),
      };
      const stream = text === undefined ? this.engine.continueTurn?.(options) : this.engine.runTurn(text, options);
      if (stream === undefined) {
        throw new Error("active engine cannot continue a relocated turn");
      }
      let noticeConsumeAttempted = false;
      for await (const event of stream) {
        nativeTurnId ??= this.engine.steeringStatus?.().nativeTurnId ?? null;
        if (event.type === "text_start") publicText.set(event.id, { text: "", truncated: false });
        if (event.type === "text_delta") {
          const current = publicText.get(event.id) ?? { text: "", truncated: false };
          const combined = current.text + event.text;
          current.text = combined.slice(0, 32000); current.truncated ||= combined.length > 32000;
          publicText.set(event.id, current);
        }
        if (event.type === "text_end") {
          const complete = publicText.get(event.id);
          if (complete?.text) lastCompletedText = { ...complete };
          publicText.delete(event.id);
        }
        if (event.type === "finish" && event.finishReason !== "error") {
          // Core providers can finish a text stream without a separate text_end.
          for (const complete of publicText.values()) if (complete.text) lastCompletedText = { ...complete };
          publicText.clear();
        }
        if (event.type === "loop_end") recordResult(event.reason);
        // TASK.159: the foreign-engine telemetry seam — see SessionOptions.
        // eventTap's own doc/invariant comment. Fires for every event this
        // loop observes (covers continueTurn too, since it drives the same
        // for-await), before any other per-event handling below, and never
        // allowed to affect the turn.
        try {
          this.eventTap?.(event);
        } catch (error) {
          console.error(`[host] eventTap failed: ${describeError(error)}`);
        }
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
        const wireEvent = sanitizeAgentEvent(event);
        // TASK.117: track the inner request ordinal (core's turn_start.turn,
        // reset per outer turn) and stamp it onto the envelope for core
        // turns — the renderer's fold checkpoint keys events and durable
        // history items by `${turnId}:${step}`.
        if (event.type === "turn_start") {
          this.currentStep = event.turn;
          // TASK.117 phase-1 defect 3: the FIRST core turn_start of the turn
          // owning the pending slot hands ownership to DURABILITY — core
          // appends the user frame strictly BEFORE the first model request,
          // so generation starting proves the frame landed. Exact-owner
          // check (turnId): a stale foreign/older event can never clear a
          // newer turn's prompt. The renderer keeps its bubble as the live
          // rendering record (host field cleared; no wire push here).
          if (this.engine.id === "core" && this.pendingPrompt !== null && this.pendingPrompt.turnId === turnId) {
            this.pendingPrompt = null;
          }
        }
        this.outbound.emit({
          type: "agent_event",
          turnId,
          ...(this.engine.id === "core" && this.currentStep !== undefined ? { step: this.currentStep } : {}),
          event: wireEvent,
        });
        if (this.child !== undefined) {
          this.observeChildEvent(event);
        }
        if (event.type === "error") {
          // TASK.2 DoD-c: the raw provider failure reaches the process log
          // (stdio:"inherit" -> app log), not only the transcript block.
          if (wireEvent.type === "error") {
            console.error(`[host] provider stream error: ${wireEvent.error.code ?? "unknown"}`);
            recordErrorDiagnostic(process.env.ANYCODE_DIAGNOSTICS_DIR, this.sessionId, wireEvent.error.code ?? "unknown", event.safe?.statusCode);
          }
          // TASK.45 W11: relay the core loop's OWN classification (event.safe.code)
          // verbatim — never reclassified here. Absent `safe` (a legacy/foreign
          // producer) defaults to "unknown" rather than dropping the signal.
          this.reportProviderHealth?.({ kind: "failure", code: event.safe?.code ?? "unknown" });
        }
        // TASK.117 control/accounting checkpoint: capture the wire state AT
        // EMISSION TIME (before any ring cap/cut could evict it). Core-only:
        // a finish's usage sums onto the cumulative session totals (mirrors
        // the renderer's accumulateSessionTokens — the checkpoint REPLACES a
        // fresh store's slot with exactly this, so the same finish can never
        // double-count across a reconnect), and a context_usage reading is a
        // latest-wins scalar. History items carry no usage fields, so after a
        // ring overflow this host-side capture is the only surviving record.
        if (this.engine.id === "core" && event.type === "finish") {
          this.checkpointSessionTokens = accumulateCheckpointTokens(this.checkpointSessionTokens, event.usage);
          // Newest-first; trimmed to the bounded window (an entry older
          // than the ring capacity can never replay again).
          if (this.currentStep !== undefined) {
            this.checkpointCountedSteps.unshift(`${turnId}:${this.currentStep}`);
            if (this.checkpointCountedSteps.length > CHECKPOINT_COUNTED_STEPS_MAX) {
              this.checkpointCountedSteps.length = CHECKPOINT_COUNTED_STEPS_MAX;
            }
          }
        }
        if (this.engine.id === "core" && event.type === "context_usage") {
          this.checkpointContextUsage = {
            estimatedTokens: event.estimatedTokens,
            budgetTokens: event.budgetTokens,
            source: event.source,
          };
        }
        // TASK.117 acceptance defect 1: fold the partial-stream checkpoint AT
        // EMISSION TIME (before any ring cap could evict the stream's
        // text_start). One Map entry per OPEN stream, keyed by the same
        // `${turnId}:${step}:${streamId}` scope the renderer's
        // openStreamBlocks uses; the value accumulates the FULL body so a
        // reconnecting renderer can re-open the block and REPLACE with the
        // complete partial (never re-append the already-streamed prefix).
        // text_end/reasoning_end delete the entry below — only genuinely
        // unfinished streams ride the checkpoint.
        if (this.engine.id === "core" && this.currentStep !== undefined) {
          if (event.type === "text_start") {
            this.liveStreams.set(`${turnId}:${this.currentStep}:${event.id}`, { turnId, step: this.currentStep, streamId: event.id, kind: "text", text: "" });
          } else if (event.type === "text_delta") {
            const entry = this.liveStreams.get(`${turnId}:${this.currentStep}:${event.id}`);
            if (entry !== undefined) {
              entry.text += event.text;
            }
          } else if (event.type === "text_end") {
            // TASK.117 acceptance defect 3: do NOT delete on text_end — core
            // appends the assistant item only AFTER the model stream's finish
            // settles, so a reconnect inside that gap would otherwise see no
            // checkpoint stream AND no durable item (and no ring text_start
            // after >CAP): the fully-streamed text vanished. The entry rides
            // until its step becomes DURABLE (pushSessionCheckpoint filters
            // against engine history) or the turn's teardown clears it.
            const endedText = this.liveStreams.get(`${turnId}:${this.currentStep}:${event.id}`);
            if (endedText !== undefined) {
              endedText.settled = true;
            }
          } else if (event.type === "reasoning_start") {
            this.liveStreams.set(`${turnId}:${this.currentStep}:${event.id}`, { turnId, step: this.currentStep, streamId: event.id, kind: "reasoning", text: "" });
          } else if (event.type === "reasoning_delta") {
            const entry = this.liveStreams.get(`${turnId}:${this.currentStep}:${event.id}`);
            if (entry !== undefined) {
              entry.text += event.text;
            }
          } else if (event.type === "reasoning_end") {
            // TASK.117 acceptance defect 3: same retention as text_end above
            // — completed reasoning is never a durable item of its own; only
            // the assistant append (after finish) makes the step durable.
            const endedReasoning = this.liveStreams.get(`${turnId}:${this.currentStep}:${event.id}`);
            if (endedReasoning !== undefined) {
              endedReasoning.settled = true;
            }
          }
        }
        if (event.type === "finish") {
          // TASK.45 W11: a model step that reached a finish reason completed a
          // real request against the pinned connection's credential/endpoint.
          this.reportProviderHealth?.({ kind: "success" });
        }
        // TASK.117 supervisor correction defect 1: fold the running-tool set AT
        // EMISSION TIME (before any ring cap could evict the start event) —
        // added on tool_execution_start, removed on its paired tool_result, so
        // the set always reads "executing right now" at any later checkpoint
        // push. Mirrors the liveStreams/checkpoint fields' capture discipline.
        if (this.engine.id === "core" && event.type === "tool_execution_start") {
          this.runningTools.set(event.toolCallId, true);
        }
        if (this.engine.id === "core" && event.type === "tool_result") {
          this.runningTools.delete(event.outcome.toolCallId);
        }
        if (event.type === "tool_result") {
          await this.emitAfterSnapshot(event.outcome);
          this.previewArtifacts.observeResult(event.outcome);
        }
      }
    } catch (error) {
      // runTurn is designed never to throw (it maps failures to loop_end), so
      // this is a defensive net; the host must not crash on a rogue turn.
      recordResult("error");
      this.outbound.emit({ type: "fatal", message: `turn failed: ${describeError(error)}` });
    }
  }

  private async startContinuation(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.onContinuationReady?.();
      if (this.continuationMode === "model") {
        // TASK.117: a continuation has NO prompt — clear any stale pending
        // state BEFORE the first turn_start of the resumed segment.
        // "cancelled": nothing is in flight; retire any bubble outright.
        this.pendingPrompt = null;
        this.pushPendingPrompt("cancelled");
        await this.runTurn(randomUUID(), undefined);
      }
      if (!this.relocating) {
        await this.onContinuationComplete?.();
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.turnId = null;
      this.currentStep = undefined;
      this.lastTurnRequest = undefined;
      this.snapshotPaths.clear();
      this.liveStreams.clear();
      // TASK.117 supervisor correction defect 1: same teardown bound as
      // acceptUserMessage's — the running set never outlives its turn.
      this.runningTools.clear();
      this.flushPreviewArtifacts();
      this.currentTurn = null;
      this.drainAgentInbox();
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
    for (const envelope of this.agentInbox.splice(0)) this.publishAgentDelivery({ envelope, state: "rejected", detail: "Cancelled by Stop before queued delivery" });
    if (this.abort) {
      this.abort.abort();
    }
    // TASK.117: cancel is a terminal boundary for the pending prompt — the
    // turn's teardown will also clear it, but clearing HERE covers the
    // pre-append window (UserPromptSubmit hook await) where no teardown has
    // started yet... teardown runs regardless; this early clear keeps a
    // reconnect mid-cancel from resurrecting the bubble. "cancelled": the
    // frame may never have become durable — the bubble must be retired, not
    // kept as a rendering record.
    this.pendingPrompt = null;
    this.pushPendingPrompt("cancelled");
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
   * Live recognizer-config push from main (TASK.198 срез C, plan §1.3):
   * called by host/index.ts's parentPort handler on every
   * `RecognizerConfigChanged`. Applies immediately while idle; while a turn
   * is running, stashes it as the ONE pending value (overwriting any earlier
   * pending push — last-write-wins) and defers the actual commit to the very
   * next busy->idle boundary (this class's own teardown, strictly before any
   * await there). A session with no wiring at all (codex/claude engine
   * boots, and every pre-existing test) is a safe no-op — the plan's
   * "codex/claude НЕ задеты (замыкание не установлено)".
   */
  applyRecognizerConfig(endpoint: RecognizerEndpoint | null): void {
    if (this.applyRecognizerConfigImpl === undefined) {
      return;
    }
    if (this.busy) {
      this.pendingRecognizerConfig = { endpoint };
      return;
    }
    this.commitRecognizerConfig(endpoint);
  }

  /**
   * Runs the host-owned apply (swap the endpoint, (de)register InspectImage,
   * recompose the prompt when needed — host/index.ts) and, ONLY after that
   * commit actually lands, emits `image_fallback_changed` with the FULL
   * live verdict re-read post-commit (never a bare echo of `endpoint`'s
   * presence on the wire) — mirrors `model_changed`'s own re-read of
   * `imageInputEnabled` after `switchModelImpl` has already run.
   */
  private commitRecognizerConfig(endpoint: RecognizerEndpoint | null): void {
    this.applyRecognizerConfigImpl!(endpoint);
    this.outbound.emit({
      type: "image_fallback_changed",
      imageFallback: this.imageFallbackAvailable?.() === true,
    });
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
 * last `maxItems` (+truncated). Returns null for an empty snapshot (nothing to
 * hydrate). `maxItems` is `SESSION_HISTORY_MAX_ITEMS` unless the composition
 * root resolved a dev/automation override (TASK.188 S4, Session.historyMaxItems).
 */
/**
 * TASK.117 control/accounting checkpoint: SUMs one core `finish` AgentEvent's
 * TokenUsage onto the host-side cumulative totals — the EXACT semantics of
 * the renderer's `accumulateSessionTokens` (store.ts), duplicated host-side
 * by design: durable history carries no usage fields, so after a replay-ring
 * overflow this accumulation is the only surviving record of what a fresh
 * store must start from (the session_checkpoint REPLACES the fresh store's
 * slot with this value; live finishes after the reconnect then stay
 * exactly-once on top of it). Missing TokenUsage fields count as 0; `total`
 * prefers the provider's own total when present, else input+output.
 */
function accumulateCheckpointTokens(
  prev: { input: number; output: number; total: number; latestCacheRead?: number; latestCacheInput?: number } | null,
  usage: TokenUsage,
): { input: number; output: number; total: number; latestCacheRead?: number; latestCacheInput?: number } {
  const base = prev ?? { input: 0, output: 0, total: 0 };
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  return {
    input: base.input + input,
    output: base.output + output,
    total: base.total + total,
    ...(usage.cachedInputTokens !== undefined
      ? { latestCacheRead: usage.cachedInputTokens, latestCacheInput: input }
      : {}),
  };
}

function buildSessionHistory(
  bootHistory: readonly HistoryItem[],
  maxItems: number,
): { items: WireHistoryItem[]; truncated: boolean } | null {
  if (bootHistory.length === 0) {
    return null;
  }
  const truncated = bootHistory.length > maxItems;
  const kept = truncated ? bootHistory.slice(-maxItems) : bootHistory;
  const items: WireHistoryItem[] = kept.map((item) => ({
    id: item.id,
    createdAt: item.createdAt,
    ...(item.kind !== undefined ? { kind: item.kind } : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
    // TASK.117 phase-1 defect 2: the causal stamps ride verbatim — the
    // renderer decides from the HANDSHAKE's engine discriminator whether
    // they mean durable coverage (core) or are inert hydration data (a
    // native host's fixed boot snapshot may carry stamped items through the
    // shared projection), never from the stamps' presence/absence alone.
    ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
    ...(item.step !== undefined ? { step: item.step } : {}),
    message: item.message,
  }));
  return { items, truncated };
}

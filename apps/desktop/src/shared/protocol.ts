/**
 * Wire protocol between the sandboxed renderer and the host utilityProcess
 * (design/phase-mvp.md §3). FROZEN by task MVP.1 — do not change shapes here
 * without going back through the architect; MVP.2-5 all build against this
 * file as their only shared contract (together with the store shape in
 * renderer/src/store.ts).
 *
 * Principle: we do not invent a second vocabulary. The core's `AgentEvent`
 * travels to the renderer as-is, inside an envelope. The only transformation
 * is sanitizing the non-serializable (`error: unknown` -> `SerializedError`)
 * so every message is structured-clone-safe (in practice JSON-safe).
 *
 * NOTE (deviation from the literal §3 snippet): in addition to the type-only
 * imports mandated by the design, this file also imports `PERMISSION_MODES`
 * as a *value* from `@anycode/core` to build the `set_mode`/`permission_request`
 * zod schemas without hand-duplicating the mode literal list (which would
 * drift silently if core ever adds/removes a mode). This is a deliberate,
 * narrow exception: it stays safe for the renderer bundle because renderer
 * code only ever imports the *types* from this file (`import type`), which
 * `verbatimModuleSyntax` guarantees are erased — the zod schemas (and this
 * value import) are only ever pulled in at runtime by the host (MVP.3).
 *
 * Wave-1 revision (architect, see working-docs/build/reviews/
 * mvp-wave1-forks.md): NO wire message shapes changed. The control-plane
 * window-message envelopes (`anycode:port` / `anycode:host-exited`) are
 * fixed in the sibling value-only module shared/envelopes.ts — they must
 * NOT live here, precisely because of the runtime imports above (a value
 * import of this file from the renderer would drag zod + the core barrel
 * into the web bundle).
 */
import { z } from "zod";
import { PERMISSION_MODES } from "@anycode/core";
import type {
  AgentEvent,
  BackgroundTaskSnapshot,
  ChatMessage,
  CodexRateLimitsWire,
  CommandHookDeclaration,
  ImageAttachment,
  ImageMediaType,
  McpServerStatus,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  SideEffectScope,
  TelemetryStatus,
} from "@anycode/core";
import type { LspServerStatus } from "@anycode/core";
import type { EngineId } from "./engines.js";
import type { UsageLimitNotice } from "./usage-limit.js";
// Slice 5.7 (design slice-5.7-cut.md §2.1): git-domain types for the additive
// git wire surface. Type-only (verbatimModuleSyntax erases them from the renderer
// bundle — hard requirement, see this file's header). They ride the ports barrel
// (@anycode/core -> ports/index.ts) and are the frozen shapes GitPort already speaks.
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitDiffTarget,
  GitFileChange,
  GitHead,
  GitStatusSummary,
} from "@anycode/core";

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * UI-safe, immutable engine feature verdicts. External engines own their own
 * loop and policy, so this is a presentation/gating projection rather than a
 * promise that AnyCode's core services exist for the session.
 */
export interface EngineCapabilitiesProjection {
  supportsCorePermissions: boolean;
  supportsRewind: boolean;
  supportsWorkflow: boolean;
  supportsGitMutations: boolean;
  supportsContextUsage: boolean;
  supportsContextBreakdown: boolean;
  supportsInteractiveApprovals: boolean;
  costAccounting: boolean;
  supportsModelSelection: boolean;
  supportsReasoningEffort: boolean;
  supportsImages: boolean;
  supportsTasks: boolean;
  supportsFileSnapshots: boolean;
}

/** One selectable model choice for a non-core engine's draft/mid-session picker (TASK.39, cut §3.1). */
export interface EngineModelChoice {
  id: string;
  label?: string;
  efforts?: string[];
}

/** One selectable permission posture for a non-core engine (TASK.39, cut §3.1) — engine-side table, never a raw config payload from the renderer. */
export interface EnginePermissionPreset {
  id: string;
  label: string;
  description: string;
}

/**
 * Omitted for legacy core sessions so their historical host_ready wire stays
 * exact. `model`/`permissions` (codex-fixes TASK.39, cut §3.1) are additive
 * and optional: absent for core (and for any engine that has not yet wired a
 * model/preset catalog) so this projection's core wire shape is unchanged.
 *
 * `account`/`quota` (codex-profiles cut §3.5) are ALSO additive-optional, for
 * the same reason: absent for core and for any engine that has not wired
 * account/quota reporting.
 */
export interface EnginePresentation {
  id: EngineId;
  capabilities: EngineCapabilitiesProjection;
  model?: { current: string; available: EngineModelChoice[] };
  permissions?: { presets: EnginePermissionPreset[]; activePresetId: string };
  /**
   * What to show in the account chip (cut §3.5/§4.4 custody): `label` is the
   * human-editable profile label, NEVER the sole identifier; e-mail (when
   * present on the underlying `CodexAccount`) is a display-time concern of
   * the consuming UI, not carried here — this projection intentionally omits
   * it so the wire shape itself cannot leak it by construction.
   */
  account?: { label: string; kind: string; plan?: string };
  /** Starting quota snapshot (cut §3.5/§6.1); live updates arrive as `engine_quota` AgentEvents. */
  quota?: CodexRateLimitsWire;
}

/**
 * Shell (AnyCode UI chrome) capabilities, independent of the agent-runtime
 * capabilities above (codex-fixes TASK.40, cut §3.2/§2(f)). Emitted ONLY
 * alongside a present `host_ready.engine` (i.e. never for core — core wire
 * stays byte-identical by construction); a renderer that sees no `shell`
 * field treats every shell feature as enabled (legacy core behavior).
 */
export interface ShellCapabilitiesProjection {
  /** status / diff / Review / Environment panels. */
  gitReadOnly: boolean;
  /** user-triggered commit/branch/stage UI. */
  gitUserMutations: boolean;
  terminal: boolean;
}

/**
 * AgentEvent after sanitization: the {type:"error"} variant carries a
 * SerializedError built EXCLUSIVELY from the core event's redacted `safe`
 * descriptor (TASK.33 W7b-FIX #2) — the raw error never crosses. `retry`
 * (TASK.33 W8) rides through unchanged from the core event. `notice`
 * (W7b-FIX #2) is the numbers-only usage_limit descriptor the host parses from
 * the raw message at the wire boundary, because the redacted `error.message`
 * the renderer now receives no longer carries the parseable z.ai text. All
 * three fields are additive-optional.
 */
export type WireAgentEvent =
  | Exclude<AgentEvent, { type: "error" }>
  | {
      type: "error";
      error: SerializedError;
      retry?: { attemptsMade: number; maxAttempts?: number; retryable: boolean; hadModelOutput: boolean; code: string };
      notice?: UsageLimitNotice;
    };

/** UI-safe subset of ToolMetadata (flat data only, no schemas/handlers). */
export interface WireToolMeta {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  riskLevel: RiskLevel;
  sideEffectScope: SideEffectScope;
}

/**
 * One persisted history item projected for transcript hydration of a resumed
 * session (design/phase-2.md §3.3). The in-memory replay ring buffer (`Outbound`)
 * is empty on a fresh host, so the persistent history — model-level
 * `HistoryItem[]`, not `AgentEvent` — is shipped as its own message rather than
 * a faked replay. `message` is JSON-safe by construction of Phase 1 (invalid
 * input was sanitized to `{}` before it was written, phase-1 §2.9).
 */
export interface WireHistoryItem {
  id: string;
  createdAt: number;
  kind?: "normal" | "compact_summary" | "microcompact_cleared";
  message: ChatMessage; // type-only import from core; erased from the renderer bundle
}

// ─────────────────────────────────────────────────────────────────────────
// ── git (slice 5.7) ── GUI-git desktop-core wire surface.
// Additive by the mcp_status precedent: three new top-level wire variants
// (git_command ui->host under zod; git_status/git_result host->ui). Destructive
// operations (discard/stash/reset/force) are NOT expressible by construction —

// ─────────────────────────────────────────────────────────────────────────

/** Cap on EACH of the three status lists (staged/unstaged/untracked) shipped on the wire. */
export const GIT_STATUS_MAX_FILES = 1_000;
/** Cap on the diff text carried in one git_result (chars). */
export const GIT_WIRE_DIFF_MAX_CHARS = 500_000;

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const satisfies readonly ImageMediaType[];
const _imageMediaTypeExhaustive: [Exclude<ImageMediaType, (typeof IMAGE_MEDIA_TYPES)[number]>] extends [never]
  ? true
  : never = true;
void _imageMediaTypeExhaustive;
const IMAGE_MAX_BYTES = 3_750_000;
const IMAGE_MAX_PER_MESSAGE = 8;
const IMAGE_BASE64_MAX_CHARS = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 4;

/** renderer -> host: one git command. Slice 5.7 shipped the non-destructive set;
 *  slice 5.8 adds the destructive tail (below), each expressible ONLY with `confirmed: true`. */
export type GitCommand =
  | { op: "refresh" }
  | { op: "branches" }
  | { op: "log"; limit?: number }
  | { op: "diff"; target?: GitDiffTarget; path?: string }
  | { op: "switch_branch"; name: string }
  | { op: "create_branch"; name: string; switch?: boolean }
  | { op: "stage"; paths: string[] }
  | { op: "unstage"; paths: string[] }
  | { op: "stage_all" }
  | { op: "commit"; message: string }
  // ── destructive tail (slice 5.8, design slice-5.8-cut.md §2.3): expressible ONLY with

  | { op: "discard"; paths: string[]; confirmed: true }
  | { op: "stash_push"; message?: string; includeUntracked?: boolean; confirmed: true }
  | { op: "stash_pop"; confirmed: true }
  | { op: "reset"; mode: "mixed" | "hard"; confirmed: true };

/**
 * Projection of {@link GitStatusSummary} with caps: the three lists are truncated
 * to {@link GIT_STATUS_MAX_FILES} each, but `dirtyCount` is the TRUE total BEFORE
 * the cap and `filesTruncated` flags whether any list was trimmed.
 */
export interface WireGitStatus {
  head: GitHead;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  dirtyCount: number;
  filesTruncated: boolean;
}

/** host -> renderer: the result of one git_command, discriminated by ok/kind. */
export type GitCommandOutcome =
  | { ok: false; reason: string }
  | { ok: true; kind: "unit" } // switch/create/stage/unstage/stage_all
  | { ok: true; kind: "branches"; branches: GitBranchInfo[] }
  | { ok: true; kind: "log"; commits: GitCommitInfo[] }
  | { ok: true; kind: "diff"; diff: string; truncated: boolean }
  | { ok: true; kind: "commit"; sha: string };

// ─────────────────────────────────────────────────────────────────────────
// ── env status (slice P7.8) ── telemetry + repo-map read-only status surface.
// Additive by the mcp_status/git_status precedent: one trusted host->ui
// composite variant, no zod (both statuses come from the same host process,
// no untrusted input). `null` per-field means the corresponding feature is
// disabled (opt-in via .anycode/config.json) — not an error.
// ─────────────────────────────────────────────────────────────────────────

/** Repo-map status projection: `TelemetryStatus` (core) is reused as-is (flat, JSON-safe). */
export interface WireRepoMapStatus {
  fileCount: number; // ext.repoMapFiles.length (discovered)
  includedCount: number; // fileCount - omittedCount (made it into the prompt)
  truncated: boolean;
  maxTokens: number; // effective budget (post-clamp)
}

/** null = telemetry disabled (opt-in). Reuses core TelemetryStatus — flat by construction. */
export interface WireEnvStatus {
  telemetry: TelemetryStatus | null;
  repoMap: WireRepoMapStatus | null; // null = repo-map disabled
}

// ─────────────────────────────────────────────────────────────────────────
// ── ctx-breakdown (slice P7.17 · F12) ── per-category context-token surface
// for the ctx-meter hover popover. Additive by the model_changed precedent
// (emitted ONLY in response to a request ⇒ byte-locked replay/automation
// snapshots of legacy flows are untouched by construction, design §2.2/§4).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Flat JSON-safe mirror of core `ContextBreakdown` (loop/agent-loop.ts). All six
 * leaves are provider-anchored shares that sum EXACTLY to totalEstimatedTokens
 * (the same number the ctx-ring headline reports). Percentages are computed in
 * the renderer (tokens / totalEstimatedTokens); core ships raw counts only.
 */
export interface WireContextBreakdown {
  messagesTokens: number;
  systemToolsTokens: number;
  mcpToolsTokens: number;
  skillsTokens: number;
  systemPromptTokens: number;
  metaTokens: number;
  totalEstimatedTokens: number;
}

// ─────────────────────────────────────────────────────────────────────────
// ── checkpoints / rewind (slice P7.26 · R2) ── timeline + /rewind wire surface.
// On-demand only, exactly like context_breakdown (§2.4): the host->ui variants
// (checkpoint_list / rewind_result) are emitted ONLY in response to a request,
// so no legacy/byte-locked replay or automation snapshot carries one. The ui->host
// direction is untrusted -> validated by zod below (fail-closed).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Wire projection of core `CheckpointMeta` (design slice-P7.26-cut.md §2.5):
 * drops `sessionId` (implicit — the session owns its own list) and `commitHash`
 * (prefix resolution is CLI-only; the wire always carries the full `id`). Age is
 * computed renderer-side from `createdAt`.
 */
export interface WireCheckpointMeta {
  id: string;
  label: string;
  createdAt: number; // epoch ms
  reason: "auto" | "pre-rewind";
}

/** Scope of a rewind: files, conversation, or both (mirror of core RewindScope). */
export type RewindScopeWire = "both" | "files" | "conversation";

// ── renderer -> host ──
export type UiToHostMessage =
  | { type: "ui_ready" } // handshake; host replies host_ready + replay
  | { type: "user_message"; requestId: string; text: string; images?: ImageAttachment[] } // starts a turn
  | { type: "cancel_turn" } // abort the in-flight turn
  | { type: "exit_worktree"; cleanup: "auto" | "keep" }
  | {
      type: "permission_response";
      requestId: string;
      behavior: "allow" | "deny";
      updatedInput?: unknown;

      // on an "allow", the host adds a rule (toolName from the pending ask) with
      // the given pattern. Optional -> the old renderer stays valid; the host
      // ignores this field until 2.2.3 (no-op by construction).
      remember?: { pattern?: string };
    } // MVP UI only ever sends allow/deny (no input editing); 2.2 adds optional `remember`
  | { type: "set_mode"; mode: PermissionMode } // only valid between turns
  | { type: "set_reasoning_effort"; effort: ReasoningEffort }
  // Slice P7.15 (F14): mid-session model switch (mirror of the CLI `/model`
  // re-budget, host-side switch not a respawn). Untrusted -> validated by
  // `setModelSchema` below (fail-closed). Honored only between turns (Session
  // silently drops it while busy, mirroring set_reasoning_effort).
  | { type: "set_model"; model: string }
  // Codex-fixes TASK.39 (cut §3.3): switch a non-core engine's permission
  // posture. Mirrors set_model's between-turns discipline (a pending-override
  // the engine applies to the NEXT turn/start, cut §2(d)) — untrusted ->
  // validated by `setEnginePresetSchema` below (fail-closed); host-authoritative
  // membership check against the engine's own preset table happens at route()
  // time, never a raw config payload from the renderer.
  | { type: "set_engine_preset"; presetId: string }
  // Slice 5.7 (design slice-5.7-cut.md §2.1): one user-initiated git command.
  // Untrusted -> validated by `gitCommandMessageSchema` below (fail-closed). NO

  | { type: "git_command"; requestId: string; command: GitCommand }
  // Renderer Panels sub-slice A: read-only LSP server-status request.
  | { type: "lsp_status_request" }
  // Slice P7.17 (F12, design §2.2): read-only per-category context-token
  // breakdown request. Mirror of lsp_status_request — payload-less, served even
  // mid-turn (contextBreakdown() is a pure read). Sent only when the ctx-meter
  // popover opens.
  | { type: "context_breakdown_request" }
  // Renderer Panels sub-slice D: background-task list/output/kill controls.
  | { type: "task_list_request" }
  | { type: "task_output_request"; taskId: string }
  | { type: "task_kill_request"; requestId: string; taskId: string; confirmed: true }
  // Slice P7.26/R2 (design slice-P7.26-cut.md §4-7): read-only checkpoint-list
  // request (mirror of lsp_status_request — payload-less, served even mid-turn:
  // list() is a pure store read). Sent when the timeline panel opens.
  | { type: "checkpoint_list_request" }
  // Slice P7.26/R2: rewind this session to a checkpoint. Untrusted -> validated by
  // `rewindRequestSchema` below (fail-closed). Honored only between turns (Session
  // busy-rejects WITH a rewind_result reply while a turn runs, unlike set_model's
  // silent drop — the timeline needs a non-silent refusal).
  | { type: "rewind_request"; requestId: string; checkpointId: string; scope: RewindScopeWire };

// ── host -> renderer ──
export interface WorktreeProjection {
  id: string;
  path: string;
  branch: string;
  baseRef: string;
  ownedByAnyCode: boolean;
}

export type HostToUiMessage =
  // Phase-2 §3.3: `sessionId` added (host knows it at boot); renderer binds the
  // tab to its session (badge, picker annotation). Additive on the wire.
  | {
      type: "host_ready";
      workspace: string;
      /** Stable project identity; differs from workspace while a worktree is active. */
      projectRoot?: string;
      /** Present only while this session is executing inside a git worktree. */
      worktree?: WorktreeProjection;
      mode: PermissionMode;
      model: string;
      sessionId: string;
      reasoningEffort?: ReasoningEffort;
      availableEffortLevels?: ReasoningEffort[];
      /**
       * TASK.56 W2: live image-input verdict for the CURRENT model (Session's
       * `imageInputEnabled` closure over the active model). A MODEL-level fact,
       * not an engine capability, so it rides beside the `engine` block rather
       * than inside EngineCapabilitiesProjection (`engine.capabilities.
       * supportsImages` stays the engine-level verdict). Additive + optional:
       * absent (older host / no seam wired) means the renderer applies no
       * model-level attachment gating — exactly the pre-TASK.56 behavior.
       */
      imageInput?: boolean;
      /** Present only for a non-core engine; absent retains legacy core wire exactly. */
      engine?: EnginePresentation;
      /** Present only alongside `engine` (never for core, cut §3.2/§2(f)); absent = every shell feature enabled. */
      shell?: ShellCapabilitiesProjection;
    }
  // Phase-2 §3.3: transcript hydration of a resumed session. Emitted per
  // ui_ready AFTER host_ready and BEFORE Outbound.replay(), only when the boot
  // history is non-empty. The renderer mapping into transcript blocks is task
  // 2.1.5; task 2.1.1 adds only the type + a no-op reducer branch.
  | { type: "session_history"; sessionId: string; items: WireHistoryItem[]; truncated: boolean }
  | { type: "worktree_notice"; message: string }
  | { type: "turn_started"; requestId: string; turnId: string }
  | { type: "turn_rejected"; requestId: string; reason: "busy" | "not_ready" | "unsupported_images" }
  | { type: "agent_event"; turnId: string; event: WireAgentEvent }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      input: unknown;
      mode: PermissionMode;
      metadata: WireToolMeta;
    }
  | {
      type: "permission_settled";
      requestId: string;
      behavior: "allow" | "deny";
      origin: "ui" | "timeout" | "turn_cancelled" | "disconnect" | "shutdown";
    }
  | {
      type: "file_snapshot";
      toolCallId: string;
      path: string;
      phase: "before" | "after";
      content: string | null;
      truncated: boolean;
    } // content:null = unreadable / too large
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "reasoning_effort_changed"; effort: ReasoningEffort; availableEffortLevels?: ReasoningEffort[] }
  // Slice P7.15 (F14): host acknowledges a `set_model` switch (trusted, no zod,
  // precedent mode_changed/reasoning_effort_changed). `reasoningEffort` is the
  // effort re-resolved for the NEW model (collapses to "off" on a non-reasoning
  // model); `availableEffortLevels` is absent when the new model is not
  // reasoning-capable (the UI then hides the effort segment). Emitted ONLY in
  // response to a `set_model` — no legacy/byte-locked flow sends one, so the
  // automation byte-snapshots stay untouched (design slice-P7.15-cut.md §2.5).
  // `imageInput` (TASK.56 W2, additive + optional, precedent
  // availableEffortLevels): the live image-input verdict re-read for the NEW
  // model, so the renderer can re-gate attachments upfront on a mid-session
  // vision -> non-vision switch. Absent (older host) = no model-level gating.
  | {
      type: "model_changed";
      model: string;
      reasoningEffort: ReasoningEffort;
      availableEffortLevels?: ReasoningEffort[];
      imageInput?: boolean;
    }
  | { type: "mode_change_rejected"; reason: string }
  // Codex-fixes TASK.39 (cut §3.3): host acknowledges a `set_engine_preset` or a
  // `set_model` for an engine with native controls — trusted, no zod, precedent
  // mode_changed/model_changed. `appliesFrom:"next_turn"` is the ONLY value today
  // (cut §2(d): preset/model changes apply to the next turn/start, never
  // mid-turn); a literal, not a boolean, so a future immediate-apply variant is
  // addable without breaking this shape. No legacy/byte-locked flow emits one
  // (core never builds an EnginePresentation with `permissions`), so
  // automation/replay snapshots stay byte-identical.
  //
  // `state` (additive, optional — B2-host carve-out) makes the ack TWO-PHASE,
  // because the app-server has no ack channel of its own: it never sends a
  // settings-updated notification (live fact L6), so there is nothing to relay.
  //   "pending" — the host validated the choice and recorded it; nothing has been
  //               sent to the server yet and the session still runs the old one.
  //   "applied" — a `turn/start` carrying the new values was ACCEPTED by the
  //               server. That acceptance is the only honest confirmation that
  //               exists; a phantom notification must never be invented for it.
  // Optional so an older renderer (and any future engine that applies settings
  // immediately) stays valid without it.
  | {
      type: "engine_settings_changed";
      model?: string;
      activePresetId?: string;
      state?: "pending" | "applied";
      appliesFrom: "next_turn";
    }
  // Phase 4 slice 4.4-T (design feature-session-titles.md §4): emitted once
  // the heuristic derives a title from the first user message, and again if
  // the async tier-2 LLM refinement upgrades it. Like `mode_changed` above,
  // this host->renderer direction is trusted and carries no zod schema (only
  // the untrusted UiToHostMessage direction is validated).
  | { type: "title_changed"; title: string }
  // Slice 3.2 (design slice-3.2-cut.md §3.5): MCP server status snapshot. Host
  // emits it on status change and on UI bind (host sends the current snapshot,
  // mirroring the host_ready cascade). Sending/consuming is task 3.2.4; this
  // task adds only the additive variant. `McpServerStatus` is flat, serializable
  // data (strings/numbers/booleans), so no sanitizer branch is needed. Like the
  // other HostToUiMessage variants, this host->renderer direction is trusted and
  // carries no zod schema (only the untrusted UiToHostMessage direction does).
  | { type: "mcp_status"; servers: McpServerStatus[] }

  // git surface (no zod schema, mirror of mcp_status). `git_status` is buffered +
  // replayed and re-pushed on UI bind, so it survives a renderer reload; `status:
  // null` means git is unavailable in this workspace (not a git repository).
  // `git_result` is an ephemeral request/response (sendDirect only — it never
  // enters the replay ring buffer, so large diffs cannot balloon host memory).
  | { type: "git_status"; status: WireGitStatus | null }
  | { type: "git_result"; requestId: string; outcome: GitCommandOutcome }
  // Renderer Panels sub-slice A: trusted snapshot of LspManager.status().
  | { type: "lsp_status"; servers: LspServerStatus[] }
  // Renderer Panels sub-slice B: trusted static command-hook config list.
  | { type: "hooks_list"; hooks: CommandHookDeclaration[]; configError?: string }
  // Renderer Panels sub-slice D: trusted background-task snapshots and output chunks.
  | { type: "task_list"; tasks: BackgroundTaskSnapshot[] }
  | { type: "task_output"; taskId: string; snapshot: BackgroundTaskSnapshot | null; newOutput: string }
  | { type: "task_kill_result"; requestId: string; ok: boolean; reason?: string }
  // Slice P7.8: trusted composite telemetry + repo-map status snapshot. Pushed
  // on ui_ready (after pushTaskList) and on turn teardown — never a pull

  | { type: "env_status"; status: WireEnvStatus }
  // Slice P7.17 (F12, design §2.2): trusted per-category context breakdown, sent
  // ONLY in response to a context_breakdown_request (no zod, precedent
  // model_changed). No legacy/byte-locked flow emits one, so automation/replay
  // snapshots stay byte-identical.
  | { type: "context_breakdown"; breakdown: WireContextBreakdown }
  // Slice P7.26/R2: trusted checkpoint timeline snapshot, sent ONLY in response to
  // a checkpoint_list_request (no zod, precedent context_breakdown). No legacy/
  // byte-locked flow emits one, so automation/replay snapshots stay byte-identical.
  | { type: "checkpoint_list"; checkpoints: WireCheckpointMeta[] }
  // Slice P7.26/R2: trusted result of one rewind_request. `conversationRestored`
  // drives the renderer's transcript-scoped clear (a truncated `session_history`
  // follows on the same port when true, in that order — design §1). `restoredPaths`
  // is the count of worktree files the file-restore touched (null when scope was
  // conversation-only or the rewind failed). Emitted ONLY in response to a
  // rewind_request — no legacy/byte-locked flow carries one.
  | {
      type: "rewind_result";
      requestId: string;
      ok: boolean;
      reason?: string;
      conversationRestored: boolean;
      restoredPaths: number | null;
      safetyCheckpointId?: string;
    }
  | { type: "fatal"; message: string };

/** Minimal port abstraction — host logic is unit-tested over worker_threads MessageChannel. */
export interface WirePort {
  post(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: () => void): void;
}

// ─────────────────────────────────────────────────────────────────────────
// zod schemas for incoming UiToHostMessage (host-side validation, MVP.3).
// Invalid/garbage input must be dropped silently with a warn-log — fail
// closed: junk can never grant a permission or start an unintended turn.
// One schema per message variant + a discriminated union, mirroring the
// UiToHostMessage type above 1:1.
// ─────────────────────────────────────────────────────────────────────────

const permissionModeSchema = z.enum(PERMISSION_MODES);

export const uiReadySchema = z
  .object({
    type: z.literal("ui_ready"),
  })
  .strict();

export const userMessageSchema = z
  .object({
    type: z.literal("user_message"),
    requestId: z.string(),
    text: z.string(),
    images: z
      .array(
        z
          .object({
            mediaType: z.union([
              z.literal("image/png"),
              z.literal("image/jpeg"),
              z.literal("image/gif"),
              z.literal("image/webp"),
            ]),
            data: z.string().min(1).max(IMAGE_BASE64_MAX_CHARS),
            sourcePath: z.string().min(1).max(4096).optional(),
          })
          .strict(),
      )
      .max(IMAGE_MAX_PER_MESSAGE)
      .optional(),
  })
  .strict();

export const cancelTurnSchema = z
  .object({
    type: z.literal("cancel_turn"),
  })
  .strict();

export const exitWorktreeSchema = z
  .object({
    type: z.literal("exit_worktree"),
    // The chrome action never exposes destructive removal; dirty removal stays
    // behind the tool permission flow and its explicit consent.
    cleanup: z.enum(["auto", "keep"]),
  })
  .strict();

export const permissionResponseSchema = z
  .object({
    type: z.literal("permission_response"),
    requestId: z.string(),
    behavior: z.enum(["allow", "deny"]),
    updatedInput: z.unknown().optional(),
    // Slice 2.2 (additive, strict-safe): absent -> old renderer valid; present ->
    // { pattern? } drives always-allow persistence (host consumes it in 2.2.3).
    remember: z.object({ pattern: z.string().optional() }).optional(),
  })
  .strict();

export const setModeSchema = z
  .object({
    type: z.literal("set_mode"),
    mode: permissionModeSchema,
  })
  .strict();

export const setReasoningEffortSchema = z.object({
  type: z.literal("set_reasoning_effort"),
  effort: z.enum(["off", "low", "medium", "high", "max"]),
}).strict();

// Slice P7.15 (F14): untrusted set_model. Mirror of the CLI /model ambiguity
// rules — a non-empty id with no internal whitespace; the Session route applies
// the trim + whitespace check too (defense in depth), but bounding length here
// keeps a hostile renderer from shipping a megabyte string. Fail-closed: junk
// is dropped in route() before any switch happens.
export const setModelSchema = z
  .object({
    type: z.literal("set_model"),
    model: z.string().min(1).max(256),
  })
  .strict();

// Codex-fixes TASK.39 (cut §3.3): untrusted set_engine_preset. Mirrors
// setModelSchema's bounded-length discipline (defense in depth — the route()
// handler is the actual membership-against-the-engine's-own-table authority,
// cut §2(d) "host-authoritative"); a hostile renderer cannot ship more than a
// short id string, let alone a raw policy/config object.
export const setEnginePresetSchema = z
  .object({
    type: z.literal("set_engine_preset"),
    presetId: z.string().min(1).max(128),
  })
  .strict();

// ── git (slice 5.7): untrusted UiToHostMessage side; semantics FROZEN incl. caps.
// DRIFT-LOCK: GIT_DIFF_TARGETS is the single source of truth for the diff.target
// enum AND is `satisfies readonly GitDiffTarget[]`, so if core renames/removes a
// GitDiffTarget this file fails to typecheck; the paired `never` assertion below
// fails to typecheck if core ADDS one — either direction is caught at compile time.
const GIT_DIFF_TARGETS = ["head", "staged", "worktree"] as const satisfies readonly GitDiffTarget[];
// `[T] extends [never]` (tuple-wrapped to defeat distribution) is `true` iff the
// tuple above already covers every GitDiffTarget; a new core target makes Exclude
// non-`never` and forces the type to `never`, so this line stops compiling.
const _gitDiffTargetExhaustive: [Exclude<GitDiffTarget, (typeof GIT_DIFF_TARGETS)[number]>] extends [never]
  ? true
  : never = true;
void _gitDiffTargetExhaustive;

const gitCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("refresh") }).strict(),
  z.object({ op: z.literal("branches") }).strict(),
  z.object({ op: z.literal("log"), limit: z.number().int().min(1).max(500).optional() }).strict(),
  z
    .object({
      op: z.literal("diff"),
      target: z.enum(GIT_DIFF_TARGETS).optional(),
      path: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ op: z.literal("switch_branch"), name: z.string().min(1).max(512) }).strict(),
  z.object({ op: z.literal("create_branch"), name: z.string().min(1).max(512), switch: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("stage"), paths: z.array(z.string().min(1).max(4096)).min(1).max(1000) }).strict(),
  z.object({ op: z.literal("unstage"), paths: z.array(z.string().min(1).max(4096)).min(1).max(1000) }).strict(),
  z.object({ op: z.literal("stage_all") }).strict(),
  z.object({ op: z.literal("commit"), message: z.string().min(1).max(10_000) }).strict(),
  // ── destructive tail (slice 5.8, design slice-5.8-cut.md §2.3): `confirmed: z.literal(true)`
  // makes every destructive op INEXPRESSIBLE without an explicit confirm. confirmed:false /
  // absence / "true" / 1 / any extra key under .strict() fails closed BEFORE any spawn (§6#5).
  z
    .object({
      op: z.literal("discard"),
      paths: z.array(z.string().min(1).max(4096)).min(1).max(1000),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      op: z.literal("stash_push"),
      message: z.string().min(1).max(10_000).optional(),
      includeUntracked: z.boolean().optional(),
      confirmed: z.literal(true),
    })
    .strict(),
  z.object({ op: z.literal("stash_pop"), confirmed: z.literal(true) }).strict(),
  z.object({ op: z.literal("reset"), mode: z.enum(["mixed", "hard"]), confirmed: z.literal(true) }).strict(),
]);

export const gitCommandMessageSchema = z
  .object({
    type: z.literal("git_command"),
    requestId: z.string().min(1).max(128),
    command: gitCommandSchema,
  })
  .strict();

export const lspStatusRequestSchema = z
  .object({
    type: z.literal("lsp_status_request"),
  })
  .strict();

// Slice P7.17 (F12): payload-less breakdown request (mirror of
// lspStatusRequestSchema). Untrusted ui->host direction, so it rides zod even
// though it carries no data — fail-closed on any extra key under .strict().
export const contextBreakdownRequestSchema = z
  .object({
    type: z.literal("context_breakdown_request"),
  })
  .strict();

export const taskListRequestSchema = z
  .object({
    type: z.literal("task_list_request"),
  })
  .strict();

export const taskOutputRequestSchema = z
  .object({
    type: z.literal("task_output_request"),
    taskId: z.string().min(1).max(128),
  })
  .strict();

export const taskKillRequestSchema = z
  .object({
    type: z.literal("task_kill_request"),
    requestId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128),
    confirmed: z.literal(true),
  })
  .strict();

// Slice P7.26/R2: payload-less checkpoint-list request (mirror of
// lspStatusRequestSchema). Fail-closed on any extra key under .strict().
export const checkpointListRequestSchema = z
  .object({
    type: z.literal("checkpoint_list_request"),
  })
  .strict();

// Slice P7.26/R2: untrusted rewind request. Non-empty requestId/checkpointId +
// a scope enum; bounded lengths keep a hostile renderer from shipping a megabyte
// id. Fail-closed: junk is dropped in route() before any store/git spawn.
export const rewindRequestSchema = z
  .object({
    type: z.literal("rewind_request"),
    requestId: z.string().min(1).max(128),
    checkpointId: z.string().min(1).max(128),
    scope: z.enum(["both", "files", "conversation"]),
  })
  .strict();

/** Discriminated union validating any incoming UiToHostMessage; unknown `type` values fail closed. */
export const uiToHostMessageSchema = z.discriminatedUnion("type", [
  uiReadySchema,
  userMessageSchema,
  cancelTurnSchema,
  exitWorktreeSchema,
  permissionResponseSchema,
  setModeSchema,
  setReasoningEffortSchema,
  setModelSchema,
  setEnginePresetSchema,
  gitCommandMessageSchema,
  lspStatusRequestSchema,
  contextBreakdownRequestSchema,
  taskListRequestSchema,
  taskOutputRequestSchema,
  taskKillRequestSchema,
  checkpointListRequestSchema,
  rewindRequestSchema,
]);

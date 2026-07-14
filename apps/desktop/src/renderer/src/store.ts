/**
 * Renderer zustand store. FROZEN shape (design/phase-mvp.md §5) — MVP.1
 * fixed the state contract and a skeletal reducer over HostToUiMessage so
 * MVP.4 (full transcript accumulation, rAF delta batching) and MVP.5
 * (permission modal / diff view) could build against a stable shape in
 * parallel. MVP.4 fills in the `agent_event` branch (transcript
 * accumulation) and adds the rAF delta-batching infrastructure below; the
 * state shape and the four MVP.1 actions (`applyHostMessage`,
 * `setAwaitingPort`, `setHostExited`, `reset`) are unchanged.
 *
 * Wave-1 revision (architect, additive — see
 * working-docs/build/reviews/mvp-wave1-forks.md): adds the `error`
 * transcript block (mid-stream provider errors keep their detail visible),
 * the one-slot `notice` channel + `setNotice` (turn_rejected /
 * mode_change_rejected / non-ui permission_settled feed it; the toast
 * component itself is MVP.5), `setAwaitingHostReady` (handshake phase),
 * and `appendUserText` (transcript writes go through the reducer, not raw
 * setState). No fields or actions were removed or reshaped.
 *
 * MVP.5 fills in the `file_snapshot` branch (`patchFileSnapshot` below):
 * before/after snapshots are attached to the matching `tool_call` block's
 * `snapshots.<phase>` by `toolCallId`, merging so one phase never clobbers
 * the other. Purely a reducer-internal addition — no new state fields or
 * actions, same as MVP.4's `agent_event` fill-in above.
 *
 * Task 1.9 (design §2.12) fills in the Phase 1 context/retry branch that MVP
 * left as a documented no-op: `compaction_start`/`compaction_end`/
 * `microcompact` and `stream_retry` now feed the existing one-slot `notice`
 * channel (additive `NoticeKind` variants — the toast component and its
 * dismiss contract are unchanged), and `context_usage` lands in a new
 * `contextUsage` status-bar field. Everything else (the frozen shape, the
 * other four MVP.1 actions, the exhaustiveness guard) is untouched.
 *
 * Task 2.1.5 (design/phase-2.md §3.3) fills in the `session_history` branch
 * that 2.1.1 left as a documented no-op: `projectHistoryToBlocks` (below)
 * projects a resumed session's persisted `WireHistoryItem[]` into
 * `TranscriptBlock[]` per the §3.3 mapping, and the reducer merges the result
 * into `transcript` deduped by block id (so a second `session_history` for
 * items already hydrated — e.g. a respawn re-sending the same boot snapshot —
 * never duplicates blocks). `truncated: true` raises a notice on the same
 * one-slot channel (additive `NoticeKind` variant, same pattern as task 1.9).
 *
 * Task 3.1.4 (design/phase-3.md §3.3/§4.2) fills in the `subagent_*` branch
 * that 3.1.1 left as a documented no-op: a new `subagent: SubagentSubStatus |
 * null` field on the `tool_call` variant of `TranscriptBlock` (default null
 * everywhere a tool_call block is created) tracks a child subagent's coarse
 * progress keyed by `toolCallId` — start seeds it, progress refreshes the
 * counters, end fills the terminal status. Purely additive: no existing
 * field, action, or the frozen five-kind `TranscriptBlock` union changes.
 *
 * Task 3.2.4 (design/slice-3.2-cut.md §6) fills in the `mcp_status` branch
 * that 3.2.1 left as a documented no-op: a new `mcpServers: McpServerStatus[]`
 * field (part of the session slice, so it resets alongside
 * turn/transcript/permission/notice/contextUsage on `reset()`/a respawned
 * `host_ready` — a fresh host process boots its own McpManager, whose bind-
 * time status snapshot supersedes whatever the dead host last reported)
 * simply mirrors the latest `McpServerStatus[]` snapshot the host sends —
 * SettingsScreen (task 3.2.4) is the sole reader.
 *
 * Task 3.4.5 (design/slice-3.4-cut.md §6) fills in the five `workflow_*`
 * branches that 3.4.1 left as a documented no-op passthrough: a new
 * `workflow: WorkflowSubStatus | null` field on the `tool_call` variant of
 * `TranscriptBlock` (default null everywhere a tool_call block is created,
 * mirroring `subagent`) tracks a Workflow tool call's coarse DAG progress
 * keyed by `toolCallId` — `workflow_start` seeds it (steps: [], final: null),
 * `workflow_step_start` appends a step entry, `workflow_step_progress`
 * refreshes a step's counters, `workflow_step_end` settles that step, and
 * `workflow_end` fills the run-level terminal status. Purely additive: no
 * existing field, action, or the frozen five-kind `TranscriptBlock` union
 * changes.
 *
 * Codex-fixes TASK.39 (B2-ui, cut §2(k).3/§3.3) fills in the
 * `engine_settings_changed` branch that B2-host's contracts left as a
 * documented no-op: `pendingEngineChange` (new session-slice field) tracks a
 * `set_model`/`set_engine_preset` the host has ACCEPTED
 * (`engine_settings_changed{state:"pending"}`) but not yet APPLIED. There is
 * no server ack channel of its own for a pre-turn override, so host/session.ts
 * answers in two phases on this SAME message: `state:"pending"` the instant
 * it validates+records the choice, then a separate `state:"applied"` once a
 * `turn/start` carrying it was actually accepted by the server (its
 * `onSettingsApplied` hook) — that second message is the authoritative
 * "actually active now" signal this reducer folds into
 * `engine.model.current`/`engine.permissions.activePresetId`, clearing the
 * matching pending field(s) in the SAME atomic `set()`. (`model_changed`, the
 * pre-existing core `set_model` ack, stays core-only in practice — an engine
 * session with its own catalog routes `set_model` entirely through
 * `engine_settings_changed` instead, host/session.ts's own routing.) Also
 * fills the `engine_notice` AgentEvent branch (cut §2(k).2's drift warning:
 * the server's effective posture came back weaker than the persisted preset
 * claims) into the existing one-slot notice/toast channel — "surface it,
 * don't swallow it" — via one additive `NoticeKind` variant.
 */
import { create } from "zustand";
import type {
  AssistantPart,
  BackgroundTaskSnapshot,
  CommandHookDeclaration,
  GitBranchInfo,
  GitCommitInfo,
  GitDiffTarget,
  ImageAttachment,
  LspServerStatus,
  McpServerStatus,
  PermissionMode,
  ReasoningEffort,
  TokenUsage,
  ToolCallStatus,
  ToolResultPart,
} from "@anycode/core";
import type {
  GitCommand,
  GitCommandOutcome,
  HostToUiMessage,
  SerializedError,
  WireAgentEvent,
  WireCheckpointMeta,
  WireContextBreakdown,
  WireEnvStatus,
  WireGitStatus,
  WireHistoryItem,
  WireToolMeta,
  EnginePresentation,
  ShellCapabilitiesProjection,
} from "../../shared/protocol.js";
import { stripReminderBlocks } from "./transcript-sanitize.js";
import { parseUsageLimitNotice, type UsageLimitNotice } from "./provider-notices.js";

/** Lifecycle of the renderer<->host port itself, independent of the agent turn lifecycle. */
export type ConnectionPhase = "awaiting_port" | "awaiting_host_ready" | "ready" | "host_exited";

export interface TurnState {
  status: "idle" | "running";
  turnId: string | null;
  requestId: string | null;
}

/** Tool-call transcript card status: proposed (awaiting dispatch/permission) -> running -> terminal outcome. */
export type ToolCallCardStatus = "proposed" | "running" | ToolCallStatus;

export interface ToolCallSnapshot {
  content: string | null;
  truncated: boolean;
}

/**
 * Sub-status of an Agent tool call's child subagent loop (design §3.3/§4.2,
 * task 3.1.4), keyed onto the Agent tool_call block by `toolCallId`.
 * `subagent_start` seeds it (turns/toolCalls at 0, `activity` empty,
 * `activityDropped` 0, `final` null — the card shows a spinner while `final`
 * is null); `subagent_progress` refreshes the counters; `subagent_activity`
 * appends a live per-child-tool row (slice P7.18/F16b, ring-capped — see
 * `SUBAGENT_ACTIVITY_RING`); `subagent_end` fills `final`, flipping the card
 * to the terminal status. The full child result/text is NOT here — it
 * arrives capped in the ordinary `tool_result` that settles this same
 * tool_call (design §3.3: no nested stream forwarding).
 */
export interface SubagentSubStatus {
  agentType: string;
  description: string;
  turns: number;
  toolCalls: number;
  lastTool: string | null;
  /** Live per-child-tool activity feed rows, oldest first, ring-capped at `SUBAGENT_ACTIVITY_RING`. */
  activity: { toolName: string; summary: string }[];
  /** Count of activity rows dropped from the front of the ring once the cap was exceeded (honest overflow counter, not a wire field). */
  activityDropped: number;
  final: { status: "completed" | "max_turns" | "cancelled" | "error"; durationMs: number } | null;
}

/** Ring cap for `SubagentSubStatus.activity` (design slice-P7.18-cut.md §4 W2): oldest row drops, `activityDropped` increments. Renderer-side bound independent of the core's own per-run emission cap. */
export const SUBAGENT_ACTIVITY_RING = 100;

/**
 * Coarse progress of one DAG step within a running Workflow tool call
 * (design/slice-3.4-cut.md §2.3/§6, task 3.4.5). Appended to the parent
 * `WorkflowSubStatus.steps` array by `workflow_step_start` (turns/toolCalls
 * at 0, `final` null); `workflow_step_progress` refreshes the counters;
 * `workflow_step_end` fills `final`. Steps may run concurrently (DAG, not a
 * single lane) — the array order is arrival order of `workflow_step_start`,
 * not necessarily definition order.
 */
export interface WorkflowStepStatus {
  stepId: string;
  agentType: string;
  turns: number;
  toolCalls: number;
  lastTool: string | null;
  final: { status: "completed" | "max_turns" | "cancelled" | "error" | "skipped"; durationMs: number } | null;
}

/**
 * Sub-status of a Workflow tool call's DAG run (design §2.3/§6, task 3.4.5),
 * keyed onto the Workflow tool_call block by `toolCallId` — the workflow
 * mirror of `SubagentSubStatus`. `workflow_start` seeds it (`steps: []`,
 * `final` null); each `workflow_step_*` event patches the matching entry in
 * `steps` (keyed by `stepId`, appended by `workflow_step_start`); `workflow_end`
 * fills `final`, flipping the card to the terminal status. Like
 * `SubagentSubStatus`, the full step/run output text is NOT here — it arrives
 * capped in the ordinary `tool_result` that settles this same tool_call.
 */
export interface WorkflowSubStatus {
  workflow: string;
  totalSteps: number;
  steps: WorkflowStepStatus[];
  final: { status: "completed" | "failed" | "cancelled"; completedSteps: number; durationMs: number } | null;
}

/**
 * One rendered block in the transcript. Streaming text/reasoning blocks
 * accumulate in place (MVP.4 rAF-batches the deltas that feed them); a
 * tool_call block is keyed by toolCallId so later events/snapshots patch it
 * instead of appending a new block.
 */
export type TranscriptBlock =
  | { kind: "user_text"; id: string; text: string }
  | { kind: "assistant_text"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string; collapsed: boolean }
  | {
      kind: "tool_call";
      id: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      status: ToolCallCardStatus;
      modelText: string | null;
      snapshots: { before: ToolCallSnapshot | null; after: ToolCallSnapshot | null };
      /** Null until a `subagent_start` for this toolCallId arrives (only ever set for the Agent tool). */
      subagent: SubagentSubStatus | null;
      /** Null until a `workflow_start` for this toolCallId arrives (only ever set for the Workflow tool). */
      workflow: WorkflowSubStatus | null;
    }
  | { kind: "error"; id: string; error: SerializedError }
  /** Renderer-only quota diagnostic; never reconstructed into prompt history. */
  | { kind: "usage_limit"; id: string; notice: UsageLimitNotice }
  | { kind: "output_truncated"; id: string }
  | { kind: "loop_end"; id: string; reason: string; turns: number };

/** Convenience alias for the tool_call variant of TranscriptBlock (used by ToolCallCard). */
export type ToolCallBlock = Extract<TranscriptBlock, { kind: "tool_call" }>;

export interface PermissionUiRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  mode: PermissionMode;
  metadata: WireToolMeta;
}

/**
 * Sources that can raise a transient notice (single-slot toast channel).
 * Task 1.9 (design §2.12) adds the four Phase 1 context/retry sources on top
 * of the MVP set — same channel, same single-slot semantics, no new plumbing.
 * Task 2.1.5 (design §3.3) adds `session_history_truncated` on the same
 * pattern: the resumed session's boot history was capped at
 * `SESSION_HISTORY_MAX_ITEMS`, so the hydrated transcript only shows the tail.
 * Slice P7.26/R2 adds `rewind_restored`/`rewind_rejected` for the checkpoint
 * timeline's `rewind_result` outcome (design slice-P7.26-R2-ratification.md §1).
 */
export type NoticeKind =
  | "turn_rejected"
  | "mode_change_rejected"
  | "permission_settled"
  | "compaction_start"
  | "compaction_end"
  | "microcompact"
  | "stream_retry"
  | "session_history_truncated"
  | "image_attach_rejected"
  | "background_task_rejected"
  | "rewind_restored"
  | "rewind_rejected"
  | "engine_notice"
  | "worktree_notice";

/** Status-bar projection of the `context_usage` event (design §2.5/§2.12) — last-known reading, minimal. */
export interface ContextUsage {
  estimatedTokens: number;
  budgetTokens: number;
  source: "provider" | "estimate";
}

/**
 * Accumulated token totals for the whole session (slice P7.17 · F12 W3): the
 * ctx-popover's "Session tokens" line. `null` until the first step-level
 * `finish` AgentEvent lands; part of the session slice (see `SessionSlice`
 * below) so a respawned `host_ready` / a public `reset()` clears it — a fresh
 * host has produced no usage yet.
 */
export interface SessionTokens {
  input: number;
  output: number;
  total: number;
  /** Prompt-cache measurement from the latest provider finish; absent when not reported. */
  latestCacheRead?: number;
  /** Matching input-token total for latestCacheRead (the cache-hit denominator). */
  latestCacheInput?: number;
}

/**
 * Adds one step's `TokenUsage` (from a `finish` AgentEvent) onto the running
 * session total. A multi-step turn (tool calls -> another model step)
 * finishes more than once, so this SUMS rather than replaces — mirrors the
 * reducer's own accumulate-not-overwrite discipline elsewhere (rAF delta
 * buffers, subagent/workflow progress counters). Missing `TokenUsage` fields
 * (the AI SDK does not guarantee all three) count as 0; `total` prefers the
 * provider's own total when present, else falls back to input+output so the
 * running total never silently drops a step whose provider omitted it.
 * Exported for unit testing.
 */
export function accumulateSessionTokens(prev: SessionTokens | null, usage: TokenUsage): SessionTokens {
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

/**
 * One transient notification for the toast channel. Single slot: each new
 * notice replaces the previous one (a fresh object identity per assignment,
 * so effect-driven toast timers retrigger on repeats of the same text). The
 * toast component that renders/dismisses it is MVP.5.
 */
export interface Notice {
  kind: NoticeKind;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────
// git slice (design slice-5.8-cut.md §2.5) — FROZEN contract for waves C/D.
//
// The renderer's git surface: the last git_status snapshot, the changes/
// history/diff panel state, per-request correlation (`pending`), a single

// and the confirm-dialog staging area (`confirm`) that is the SOLE producer of

// ─────────────────────────────────────────────────────────────────────────

/** Which tab of the git panel is showing. */
export type GitPanelView = "changes" | "history" | "diff";

/** What a given git request expects back, so its `git_result` is dispatched correctly. */
export type GitPendingKind = "refresh" | "branches" | "log" | "diff" | "mutation";

export interface GitPendingRequest {
  kind: GitPendingKind;
  /** kind:"diff" only — what was asked for, so a stale/mismatched result is dropped. */
  diff?: { path: string | null; target: GitDiffTarget };
  /** Short op label for the in-panel error line ("stage", "discard", "reset"…). */
  label: string;
}

/** Destructive intent staged for the confirm dialog — the ONLY source of confirmed:true. */
export type GitDestructiveIntent =
  | { op: "discard"; paths: string[] }
  | { op: "stash_push"; message?: string; includeUntracked?: boolean }
  | { op: "stash_pop" }
  | { op: "reset"; mode: "mixed" | "hard" };

export interface GitDiffState {
  path: string | null;
  target: GitDiffTarget;
  text: string;
  truncated: boolean;
}

export interface GitSlice {
  /** Last `git_status` payload; null = git unavailable in this workspace (not a repo). */
  status: WireGitStatus | null;
  /** False until the FIRST `git_status` arrives (the pill renders nothing until then). */
  statusKnown: boolean;
  panelOpen: boolean;
  view: GitPanelView;
  branches: GitBranchInfo[] | null;
  log: GitCommitInfo[] | null;
  diff: GitDiffState | null;
  /** Destructive intent awaiting confirmation; null = no dialog open. */
  confirm: GitDestructiveIntent | null;
  /** requestId -> disposition of its `git_result`. */
  pending: Record<string, GitPendingRequest>;
  /* */
  lastError: { label: string; reason: string } | null;
}

function initialGitSlice(): GitSlice {
  return {
    status: null,
    statusKnown: false,
    panelOpen: false,
    view: "changes",
    branches: null,
    log: null,
    diff: null,
    confirm: null,
    pending: {},
    lastError: null,
  };
}

/**

 * null unless a confirm is staged, so a dispatch without the confirm dialog is
 * structurally impossible. Pure — exported for the unit gate (§6#6) and used by
 * GitConfirmDialog (wave D2) as the one place a `confirmed: true` command is built.
 */
export function buildConfirmedGitCommand(confirm: GitDestructiveIntent | null): GitCommand | null {
  if (confirm === null) {
    return null;
  }
  switch (confirm.op) {
    case "discard":
      return { op: "discard", paths: confirm.paths, confirmed: true };
    case "stash_push":
      return {
        op: "stash_push",
        ...(confirm.message !== undefined ? { message: confirm.message } : {}),
        ...(confirm.includeUntracked !== undefined ? { includeUntracked: confirm.includeUntracked } : {}),
        confirmed: true,
      };
    case "stash_pop":
      return { op: "stash_pop", confirmed: true };
    case "reset":
      return { op: "reset", mode: confirm.mode, confirmed: true };
    default: {
      const _exhaustive: never = confirm;
      void _exhaustive;
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// prompt queue (slice P7.14 · F15) — pure renderer state, ZERO wire delta.
//
// A per-tab FIFO of user prompts entered while a turn is running. The host's
// busy-reject stays the protocol's guard; the queue holds messages on the
// renderer side and drains them one-at-a-time on turn-end (tab-registry's
// drainer subscription). These slots are deliberately NOT part of
// `initialSessionSlice`: a host respawn (`host_ready`) must preserve prompts
// the user already typed, so `performReset` leaves them alone — only a public
// `reset()` (a genuinely new session in the tab) clears them via `clearQueue`.
// ─────────────────────────────────────────────────────────────────────────

export interface QueuedPromptImage {
  /** Filename for the queue-list pill. */
  name: string;
  /** Byte size for the queue-list pill. */
  sizeBytes: number;
  /** The `user_message.images` payload carried through to the wire on drain. */
  attachment: ImageAttachment;
}

export interface QueuedPrompt {
  /** crypto.randomUUID() minted at enqueue; identifies the item for edit/delete. */
  id: string;
  /** Final send text — paste markers already reconstituted at enqueue time. */
  text: string;
  images: readonly QueuedPromptImage[];
}

/**
 * Codex-fixes TASK.39 (cut §2(k).3): a `set_model`/`set_engine_preset` the
 * host has ACCEPTED (an `engine_settings_changed{state:"pending"}` landed)
 * but not yet APPLIED (the matching `state:"applied"` — host/session.ts's
 * `onSettingsApplied`, fired only once a `turn/start` carrying the change was
 * actually accepted by the server — has not landed since). Both fields are
 * independent — a model pick pending while the preset stays confirmed leaves
 * `activePresetId` absent, and vice versa.
 */
export interface PendingEngineChange {
  model?: string;
  activePresetId?: string;
}

export interface DesktopState {
  connection: ConnectionPhase;
  workspace: string | null;
  model: string | null;
  mode: PermissionMode | null;
  /** Host-authoritative external-engine projection; null means historical core wire. */
  engine: EnginePresentation | null;
  /**
   * Codex-fixes TASK.39 (cut §2(k).3): a model/preset change the host has
   * accepted but not yet applied — see `PendingEngineChange`'s own doc
   * comment. Null when nothing is queued (the common case: `engine === null`
   * for core, or an engine session with no outstanding change). Part of the
   * session slice so a respawn/reset clears it — a fresh host has nothing
   * pending yet.
   */
  pendingEngineChange: PendingEngineChange | null;
  /**
   * Host-authoritative shell (AnyCode chrome) capability projection (design
   * TASK.40 §2(f)/§3.2): null for core (legacy wire) OR whenever the host
   * omitted it -- every consumer treats null the SAME as "every shell
   * feature enabled" (`shell?.x ?? true`), never as "everything disabled".
   */
  shell: ShellCapabilitiesProjection | null;
  reasoningEffort: ReasoningEffort;
  /** Effort levels the current model supports; undefined ⇒ hide the selector. */
  availableEffortLevels: ReasoningEffort[] | undefined;
  turn: TurnState;
  transcript: TranscriptBlock[];
  permission: PermissionUiRequest | null;
  /** Transient toast-channel notice; null when nothing is pending. Fed by the reducer, rendered by MVP.5. */
  notice: Notice | null;
  /** Last `context_usage` reading (design §2.12); null before the first one arrives in a session. */
  contextUsage: ContextUsage | null;
  /** Last fatal message from the host (e.g. sanitizer failure); null once nothing has fired yet. */
  lastFatal: string | null;
  /**
   * Latest MCP server status snapshot (design slice-3.2-cut.md §3.5/§6, task
   * 3.2.4): mirrors the host's `mcp_status` message verbatim — a full
   * replacement of the array on every change, never merged. Empty before the
   * first snapshot arrives (fresh boot) or when this tab's host has zero MCP
   * servers configured. SettingsScreen renders it; no other component reads it.
   */
  mcpServers: McpServerStatus[];
  /** Latest LSP server status snapshot from the host, replaced wholesale. */
  lspServers: LspServerStatus[];
  /** Static command-hook config list for this session, replaced wholesale on host bind. */
  hookDeclarations: CommandHookDeclaration[];
  /** Hook config load error, if the host fail-softed to no command hooks. */
  hookConfigError: string | null;
  /** Latest background-task snapshots from the host, replaced wholesale. */
  backgroundTasks: BackgroundTaskSnapshot[];
  /** Accumulated output chunks keyed by taskId. */
  backgroundTaskOutput: Record<string, string>;
  /**
   * GUI-git slice (design slice-5.8-cut.md §2.5): per-tab, part of the session
   * slice so `reset()`/a respawned `host_ready` clear it wholesale — a fresh

   */
  git: GitSlice;
  /**
   * Telemetry + repo-map read-only status surface (design slice-P7.8-cut.md
   * §3.4): mirrors the host's `env_status` message verbatim, replaced
   * wholesale. Null before the first snapshot arrives (fresh boot) or when
   * this tab has no active host yet. Consumed only by the Settings
   * "Environment" pane.
   */
  envStatus: WireEnvStatus | null;
  /**
   * Latest per-category context-token breakdown (slice P7.17 · F12), fetched on
   * demand when the ctx-meter popover opens (context_breakdown reducer branch);
   * null until the first response arrives / after reset. Part of the session
   * slice so a respawn clears it. The popover renders a skeleton while null.
   */
  contextBreakdown: WireContextBreakdown | null;
  /**
   * Session-wide accumulated token totals (slice P7.17 · F12 W3): summed
   * across every `finish` AgentEvent by `accumulateSessionTokens`. Part of
   * the session slice so a respawn/reset clears it. Null until the first
   * `finish` of the session lands. The ctx-popover's sole reader.
   */
  sessionTokens: SessionTokens | null;
  /**
   * Checkpoint timeline snapshot (slice P7.26/R2): fetched on demand when the
   * timeline panel opens (`checkpoint_list_request`), replaced wholesale on
   * each `checkpoint_list` reply. Part of the session slice so a respawn/reset
   * clears it. Empty both when no checkpoint has been captured yet AND when
   * the checkpoint seam is disabled — the wire carries no way to tell those
   * apart (design slice-P7.26-R2-ratification.md §2.1), so the panel's empty
   * state must stay honest about that ambiguity.
   */
  checkpoints: WireCheckpointMeta[];
  /**
   * Outcome of the last `rewind_request` sent this session; null before the
   * first one. Set alongside the toast the reducer raises on the same event
   * (design §1) — no dedicated reader yet, kept for a future timeline "last
   * rewind" readout.
   */
  lastRewindResult: RewindResultInfo | null;

  /**
   * Prompt queue (slice P7.14 · F15): FIFO of prompts the user entered while a
   * turn was running, head = index 0. NOT part of the session slice — survives
   * a host respawn (see the section comment above `QueuedPrompt`).
   */
  promptQueue: readonly QueuedPrompt[];
  /** True after an anomalous turn end / respawn / reject left the queue held for the user to Resume or Clear. */
  queuePaused: boolean;
  /**
   * The single item currently "in flight": taken off the queue with its wire
   * `user_message` sent, but its `turn_started` not yet acknowledged. The
   * drainer's re-entrancy gate — non-null means a drain is already underway, so
   * the next drain must wait. Constructed ONLY by `takeQueueHead`.
   */
  queueInFlight: { requestId: string; item: QueuedPrompt } | null;

  /** Single reducer entry point: applies one HostToUiMessage to the store. */
  applyHostMessage(message: HostToUiMessage): void;
  /* */
  setAwaitingPort(): void;
  /** Marks the handshake in flight: port received and ui_ready sent, host_ready not yet received. */
  setAwaitingHostReady(): void;
  /* */
  setHostExited(): void;
  /** Sets or clears (null) the transient notice; the toast UI (MVP.5) dismisses through this. */
  setNotice(notice: Notice | null): void;
  /** Appends the local user's message to the transcript (the wire never echoes user input back, §3). */
  appendUserText(id: string, text: string): void;
  /** Appends a renderer-only persisted provider diagnostic; never sent to the host/model. */
  appendUsageLimitNotice(notice: UsageLimitNotice): void;
  /**
   * Records a pending git request keyed by `requestId` so the matching
   * `git_result` can be dispatched (the caller sends the wire message itself
   * via useTabSend). A `kind:"diff"` request also stamps `git.diff` with the
   * requested {path,target} (text empty until the result lands) so a later
   * out-of-order diff result can be stale-dropped (see the `git_result` reducer).
   */
  gitRequestStarted(requestId: string, request: GitPendingRequest): void;
  /** Opens/closes the right-hand Git Review panel. */
  gitSetPanelOpen(open: boolean): void;
  /** Switches the git panel's active view (changes/history/diff). */
  gitSetView(view: GitPanelView): void;
  /**
   * Stages a destructive intent for the confirm dialog. REFUSES (returns false,

   * may be writing the same files). Returns true when the intent was staged.
   */
  gitStageConfirm(intent: GitDestructiveIntent): boolean;
  /** Clears the staged destructive intent (Cancel/Esc/after-dispatch). */
  gitClearConfirm(): void;
  /**
   * Full session reset: clears turn/transcript/permission/notice/
   * contextUsage/lastFatal, and drains the rAF delta buffers (pendingText/
   * pendingReasoning — otherwise-invisible closure state that lives outside
   * this store, see the rAF batching section below).
   *

   * say reset is "NOT called on renderer reload or host respawn" because

   * respawn story — main's `TabHostManager` now treats every respawn as a

   * persisted history replaces the old process's memory). A `host_ready`
   * arriving on an already-hydrated store is therefore never "the same
   * session continuing" — it is always a NEW, now-authoritative process — so
   * `applyHostMessage`'s `host_ready` branch calls this same reset path
   * before the `session_history`/replay that follows on the same port
   * hydrates the transcript from persisted truth. `reset()` itself is
   * unchanged as the public action for a workspace switch or other explicit
   * "start over" call site.
   */
  reset(): void;

  // ── prompt queue actions (slice P7.14 · F15) — pure reducer mutations, no IPC ──
  /**
   * Appends a prompt to the queue tail, minting its `id`, and RETURNS that id.
   * Returning the id (rather than making the caller read it back off the tail)
   * is load-bearing: at truly-idle the enqueue synchronously fires the drainer,
   * which pops the just-added item into `queueInFlight` before any tail read —
   * so the tail no longer holds this item. The UI's Composer ignores the return.
   */
  enqueuePrompt(item: Omit<QueuedPrompt, "id">): string;
  /** Replaces the text of the queued prompt matching `id` (no-op on an unknown id); images are not editable in v1. */
  editQueuedPrompt(id: string, text: string): void;
  /** Removes the queued prompt matching `id` (no-op on an unknown id). */
  deleteQueuedPrompt(id: string): void;
  /**
   * ATOMICALLY takes the head of the queue and marks it in flight under
   * `requestId`. Returns null (no state change) when the queue is empty, paused,
   * or already has an item in flight — the double-guard that makes the drainer
   * re-entrancy-safe. The SOLE constructor of `queueInFlight`.
   */
  takeQueueHead(requestId: string): QueuedPrompt | null;
  /** Clears the paused flag so the drainer can resume (Resume button). */
  resumeQueue(): void;
  /** Empties the queue, clears any in-flight item, and un-pauses (Clear button / new session). */
  clearQueue(): void;
}

/**
 * Renderer-side echo of one `rewind_result` (slice P7.26/R2, design
 * slice-P7.26-R2-ratification.md §1). No dedicated consumer yet beyond the
 * toast the reducer raises alongside it, PLUS `requestId` (W3-FIX): the
 * automation facade's `checkpointRewind` correlates its own dispatched
 * request against this field rather than "any change to this slot", since two
 * concurrent rewinds (or a stale result the facade merely raced past) would
 * otherwise both look like a satisfied wait. NOT in `TabStateSnapshot`
 * (automation.ts) — this stays a facade-only read via the tab's live store,
 * same posture as before.
 */
export interface RewindResultInfo {
  requestId: string;
  ok: boolean;
  reason?: string;
  conversationRestored: boolean;
  restoredPaths: number | null;
  safetyCheckpointId?: string;
}

interface SessionSlice {
  engine: EnginePresentation | null;
  /** Codex-fixes TASK.39 (cut §2(k).3): see `PendingEngineChange`'s own doc comment. */
  pendingEngineChange: PendingEngineChange | null;
  /** Design TASK.40 §2(f)/§3.2: mirrors `engine` -- reset alongside it on a respawn/reset. */
  shell: ShellCapabilitiesProjection | null;
  turn: TurnState;
  transcript: TranscriptBlock[];
  permission: PermissionUiRequest | null;
  notice: Notice | null;
  contextUsage: ContextUsage | null;
  mcpServers: McpServerStatus[];
  lspServers: LspServerStatus[];
  hookDeclarations: CommandHookDeclaration[];
  hookConfigError: string | null;
  backgroundTasks: BackgroundTaskSnapshot[];
  backgroundTaskOutput: Record<string, string>;
  git: GitSlice;
  envStatus: WireEnvStatus | null;
  contextBreakdown: WireContextBreakdown | null;
  sessionTokens: SessionTokens | null;
  /** On-demand checkpoint-timeline snapshot (slice P7.26/R2); replaced wholesale on each `checkpoint_list`. */
  checkpoints: WireCheckpointMeta[];
  /** Outcome of the last `rewind_request`, if any this session; null before the first one. */
  lastRewindResult: RewindResultInfo | null;
}

function initialSessionSlice(): SessionSlice {
  return {
    engine: null,
    pendingEngineChange: null,
    shell: null,
    turn: { status: "idle", turnId: null, requestId: null },
    transcript: [],
    permission: null,
    notice: null,
    contextUsage: null,
    mcpServers: [],
    lspServers: [],
    hookDeclarations: [],
    hookConfigError: null,
    backgroundTasks: [],
    backgroundTaskOutput: {},
    git: initialGitSlice(),
    envStatus: null,
    contextBreakdown: null,
    sessionTokens: null,
    checkpoints: [],
    lastRewindResult: null,
  };
}

/**
 * Toast text for permission settlements that did not originate from the UI
 * itself (design §5: the modal closes with a toast explaining why). A plain
 * UI answer produces no notice — the user just clicked the button.
 */
const PERMISSION_SETTLE_TEXT: Record<Exclude<Extract<HostToUiMessage, { type: "permission_settled" }>["origin"], "ui">, string> = {
  timeout: "Permission request timed out — denied.",
  turn_cancelled: "Turn cancelled — pending permission denied.",
  disconnect: "UI disconnected — pending permission denied.",
  shutdown: "Shutting down — pending permission denied.",
};

// ─────────────────────────────────────────────────────────────────────────

//
// text_delta/reasoning_delta arrive far more often than the UI needs to
// repaint (a naive `set()` per delta is the known B4.4 footgun). Deltas are
// accumulated in plain Maps (block id -> concatenated text-so-far) that live
// outside zustand state entirely, so appending to them never triggers a
// re-render; a single flush per animation frame drains them into the store
// in one `set()` call. All non-delta agent events (tool cards, loop_end,
// text_start/reasoning_start creating the block shell, etc.) apply
// immediately, per §5.
//
// The scheduler is injected (`FrameScheduler`) instead of calling
// `requestAnimationFrame` directly so tests can supply a manual/fake
// scheduler and assert "N deltas -> 1 scheduled flush" deterministically,
// without depending on real frame timing.
// ─────────────────────────────────────────────────────────────────────────

export interface FrameScheduler {
  /** Schedules `flush` to run once "soon" (e.g. next animation frame). */
  schedule(flush: () => void): void;
}

const defaultScheduler: FrameScheduler = {
  schedule(flush) {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      // Non-browser fallback (shouldn't happen in the renderer at runtime,
      // but keeps this module importable from a plain Node test context).
      setTimeout(flush, 0);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Session-history hydration (design §3.3, task 2.1.5).
//
// Projects a resumed session's persisted `WireHistoryItem[]` into
// `TranscriptBlock[]`, pure and side-effect free so the mapping itself is
// unit-testable without a live store. Mapping:
//   - `user` message (role "user", including `kind:"compact_summary"` — still
//     a user-role item, rendered the same way) -> one `user_text` block, text
//     run through `stripReminderBlocks` (host/core reminder-injection tags
//     stripped presentation-only, wire payload stays honest); if the message
//     is entirely a stripped block (trim()-empty remainder), no block is
//     emitted at all (design slice-P7.9-cut.md §3.5).
//   - `assistant` message -> one block per part, in part order: a `text` part
//     becomes `assistant_text`; a `tool_call` part becomes a `tool_call`
//     block, paired with the `ToolResultPart` of the matching `toolCallId`
//     from the run of `tool`-role items immediately following this item
//     (packages/core/src/loop/agent-loop.ts appends exactly one `tool`-role
//     HistoryItem per outcome, in proposal order, right after the assistant
//     item and before the next user/assistant message — same invariant
//     `ConversationHistory.unansweredToolCallIds()` relies on). No match
//     (truncation cut the pairing tool-message, or history is a defective
//     resume snapshot) -> status stays "proposed", modelText stays null.
//     `snapshots` is always `{before: null, after: null}` — diffs are never
//     persisted, an honest limitation (design §8).
//   - `tool` message -> no block of its own; it is only consumed above for
//     pairing.
//   - reasoning is never part of `ChatMessage` (Phase 1 does not persist it)
//     -> absent from the hydrated transcript, by construction.
// Block id = `${item.id}:${partIdx}` (`item.id` is the persisted item's own
// stable uuid) — a `user` item has exactly one part, so its id is
// `${item.id}:0`.
// ─────────────────────────────────────────────────────────────────────────

export function projectHistoryToBlocks(items: readonly WireHistoryItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];

  for (const [index, item] of items.entries()) {
    const message = item.message;

    if (message.role === "user") {
      const text = stripReminderBlocks(message.content);
      if (text !== message.content && text.trim() === "") {
        continue;
      }
      blocks.push({ kind: "user_text", id: `${item.id}:0`, text });
      continue;
    }

    if (message.role === "tool") {
      // Consumed by the preceding assistant item's tool_call pairing below;
      // a tool-role item never gets its own transcript block.
      continue;
    }

    // message.role === "assistant"
    const results = new Map<string, ToolResultPart>();
    for (let j = index + 1; j < items.length; j += 1) {
      const next = items[j];
      if (!next || next.message.role !== "tool") {
        break;
      }
      for (const part of next.message.content) {
        results.set(part.toolCallId, part);
      }
    }

    message.content.forEach((part: AssistantPart, partIdx: number) => {
      const id = `${item.id}:${partIdx}`;
      if (part.type === "text") {
        blocks.push({ kind: "assistant_text", id, text: part.text });
        return;
      }
      const result = results.get(part.toolCallId);
      blocks.push({
        kind: "tool_call",
        id,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        status: result ? result.status : "proposed",
        modelText: result ? result.text : null,
        snapshots: { before: null, after: null },

        // are ephemeral) — a hydrated tool_call never has a sub-status to replay.
        subagent: null,
        workflow: null,
      });
    });
  }

  return blocks;
}

/**
 * Builds a desktop store instance. Each tab gets its own instance via
 * tab-registry's per-tab factory; this factory is exported so tests can
 * construct an isolated store with an injected `FrameScheduler` test double
 * instead of sharing a single store's buffered-delta state across test cases.
 */
export function createDesktopStore(scheduler: FrameScheduler = defaultScheduler) {
  // Buffered delta text, keyed by the minted transcript block id (see
  // `blockSeq`/`openStreamBlocks` below) that owns the block — NOT the raw
  // stream id, which repeats across steps. Mutated in place (never
  // reassigned) so closures below always see the live buffer.
  const pendingText = new Map<string, string>();
  const pendingReasoning = new Map<string, string>();
  let flushScheduled = false;
  // Monotonic id source for error transcript blocks (the error AgentEvent
  // variant carries no stream id of its own). Never reset: ids stay unique
  // across turns and resets.
  let errorSeq = 0;
  // Monotonic id source for streamed text/reasoning transcript blocks. The
  // agent loop makes one streamText call per step, so the AI-SDK stream part
  // id (event.id on text_start/reasoning_start) is only unique *within* a
  // step — it restarts at "0" every step. blockSeq mints a turn-global id per
  // block so same-numbered stream parts across steps never collide.
  let blockSeq = 0;
  // Maps the raw (step-scoped) stream id to the minted transcript block id
  // for the currently-open block, so text_delta/reasoning_delta know which
  // block to buffer into. Cleared on reset/respawn (drainPendingDeltas).
  const openStreamBlocks = new Map<string, string>();

  return create<DesktopState>()((set, get) => {
    /** Drains buffered deltas into the store in one `set()`. Idempotent no-op when nothing is pending. */
    function flushDeltas(): void {
      flushScheduled = false;
      if (pendingText.size === 0 && pendingReasoning.size === 0) {
        return;
      }
      const textUpdates = new Map(pendingText);
      const reasoningUpdates = new Map(pendingReasoning);
      pendingText.clear();
      pendingReasoning.clear();
      set((state) => ({
        transcript: state.transcript.map((block) => {
          if (block.kind === "assistant_text") {
            const delta = textUpdates.get(block.id);
            return delta ? { ...block, text: block.text + delta } : block;
          }
          if (block.kind === "reasoning") {
            const delta = reasoningUpdates.get(block.id);
            return delta ? { ...block, text: block.text + delta } : block;
          }
          return block;
        }),
      }));
    }

    /**
     * Drops any buffered-but-unflushed deltas without applying them, and
     * cancels the "a flush is already scheduled" bookkeeping. Used by
     * `performReset` below: the transcript blocks those deltas target are
     * about to be discarded wholesale (session reset / respawn-hydration),
     * so flushing them into state first would just be wasted work applied to
     * blocks nobody will see. `flushScheduled` is reset to `false` so a
     * scheduler callback still in flight from before the reset is a no-op
     * when it eventually fires (`flushDeltas`'s empty-map guard).
     */
    function drainPendingDeltas(): void {
      pendingText.clear();
      pendingReasoning.clear();
      openStreamBlocks.clear();
      flushScheduled = false;
    }

    /**
     * Shared reset path for the public `reset()` action AND the `host_ready`

     * `reset()` docstring above for the respawn-hydration rationale). Drains
     * the rAF delta buffers first so no stale delta from the dead host lands
     * on a transcript block that's about to be cleared anyway.
     */
    function performReset(): void {
      drainPendingDeltas();
      set({ ...initialSessionSlice(), lastFatal: null });
    }

    /**
     * Correlates one `git_result` to its pending request (design §2.5). An

     * a result can arrive after `performReset` wiped `pending` on respawn /
     * workspace switch). Otherwise the pending entry is retired and the slice
     * updated by outcome kind: branches/log replace their list; a diff result
     * lands only while `git.diff` still reflects the spec this request asked
     * for (stale-drop of a superseded, slower diff); a successful mutation

     */
    function applyGitResult(requestId: string, outcome: GitCommandOutcome): void {
      if (!get().git.pending[requestId]) {
        console.warn(`[git] git_result for unknown requestId "${requestId}" — ignored (reset race).`);
        return;
      }
      set((state) => {
        const git = state.git;
        const pending = git.pending[requestId];
        if (!pending) {
          // Racing set() already retired it; nothing to do.
          return {};
        }
        const nextPending = { ...git.pending };
        delete nextPending[requestId];
        const next: GitSlice = { ...git, pending: nextPending };

        if (!outcome.ok) {
          next.lastError = { label: pending.label, reason: outcome.reason };
          return { git: next };
        }

        switch (outcome.kind) {
          case "branches":
            next.branches = outcome.branches;
            break;
          case "log":
            next.log = outcome.commits;
            break;
          case "diff": {
            // Stale-drop: apply only while git.diff still points at the spec
            // this request asked for. A newer diff request (which re-stamped
            // git.diff with its own {path,target}) supersedes an older/slower
            // result, so the mismatched result is discarded rather than
            // clobbering the currently-requested view.
            const want = git.diff;
            if (pending.diff && want && want.path === pending.diff.path && want.target === pending.diff.target) {
              next.diff = {
                path: pending.diff.path,
                target: pending.diff.target,
                text: outcome.diff,
                truncated: outcome.truncated,
              };
            }
            break;
          }
          case "unit":
          case "commit":

            next.lastError = null;
            break;
          default: {
            const _exhaustive: never = outcome;
            void _exhaustive;
            break;
          }
        }
        return { git: next };
      });
    }

    function scheduleFlush(): void {
      if (flushScheduled) {
        return;
      }
      flushScheduled = true;
      scheduler.schedule(flushDeltas);
    }

    /** Appends a new transcript block; flushes any pending deltas first so ordering stays intuitive. */
    function appendBlock(block: TranscriptBlock): void {
      flushDeltas();
      set((state) => ({ transcript: [...state.transcript, block] }));
    }

    /** Patches the tool_call block matching `toolCallId` in place (no-op if it isn't in the transcript yet). */
    function patchToolCall(toolCallId: string, patch: Partial<ToolCallBlock>): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId ? { ...block, ...patch } : block,
        ),
      }));
    }

    /**
     * Attaches a `file_snapshot` (before/after content read by the host-side
     * snapshot hook, design §5) to the matching tool_call block's
     * `snapshots.<phase>`, merging rather than replacing so setting one phase
     * never clobbers the other that may have already arrived. No-op if the
     * toolCallId isn't in the transcript yet (defensive: in practice
     * `tool_call` always precedes its `file_snapshot`s in the host's own
     * event ordering, per §5's PreToolUse-hook / post-tool_result sequencing).
     */
    function patchFileSnapshot(toolCallId: string, phase: "before" | "after", snapshot: ToolCallSnapshot): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId
            ? { ...block, snapshots: { ...block.snapshots, [phase]: snapshot } }
            : block,
        ),
      }));
    }

    /**
     * Seeds the sub-status region of the Agent tool_call block matching
     * `toolCallId` on `subagent_start` (design §3.3/§4.2, task 3.1.4): turns/
     * toolCalls start at zero and `final` stays null so the card renders the
     * spinner. No-op if `toolCallId` doesn't match a tool_call block yet
     * (defensive, same posture as `patchFileSnapshot`) or belongs to a
     * different/unknown turn's toolCallId (foreign events are ignored by
     * construction — the map below simply finds nothing to patch).
     */
    function patchSubagentStart(toolCallId: string, agentType: string, description: string): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId
            ? {
                ...block,
                subagent: {
                  agentType,
                  description,
                  turns: 0,
                  toolCalls: 0,
                  lastTool: null,
                  activity: [],
                  activityDropped: 0,
                  final: null,
                },
              }
            : block,
        ),
      }));
    }

    /**
     * Refreshes the live counters on `subagent_progress`. Requires a
     * sub-status already seeded by `subagent_start` to merge into — a
     * progress event with no prior start (or a foreign toolCallId) is a
     * no-op, same guard rationale as `patchSubagentStart` above.
     */
    function patchSubagentProgress(toolCallId: string, turns: number, toolCalls: number, lastTool: string | null): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId && block.subagent
            ? { ...block, subagent: { ...block.subagent, turns, toolCalls, lastTool } }
            : block,
        ),
      }));
    }

    /**
     * Appends a live per-child-tool row on `subagent_activity` (slice
     * P7.18/F16b, design §4 W2). Requires a sub-status already seeded by
     * `subagent_start` to append into — same existing-subagent +
     * matching-toolCallId guard as `patchSubagentProgress` (an event for an
     * unseeded or foreign toolCallId is a no-op, nothing invented). Ring-caps
     * at `SUBAGENT_ACTIVITY_RING`: once full, the oldest row drops and
     * `activityDropped` increments — an honest count of rows the renderer
     * chose not to keep, never a wire-reported value.
     */
    function patchSubagentActivity(toolCallId: string, toolName: string, summary: string): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) => {
          if (block.kind !== "tool_call" || block.toolCallId !== toolCallId || !block.subagent) return block;
          const activity = [...block.subagent.activity, { toolName, summary }];
          const overflow = activity.length - SUBAGENT_ACTIVITY_RING;
          const ringed = overflow > 0 ? activity.slice(overflow) : activity;
          const activityDropped = block.subagent.activityDropped + Math.max(overflow, 0);
          return { ...block, subagent: { ...block.subagent, activity: ringed, activityDropped } };
        }),
      }));
    }

    /**
     * Records the terminal outcome on `subagent_end`: fills `final`, which
     * flips the card from spinner to a settled status label. Same
     * existing-subagent + matching-toolCallId guard as `patchSubagentProgress`.
     */
    function patchSubagentEnd(
      toolCallId: string,
      status: "completed" | "max_turns" | "cancelled" | "error",
      turns: number,
      durationMs: number,
    ): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId && block.subagent
            ? { ...block, subagent: { ...block.subagent, turns, final: { status, durationMs } } }
            : block,
        ),
      }));
    }

    /**
     * Seeds the sub-status region of the Workflow tool_call block matching
     * `toolCallId` on `workflow_start` (design §2.3/§6, task 3.4.5): `steps`
     * starts empty and `final` stays null so the card renders the spinner.
     * No-op if `toolCallId` doesn't match a tool_call block yet — same
     * defensive posture as `patchSubagentStart`.
     */
    function patchWorkflowStart(toolCallId: string, workflow: string, totalSteps: number): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId
            ? { ...block, workflow: { workflow, totalSteps, steps: [], final: null } }
            : block,
        ),
      }));
    }

    /**
     * Appends a step entry on `workflow_step_start`. Requires a workflow
     * sub-status already seeded by `workflow_start` to append into — a
     * step_start with no prior start (or a foreign toolCallId) is a no-op,
     * same guard rationale as `patchSubagentProgress`.
     */
    function patchWorkflowStepStart(toolCallId: string, stepId: string, agentType: string): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId && block.workflow
            ? {
                ...block,
                workflow: {
                  ...block.workflow,
                  steps: [
                    ...block.workflow.steps,
                    { stepId, agentType, turns: 0, toolCalls: 0, lastTool: null, final: null },
                  ],
                },
              }
            : block,
        ),
      }));
    }

    /**
     * Refreshes the live counters of the step matching `stepId` on
     * `workflow_step_progress`. No-op if the workflow sub-status isn't
     * seeded, or if `stepId` doesn't match a step already appended by
     * `workflow_step_start` (the inner `.map` simply finds nothing to patch —
     * same "foreign id is a no-op" posture as the toolCallId guards above).
     */
    function patchWorkflowStepProgress(
      toolCallId: string,
      stepId: string,
      turns: number,
      toolCalls: number,
      lastTool: string | null,
    ): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId && block.workflow
            ? {
                ...block,
                workflow: {
                  ...block.workflow,
                  steps: block.workflow.steps.map((step) =>
                    step.stepId === stepId ? { ...step, turns, toolCalls, lastTool } : step,
                  ),
                },
              }
            : block,
        ),
      }));
    }

    /**
     * Records the terminal outcome of the step matching `stepId` on
     * `workflow_step_end`: fills that step's `final`. Same
     * existing-workflow + matching-stepId guard as `patchWorkflowStepProgress`.
     */
    function patchWorkflowStepEnd(
      toolCallId: string,
      stepId: string,
      status: "completed" | "max_turns" | "cancelled" | "error" | "skipped",
      turns: number,
      durationMs: number,
    ): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId && block.workflow
            ? {
                ...block,
                workflow: {
                  ...block.workflow,
                  steps: block.workflow.steps.map((step) =>
                    step.stepId === stepId ? { ...step, turns, final: { status, durationMs } } : step,
                  ),
                },
              }
            : block,
        ),
      }));
    }

    /**
     * Records the terminal outcome of the whole run on `workflow_end`: fills
     * the run-level `final`, which flips the card from spinner to a settled
     * status label. Same existing-workflow + matching-toolCallId guard as
     * `patchSubagentEnd`.
     */
    function patchWorkflowEnd(
      toolCallId: string,
      status: "completed" | "failed" | "cancelled",
      completedSteps: number,
      totalSteps: number,
      durationMs: number,
    ): void {
      flushDeltas();
      set((state) => ({
        transcript: state.transcript.map((block) =>
          block.kind === "tool_call" && block.toolCallId === toolCallId && block.workflow
            ? { ...block, workflow: { ...block.workflow, totalSteps, final: { status, completedSteps, durationMs } } }
            : block,
        ),
      }));
    }

    /**
     * Applies one `session_history` message (design §3.3, task 2.1.5):
     * projects `items` via `projectHistoryToBlocks` and merges the result
     * into `transcript`, deduped by block id against what's already there.
     * Idempotent by construction: a second hydration carrying items already
     * represented contributes zero new blocks rather than duplicating them.
     * This is now mostly a defensive backstop rather than the primary
     * respawn-safety mechanism: since `host_ready`'s branch resets the

     * runs, `existingIds` is normally empty going into a respawn's hydration
     * too — the dedup still guards e.g. a host resending an identical
     * `session_history` without an intervening `host_ready`. A page reload
     * needs no special handling here at all — it recreates the store from
     * scratch, so the first (and only) hydration lands on an empty
     * transcript.
     */
    function hydrateSessionHistory(items: readonly WireHistoryItem[], truncated: boolean): void {
      flushDeltas();
      const existingIds = new Set(get().transcript.map((block) => block.id));
      const newBlocks = projectHistoryToBlocks(items).filter((block) => !existingIds.has(block.id));
      if (newBlocks.length > 0) {
        set((state) => ({ transcript: [...state.transcript, ...newBlocks] }));
      }
      if (truncated) {
        set({
          notice: {
            kind: "session_history_truncated",
            text: "Showing the tail of history — earlier messages were not loaded.",
          },
        });
      }
    }

    /**
     * Applies one `rewind_result` (slice P7.26/R2, design
     * slice-P7.26-R2-ratification.md §1). A conversation-restoring success
     * does a TRANSCRIPT-SCOPED clear — drains the rAF delta buffers (they'd
     * otherwise land stray deltas on blocks about to vanish) then empties
     * `transcript` — so the truncated `session_history` the host sends
     * immediately after on the same port rehydrates onto a blank slate via
     * the existing dedup-append path (`hydrateSessionHistory`). A files-only
     * success (`conversationRestored:false`, scope `"files"`) and any
     * `ok:false` failure leave the transcript untouched. Never resets the
     * rest of the session slice — a faked full reset would blank the
     * LSP/hooks/git/env panels with no re-push to refill them (ratification
     * §1, rejected-mechanism note).
     */
    function applyRewindResult(message: Extract<HostToUiMessage, { type: "rewind_result" }>): void {
      const lastRewindResult: RewindResultInfo = {
        requestId: message.requestId,
        ok: message.ok,
        conversationRestored: message.conversationRestored,
        restoredPaths: message.restoredPaths,
        ...(message.reason !== undefined ? { reason: message.reason } : {}),
        ...(message.safetyCheckpointId !== undefined ? { safetyCheckpointId: message.safetyCheckpointId } : {}),
      };

      if (!message.ok) {
        set({ lastRewindResult, notice: { kind: "rewind_rejected", text: message.reason ?? "Rewind failed." } });
        return;
      }

      if (message.conversationRestored) {
        drainPendingDeltas();
        set({ transcript: [] });
      }

      const shortId = message.safetyCheckpointId?.slice(0, 8);
      set({
        lastRewindResult,
        notice: {
          kind: "rewind_restored",
          text: shortId ? `Restored — safety checkpoint ${shortId}` : "Restored.",
        },
      });
    }

    /**
     * Applies one agent_event envelope. Events whose `turnId` no longer
     * matches the active turn are dropped (design §3: late events from a
     * cancelled/replaced turn must not resurrect stale UI).
     */
    function onAgentEvent(turnId: string, event: WireAgentEvent): void {
      if (get().turn.turnId !== turnId) {
        return;
      }
      switch (event.type) {
        // ── streamed text (batched) ──
        case "text_start": {
          const blockId = `text:${blockSeq++}:${event.id}`;
          openStreamBlocks.set(event.id, blockId);
          appendBlock({ kind: "assistant_text", id: blockId, text: "" });
          return;
        }
        case "text_delta": {
          const blockId = openStreamBlocks.get(event.id);
          if (blockId === undefined) {
            return;
          }
          pendingText.set(blockId, (pendingText.get(blockId) ?? "") + event.text);
          scheduleFlush();
          return;
        }
        case "text_end":
          return;

        // ── streamed reasoning (batched) ──
        case "reasoning_start": {
          const blockId = `reason:${blockSeq++}:${event.id}`;
          openStreamBlocks.set(event.id, blockId);
          appendBlock({ kind: "reasoning", id: blockId, text: "", collapsed: false });
          return;
        }
        case "reasoning_delta": {
          const blockId = openStreamBlocks.get(event.id);
          if (blockId === undefined) {
            return;
          }
          pendingReasoning.set(blockId, (pendingReasoning.get(blockId) ?? "") + event.text);
          scheduleFlush();
          return;
        }
        case "reasoning_end":
          return;

        // ── tool-call lifecycle: tool_call -> tool_execution_start -> tool_result (immediate) ──
        case "tool_call":
          appendBlock({
            kind: "tool_call",
            id: event.toolCall.id,
            toolCallId: event.toolCall.id,
            toolName: event.toolCall.name,
            input: event.toolCall.input,
            status: "proposed",
            modelText: null,
            snapshots: { before: null, after: null },
            subagent: null,
            workflow: null,
          });
          return;
        case "tool_execution_start":
          patchToolCall(event.toolCallId, { status: "running" });
          return;
        case "tool_result":
          patchToolCall(event.outcome.toolCallId, {
            status: event.outcome.status,
            modelText: event.outcome.modelText,
          });
          return;

        // ── loop end: footer block + turn goes idle again (immediate) ──
        case "loop_end":
          flushDeltas();
          set((state) => ({
            transcript: [
              ...state.transcript,
              { kind: "loop_end", id: `loop_end:${turnId}`, reason: event.reason, turns: event.turns },
            ],
          }));
          // Slice P7.14: flip the turn to idle AND apply any non-"completed"
          // pause in ONE atomic set(). The drainer subscription (tab-registry
          // `maybeDrain`) fires SYNCHRONOUSLY on every set() and dispatches the
          // queue head the instant it observes ready+idle+unpaused+non-empty.
          // A separate `set({turn:idle})` followed by a later pause would let
          // the drainer fire in the idle+unpaused intermediate and silently
          // send a queued prompt after a cancelled/errored/max_turns end — the
          // opposite of "don't send silently" after an anomaly. Merging them
          // means subscribers only ever observe the final, already-paused
          // state. A clean "completed" end leaves the queue unpaused so this
          // same set() drains it normally (FIFO) — the idle flip is what the
          // drainer watches for.
          set((state) => ({
            turn: { status: "idle", turnId: null, requestId: null },
            ...(event.reason !== "completed" && state.promptQueue.length > 0
              ? { queuePaused: true }
              : {}),
          }));
          return;

        // ── loop-internal bookkeeping with no transcript representation in
        // the frozen TranscriptBlock union (design §5 enumerates exactly:
        // user_text, assistant_text, reasoning, tool_call, loop_end) ──
        case "turn_end":
          if (event.finishReason === "length") {
            appendBlock({ kind: "output_truncated", id: `output_truncated:${turnId}:${event.turn}` });
          }
          return;
        case "start":
        case "turn_start":
        case "tool_input_start":
        case "tool_input_delta":
        case "tool_input_end":
          return;

        // Session-token accumulator (slice P7.17 · F12 W3): a step-level
        // `finish` carries that step's usage, not a running total — SUM onto
        // `sessionTokens` (accumulateSessionTokens), never replace. No
        // transcript representation (mirrors turn_start/tool_input_*
        // above); the ctx-popover is the sole reader.
        case "finish":
          set((state) => ({ sessionTokens: accumulateSessionTokens(state.sessionTokens, event.usage) }));
          return;

        // ── Phase 1 context/retry events (design §2.12): compaction_*/
        // microcompact/stream_retry surface through the existing one-slot
        // notice channel (same as turn_rejected/mode_change_rejected — a
        // later notice simply replaces an earlier one still showing);
        // context_usage is a pure status-bar reading, no notice ──
        case "stream_retry":
          set({
            notice: {
              kind: "stream_retry",
              text: `Retrying… (attempt ${event.attempt}/${event.maxAttempts}: ${event.reason})`,
            },
          });
          return;
        case "compaction_start":
          set({
            notice: {
              kind: "compaction_start",
              text:
                event.trigger === "manual"
                  ? "Compacting conversation…"
                  : "Context window full — compacting conversation…",
            },
          });
          return;
        case "compaction_end":
          set({
            notice: {
              kind: "compaction_end",
              text: event.ok
                ? `Conversation compacted (${event.preTokens} → ${event.postTokens ?? "?"} tokens).`
                : `Compaction failed: ${event.error ?? "unknown error"}`,
            },
          });
          return;
        case "microcompact":
          set({
            notice: {
              kind: "microcompact",
              text: `Cleared ${event.clearedToolResults} old tool result(s) to free ~${event.savedTokens} tokens.`,
            },
          });
          return;
        case "context_usage":
          set({
            contextUsage: {
              estimatedTokens: event.estimatedTokens,
              budgetTokens: event.budgetTokens,
              source: event.source,
            },
          });
          return;

        // Mid-stream provider/model error: appended as a dedicated block so
        // the error detail (name/message) stays visible in the transcript —
        // the loop_end that follows (reason:"error") only closes the turn.
        // TODO(MVP.6): proper visual treatment; MessageList renders a minimal
        // line for now.
        case "error":
          {
            const quota = parseUsageLimitNotice(event.error);
            appendBlock(
              quota
                ? { kind: "usage_limit", id: `usage-limit:${turnId}:${errorSeq}`, notice: quota }
                : { kind: "error", id: `error:${turnId}:${errorSeq}`, error: event.error },
            );
          }
          errorSeq += 1;
          return;

        // ── Phase 3 subagent coarse-progress (design §3.3/§4.2, task 3.1.4):
        // additive AgentEvent variants riding the existing agent_event
        // envelope, keyed onto the Agent tool's own tool_call block by
        // toolCallId (patch helpers above no-op on a foreign/unmatched id). ──
        case "subagent_start":
          patchSubagentStart(event.toolCallId, event.agentType, event.description);
          return;
        case "subagent_progress":
          patchSubagentProgress(event.toolCallId, event.turns, event.toolCalls, event.lastTool ?? null);
          return;
        case "subagent_end":
          patchSubagentEnd(event.toolCallId, event.status, event.turns, event.durationMs);
          return;
        // Per-child-tool activity (slice P7.18/F16b, design §4 W2): additive
        // AgentEvent variant riding the same agent_event envelope, appended to
        // the matching Agent tool_call's `subagent.activity` ring
        // (patchSubagentActivity no-ops on a foreign/unseeded toolCallId).
        case "subagent_activity":
          patchSubagentActivity(event.toolCallId, event.toolName, event.summary);
          return;

        // ── Phase 3 workflow coarse-progress (design §2.3/§6, task 3.4.5):
        // additive AgentEvent variants riding the existing agent_event
        // envelope, keyed onto the Workflow tool's own tool_call block by
        // toolCallId (patch helpers above no-op on a foreign/unmatched id,
        // mirror of the subagent_* block above). ──
        case "workflow_start":
          patchWorkflowStart(event.toolCallId, event.workflow, event.totalSteps);
          return;
        case "workflow_step_start":
          patchWorkflowStepStart(event.toolCallId, event.stepId, event.agentType);
          return;
        case "workflow_step_progress":
          patchWorkflowStepProgress(event.toolCallId, event.stepId, event.turns, event.toolCalls, event.lastTool ?? null);
          return;
        case "workflow_step_end":
          patchWorkflowStepEnd(event.toolCallId, event.stepId, event.status, event.turns, event.durationMs);
          return;
        case "workflow_end":
          patchWorkflowEnd(event.toolCallId, event.status, event.completedSteps, event.totalSteps, event.durationMs);
          return;

        // ── Phase 4 slice 4.7 checkpoint coarse events (design slice-4.7-cut.md
        // §2.3): additive AgentEvent variants riding the existing agent_event

        // (host/index.ts builds the AgentLoop without checkpoints), so these are
        // dormant by construction; they can only reach the renderer once desktop
        // consumption lands (R3, after M-UI). No-op today keeps the transcript +
        // automation snapshots byte-identical, while satisfying exhaustiveness. ──
        case "checkpoint_created":
        case "checkpoint_failed":
          return;

        // Codex-fixes TASK.39 (cut §2(k).2): additive AgentEvent variant the
        // core loop never emits (dormant for every existing core session).
        // Today's only producer is the host's own drift check — the
        // server's effective posture on resume came back weaker than the
        // persisted preset claims — surfaced honestly via the existing
        // one-slot toast channel ("surface it, don't swallow it"; the
        // transcript/automation snapshot shape is untouched). TASK.42/B5-eng
        // may additionally give warning/retry/info notices a dedicated
        // transcript line later — additive on top of this, not a
        // replacement.
        case "engine_notice":
          set({ notice: { kind: "engine_notice", text: event.message } });
          return;

        // Session consumes this control-plane event before it reaches the UI;
        // keep a defensive no-op for structural completeness on a rogue wire.
        case "workspace_transition":
          return;

        default: {
          const _exhaustive: never = event;
          void _exhaustive;
          return;
        }
      }
    }

    return {
      connection: "awaiting_port",
      workspace: null,
      model: null,
      mode: null,
      reasoningEffort: "off",
      availableEffortLevels: undefined,
      ...initialSessionSlice(),
      lastFatal: null,
      // Prompt-queue slots (slice P7.14): outside initialSessionSlice so a
      // host respawn preserves user-typed prompts (see QueuedPrompt comment).
      promptQueue: [],
      queuePaused: false,
      queueInFlight: null,

      applyHostMessage(message: HostToUiMessage): void {
        switch (message.type) {
          case "host_ready":
            // A `host_ready` on a store that already has session state only

            // resume) — reset BEFORE applying the new connection fields so
            // the `session_history`/replay that follows on this same port
            // (guaranteed in-order on one MessagePort) hydrates a clean
            // slate instead of appending on top of the dead host's stale
            // live-rendered blocks. A no-op on a fresh store (page load: the
            // session slice is already empty).
            performReset();
            // Slice P7.14: `performReset` deliberately leaves the prompt queue
            // intact (it isn't in the session slice), so a respawn keeps the
            // user's typed-ahead prompts. But a respawn is an anomaly — restore
            // any in-flight item to the HEAD of the queue (so a prompt caught
            // mid-flight by the crash isn't lost) and hold a non-empty queue
            // paused so nothing re-sends silently; the user Resumes when ready.
            // This MUST run BEFORE the connection flips to "ready" below, or the
            // drainer subscription would fire on that flip (turn already idle)
            // and dispatch an item before the pause lands. Idempotent: on a
            // crash+respawn `setHostExited` already restored + cleared the
            // in-flight slot before this `host_ready` arrives, so `queueInFlight`
            // is null here and `promptQueue` is left untouched.
            set((state) => {
              const promptQueue =
                state.queueInFlight !== null ? [state.queueInFlight.item, ...state.promptQueue] : state.promptQueue;
              return {
                queueInFlight: null,
                promptQueue,
                ...(promptQueue.length > 0 ? { queuePaused: true } : {}),
              };
            });
            set({
              connection: "ready",
              workspace: message.workspace,
              mode: message.mode,
              engine: message.engine ?? null,
              shell: message.shell ?? null,
              model: message.model,
              reasoningEffort: message.reasoningEffort ?? "off",
              availableEffortLevels: message.availableEffortLevels,
            });
            return;
          case "mode_changed":
            set({ mode: message.mode });
            return;
          case "reasoning_effort_changed":
            set({
              reasoningEffort: message.effort,
              ...(message.availableEffortLevels !== undefined ? { availableEffortLevels: message.availableEffortLevels } : {}),
            });
            return;
          case "model_changed":
            // Slice P7.15 (F14, design §2.3): the host acknowledged a set_model
            // switch — update the three derived pill fields at once. ZERO new
            // store slots: `model` already exists (host_ready set it), effort +
            // levels reuse the reasoning_effort_changed slots. `reasoningEffort`
            // is the effort re-resolved for the new model ("off" on a
            // non-reasoning model); `availableEffortLevels` is undefined for a
            // non-reasoning model, which hides the effort segment of the pill
            // (same predicate the effort selector already uses).
            //
            // Codex-fixes TASK.39: host/session.ts's set_model handler routes a
            // session with `engineSettings` wired (Codex) ENTIRELY through
            // `onEngineSettingsChange` (-> engine_settings_changed below) and
            // never falls through to this legacy switchModel path — this
            // message is core-only in practice. No engine-projection handling
            // needed here.
            set({
              model: message.model,
              reasoningEffort: message.reasoningEffort,
              availableEffortLevels: message.availableEffortLevels,
            });
            return;
          case "mode_change_rejected":
            set({ notice: { kind: "mode_change_rejected", text: message.reason } });
            return;
          case "worktree_notice":
            set({ notice: { kind: "worktree_notice", text: message.message } });
            return;
          case "turn_started": {
            // Slice P7.14: a queued item whose drain this turn_started
            // acknowledges is officially accepted — clear the in-flight slot so
            // the drainer can dispatch the next item on the following turn-end.
            //
            // Codex-fixes TASK.39: does NOT fold `pendingEngineChange` here.
            // `turn_started` only announces that a turn began client-side; the
            // host's own `engine_settings_changed{state:"applied"}` (below) is
            // the authoritative "the override actually rode an accepted
            // turn/start" signal (host/session.ts's `onSettingsApplied` fires
            // from inside the RPC, which can land after this event) — folding
            // here would show "active" slightly before the host itself can
            // honestly claim that.
            const inFlight = get().queueInFlight;
            set({
              turn: { status: "running", turnId: message.turnId, requestId: message.requestId },
              ...(inFlight?.requestId === message.requestId ? { queueInFlight: null } : {}),
            });
            return;
          }
          case "turn_rejected": {
            // Slice P7.14: if the host rejected the very drain we just sent (the
            // race in §0/§2.3 — busy/unsupported_images), return the item to the
            // HEAD of the queue and pause so it isn't re-sent silently. The
            // existing notice explains the pause.
            const { queueInFlight, promptQueue } = get();
            const restore =
              queueInFlight && queueInFlight.requestId === message.requestId
                ? { promptQueue: [queueInFlight.item, ...promptQueue], queuePaused: true, queueInFlight: null }
                : null;
            set({
              notice: {
                kind: "turn_rejected",
                text:
                  message.reason === "busy"
                    ? "Message rejected: the agent is still running the current turn."
                    : message.reason === "unsupported_images"
                      ? "Message rejected: the current model does not accept image attachments."
                    : "Message rejected: the host is not ready yet.",
              },
              ...(restore ?? {}),
            });
            return;
          }
          case "agent_event":
            onAgentEvent(message.turnId, message.event);
            return;
          case "permission_request":
            set({
              permission: {
                requestId: message.requestId,
                toolName: message.toolName,
                input: message.input,
                mode: message.mode,
                metadata: message.metadata,
              },
            });
            return;
          case "permission_settled": {
            // Settlements from outside the UI (timeout/cancel/disconnect/
            // shutdown) explain the vanishing modal via the notice channel
            // (design §5); a plain UI answer raises no notice. The toast
            // component rendering `notice` is MVP.5.
            const notice: Notice | null =
              message.origin === "ui"
                ? null
                : { kind: "permission_settled", text: PERMISSION_SETTLE_TEXT[message.origin] };
            set((state) => ({ permission: null, notice: notice ?? state.notice }));
            return;
          }
          case "file_snapshot":
            patchFileSnapshot(message.toolCallId, message.phase, {
              content: message.content,
              truncated: message.truncated,
            });
            return;
          case "fatal":
            // Slice P7.14: a fatal is an anomalous end — hold a non-empty queue
            // paused so nothing drains silently after it. Recorded in ONE
            // atomic set() so the drainer subscription (tab-registry
            // `maybeDrain`, fires synchronously per set()) never observes an
            // intermediate state (invariant shared with `loop_end`).
            set((state) => ({
              lastFatal: message.message,
              ...(state.promptQueue.length > 0 ? { queuePaused: true } : {}),
            }));
            return;
          case "session_history":
            hydrateSessionHistory(message.items, message.truncated);
            return;
          case "title_changed":
            // Phase 4 slice 4.4-T (design feature-session-titles.md §4): title
            // lives in the tabs-store, not this per-tab DesktopState — lifted
            // by tab-registry.ts's attach() (mirrors host_ready's sessionId
            // lift). No-op here; only present to satisfy the exhaustive switch.
            return;
          case "mcp_status":
            // Slice 3.2 (design §3.5, task 3.2.4): the host sends a full
            // snapshot on every status change AND once more when the UI port
            // binds (mirroring the host_ready cascade for a late-attaching
            // renderer) — a plain replacement, never a merge, since the
            // snapshot is already complete by construction (McpManager.status()).
            set({ mcpServers: message.servers });
            return;
          case "lsp_status":
            // Renderer Panels sub-slice A: request/reply or ui_ready snapshot
            // of LspManager.status(); a plain replacement, never a merge.
            set({ lspServers: message.servers });
            return;
          case "hooks_list":
            // Renderer Panels sub-slice B: host boot's static command-hook list;
            // a plain replacement because ui_ready re-sends the complete set.
            set({ hookDeclarations: message.hooks, hookConfigError: message.configError ?? null });
            return;
          case "task_list":
            // Renderer Panels sub-slice D: full snapshot replacement; output is
            // carried by task_output chunks below because core exposes a cursor.
            set({ backgroundTasks: message.tasks });
            return;
          case "task_output":
            if (message.snapshot !== null) {
              set((state) => ({
                backgroundTasks: state.backgroundTasks.some((task) => task.taskId === message.snapshot!.taskId)
                  ? state.backgroundTasks.map((task) => (task.taskId === message.snapshot!.taskId ? message.snapshot! : task))
                  : [...state.backgroundTasks, message.snapshot!],
                backgroundTaskOutput:
                  message.newOutput.length === 0
                    ? state.backgroundTaskOutput
                    : {
                        ...state.backgroundTaskOutput,
                        [message.taskId]: (state.backgroundTaskOutput[message.taskId] ?? "") + message.newOutput,
                      },
              }));
            }
            return;
          case "task_kill_result":
            if (!message.ok) {
              set({
                notice: {
                  kind: "background_task_rejected",
                  text: message.reason ?? "Background task was not stopped.",
                },
              });
            }
            return;
          case "git_status":
            // Slice 5.8 (design slice-5.8-cut.md §2.5): buffered/replayed git
            // status snapshot (or null = git unavailable). statusKnown flips true
            // on the first one so the pill stops rendering nothing.
            set((state) => ({ git: { ...state.git, status: message.status, statusKnown: true } }));
            return;
          case "git_result":
            // Slice 5.8: ephemeral request/response correlated by requestId.
            applyGitResult(message.requestId, message.outcome);
            return;
          case "env_status":
            // Slice P7.8 (design slice-P7.8-cut.md §3.4): seam-gated boot/
            // teardown snapshot from the host, replaced wholesale.
            set({ envStatus: message.status });
            return;
          case "context_breakdown":
            // Slice P7.17 (F12): on-demand per-category breakdown response,
            // replaced wholesale (the host recomputes the full snapshot per
            // request). Part of the session slice — cleared by reset()/respawn.
            set({ contextBreakdown: message.breakdown });
            return;
          case "checkpoint_list":
            // Slice P7.26/R2 (W2): on-demand timeline snapshot, replaced
            // wholesale (mirrors lsp_status/context_breakdown — the host
            // resends the complete list per request).
            set({ checkpoints: message.checkpoints });
            return;
          case "rewind_result":
            applyRewindResult(message);
            return;
          // Codex-fixes TASK.39 (cut §3.3/§2(k).3): host ack of a
          // `set_engine_preset`/`set_model`. `state` is the authoritative
          // two-phase signal host/session.ts now sends (there is no server
          // ack channel — `onEngineSettingsChange` emits `state:"pending"`
          // the instant it validates+records the choice; the engine's own
          // `onSettingsApplied` hook later emits a SEPARATE `state:"applied"`
          // once a `turn/start` carrying it was actually accepted by the
          // server — the only honest confirmation that exists).
          //   "pending"            -> record it, don't touch the displayed
          //                           engine.model.current/activePresetId yet.
          //   "applied" | absent   -> fold straight into the displayed
          //                           projection now. `absent` covers a
          //                           future engine with no pending phase at
          //                           all (its ack never sends "pending"
          //                           either, so there is nothing to defer —
          //                           the wire comment's own "applies
          //                           settings immediately" case).
          // Either way, only a genuine DELTA from what's currently displayed
          // is ever recorded pending — a field matching what's already
          // active clears any stale pending entry for that same field
          // instead of leaving it dangling (covers the user picking back to
          // the active value before the queued change applies). No-op while
          // there is no `engine` projection at all (shouldn't happen —
          // host_ready always precedes this on the same port — defensive).
          case "engine_settings_changed": {
            set((state) => {
              if (state.engine === null) {
                return {};
              }
              if (message.state === "pending") {
                const nextPending: PendingEngineChange = { ...state.pendingEngineChange };
                let touched = false;
                if (message.model !== undefined) {
                  touched = true;
                  if (message.model === state.engine.model?.current) {
                    delete nextPending.model;
                  } else {
                    nextPending.model = message.model;
                  }
                }
                if (message.activePresetId !== undefined) {
                  touched = true;
                  if (message.activePresetId === state.engine.permissions?.activePresetId) {
                    delete nextPending.activePresetId;
                  } else {
                    nextPending.activePresetId = message.activePresetId;
                  }
                }
                if (!touched) {
                  return {};
                }
                const hasPending = nextPending.model !== undefined || nextPending.activePresetId !== undefined;
                return { pendingEngineChange: hasPending ? nextPending : null };
              }
              // "applied" or absent — actually active now. Clear whichever
              // fields this message confirms out of any stale pending entry
              // (model/preset apply independently, cut §2(k).1 — a field
              // this message doesn't carry is left untouched, still pending
              // if it was).
              const nextPending: PendingEngineChange = { ...state.pendingEngineChange };
              if (message.model !== undefined) delete nextPending.model;
              if (message.activePresetId !== undefined) delete nextPending.activePresetId;
              const hasPending = nextPending.model !== undefined || nextPending.activePresetId !== undefined;
              return {
                engine: {
                  ...state.engine,
                  ...(message.model !== undefined && state.engine.model
                    ? { model: { ...state.engine.model, current: message.model } }
                    : {}),
                  ...(message.activePresetId !== undefined && state.engine.permissions
                    ? { permissions: { ...state.engine.permissions, activePresetId: message.activePresetId } }
                    : {}),
                },
                pendingEngineChange: hasPending ? nextPending : null,
              };
            });
            return;
          }
          default: {
            const _exhaustive: never = message;
            void _exhaustive;
          }
        }
      },

      setAwaitingPort(): void {
        set({ connection: "awaiting_port" });
      },

      setAwaitingHostReady(): void {
        set({ connection: "awaiting_host_ready" });
      },

      setHostExited(): void {
        // Slice P7.14: the host dying is an anomalous end — hold a non-empty
        // queue paused so nothing drains silently once a new host connects.
        // The connection flip AWAY from "ready" already disables the drainer,
        // but pause and flip land in ONE atomic set() so the invariant is
        // uniform with `loop_end`/`fatal` (drainer never sees an intermediate).
        //
        // If a drained item was mid-flight (dispatched, `turn_started` not yet
        // acknowledged) when the host died, restore it to the HEAD of the queue
        // and clear the in-flight slot — otherwise that already-typed prompt
        // vanishes silently (matches the `turn_rejected` restore pattern).
        // Idempotent: a null `queueInFlight` leaves `promptQueue` untouched.
        set((state) => {
          const promptQueue =
            state.queueInFlight !== null ? [state.queueInFlight.item, ...state.promptQueue] : state.promptQueue;
          return {
            connection: "host_exited",
            queueInFlight: null,
            promptQueue,
            ...(promptQueue.length > 0 ? { queuePaused: true } : {}),
          };
        });
      },

      setNotice(notice: Notice | null): void {
        set({ notice });
      },

      appendUserText(id: string, text: string): void {
        appendBlock({ kind: "user_text", id, text });
      },

      appendUsageLimitNotice(notice: UsageLimitNotice): void {
        appendBlock({ kind: "usage_limit", id: `usage-limit:restored:${errorSeq}`, notice });
        errorSeq += 1;
      },

      gitRequestStarted(requestId: string, request: GitPendingRequest): void {
        set((state) => {
          const pending = { ...state.git.pending, [requestId]: request };
          // A diff request stamps git.diff with the requested spec (text empty
          // until the result lands) so a later out-of-order diff result is
          // stale-dropped when it no longer matches (see applyGitResult).
          const diff =
            request.kind === "diff" && request.diff
              ? { path: request.diff.path, target: request.diff.target, text: "", truncated: false }
              : state.git.diff;
          return { git: { ...state.git, pending, diff } };
        });
      },

      gitSetPanelOpen(open: boolean): void {
        set((state) => ({ git: { ...state.git, panelOpen: open } }));
      },

      gitSetView(view: GitPanelView): void {
        set((state) => ({ git: { ...state.git, view } }));
      },

      gitStageConfirm(intent: GitDestructiveIntent): boolean {

        // agent may be writing the same files). Refuse without touching state.
        if (get().turn.status === "running") {
          return false;
        }
        set((state) => ({ git: { ...state.git, confirm: intent } }));
        return true;
      },

      gitClearConfirm(): void {
        set((state) => ({ git: { ...state.git, confirm: null } }));
      },

      reset(): void {
        performReset();
        // A genuinely new session in the same tab does NOT own the prior
        // session's queued prompts (slice P7.14) — unlike the respawn path,
        // clear them outright.
        get().clearQueue();
      },

      enqueuePrompt(item: Omit<QueuedPrompt, "id">): string {
        const id = crypto.randomUUID();
        set((state) => ({
          promptQueue: [...state.promptQueue, { ...item, id }],
        }));
        return id;
      },

      editQueuedPrompt(id: string, text: string): void {
        set((state) => ({
          promptQueue: state.promptQueue.map((prompt) => (prompt.id === id ? { ...prompt, text } : prompt)),
        }));
      },

      deleteQueuedPrompt(id: string): void {
        set((state) => ({ promptQueue: state.promptQueue.filter((prompt) => prompt.id !== id) }));
      },

      takeQueueHead(requestId: string): QueuedPrompt | null {
        const { promptQueue, queuePaused, queueInFlight } = get();
        // Atomic double-guard: nothing to take, held, or a drain already in
        // flight. Read-then-set is atomic in single-threaded JS (no await
        // between), so a re-entrant subscriber fired by the set() below always
        // observes the new inFlight and bails.
        if (queuePaused || queueInFlight !== null || promptQueue.length === 0) {
          return null;
        }
        const [head, ...rest] = promptQueue;
        set({ promptQueue: rest, queueInFlight: { requestId, item: head! } });
        return head!;
      },

      resumeQueue(): void {
        set({ queuePaused: false });
      },

      clearQueue(): void {
        set({ promptQueue: [], queueInFlight: null, queuePaused: false });
      },
    };
  });
}

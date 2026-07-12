/**
 * Hook contracts (Phase 1, design §2.11). Five events:
 *   PreToolUse            — gate, fail-closed (timeout/throw => deny);
 *   PostToolUse           — observer after a successful outcome, fail-open;
 *   PostToolUseFailure    — observer after a non-success outcome, fail-open;
 *   UserPromptSubmit      — may contribute additionalContext, fail-open;
 *   Stop                  — observer before loop_end, fail-open.
 * Failure matrix is frozen: only PreToolUse failures affect control flow; an
 * external abort always propagates. Each hook runs under its own timeout
 * (DEFAULT_HOOK_TIMEOUT_MS) linked to the turn signal.
 * SessionStart/PermissionRequest events are Phase 2/3.
 */

import type { LoopEndReason } from "./events.js";
import type { ToolCallOutcome } from "./tools.js";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop";

// ---------------------------------------------------------------------------
// Hook inputs

export interface PreToolUseHookInput {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface PostToolUseHookInput {
  toolCallId: string;
  toolName: string;
  input: unknown;
  outcome: ToolCallOutcome;
}

export interface UserPromptSubmitHookInput {
  prompt: string;
}

export interface StopHookInput {
  reason: LoopEndReason;
  turns: number;
}

export interface SubagentStopHookInput {
  agentType: string;
  description: string;
  status: LoopEndReason;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Hook results & function shapes

export interface PreToolUseHookResult {
  /** Merge semantics across hooks: deny > ask > allow. */
  permissionDecision?: "allow" | "ask" | "deny";
  reason?: string;
  /** Replaces the tool input; the dispatcher re-validates it against the tool schema. */
  updatedInput?: unknown;
}

export type PreToolUseHook = (
  input: PreToolUseHookInput,
  signal: AbortSignal,
) => Promise<PreToolUseHookResult | undefined>;

export type PostToolUseHook = (
  input: PostToolUseHookInput,
  signal: AbortSignal,
) => Promise<void>;

export type UserPromptSubmitHook = (
  input: UserPromptSubmitHookInput,
  signal: AbortSignal,
) => Promise<{ additionalContext?: string } | undefined>;

export type StopHook = (input: StopHookInput, signal: AbortSignal) => Promise<void>;

export type SubagentStopHook = (
  input: SubagentStopHookInput,
  signal: AbortSignal,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Registration (discriminated union keyed on event)

export type HookRegistration =
  | { event: "PreToolUse"; matcher?: RegExp; hook: PreToolUseHook }
  | { event: "PostToolUse" | "PostToolUseFailure"; matcher?: RegExp; hook: PostToolUseHook }
  /** matcher is tested against the prompt text. */
  | { event: "UserPromptSubmit"; matcher?: RegExp; hook: UserPromptSubmitHook }
  | { event: "Stop"; hook: StopHook }
  /** matcher is tested against the subagent's agentType. */
  | { event: "SubagentStop"; matcher?: RegExp; hook: SubagentStopHook };

/** Merged result of all matching PreToolUse hooks. */
export interface AggregatedPreToolUseResult {
  permissionDecision?: "allow" | "ask" | "deny";
  reason?: string;
  updatedInput?: unknown;
}

export interface HookRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HookRunner {
  register(registration: HookRegistration): void;
  /** Runs matching hooks sequentially, each under its own timeout + linked abort. Fail-closed. */
  runPreToolUse(
    input: PreToolUseHookInput,
    options?: HookRunOptions,
  ): Promise<AggregatedPreToolUseResult>;
  /** Fail-open; additionalContext strings from all matching hooks are concatenated. */
  runUserPromptSubmit(
    input: UserPromptSubmitHookInput,
    options?: HookRunOptions,
  ): Promise<{ additionalContext?: string }>;
  /** Fail-open observers: a throwing/hanging hook is logged and skipped; external abort propagates. */
  runObservers(
    event: "PostToolUse" | "PostToolUseFailure",
    input: PostToolUseHookInput,
    options?: HookRunOptions,
  ): Promise<void>;
  runObservers(event: "Stop", input: StopHookInput, options?: HookRunOptions): Promise<void>;
  runObservers(
    event: "SubagentStop",
    input: SubagentStopHookInput,
    options?: HookRunOptions,
  ): Promise<void>;
}

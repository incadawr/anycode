/**
 * Permission contracts. Two-stage gate:
 *  1. PermissionEngine.check — pure rule/mode evaluation -> allow | deny | ask.
 *  2. "ask" escalates to PermissionBroker.requestPermission (interactive client).
 * Fail-closed invariant: when no interactive client is wired, the broker MUST
 * be DenyPermissionBroker, so every "ask" resolves to deny.
 */

import type { ToolMetadata } from "./tools.js";

export const PERMISSION_MODES = ["plan", "build", "edit", "auto", "yolo"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PermissionRequest {
  toolName: string;
  /** Validated tool input (post-zod, post-hook rewrite). */
  input: unknown;
  metadata: ToolMetadata;
  mode: PermissionMode;
  /* */
  toolCallId?: string;
}

/** Pure rule evaluation result. */
export interface PermissionRuling {
  decision: "allow" | "ask" | "deny";
  reason?: string;
}

/** Broker resolution of an "ask" ruling. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; reason: string };

export interface PermissionEngine {
  check(request: PermissionRequest): PermissionRuling;
}

/**

 * across sessions is deferred to 2.2; for 2.3 these live only in memory
 * (SessionPermissionRules). `pattern` is a picomatch glob matched against a
 * per-tool "subject" extracted from the validated input (Bash -> input.command,
 * Read/Edit/Write -> file_path, Glob/Grep -> path, WebFetch -> url); an unknown
 * tool has no subject, so only a pattern-less rule can ever match it. Omitting
 * `pattern` matches every call to `toolName` regardless of input.
 */
export interface PermissionRule {
  toolName: string;
  pattern?: string;
}

export interface PermissionBroker {
  /**

   * Implementations MUST tolerate concurrent in-flight requests (parallel
   * read-only tool batches can escalate several asks at once, design §2.7);
   * presentation serialization is a client concern (e.g. the desktop FIFO queue).
   */
  requestPermission(
    request: PermissionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PermissionDecision>;
}

/**
 * Sanctioned exit from plan mode (design slice-4.3-cut.md §2.2). Built by the
 * loop on every turn ONLY when the wiring set AgentLoopConfig.planExitMode, then
 * threaded into the DispatchContext/ToolContext; its absence in a ToolContext is
 * the fail-closed lock (children spawned via buildChildConfig and any client
 * that never opts in never receive it, so the ExitPlanMode handler reports
 * "unavailable" rather than mutating any mode).
 */
export interface PlanModeControl {
  /** Live mode of the CURRENT turn (after a successful exitPlan it is already the target). */
  currentMode(): PermissionMode;
  /**
   * The single sanctioned mid-turn transition: plan -> the configured
   * planExitMode. Returns the new mode; returns null (with zero effects) when
   * the current mode is not plan. Called ONLY by the ExitPlanMode handler, and
   * only AFTER the broker approved the tool's ask.
   */
  exitPlan(): PermissionMode | null;
}

/**
 * Host-local boundary between the desktop Session protocol server and an agent
 * runtime.  Engines own their turn lifecycle; Session owns UI transport,
 * replay, and the generic tab/session affordances.
 *
 * This deliberately lives outside @anycode/core: an external engine replaces
 * the core loop rather than becoming another ModelPort implementation.
 */

import type {
  AgentEvent,
  ContextBreakdown,
  HistoryItem,
  ImageAttachment,
  PermissionMode,
  ReasoningEffort,
} from "@anycode/core";
import type { EngineId } from "../../shared/engines.js";

export type { EngineId } from "../../shared/engines.js";

/** Frozen engine feature facts. Later UI wiring projects these host-side. */
export interface EngineCapabilities {
  readonly supportsCorePermissions: boolean;
  readonly supportsRewind: boolean;
  readonly supportsWorkflow: boolean;
  readonly supportsGitMutations: boolean;
  readonly supportsContextUsage: boolean;
  readonly supportsContextBreakdown: boolean;
  readonly supportsInteractiveApprovals: boolean;
  readonly costAccounting: boolean;
  readonly supportsModelSelection: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportsImages: boolean;
  readonly supportsTasks: boolean;
  readonly supportsFileSnapshots: boolean;
  /**
   * Manual compaction is available when the engine exposes compactNow.
   * Native engines verify support against their configured executable at boot.
   */
  readonly supportsManualCompact: boolean;
}

export interface ModelSwitchResult {
  model: string;
  reasoningEffort: ReasoningEffort;
  availableEffortLevels?: ReasoningEffort[];
}

export interface RunTurnOptions {
  signal: AbortSignal;
  attachments?: ImageAttachment[];
  /** Ephemeral host context for this real turn; never persisted as a user frame. */
  systemContext?: string;
  /**
   * TASK.145 срез 2: stamps the appended user HistoryItem's `origin` (the
   * turn was opened by a host-injected message — a detached child's report —
   * not human input). Forwarded verbatim to `AgentLoop.runTurn`'s own
   * `origin` option (core-engine.ts); only CoreEngine ever reads it — Claude/
   * Codex engines have no session-tier `Agent` tool to begin with (spec §5),
   * so their `runTurn` simply never sees this field set.
   */
  origin?: "system";
  /**
   * TASK.117 causal stamp: the outer turn UUID `Session.runTurn` minted for
   * this turn (`turn_started.turnId`). CoreEngine forwards it to
   * AgentLoop.runTurn so every HistoryItem the turn appends carries
   * `{turnId, step}` (see core's HistoryItem.turnId/step). Foreign engines
   * never read it — their history projection owns its own stamps (absent
   * fields, by design).
   */
  turnId?: string;
}

/**
 * The only agent-runtime API Session consumes. `dispose` must synchronously
 * begin interruption before returning its bounded promise; Session starts it
 * before waiting for its active turn during host shutdown.
 */
export interface SessionEngine {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  mode(): PermissionMode;
  setMode?(mode: PermissionMode): void;
  reasoningEffort(): ReasoningEffort | undefined;
  setReasoningEffort(effort: ReasoningEffort | undefined): void;
  setSelectedReasoningEffort?(effort: ReasoningEffort): void;
  switchModel?(id: string, effort: ReasoningEffort): ModelSwitchResult;
  todoReminderSnapshot?(): { count: number; threshold: number } | null;
  runTurn(input: string, options: RunTurnOptions): AsyncIterable<AgentEvent>;
  /** Continue a terminal-control turn after rehost without a synthetic user frame. */
  continueTurn?(options: RunTurnOptions): AsyncIterable<AgentEvent>;
  /** Owned transport only. Acknowledgement does not prove model application. */
  steeringStatus?(): { supported: boolean; ready: boolean; nativeTurnId?: string };
  steer?(input: string): Promise<{ turnId: string }>;
  historyItems(): readonly HistoryItem[];
  /**
   * Fresh read of the engine's live transcript (codex: `thread/read`), for
   * callers that need every turn of this launch rather than the boot snapshot
   * `historyItems()` returns. Optional; Taskana 4068 engine switch prefers it.
   */
  readTranscript?(): Promise<readonly HistoryItem[]>;
  replaceHistory?(items: HistoryItem[]): void;
  contextBreakdown?(): ContextBreakdown;
  /**
   * Manual conversation compaction on the existing host maintenance rail.
   * Unsupported engines omit this method; Session visibly refuses the request.
   */
  compactNow?(options: { signal: AbortSignal }): AsyncIterable<AgentEvent>;
  dispose(reason: "session-close" | "host-shutdown"): Promise<void>;
}

export const CORE_ENGINE_CAPABILITIES: EngineCapabilities = {
  supportsCorePermissions: true,
  supportsRewind: true,
  supportsWorkflow: true,
  supportsGitMutations: true,
  supportsContextUsage: true,
  supportsContextBreakdown: true,
  supportsInteractiveApprovals: true,
  costAccounting: true,
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  supportsImages: true,
  supportsTasks: true,
  supportsFileSnapshots: true,
  supportsManualCompact: true,
};

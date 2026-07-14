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
  switchModel?(id: string, effort: ReasoningEffort): ModelSwitchResult;
  runTurn(input: string, options: RunTurnOptions): AsyncIterable<AgentEvent>;
  /** Continue a terminal-control turn after rehost without a synthetic user frame. */
  continueTurn?(options: RunTurnOptions): AsyncIterable<AgentEvent>;
  historyItems(): readonly HistoryItem[];
  replaceHistory?(items: HistoryItem[]): void;
  contextBreakdown?(): ContextBreakdown;
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
};

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
  readonly supportsContextBreakdown: boolean;
  readonly supportsModelSelection: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportsImages: boolean;
}

export interface ModelSwitchResult {
  model: string;
  reasoningEffort: ReasoningEffort;
  availableEffortLevels?: ReasoningEffort[];
}

export interface RunTurnOptions {
  signal: AbortSignal;
  attachments?: ImageAttachment[];
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
  historyItems(): readonly HistoryItem[];
  replaceHistory?(items: HistoryItem[]): void;
  contextBreakdown?(): ContextBreakdown;
  dispose(reason: "session-close" | "host-shutdown"): Promise<void>;
}

export const CORE_ENGINE_CAPABILITIES: EngineCapabilities = {
  supportsCorePermissions: true,
  supportsRewind: true,
  supportsContextBreakdown: true,
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  supportsImages: true,
};

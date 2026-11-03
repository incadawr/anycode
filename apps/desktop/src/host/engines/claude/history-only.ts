import type { HistoryItem } from "@anycode/core";
import type { SessionEngine } from "../session-engine.js";

/** A failed session with no native Claude reference can only display history. */
export function claudeHistoryOnlyEngine(history: readonly HistoryItem[]): SessionEngine {
  return {
    id: "claude",
    capabilities: { supportsCorePermissions: false, supportsRewind: false, supportsWorkflow: false, supportsGitMutations: false, supportsContextUsage: false, supportsContextBreakdown: false, supportsInteractiveApprovals: false, costAccounting: false, supportsModelSelection: false, supportsReasoningEffort: false, supportsImages: false, supportsTasks: false, supportsFileSnapshots: false, supportsManualCompact: false },
    mode: () => "build",
    reasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    historyItems: () => history,
    async *runTurn() {
      yield { type: "error", error: new Error("This session has no native session to continue. Start a new session."), safe: { code: "history_only", message: "This session has no native session to continue. Start a new session." } };
      yield { type: "loop_end", reason: "error", turns: 0 };
    },
    dispose: async () => {},
  };
}

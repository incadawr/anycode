/**
 * Turn-end auto-open artifact collector (night-track wave-1 cut §1(a)/§2.8,
 * TASK.96 96-E). A small pure class — zero I/O, engine-agnostic — that
 * Session drains once per turn (`turn_end`, including an aborted/cancelled
 * turn) to build the `PREVIEW_ARTIFACTS` message body (shared/preview.ts).
 *
 * Detection mirrors the snapshot-hook precedent (host/snapshot-hook.ts)
 * EXACTLY — same `/^(Write|Edit)$/` matcher, same `file_path` extraction —
 * but is DELIBERATELY independent of `engine.capabilities.supportsFileSnapshots`
 * (that flag gates the diff-view "before/after" feature only; codex/claude
 * both report `supportsFileSnapshots:false` while still emitting path-carrying
 * Write/Edit events per the translator fixtures — cut recon note, risk §5.3).
 * Both foreign-engine projections (codex's apply_patch -> toolName "Write"
 * with `input.file_path`; claude's native "Write"/"Edit" tool_use, same
 * `file_path` field) are covered by construction because the extraction is
 * the SAME `file_path`-reading helper core's own tools populate. An engine
 * whose write event carries no `file_path` (none known today) silently
 * contributes nothing — auto-open no-ops for it rather than guessing a path.
 */

import type { AgentEvent, ToolCallOutcome } from "@anycode/core";
import { extractSnapshotPath, isSnapshotTool } from "./snapshot-hook.js";

/** Auto-open candidates (cut §1(a)): rendered file kinds PreviewHost/BrowserOpen understand. */
const PREVIEWABLE_EXTENSION = /\.(html?|md)$/i;

export class PreviewArtifactCollector {
  /** toolCallId -> candidate path, captured at tool_execution_start, consumed at the matching tool_result. */
  private readonly pending = new Map<string, string>();
  /** Ordered, deduped-by-path accumulator for the turn in progress; last write wins the ordering position. */
  private paths: string[] = [];

  /** Feed every `AgentEvent` of the turn; captures a Write/Edit's target path, no-op for everything else. */
  observeStart(event: AgentEvent): void {
    if (event.type !== "tool_execution_start" || !isSnapshotTool(event.toolName)) {
      return;
    }
    const path = extractSnapshotPath(event.input);
    if (path !== null) {
      this.pending.set(event.toolCallId, path);
    }
  }

  /** Feed every `ToolCallOutcome` of the turn; records the path iff the matching start captured one AND the call succeeded AND the extension qualifies. */
  observeResult(outcome: ToolCallOutcome): void {
    const path = this.pending.get(outcome.toolCallId);
    this.pending.delete(outcome.toolCallId);
    if (path === undefined || outcome.status !== "success" || !PREVIEWABLE_EXTENSION.test(path)) {
      return;
    }
    // Dedup by path (cut §1(a)): a file written twice this turn moves to the
    // end of the ordering (last-write-wins) instead of appearing twice.
    const existing = this.paths.indexOf(path);
    if (existing !== -1) {
      this.paths.splice(existing, 1);
    }
    this.paths.push(path);
  }

  /** Returns the collected paths and clears ALL state (including any still-pending starts) — call exactly once per turn end, whatever the turn's outcome (normal, error, or abort/cancel). */
  drain(): string[] {
    const result = this.paths;
    this.paths = [];
    this.pending.clear();
    return result;
  }
}

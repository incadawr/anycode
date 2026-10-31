import { randomUUID } from "node:crypto";
import type { ProviderUsageAudit, Session } from "./session.js";
import type { CodexEngine } from "./engines/codex/codex-engine.js";
import type { ClaudeEngine } from "./engines/claude/claude-engine.js";
import { claudeUsageRecord } from "./claude-usage.js";

/**
 * Native engines report their own usage snapshots (one per model request),
 * and those snapshots carry no host turn of their own. The context popover
 * selects the live turn by the host's turn id, so a standalone id here would
 * hide "this turn" the moment a native turn ends. Hand the row to the live
 * session instead: it stamps the host turn id when the request belongs to a
 * turn and keeps the sink's own write-behind/fail-soft path.
 */
type NativeRow = Omit<Parameters<ProviderUsageAudit["record"]>[0], "turnId" | "step">;

function deliver(sink: ProviderUsageAudit, session: Session | null, row: NativeRow, belongsToTurn: boolean): void {
  // No session yet (usage reported during boot) — the old standalone row is
  // still the honest record; the session path just adds turn identity.
  if (session === null) sink.record({ ...row, turnId: randomUUID(), step: 1 });
  else session.recordNativeUsage(row, belongsToTurn);
}

/** Codex reports per-request usage only inside its own turn translator. */
export function bindCodexUsage(engine: CodexEngine, sink: ProviderUsageAudit, session: () => Session | null): void {
  engine.onUsage((usage) =>
    deliver(sink, session(), { model: engine.usageModel(), ...usage, finishReason: "unknown", transportRetries: 0 }, true),
  );
}

/**
 * Claude results arrive for the owner turn (translator — `belongsToTurn`) and
 * for results that belong to no turn at all: a compaction summarization or an
 * absorbed foreign turn. Only the former may join the live turn's steps.
 */
export function bindClaudeUsage(
  engine: ClaudeEngine,
  sink: ProviderUsageAudit,
  session: () => Session | null,
  fallbackModel: string,
): void {
  engine.onCostResult((result, belongsToTurn) => {
    const { turnId: _turnId, step: _step, ...row } = claudeUsageRecord(result, "", engine.resolvedModel() ?? fallbackModel);
    deliver(sink, session(), row, belongsToTurn);
  });
}

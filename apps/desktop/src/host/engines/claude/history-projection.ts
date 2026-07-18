/**
 * Read side of the Claude shadow transcript mirror (SLICE-CC D-min, cut
 * §1.5). Deliberately simpler than codex's history-projection.ts: `--resume`
 * gives us the FULL live stream on every process, so there is no lossy
 * native-source to merge against — the mirror rows already carry ready
 * `HistoryItem` projections (written by shadow-transcript.ts), and this
 * module's only job is to put them back in the order they were produced.
 */

import type { ClaudeTranscriptItem, HistoryItem } from "@anycode/core";

/** Orders mirror rows by (turnOrdinal, positionInTurn) and unwraps their projected items. Pure — no I/O. */
export function projectClaudeHistory(rows: readonly ClaudeTranscriptItem[]): HistoryItem[] {
  return [...rows]
    .sort((a, b) => a.turnOrdinal - b.turnOrdinal || a.positionInTurn - b.positionInTurn)
    .map((row) => row.data as HistoryItem);
}

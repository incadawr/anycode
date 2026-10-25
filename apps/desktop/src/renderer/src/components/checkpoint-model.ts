/**
 * Checkpoint/rewind pure model (Taskana 4742). The survivors of the removed
 * TimelinePanel dock panel (`TimelinePanel.tsx`, slice P7.26/R2) plus the new
 * turn→checkpoint matching the left-edge tick rail needs. Pure by design —
 * no React, no store, no DOM — same posture as TranscriptMinimap's own
 * projection helpers:
 *
 *  - `sortCheckpointsNewestFirst` / `buildRewindRequest` moved VERBATIM from
 *    TimelinePanel.tsx (their bodies are byte-identical; only the home
 *    changed). `automation.ts` still consumes the sorter for the
 *    `/tabs/:id/checkpoints`/`rewind` routes.
 *  - `deriveTurnLabel` is the renderer-side mirror of core's
 *    `deriveCheckpointLabel` (`packages/core/src/checkpoints/shadow-git.ts`)
 *    — deliberately NOT an import: renderer runtime code may only ever
 *    `import type` from `@anycode/core` (a value import would drag the core
 *    barrel into the web bundle), so the rule is copied and pinned here by
 *    the test table below.
 *  - `matchCheckpointsToTurns` maps transcript user turns to their
 *    auto-captured checkpoints by label + chronological order (a checkpoint
 *    carries NO turn/message id — the label is all the wire gives us).
 */
import type { UiToHostMessage, WireCheckpointMeta } from "../../../shared/protocol.js";

/** Mirror of core's CHECKPOINT_LABEL_MAX_CHARS (shadow-git.ts). */
export const CHECKPOINT_LABEL_MAX_CHARS = 64;

/**
 * Newest-first timeline order (§7 of the retired panel's design: a TIMELINE,
 * not array/creation order — `checkpoint_list`'s wire order is a store-read
 * detail, not a UI contract). Moved verbatim from TimelinePanel.tsx.
 */
export function sortCheckpointsNewestFirst(checkpoints: readonly WireCheckpointMeta[]): WireCheckpointMeta[] {
  return [...checkpoints].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The SOLE constructor of a `rewind_request` (mirror of git's
 * `buildConfirmedGitCommand` — one pure builder, exercised directly by the
 * unit gate, used by exactly one call site: the tick-rail popover's confirm).
 * v1 scope is always `"both"` (design §4: no files/conversation toggle yet).
 * Moved verbatim from TimelinePanel.tsx.
 */
export function buildRewindRequest(checkpointId: string, requestId: string): Extract<UiToHostMessage, { type: "rewind_request" }> {
  return { type: "rewind_request", requestId, checkpointId, scope: "both" };
}

/**
 * Renderer-side copy of core's `deriveCheckpointLabel`
 * (packages/core/src/checkpoints/shadow-git.ts — keep the two in sync; the
 * test table in checkpoint-model.test.ts pins this mirror against
 * shadow-git.test.ts's). Rule: first line of the prompt, C0 control chars
 * (incl. tab/CR) and DEL dropped, trimmed, sliced to 64 chars.
 */
export function deriveTurnLabel(userInput: string): string {
  const firstLine = userInput.split("\n", 1)[0] ?? "";
  let cleaned = "";
  for (const ch of firstLine) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 control chars (incl. tab/CR) and DEL.
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += ch;
  }
  return cleaned.trim().slice(0, CHECKPOINT_LABEL_MAX_CHARS);
}

/**
 * Map transcript user turns to their auto-captured checkpoints (Taskana
 * 4742 §2.3). A checkpoint carries no turn/message id — only the label core
 * derived from the turn's prompt (`deriveTurnLabel` above) and `createdAt`.
 * The rail's "Rewind to before this message" action is offered ONLY for a
 * turn with a matched checkpoint; never a guess.
 *
 * Algorithm: keep only `reason === "auto"` checkpoints (pre-rewind safety
 * snapshots label nothing the user typed), sort ascending by `createdAt`
 * (stable on ties); walk the turns in transcript order with a forward-only
 * cursor over that list; for each turn take the first not-yet-consumed
 * checkpoint at/after the cursor whose label equals the turn's derived
 * label, advancing the cursor past it; otherwise `null` (the turn had no
 * write-effect tool → no checkpoint, or its label no longer matches after a
 * rewind/compaction — then simply no rewind button). One checkpoint is never
 * reused for two turns (the cursor only moves forward, and a consumed
 * checkpoint is skipped).
 *
 * The forward-only cursor is what makes duplicate prompts honest: "continue"
 * ×3 with 2 checkpoints matches the FIRST TWO turns in order (each consumes
 * the next unused "continue" checkpoint) and leaves the third null — a
 * two-pointer walk over label equality alone would be ambiguous there.
 */
export function matchCheckpointsToTurns(
  turnTexts: readonly string[],
  checkpoints: readonly WireCheckpointMeta[],
): (string | null)[] {
  const autos = checkpoints
    .filter((checkpoint) => checkpoint.reason === "auto")
    .map((checkpoint, index) => ({ checkpoint, index }))
    .sort((a, b) => a.checkpoint.createdAt - b.checkpoint.createdAt || a.index - b.index);
  const used = new Set<number>();
  let cursor = 0;
  const matched: (string | null)[] = [];
  for (const text of turnTexts) {
    const label = deriveTurnLabel(text);
    let hit: string | null = null;
    if (label !== "") {
      for (let i = cursor; i < autos.length; i += 1) {
        const entry = autos[i]!;
        if (used.has(entry.index)) {
          // Skip a consumed entry without advancing the cursor past a still-
          // unused one that precedes it (ties/ordering edge): the cursor is
          // a hint, not an invariant.
          continue;
        }
        if (entry.checkpoint.label === label) {
          hit = entry.checkpoint.id;
          used.add(entry.index);
          cursor = i + 1;
          break;
        }
      }
    }
    matched.push(hit);
  }
  return matched;
}

/**
 * Gate for the popover's "Rewind to before this message" action (Taskana
 * 4742 §2.4): shown only when the tab supports rewind (the owner already
 * resolved `engine?.capabilities.supportsRewind ?? true` — an absent
 * `rewind` prop means no), the turn has a MATCHED checkpoint, and the list
 * is not read-only (a read-only pane never passes a `rewind` prop, so
 * `hasRewindProps` false covers it). Pure so the gating is pinnable.
 */
export function railActionsFor(
  checkpointId: string | null,
  hasRewindProps: boolean,
): { canRewind: boolean } {
  return { canRewind: hasRewindProps && checkpointId !== null };
}

/** Human label for a checkpoint's capture reason — same text the old TimelinePanel rows showed (automation's /tabs/:id/checkpoints keeps serving it byte-identically). */
export function formatCheckpointReason(reason: WireCheckpointMeta["reason"]): string {
  return reason === "auto" ? "Auto" : "Pre-rewind";
}

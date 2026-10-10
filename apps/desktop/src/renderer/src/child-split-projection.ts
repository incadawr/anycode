/**
 * TASK.218 (supervisor correction 4): the pure projection seam for the split
 * stack's rows — extracted from App.tsx's `resolveChildRowCard`/`childSplitRows`
 * composition so the continuation panel logic is testable WITHOUT mounting
 * React: a test drives the REAL relation store (registerPort's registrations)
 * and the master transcript, and reads exactly what the pane would paint.
 *
 * Everything here is pure: (relations, transcript, live stores, view) in,
 * rows out. App.tsx's ActiveTabBody feeds it the same inputs it already
 * subscribed to; no store of its own, no DOM.
 */
import type { DesktopStoreApi } from "./tab-registry.js";
import type { TranscriptBlock } from "./store.js";
import type { SubagentSubStatus } from "./store.js";
import type { ChildSplitRow } from "./components/ChildSplitPane.js";
import {
  childBadgeKind,
  continuationSiblingSpawnIds,
  detachedOutcomeFromParent,
  lastLiveChildCard,
  rememberLiveChildCard,
  withLiveChildCounters,
} from "./child-layout.js";
import { childRelationKey, spawnToolCallIdForChild, type ChildRelation } from "./child-sessions.js";

/**
 * CUT-S3 §3.3's "отсутствующая карточка → фолбэк ..., как в B" fallback: a
 * split row's counters need every field, and the card is genuinely unknown
 * here, so zero-valued is the honest reading.
 */
export const FALLBACK_SUBAGENT_CARD: SubagentSubStatus = {
  agentType: "Subagent",
  description: "",
  model: null,
  engine: null,
  turns: 0,
  toolCalls: 0,
  lastTool: null,
  activity: [],
  activityDropped: 0,
  final: null,
};

/**
 * A spawn block whose `subagent_start` never reached this renderer (F11: a
 * detached Agent call) still names its child in its own input — the row
 * keeps the requested agent type and description instead of "Subagent".
 */
export function fallbackCardFromInput(input: unknown): SubagentSubStatus {
  if (typeof input !== "object" || input === null) {
    return FALLBACK_SUBAGENT_CARD;
  }
  const { agent_type: agentType, description } = input as { agent_type?: unknown; description?: unknown };
  return {
    ...FALLBACK_SUBAGENT_CARD,
    ...(typeof agentType === "string" && agentType !== "" ? { agentType } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}

/**
 * One child row's card (App.tsx's `resolveChildRowCard`, extracted verbatim
 * in behavior): the master's per-call Agent cards for the row's EFFECTIVE id
 * and every continuation sibling, merged by `mergeContinuationCards`' frozen
 * discipline; for a detached call the child's live store, else the last card
 * this renderer saw live, else the outcome the parent's `<task-notification>`
 * reported — never "running" for a child that has ended.
 */
export function resolveChildRowCard(
  spawnToolCallId: string,
  siblingIds: readonly string[],
  parentTranscript: readonly TranscriptBlock[],
  childStore: DesktopStoreApi | undefined,
): SubagentSubStatus {
  const defined = (sourced: SourcedCard | undefined): sourced is SourcedCard => sourced !== undefined;
  const sourcedCards = siblingIds.map((id) => siblingRunCard(parentTranscript, id)).filter(defined);
  // Chronological fold retaining PROVENANCE (correction 5, repeated
  // continuations): a remembered CUMULATIVE snapshot supersedes the prefix
  // totals it already contains (the resumed child's transcript replays the
  // whole logical child's history — its totals OVERLAP every earlier
  // sibling's, so summing them double-counts); per-run cards ADD to
  // whatever prefix they follow. Duration stays unknown (-1) once any
  // needed run's duration is unknown, until a later authoritative
  // cumulative snapshot supersedes it with a known total.
  const { baseCard, durationMs } = foldSiblings(sourcedCards);
  // `detached` follows the row's EFFECTIVE (latest) call — the continuation
  // of a detached child is itself a per-call card the parent never sees
  // progress for.
  const lastBlock = parentTranscript.find(
    (entry) => entry.kind === "tool_call" && entry.toolCallId === spawnToolCallId,
  );
  if (!lastBlock || lastBlock.kind !== "tool_call") {
    return baseCard;
  }
  const detached = (lastBlock.input as { detach?: unknown } | null)?.detach === true;
  if (childStore !== undefined) {
    const state = childStore.getState();
    // A LIVE store exists only for the EFFECTIVE (latest) spawn — the child
    // session itself, resumed. Its transcript is CUMULATIVE across the whole
    // logical child's history, so the counters it yields already include
    // every prior run's contribution. It is therefore NEVER summed with the
    // prior per-run totals (correction 5: no double count); the prior totals
    // only act as a FLOOR via max semantics, for the boot window before the
    // resumed store has replayed its history.
    const liveCard = withLiveChildCounters(
      baseCard,
      { transcript: state.transcript, modelTurns: state.modelTurns, running: state.turn.status !== "idle" },
      detached,
    );
    if (detached) rememberLiveChildCard(spawnToolCallId, liveCard);
    return liveCard;
  }
  if (!detached || baseCard.final !== null) {
    return baseCard;
  }
  const remembered = lastLiveChildCard(spawnToolCallId);
  const outcome = detachedOutcomeFromParent(parentTranscript, spawnToolCallId);
  const card: SubagentSubStatus = remembered ?? baseCard;
  if (card.final !== null || outcome === null) {
    return card;
  }
  // Ended before this renderer saw its last run: the outcome is known. The
  // total DURATION was already resolved by the chronological fold
  // (`durationMs` — unknown stays -1 when no authoritative cumulative total
  // covers the unknown run; defect 2).
  return { ...card, final: { status: outcome, durationMs } };
}

/** A prefix accumulator: per-run totals so far, or a superseding cumulative snapshot. */
interface PrefixTotals {
  turns: number;
  toolCalls: number;
  durationMs: number;
  /** true while any needed run's duration is unknown and no cumulative snapshot has superseded it. */
  durationUnknown: boolean;
}

/**
 * Chronological fold over ALL siblings, retaining provenance (correction 5,
 * repeated continuations):
 *  - a CUMULATIVE snapshot (remembered off the child's own live transcript)
 *    SUPERSEDES the prefix totals — its counters already contain every
 *    earlier run's contribution (max, never sum, against the prefix to
 *    cover the replay boot window), and its known duration REPLACES the
 *    prefix's (an unknown prefix duration stops mattering: the snapshot is
 *    authoritative for the whole history up to itself);
 *  - a PER-RUN card ADDS its counters to the prefix it follows (its
 *    duration adds too, but any unknown — its own or the prefix's — makes
 *    the running duration total unknown).
 * The latest sibling's card supplies identity/status/lastTool/activity.
 */
function foldSiblings(sourcedCards: readonly SourcedCard[]): { baseCard: SubagentSubStatus; durationMs: number } {
  if (sourcedCards.length === 0) {
    return { baseCard: FALLBACK_SUBAGENT_CARD, durationMs: -1 };
  }
  let prefix: PrefixTotals = { turns: 0, toolCalls: 0, durationMs: 0, durationUnknown: false };
  for (let i = 0; i < sourcedCards.length - 1; i += 1) {
    const { card, cumulative } = sourcedCards[i]!;
    if (cumulative) {
      // Supersedes: overlaps every earlier sibling's history. The snapshot
      // REPLACES exact-total knowledge wholesale: KNOWN -> the total is
      // known (earlier uncertainty is cleared — the snapshot is
      // authoritative for everything up to itself); UNKNOWN -> unknown (it
      // covers MORE history than the prefix, so the prefix's known value is
      // not the larger history's total) — irrespective of the previous
      // prefix state (defect 4/5).
      const snapshotDuration = card.final?.durationMs;
      const snapshotKnown = snapshotDuration !== undefined && snapshotDuration >= 0;
      prefix = {
        turns: Math.max(prefix.turns, card.turns),
        toolCalls: Math.max(prefix.toolCalls, card.toolCalls),
        durationMs: snapshotKnown ? snapshotDuration : prefix.durationMs,
        durationUnknown: !snapshotKnown,
      };
    } else {
      prefix = {
        turns: prefix.turns + card.turns,
        toolCalls: prefix.toolCalls + card.toolCalls,
        durationMs:
          !prefix.durationUnknown && card.final !== null && card.final.durationMs >= 0
            ? prefix.durationMs + card.final.durationMs
            : prefix.durationMs,
        durationUnknown: prefix.durationUnknown || card.final === null || card.final.durationMs < 0,
      };
    }
  }
  const last = sourcedCards[sourcedCards.length - 1]!;
  const lastCard = last.card;
  if (last.cumulative) {
    // The latest snapshot is authoritative for the whole history — the
    // prefix only floors its counters during the replay boot window. Its
    // duration is the total ONLY when the snapshot itself carries one; an
    // unknown/absent one never inherits the prefix's earlier partial
    // knowledge as an exact whole-session total (defect 4).
    const lastDuration = lastCard.final?.durationMs;
    const lastKnown = lastDuration !== undefined && lastDuration >= 0;
    return {
      baseCard: {
        ...lastCard,
        turns: Math.max(lastCard.turns, prefix.turns),
        toolCalls: Math.max(lastCard.toolCalls, prefix.toolCalls),
      },
      durationMs: lastKnown ? lastDuration : -1,
    };
  }
  // Latest per-run card: its counters add; duration sums only when the
  // prefix's and its own are both known (defect 2).
  const lastDuration = lastCard.final !== null ? lastCard.final.durationMs : -1;
  const durationMs =
    lastDuration >= 0 && !prefix.durationUnknown ? lastDuration + prefix.durationMs : -1;
  const final = lastCard.final !== null ? { ...lastCard.final, durationMs } : null;
  return {
    baseCard: {
      ...lastCard,
      turns: lastCard.turns + prefix.turns,
      toolCalls: lastCard.toolCalls + prefix.toolCalls,
      ...(final !== null ? { final } : {}),
    },
    durationMs,
  };
}

/** One sibling's resolved per-run card plus whether it is a CUMULATIVE snapshot. */
interface SourcedCard {
  card: SubagentSubStatus;
  /**
   * true when the card came from `lastLiveChildCard` — projected off the
   * child's own LIVE transcript. For the latest sibling of a continuation
   * that transcript is the resumed child's CUMULATIVE history; such a card
   * must never be summed with prior per-run totals.
   */
  cumulative: boolean;
}

/**
 * One sibling's per-run card: the master's own Agent-card snapshot, else —
 * for a detached call whose card never heard progress (defect 1) — the last
 * card this renderer saw while that call's child host ran
 * (`lastLiveChildCard`), else the input fallback. `undefined` only when
 * nothing at all is known for that id.
 */
function siblingRunCard(parentTranscript: readonly TranscriptBlock[], id: string): SourcedCard | undefined {
  const block = parentTranscript.find((entry) => entry.kind === "tool_call" && entry.toolCallId === id);
  if (block && block.kind === "tool_call" && block.subagent !== null) {
    return { card: block.subagent, cumulative: false };
  }
  const remembered = lastLiveChildCard(id);
  if (remembered !== undefined) {
    return { card: remembered, cumulative: true };
  }
  if (block && block.kind === "tool_call") {
    return { card: fallbackCardFromInput(block.input), cumulative: false };
  }
  return undefined;
}

/** The effective-id projection inputs App.tsx already holds (TASK.218). */
export interface ChildSplitProjectionDeps {
  parentSessionId: string | null | undefined;
  relations: ReadonlyMap<string, ChildRelation>;
  transcript: readonly TranscriptBlock[];
  /** The master's live child stores, keyed by EFFECTIVE spawn id. */
  liveChildStores: ReadonlyMap<string, DesktopStoreApi>;
}

/**
 * The split stack's rows for one `view.order`: each row's DISPLAYED id stays
 * the view id (React key / `data-spawn-id` frozen), while its card resolves
 * through the EFFECTIVE id (the latest spawn registered for the same logical
 * child) plus all its continuation siblings' per-call cards.
 */
export function projectChildSplitRows(
  order: readonly string[],
  deps: ChildSplitProjectionDeps,
): readonly ChildSplitRow[] {
  const { parentSessionId, relations, transcript, liveChildStores } = deps;
  const childSessionIdOf = (id: string): string | undefined =>
    parentSessionId ? relations.get(childRelationKey(parentSessionId, id))?.childSessionId : undefined;
  const effectiveChildId = (id: string): string => {
    const cs = childSessionIdOf(id);
    return (cs !== undefined && parentSessionId ? spawnToolCallIdForChild(relations, parentSessionId, cs) : undefined) ?? id;
  };
  return order.map((id) => {
    const eff = effectiveChildId(id);
    // Shared helper (child-layout.ts, TASK.218) — no duplicated traversal here.
    const card = resolveChildRowCard(
      eff,
      continuationSiblingSpawnIds(transcript, eff, childSessionIdOf),
      transcript,
      liveChildStores.get(eff),
    );
    return { spawnToolCallId: id, card, badge: childBadgeKind(card) };
  });
}

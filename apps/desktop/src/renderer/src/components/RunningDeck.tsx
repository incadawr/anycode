import { useCallback, useEffect, useMemo, useRef } from "react";
import { formatTaskElapsed } from "../claude-background-tasks.js";
import { visibleDeckRows, type AnchorState, type DeckRow } from "../running-deck.js";
import { RunningStack, type RunningStackItem } from "../ui/index.js";
import { Robot, Terminal } from "./icons.js";

export interface RunningDeckProps {
  /** Every running row (deckRowsFrom); the deck decides which are shown. */
  readonly rows: readonly DeckRow[];
  /** Anchor states keyed by row key (useDeckAnchors). */
  readonly anchors: ReadonlyMap<string, AnchorState>;
  readonly blockIdByToolCall: ReadonlyMap<string, string>;
  readonly elapsedNow: number;
  readonly onJumpToBlock: (blockId: string) => void;
  /** Folded into one "N running" chip (owned per tab by the host). */
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  /** No room for rows (the host's placement): only the count chip shows. */
  readonly chipOnly?: boolean;
}

/**
 * The sticky "Running" deck: what is running and has no visible live card, as a RunningStack. This adapter maps the deck's rows
 * (the model in running-deck.ts) onto the kit's items; the host owns the store, the anchors and the placement.
 */
export function RunningDeck(props: RunningDeckProps) {
  const { rows, anchors, blockIdByToolCall, elapsedNow, onJumpToBlock, collapsed, onCollapsedChange, chipOnly } = props;
  const blockIdOf = useCallback(
    (row: DeckRow): string | undefined => (row.toolCallId === undefined ? undefined : blockIdByToolCall.get(row.toolCallId)),
    [blockIdByToolCall],
  );
  // The kit freezes the list while the pointer is on the stack, so a row can be clicked after its work ended and it left `rows`.
  // Its card is still there: remember each row's block id, so that click still jumps.
  const knownBlocks = useRef(new Map<string, string>());
  const items = useMemo<readonly RunningStackItem[]>(
    () => visibleDeckRows(rows, anchors).map(row => {
      const blockId = blockIdOf(row);
      if (blockId !== undefined) {
        knownBlocks.current.set(row.key, blockId);
      }
      return {
        key: row.key,
        icon: row.kind === "child" ? <Robot width={14} height={14} /> : <Terminal width={14} height={14} />,
        typeLabel: row.typeLabel,
        title: row.title,
        meta: formatTaskElapsed(row.startedAt, elapsedNow),
        detail: row.detail,
        activatable: blockId !== undefined,
      };
    }),
    [rows, anchors, elapsedNow, blockIdOf],
  );
  useEffect(() => {
    if (rows.length === 0) {
      knownBlocks.current.clear();
    }
  }, [rows.length]);
  const onActivate = useCallback((key: string) => {
    const blockId = knownBlocks.current.get(key);
    if (blockId !== undefined) {
      onJumpToBlock(blockId);
    }
  }, [onJumpToBlock]);
  return <RunningStack items={items} collapsed={collapsed} onCollapsedChange={onCollapsedChange} onActivate={onActivate} chipOnly={chipOnly} />;
}

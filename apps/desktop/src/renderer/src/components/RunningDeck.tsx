import { useCallback, useMemo } from "react";
import { formatTaskElapsed } from "../claude-background-tasks.js";
import { visibleDeckRows, type AnchorState, type DeckRow } from "../running-deck.js";
import { PeekStack, type PeekStackItem } from "../ui/index.js";
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
 * The sticky "Running" deck: what is running and has no visible live card, as a PeekStack. This adapter maps the deck's rows
 * (the model in running-deck.ts) onto the kit's items; the host owns the store, the anchors and the placement.
 */
export function RunningDeck(props: RunningDeckProps) {
  const { rows, anchors, blockIdByToolCall, elapsedNow, onJumpToBlock, collapsed, onCollapsedChange, chipOnly } = props;
  const blockIdOf = useCallback(
    (row: DeckRow): string | undefined => (row.toolCallId === undefined ? undefined : blockIdByToolCall.get(row.toolCallId)),
    [blockIdByToolCall],
  );
  const items = useMemo<readonly PeekStackItem[]>(
    () => visibleDeckRows(rows, anchors).map(row => ({
      key: row.key,
      icon: row.kind === "child" ? <Robot width={14} height={14} /> : <Terminal width={14} height={14} />,
      typeLabel: row.typeLabel,
      title: row.title,
      meta: formatTaskElapsed(row.startedAt, elapsedNow),
      detail: row.detail,
      activatable: blockIdOf(row) !== undefined,
    })),
    [rows, anchors, elapsedNow, blockIdOf],
  );
  const onActivate = useCallback((key: string) => {
    const row = rows.find(r => r.key === key);
    const blockId = row === undefined ? undefined : blockIdOf(row);
    if (blockId !== undefined) {
      onJumpToBlock(blockId);
    }
  }, [rows, blockIdOf, onJumpToBlock]);
  return <PeekStack items={items} collapsed={collapsed} onCollapsedChange={onCollapsedChange} onActivate={onActivate} chipOnly={chipOnly} />;
}

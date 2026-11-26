import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { cardShowsRunning } from "./components/ToolCallCard.js";
import { findLaidOutAnchor } from "./components/MessageList.js";
import type { AnchorState, DeckRow } from "./running-deck.js";
import type { ToolCallBlock, TranscriptBlock } from "./store.js";
import { TabContext } from "./tab-context.js";

type AnchorMap = ReadonlyMap<string, AnchorState>;

const EMPTY_ANCHORS: AnchorMap = new Map();
const NO_CARD: AnchorState = { hasCard: false, live: false, above: false, distance: Number.POSITIVE_INFINITY };

let lastIdsKey: string | null = null;
let lastIdMap: ReadonlyMap<string, string> = new Map();

/** toolCallId -> block id. Memoised on the ordered tool_call ids, so unrelated block changes keep the same Map. */
export function blockIdByToolCall(blocks: readonly TranscriptBlock[]): ReadonlyMap<string, string> {
  const tools = blocks.filter((block): block is ToolCallBlock => block.kind === "tool_call");
  const key = tools.map(block => `${block.id}\u0000${block.toolCallId}`).join("\u0001");
  if (key === lastIdsKey) {
    return lastIdMap;
  }
  lastIdsKey = key;
  lastIdMap = new Map(tools.map(block => [block.toolCallId, block.id] as const));
  return lastIdMap;
}

/** The requested tool_call blocks by toolCallId; no work at all when nothing is requested. */
export function toolBlocksFor(
  blocks: readonly TranscriptBlock[],
  toolCallIds: ReadonlySet<string>,
): ReadonlyMap<string, ToolCallBlock> {
  if (toolCallIds.size === 0) {
    return new Map();
  }
  return new Map(
    blocks
      .filter((block): block is ToolCallBlock => block.kind === "tool_call" && toolCallIds.has(block.toolCallId))
      .map(block => [block.toolCallId, block] as const),
  );
}

export function resolveAnchorElement(list: HTMLElement, blockId: string): HTMLElement | null {
  return findLaidOutAnchor(list, blockId);
}

/** Above from `rectBottom <= collapsedDeckBottom`; stays above until it clears the bottom by more than `hysteresisPx`. */
export function isAbove(rectBottom: number, collapsedDeckBottom: number, wasAbove: boolean, hysteresisPx = 4): boolean {
  return rectBottom <= collapsedDeckBottom + (wasAbove ? hysteresisPx : 0);
}

const sameAnchor = (a: AnchorState, b: AnchorState): boolean =>
  a.hasCard === b.hasCard && a.live === b.live && a.above === b.above && a.distance === b.distance;

const sameAnchors = (a: AnchorMap, b: AnchorMap): boolean =>
  a.size === b.size && [...b].every(([key, next]) => {
    const prev = a.get(key);
    return prev !== undefined && sameAnchor(prev, next);
  });

export interface UseDeckAnchorsArgs {
  readonly listRef: RefObject<HTMLElement | null>;
  readonly blocks: readonly TranscriptBlock[];
  readonly rows: readonly DeckRow[];
  /** Bottom edge of the COLLAPSED deck (collapsed height + --deck-top), never the open height. */
  readonly collapsedDeckBottom: () => number;
}

export function useDeckAnchors(args: UseDeckAnchorsArgs): AnchorMap {
  const ctx = useContext(TabContext);
  const [anchors, setAnchors] = useState<AnchorMap>(EMPTY_ANCHORS);
  const latest = useRef({ args, ctx, anchors });
  latest.current = { args, ctx, anchors };
  const nodes = useRef(new Map<string, HTMLElement>());
  const frame = useRef<number | null>(null);

  const read = useRef(() => {
    const { args: a, ctx: c, anchors: previous } = latest.current;
    const list = a.listRef.current;
    if (!list || a.rows.length === 0) {
      if (previous.size !== 0) {
        setAnchors(EMPTY_ANCHORS);
      }
      return;
    }
    const idByCall = blockIdByToolCall(a.blocks);
    const toolBlocks = toolBlocksFor(a.blocks, new Set(a.rows.flatMap(r => (r.toolCallId === undefined ? [] : [r.toolCallId]))));
    const tasks = c?.store.getState().claudeTaskByToolCall ?? {};
    const deckBottom = a.collapsedDeckBottom();
    const next = new Map(
      a.rows.map((r): [string, AnchorState] => {
        const blockId = r.toolCallId === undefined ? undefined : idByCall.get(r.toolCallId);
        const block = r.toolCallId === undefined ? undefined : toolBlocks.get(r.toolCallId);
        if (blockId === undefined || block === undefined) {
          return [r.key, NO_CARD];
        }
        const cached = nodes.current.get(blockId);
        const el = cached?.isConnected ? cached : resolveAnchorElement(list, blockId);
        if (el === null) {
          nodes.current.delete(blockId);
          return [r.key, NO_CARD];
        }
        nodes.current.set(blockId, el);
        const bottom = el.getBoundingClientRect().bottom;
        return [r.key, {
          hasCard: true,
          live: cardShowsRunning(block, r.toolCallId === undefined ? undefined : tasks[r.toolCallId]),
          above: isAbove(bottom, deckBottom, previous.get(r.key)?.above ?? false),
          distance: bottom - deckBottom,
        }];
      }),
    );
    if (!sameAnchors(previous, next)) {
      setAnchors(next);
    }
  }).current;

  const schedule = useRef(() => {
    if (frame.current !== null) {
      return;
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      read();
    });
  }).current;

  useEffect(() => {
    const list = args.listRef.current;
    if (!list) {
      return;
    }
    list.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [args.listRef, schedule]);

  useEffect(() => {
    schedule();
  }, [args.blocks, args.rows, schedule]);

  return anchors;
}

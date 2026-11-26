import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cardShowsRunning } from "./components/ToolCallCard.js";
import { findLaidOutAnchor } from "./block-anchor.js";
import type { AnchorState, DeckRow } from "./running-deck.js";
import type { ToolCallBlock, TranscriptBlock } from "./store.js";
import { TabContext } from "./tab-context.js";

type AnchorMap = ReadonlyMap<string, AnchorState>;

const EMPTY_ANCHORS: AnchorMap = new Map();
const NO_CARD: AnchorState = { hasCard: false, live: false, above: false, distance: Number.POSITIVE_INFINITY };

export interface BlockIdEntry {
  readonly key: string;
  readonly map: ReadonlyMap<string, string>;
}

/** toolCallId -> block id (live: same id; hydrated: `item:part`). Pure. */
export function blockIdByToolCall(blocks: readonly TranscriptBlock[]): ReadonlyMap<string, string> {
  return blockIdEntry(null, blocks).map;
}

/** Same as `blockIdByToolCall`, but returns `prev` (same Map identity) while the ordered tool_call ids are unchanged. */
export function blockIdEntry(prev: BlockIdEntry | null, blocks: readonly TranscriptBlock[]): BlockIdEntry {
  const tools = blocks.filter((block): block is ToolCallBlock => block.kind === "tool_call");
  const key = tools.map(block => `${block.id}\u0000${block.toolCallId}`).join("\u0001");
  return prev !== null && prev.key === key
    ? prev
    : { key, map: new Map(tools.map(block => [block.toolCallId, block.id] as const)) };
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

/** `distance` is deliberately not compared: it changes every scroll frame; only the ORDER it implies matters (see `aboveOrder`). */
const sameAnchor = (a: AnchorState, b: AnchorState): boolean =>
  a.hasCard === b.hasCard && a.live === b.live && a.above === b.above;

const sameAnchors = (a: AnchorMap, b: AnchorMap): boolean =>
  a.size === b.size && [...b].every(([key, next]) => {
    const prev = a.get(key);
    return prev !== undefined && sameAnchor(prev, next);
  });

/** Keys of the visible above-rows, nearest the viewport top first (distance is negative above: least negative first). */
const aboveOrder = (anchors: AnchorMap): string =>
  [...anchors]
    .filter(([, a]) => a.hasCard && a.live && a.above)
    .sort(([ka, a], [kb, b]) => b.distance - a.distance || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([key]) => key)
    .join("\u0000");

export interface UseDeckAnchorsArgs {
  readonly listRef: RefObject<HTMLElement | null>;
  readonly blocks: readonly TranscriptBlock[];
  readonly rows: readonly DeckRow[];
  /** toolCallId -> block id, built once per `blocks` by the caller. */
  readonly idByCall: ReadonlyMap<string, string>;
  /** Bottom edge of the COLLAPSED deck (collapsed height + --deck-top), never the open height. */
  readonly collapsedDeckBottom: () => number;
}

export interface DeckAnchors {
  readonly anchors: AnchorMap;
  /** Coalesces into one rAF read; for callers that know the geometry changed (e.g. the todo card resized). */
  readonly schedule: () => void;
}

export function useDeckAnchors(args: UseDeckAnchorsArgs): DeckAnchors {
  const ctx = useContext(TabContext);
  const [anchors, setAnchors] = useState<AnchorMap>(EMPTY_ANCHORS);
  // O(blocks) work happens only when `blocks` or the SET of wanted toolCallIds changes
  // (a key string), never on a rows-only change and never per scroll frame.
  const wantedKey = args.rows.flatMap(r => (r.toolCallId === undefined ? [] : [r.toolCallId])).sort().join("\u0000");
  const toolBlocks = useMemo(
    () => toolBlocksFor(args.blocks, new Set(wantedKey === "" ? [] : wantedKey.split("\u0000"))),
    [args.blocks, wantedKey],
  );
  const derived = useMemo(() => ({ idByCall: args.idByCall, toolBlocks }), [args.idByCall, toolBlocks]);
  const latest = useRef({ args, ctx, anchors, derived });
  latest.current = { args, ctx, anchors, derived };
  const nodes = useRef(new Map<string, HTMLElement>());
  // Block ids whose element was not laid out; not re-queried until `blocks` change or the list's content height does.
  const missing = useRef(new Set<string>());
  const missingHeight = useRef(-1);
  const publishedOrder = useRef("");
  const frame = useRef<number | null>(null);

  const read = useRef(() => {
    const { args: a, ctx: c, anchors: previous, derived: d } = latest.current;
    const list = a.listRef.current;
    if (!list || a.rows.length === 0) {
      if (previous.size !== 0) {
        setAnchors(EMPTY_ANCHORS);
      }
      return;
    }
    const { idByCall, toolBlocks } = d;
    if (list.scrollHeight !== missingHeight.current) {
      missingHeight.current = list.scrollHeight;
      missing.current.clear();
    }
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
        if (!cached?.isConnected && missing.current.has(blockId)) {
          return [r.key, NO_CARD];
        }
        const el = cached?.isConnected ? cached : resolveAnchorElement(list, blockId);
        if (el === null) {
          nodes.current.delete(blockId);
          missing.current.add(blockId);
          return [r.key, NO_CARD];
        }
        missing.current.delete(blockId);
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
    const live = new Set(a.rows.flatMap(r => {
      const id = r.toolCallId === undefined ? undefined : idByCall.get(r.toolCallId);
      return id === undefined ? [] : [id];
    }));
    [...nodes.current.keys()].filter(id => !live.has(id)).forEach(id => nodes.current.delete(id));
    const order = aboveOrder(next);
    if (!sameAnchors(previous, next) || order !== publishedOrder.current) {
      publishedOrder.current = order;
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
    missing.current.clear();
  }, [args.blocks]);

  useEffect(() => {
    schedule();
  }, [args.blocks, args.rows, schedule]);

  // A task status change is a trigger too: one rAF read of O(rows).
  useEffect(() => {
    if (ctx === null) {
      return;
    }
    let tasks = ctx.store.getState().claudeTaskByToolCall;
    return ctx.store.subscribe(state => {
      if (state.claudeTaskByToolCall !== tasks) {
        tasks = state.claudeTaskByToolCall;
        schedule();
      }
    });
  }, [ctx, schedule]);

  return { anchors, schedule };
}

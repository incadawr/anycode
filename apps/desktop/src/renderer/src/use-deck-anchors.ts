import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cardShowsRunning } from "./components/ToolCallCard.js";
import { findLaidOutAnchor, findLaidOutAnchorEntry, isLaidOut, type LaidOutAnchor } from "./block-anchor.js";
import type { AnchorState, DeckRow } from "./running-deck.js";
import type { ToolCallBlock, TranscriptBlock } from "./store.js";
import { TabContext } from "./tab-context.js";

type AnchorMap = ReadonlyMap<string, AnchorState>;

const EMPTY_ANCHORS: AnchorMap = new Map();
/**
 * The root of a collapsed stack of cards. A collapsed stack puts its FIRST member's block id on its own root, and the other members on
 * hidden anchors, so an element carrying a card's id can still be only the stack that holds it: its header reads "Success" and shows
 * nothing about running work.
 */
const STACK_ROOT = ".tool-call-stack, .agent-message-stack";
const isTheCard = (el: HTMLElement, blockId: string): boolean => el.getAttribute("data-block-id") === blockId && !el.matches(STACK_ROOT);

const NO_CARD: AnchorState = { hasCard: false, live: false, above: false, distance: Number.POSITIVE_INFINITY };

export interface BlockIdEntry {
  /** The ordered tool calls the map was built from, flattened as [blockId, toolCallId, blockId, toolCallId, ...]. */
  readonly pairs: readonly string[];
  readonly map: ReadonlyMap<string, string>;
}

/** toolCallId -> block id (live: same id; hydrated: `item:part`). Pure. */
export function blockIdByToolCall(blocks: readonly TranscriptBlock[]): ReadonlyMap<string, string> {
  return blockIdEntry(null, blocks).map;
}

/**
 * Same as `blockIdByToolCall`, but returns `prev` (same Map identity) while the ordered tool_call ids are unchanged. Every text flush
 * of a streaming turn replaces `blocks`, so the unchanged case is the hot one: one pass, no allocation, nothing built unless a tool
 * call was added, removed or renumbered.
 */
export function blockIdEntry(prev: BlockIdEntry | null, blocks: readonly TranscriptBlock[]): BlockIdEntry {
  let count = 0;
  let same = prev !== null;
  for (const block of blocks) {
    if (block.kind !== "tool_call") {
      continue;
    }
    if (same && (prev!.pairs[2 * count] !== block.id || prev!.pairs[2 * count + 1] !== block.toolCallId)) {
      same = false;
    }
    count++;
  }
  if (prev !== null && same && prev.pairs.length === 2 * count) {
    return prev;
  }
  const pairs: string[] = [];
  const map = new Map<string, string>();
  for (const block of blocks) {
    if (block.kind === "tool_call") {
      pairs.push(block.id, block.toolCallId);
      map.set(block.toolCallId, block.id);
    }
  }
  return { pairs, map };
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
  /** The transcript column inside the list. Its size changes when content above a card changes height (an image loads) with no scroll, no resize of the list and no DOM insertion. */
  readonly columnRef?: RefObject<HTMLElement | null>;
  readonly blocks: readonly TranscriptBlock[];
  readonly rows: readonly DeckRow[];
  /** toolCallId -> block id, built once per `blocks` by the caller. */
  readonly idByCall: ReadonlyMap<string, string>;
  /** Bottom edge of the COLLAPSED deck (collapsed height + --deck-top), never the open height. */
  readonly collapsedDeckBottom: () => number;
}

export interface DeckAnchors {
  readonly anchors: AnchorMap;
  /** True once a read has run with the list attached. Rows for calls that have a card must not paint before that: their position is unknown. */
  readonly ready: boolean;
  /** Coalesces into one rAF read; for callers that know the geometry changed (e.g. the todo card resized). */
  readonly schedule: () => void;
}

export function useDeckAnchors(args: UseDeckAnchorsArgs): DeckAnchors {
  const ctx = useContext(TabContext);
  const [anchors, setAnchors] = useState<AnchorMap>(EMPTY_ANCHORS);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
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
  const nodes = useRef(new Map<string, LaidOutAnchor>());
  // Block ids whose element was not laid out; not re-queried until `blocks` change or the list's content height does.
  const missing = useRef(new Set<string>());
  const missingHeight = useRef(-1);
  const publishedOrder = useRef("");
  const frame = useRef<number | null>(null);

  const read = useRef(() => {
    const { args: a, ctx: c, anchors: previous, derived: d } = latest.current;
    const list = a.listRef.current;
    if (list && !readyRef.current) {
      readyRef.current = true;
      setReady(true);
    }
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
        if (cached === undefined && missing.current.has(blockId)) {
          return [r.key, NO_CARD];
        }
        // A cached element counts while it is still laid out and the node that carries the id is still in the DOM with that id. For a
        // card in a collapsed stack the element is the stack's root (or the nearest laid-out ancestor), which stands in for the card:
        // opening the stack removes the hidden anchor, or the root's id, so the entry goes stale at once and the real card is found.
        // This keeps a running member of a collapsed stack off the DOM query on every scroll frame.
        // A stand-in is stale as soon as the node that carries the id is laid out itself: that node is the card now.
        const fresh = cached !== undefined && cached.el.isConnected && cached.via.isConnected
          && cached.via.getAttribute("data-block-id") === blockId && cached.el.getClientRects().length > 0
          && (cached.el === cached.via || !isLaidOut(cached.via));
        const found = fresh ? cached : findLaidOutAnchorEntry(list, blockId);
        if (found === null) {
          nodes.current.delete(blockId);
          missing.current.add(blockId);
          return [r.key, NO_CARD];
        }
        const el = found.el;
        missing.current.delete(blockId);
        nodes.current.set(blockId, found);
        const bottom = el.getBoundingClientRect().bottom;
        // Not the card itself: the stack that holds it is collapsed. Its header says "Success" and nothing shows that work is running,
        // so the row must stay listed even while that header is in view.
        const isCard = isTheCard(el, blockId);
        return [r.key, {
          hasCard: true,
          live: isCard && cardShowsRunning(block, r.toolCallId === undefined ? undefined : tasks[r.toolCallId]),
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
    const column = args.columnRef?.current;
    if (column) {
      observer.observe(column);
    }
    // A card can move, or appear, with no scroll and no change to `blocks`: the user opens or closes a tool-call stack or a card
    // above it. Its box does not change either, so the list's resize does not fire. A DOM change inside the list schedules a read;
    // many changes in a frame still cost one read.
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutations?.observe(list, { childList: true, subtree: true });
    return () => {
      list.removeEventListener("scroll", schedule);
      observer.disconnect();
      mutations?.disconnect();
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [args.listRef, args.columnRef, schedule]);

  useEffect(() => {
    missing.current.clear();
  }, [args.blocks]);

  // A row for a call that has a card appears in the deck only once the card's position is known. Read it synchronously, before the
  // paint, when the set of wanted calls changes: waiting for the next frame would flash a row for a card that is on screen. This is
  // the one synchronous read (rare: a task starting or ending); every other trigger stays on the coalesced rAF. When the list itself
  // mounts in the same commit it is not attached yet, so the read returns early and the frame read covers it.
  useLayoutEffect(() => {
    read();
  }, [wantedKey, read]);

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

  return { anchors, ready, schedule };
}

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStore, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import { deckRowsFrom, tasksForEngine, type DeckRow } from "../running-deck.js";
import type { DesktopState, TranscriptBlock } from "../store.js";
import { TabContext } from "../tab-context.js";
import { blockIdEntry, useDeckAnchors, type BlockIdEntry } from "../use-deck-anchors.js";
import { taskDescription } from "./ClaudeBackgroundTasks.js";
import { RunningDeck } from "./RunningDeck.js";

export interface DeckSpacing {
  /** Space between the todo card's bottom and a lowered deck (--sp-2). */
  readonly gap: number;
  /** Height kept free at the bottom for the jump-to-latest chip. */
  readonly chipZone: number;
  /** Below this many rows of room, the deck shows its chip only. */
  readonly floorRows: number;
  readonly rowHeight: number;
  /** The deck's top when nothing is in the way (--sp-3). */
  readonly defaultTop: number;
}

export interface DeckPlacement {
  readonly top: "default" | number;
  readonly chipOnly: boolean;
  readonly maxHeight: number;
}

/**
 * Where the deck sits, all values in the list's coordinates (px from the
 * scrollport's top/left). Only HORIZONTAL overlap between the deck's default
 * box and the todo card is tested: the card is always top-anchored, and the
 * result never feeds back into its own input, so it cannot oscillate.
 */
export function deckPlacement(
  deckBoxDefault: { readonly left: number; readonly width: number },
  todoCard: Pick<DOMRect, "left" | "right" | "bottom"> | null,
  spacing: DeckSpacing,
  listClientHeight: number,
): DeckPlacement {
  const overlaps = todoCard !== null
    && todoCard.left < deckBoxDefault.left + deckBoxDefault.width
    && deckBoxDefault.left < todoCard.right;
  const top = overlaps ? todoCard.bottom + spacing.gap : "default";
  const maxHeight = listClientHeight - (top === "default" ? spacing.defaultTop : top) - spacing.chipZone;
  return maxHeight < spacing.floorRows * spacing.rowHeight
    ? { top: "default", chipOnly: true, maxHeight: listClientHeight - spacing.defaultTop - spacing.chipZone }
    : { top, chipOnly: false, maxHeight };
}

type DeckSources = Pick<DesktopState, "claudeBackgroundTasks" | "backgroundTasks" | "backgroundChildren" | "engine">;

/** Stand-in when no tab provides a store (render tests): no rows, no deck. */
const EMPTY_STORE: StoreApi<DeckSources> = createStore<DeckSources>(() => ({ claudeBackgroundTasks: [], backgroundTasks: [], backgroundChildren: [], engine: null }));

/**
 * Per-tab "folded" flag. MessageList is remounted per tab (key={tabId}), so the
 * flag lives at module level like MessageList's savedScroll.
 */
const foldedTabs = new Set<string>();

/** Test hook: forget every tab's folded flag. */
export function resetFoldedDecks(): void {
  foldedTabs.clear();
}

const TICK_MS = 1000;
const FLOOR_ROWS = 3;

/** A length custom property in px. The deck's sizes and the spacing tokens are literal rem/px values. */
function lengthVar(style: CSSStyleDeclaration, rootPx: number, name: string, fallbackRem: number): number {
  const match = /^(-?\d*\.?\d+)(rem|px)$/.exec(style.getPropertyValue(name).trim());
  return match ? Number(match[1]) * (match[2] === "rem" ? rootPx : 1) : fallbackRem * rootPx;
}

function readSpacing(wrap: HTMLElement): DeckSpacing {
  const style = getComputedStyle(wrap);
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return {
    gap: lengthVar(style, rootPx, "--sp-2", 0.5),
    defaultTop: lengthVar(style, rootPx, "--sp-3", 0.75),
    rowHeight: lengthVar(style, rootPx, "--deck-row-h", 2.75),
    chipZone: lengthVar(style, rootPx, "--deck-chip-zone", 3.5),
    floorRows: FLOOR_ROWS,
  };
}

/** The todo card, found among the list's direct children only (never a transcript-wide query). */
function findTodoCard(list: HTMLElement): HTMLElement | null {
  const panel = [...list.children].find(child => child.classList.contains("todo-panel"));
  return panel?.querySelector<HTMLElement>(".todo-panel-card") ?? null;
}

export interface RunningDeckHostProps {
  readonly listRef: RefObject<HTMLElement | null>;
  readonly blocks: readonly TranscriptBlock[];
  readonly onJumpToBlock: (blockId: string) => void;
}

interface DeckMachineryProps extends RunningDeckHostProps {
  readonly rows: readonly DeckRow[];
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * The geometry side of the deck (anchors, placement, observers, elapsed tick).
 * Mounted only while rows exist, so a transcript with no background work pays
 * for none of it.
 */
function DeckMachinery({ listRef, blocks, onJumpToBlock, rows, collapsed, onCollapsedChange }: DeckMachineryProps) {
  const idEntry = useRef<BlockIdEntry | null>(null);
  const blockIds = useMemo(() => {
    idEntry.current = blockIdEntry(idEntry.current, blocks);
    return idEntry.current.map;
  }, [blocks]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const spacingRef = useRef<DeckSpacing | null>(null);
  const [chipOnly, setChipOnly] = useState(false);
  const written = useRef<{ top: string | null; max: string | null; chipOnly: boolean }>({ top: null, max: null, chipOnly: false });

  /** Measure, then write --deck-top/--deck-max straight onto the wrapper (never React state). */
  const place = useCallback((): { originTop: number; top: number; rowHeight: number } | null => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    if (!list || !wrap) {
      return null;
    }
    const spacing = spacingRef.current ?? (spacingRef.current = readSpacing(wrap));
    const listRect = list.getBoundingClientRect();
    const originTop = listRect.top + list.clientTop;
    const originLeft = listRect.left + list.clientLeft;
    const wrapRect = wrap.getBoundingClientRect();
    const card = cardRef.current?.isConnected ? cardRef.current.getBoundingClientRect() : null;
    const p = deckPlacement(
      { left: wrapRect.left - originLeft, width: wrapRect.width },
      card === null ? null : { left: card.left - originLeft, right: card.right - originLeft, bottom: card.bottom - originTop },
      spacing,
      list.clientHeight,
    );
    const top = p.top === "default" ? null : `${p.top}px`;
    const max = `${Math.max(0, p.maxHeight)}px`;
    const last = written.current;
    if (top !== last.top) {
      if (top === null) {
        wrap.style.removeProperty("--deck-top");
      } else {
        wrap.style.setProperty("--deck-top", top);
      }
    }
    if (max !== last.max) {
      wrap.style.setProperty("--deck-max", max);
    }
    if (p.chipOnly !== last.chipOnly) {
      wrap.toggleAttribute("data-chip-only", p.chipOnly);
    }
    written.current = { top, max, chipOnly: p.chipOnly };
    setChipOnly(p.chipOnly);
    return { originTop, top: p.top === "default" ? spacing.defaultTop : p.top, rowHeight: spacing.rowHeight };
  }, [listRef]);

  const { anchors, schedule } = useDeckAnchors({
    listRef,
    blocks,
    rows,
    idByCall: blockIds,
    collapsedDeckBottom: () => {
      const placed = place();
      return placed === null ? Number.NEGATIVE_INFINITY : placed.originTop + placed.top + placed.rowHeight;
    },
  });

  // Re-measure on list resize and todo-card resize; the card mounts and
  // unmounts as a direct child of the list, so re-attach on childList changes.
  // The observers attach in a passive effect: the list is this component's
  // parent, and its ref is not set yet during a same-commit layout effect.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") {
      return;
    }
    const resize = new ResizeObserver(() => {
      spacingRef.current = null;
      place();
      schedule();
    });
    resize.observe(list);
    let observed: HTMLElement | null = null;
    const attach = () => {
      const next = findTodoCard(list);
      if (next !== observed) {
        if (observed) {
          resize.unobserve(observed);
        }
        observed = next;
        cardRef.current = next;
        if (next) {
          resize.observe(next);
        }
        place();
      }
    };
    attach();
    place();
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(attach);
    mutations?.observe(list, { childList: true });
    return () => {
      resize.disconnect();
      mutations?.disconnect();
      cardRef.current = null;
      written.current = { top: null, max: null, chipOnly: false };
    };
  }, [listRef, place, schedule]);

  // First placement before paint. A no-op while the list ref is still unset
  // (same-commit mount); the passive effect above places again.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    cardRef.current = findTodoCard(list);
    place();
  }, [listRef, place]);

  const [now, setNow] = useState(() => Date.now());
  // Elapsed text exists only on rows; the folded chip and the chip-only mode show none.
  const ticking = !collapsed && !chipOnly;
  useEffect(() => {
    if (!ticking) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [ticking]);

  const jump = useCallback((blockId: string) => {
    onJumpToBlock(blockId);
    listRef.current?.focus({ preventScroll: true });
  }, [onJumpToBlock, listRef]);

  return (
    <div className="running-deck-wrap" ref={wrapRef}>
      <RunningDeck
        rows={rows}
        anchors={anchors}
        blockIdByToolCall={blockIds}
        elapsedNow={now}
        onJumpToBlock={jump}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
      />
    </div>
  );
}

/** Cheap shell: derives the rows from the tab store and mounts the machinery only when there are any. */
export function RunningDeckHost(props: RunningDeckHostProps) {
  const { blocks } = props;
  const ctx = useContext(TabContext);
  const tabId = ctx?.tabId ?? "";
  const { tasks, coreTasks, children } = useStore(
    (ctx?.store ?? EMPTY_STORE) as StoreApi<DeckSources>,
    useShallow((state: DeckSources) => {
      const lists = tasksForEngine(state.engine?.id, state.claudeBackgroundTasks, state.backgroundTasks);
      return { tasks: lists.claude, coreTasks: lists.core, children: state.backgroundChildren };
    }),
  );
  const rows = useMemo(
    () => deckRowsFrom(tasks, children, task => taskDescription(task, blocks), coreTasks),
    [tasks, coreTasks, children, blocks],
  );
  const hasRows = rows.length > 0;

  const [, setVersion] = useState(0);
  const onCollapsedChange = useCallback((collapsed: boolean) => {
    if (collapsed) {
      foldedTabs.add(tabId);
    } else {
      foldedTabs.delete(tabId);
    }
    setVersion(v => v + 1);
  }, [tabId]);

  if (!hasRows) {
    return null;
  }
  return <DeckMachinery {...props} rows={rows} collapsed={foldedTabs.has(tabId)} onCollapsedChange={onCollapsedChange} />;
}

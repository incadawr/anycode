import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { formatTaskElapsed } from "../claude-background-tasks.js";
import { collapsedRows, visibleDeckRows, type AnchorState, type DeckRow } from "../running-deck.js";
import { Button } from "../ui/index.js";
import { Robot, Spinner, Terminal } from "./icons.js";

/** How long an expanded row stays expanded after the pointer leaves it, so a pass to the next row does not skip. */
const COLLAPSE_DELAY_MS = 100;
/** `--open-index` when no row is expanded: larger than any `--i`, so no row shifts. */
const NO_OPEN_INDEX = 9999;
const COLLAPSE_ID = "\u0000collapse";
const CHIP_ID = "\u0000chip";

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
}

const INTERACTIVE = "button, a, input, select, textarea";

const rowName = (row: DeckRow, canJump: boolean): string =>
  `${row.typeLabel}: ${row.title}, running${canJump ? ", jump to its card" : ""}`;

const cssVars = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

/**
 * The sticky "Running" deck: a Sonner-style stack of what is running and has no
 * visible live card. Presentational; the host owns the store, the anchors and
 * the placement. Hover and focus state live here (the parent owns hover: one
 * region whose box covers every row while open).
 */
export function RunningDeck(props: RunningDeckProps) {
  const idBase = useId();
  const { rows, anchors, blockIdByToolCall, elapsedNow, onJumpToBlock, collapsed, onCollapsedChange } = props;
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<readonly DeckRow[] | null>(null);

  const live = visibleDeckRows(rows, anchors);
  const open = (hovered || focusWithin) && !dismissed && !collapsed;
  // While open, the rendered list is frozen so nothing moves or vanishes under
  // the pointer; changes apply on close. Derived state set during render.
  if (open && frozen === null) {
    setFrozen(live);
  } else if (!open && frozen !== null) {
    setFrozen(null);
  }
  const latest = new Map(rows.map(r => [r.key, r] as const));
  // The freeze keeps a finished row from vanishing under a pointer that is on it. Keyboard focus alone does not freeze: a row whose
  // work ended is dropped at once, so it never reads "running" while a user parked on it waits for the result.
  const shown = (open ? frozen ?? live : live).filter(r => hovered || latest.has(r.key)).map(r => latest.get(r.key) ?? r);
  const { front, more } = collapsedRows(shown);
  const mounted = open ? shown : front;
  const expandedIndex = open ? mounted.findIndex(r => r.key === expandedKey) : -1;
  const expanding = expandedIndex >= 0 && mounted[expandedIndex]?.detail !== undefined;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  // Focus bookkeeping: which deck element held focus, so an unmount never leaves it on body.
  const focusInside = useRef(false);
  const focusedId = useRef<string | null>(null);
  const prevKeys = useRef<readonly string[]>([]);
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const collapseEl = useRef<HTMLButtonElement | null>(null);
  const chipEl = useRef<HTMLButtonElement | null>(null);
  const regionEl = useRef<HTMLDivElement | null>(null);
  const stackEl = useRef<HTMLDivElement | null>(null);
  // Set by the click handlers that swap the chip and the rows, so focus lands on a live element
  // whether or not the browser fires blur for the node it removes.
  const pendingFocus = useRef<"chip" | "foot" | null>(null);

  const setRegion = useCallback((el: HTMLDivElement | null) => {
    regionEl.current = el;
    if (el === null) {
      return;
    }
    return () => {
      // Runs before the node leaves the DOM: hand focus to the nearest focusable ancestor (the list).
      if (el.contains(document.activeElement)) {
        el.parentElement?.closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });
      }
      regionEl.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (pending !== null) {
      const target = pending === "chip" ? chipEl.current : collapseEl.current ?? [...rowEls.current.values()][0];
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        prevKeys.current = mounted.map(r => r.key);
        return;
      }
    }
    const active = document.activeElement;
    const lost = active === null || active === document.body || !active.isConnected;
    const id = focusedId.current;
    if (lost && focusInside.current && id !== null && regionEl.current !== null) {
      const after = prevKeys.current.slice(prevKeys.current.indexOf(id) + 1);
      const nextRow = id === COLLAPSE_ID || id === CHIP_ID ? undefined : [id, ...after].map(k => rowEls.current.get(k)).find(el => el !== undefined);
      const firstRow = [...rowEls.current.values()][0];
      const chain = id === CHIP_ID
        ? [firstRow, collapseEl.current]
        : id === COLLAPSE_ID
          ? [chipEl.current]
          : [nextRow, collapseEl.current, chipEl.current];
      const candidates: readonly (HTMLElement | null | undefined)[] = [...chain, regionEl.current];
      const target = candidates.find((el): el is HTMLElement => el !== null && el !== undefined && el.isConnected);
      target?.focus({ preventScroll: true });
    }
    prevKeys.current = mounted.map(r => r.key);
  });

  // Scroll containment only while the open stack really overflows, so wheel scrolling of the transcript is never trapped.
  useLayoutEffect(() => {
    const el = stackEl.current;
    if (el !== null) {
      el.toggleAttribute("data-scrollable", open && el.scrollHeight > el.clientHeight);
    }
  });

  // Nothing shown: forget hover/focus state (no pointerleave/blur fires for a removed node).
  const empty = shown.length === 0;
  useLayoutEffect(() => {
    if (empty) {
      focusInside.current = false;
      focusedId.current = null;
      clearTimer();
      setHovered(false);
      setFocusWithin(false);
      setDismissed(false);
      setExpandedKey(null);
    }
  }, [empty]);

  if (empty) {
    return null;
  }

  // Like hover, only a row opens the deck: pressing Hide or the chip focuses them, and opening then would move the foot away mid-click.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    focusInside.current = true;
    if (event.target instanceof Element && event.target.closest(".running-deck-stack") !== null) {
      setFocusWithin(true);
    }
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) {
      return;
    }
    focusInside.current = false;
    focusedId.current = null;
    setFocusWithin(false);
    clearTimer();
    setExpandedKey(null);
    if (!hovered) {
      setDismissed(false);
    }
  };
  // Only the row stack opens the deck: the foot (Hide, "+N running") must not move away under the pointer.
  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(".running-deck-stack") !== null) {
      setHovered(true);
    }
  };
  // A click on the region's own background must not focus it (that would count as focus within and pin the deck open).
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const hit = event.target instanceof Element ? event.target.closest(INTERACTIVE) : null;
    if (hit === null || !event.currentTarget.contains(hit)) {
      event.preventDefault();
    }
  };
  const onPointerLeave = () => {
    setHovered(false);
    clearTimer();
    setExpandedKey(null);
    if (!focusWithin) {
      setDismissed(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      // App.tsx's global Escape cancels the turn unless the key is consumed.
      event.preventDefault();
      clearTimer();
      setExpandedKey(null);
      setDismissed(true);
    }
  };
  const expand = (key: string) => {
    clearTimer();
    setExpandedKey(key);
  };
  const collapseLater = (key: string) => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      setExpandedKey(current => (current === key ? null : current));
    }, COLLAPSE_DELAY_MS);
  };
  const blockIdOf = (row: DeckRow): string | undefined =>
    row.toolCallId === undefined ? undefined : blockIdByToolCall.get(row.toolCallId);

  return (
    <div
      ref={setRegion}
      className="running-deck"
      role="region"
      aria-label="Running"
      tabIndex={-1}
      data-open={open || undefined}
      data-expanding={expanding || undefined}
      style={cssVars({ "--n": mounted.length, "--open-index": expanding ? expandedIndex : NO_OPEN_INDEX })}
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerOver={onPointerOver}
      onMouseDown={onMouseDown}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      {collapsed ? (
        <Button
          ref={chipEl}
          variant="ghost"
          className="running-deck-chip"
          onFocus={() => { focusedId.current = CHIP_ID; }}
          onClick={() => {
            pendingFocus.current = "foot";
            onCollapsedChange(false);
          }}
        >
          <Spinner className="icon-spin" width={12} height={12} />
          {`${live.length} running`}
        </Button>
      ) : (
        <>
          <div className="running-deck-stack" ref={stackEl}>
            {mounted.map((row, i) => {
              const blockId = blockIdOf(row);
              const detailId = `${idBase}-${i}`;
              return (
                <Button
                  key={row.key}
                  variant="ghost"
                  ref={el => {
                    if (el === null) {
                      return;
                    }
                    rowEls.current.set(row.key, el);
                    return () => {
                      if (rowEls.current.get(row.key) === el) {
                        rowEls.current.delete(row.key);
                      }
                    };
                  }}
                  className="running-deck-row"
                  aria-label={rowName(row, blockId !== undefined)}
                  aria-describedby={row.detail === undefined ? undefined : detailId}
                  aria-disabled={blockId === undefined || undefined}
                  tabIndex={open || i === 0 ? undefined : -1}
                  data-front={i === 0 || undefined}
                  data-expanded={(open && expandedKey === row.key) || undefined}
                  style={cssVars({ "--i": i })}
                  onPointerEnter={() => expand(row.key)}
                  onPointerLeave={() => collapseLater(row.key)}
                  onFocus={() => {
                    focusedId.current = row.key;
                    expand(row.key);
                  }}
                  onClick={() => {
                    if (blockId !== undefined) {
                      onJumpToBlock(blockId);
                    }
                  }}
                >
                  <span className="running-deck-card">
                    <span className="running-deck-line">
                      <Spinner className="icon-spin running-deck-spinner" width={12} height={12} />
                      {row.kind === "child" ? <Robot className="running-deck-kind" width={14} height={14} /> : <Terminal className="running-deck-kind" width={14} height={14} />}
                      <span className="running-deck-type">{row.typeLabel}</span>
                      <span className="running-deck-title">{row.title}</span>
                      <span className="running-deck-meta">{formatTaskElapsed(row.startedAt, elapsedNow)}</span>
                      {blockId !== undefined && <span className="running-deck-jump">↑ jump</span>}
                    </span>
                    {row.detail !== undefined && <span className="running-deck-detail" id={detailId}>{row.detail}</span>}
                  </span>
                </Button>
              );
            })}
          </div>
          <div className="running-deck-foot">
            {!open && more > 0 && <span className="running-deck-more">{`+${more} running`}</span>}
            <Button
              ref={collapseEl}
              variant="ghost"
              size="sm"
              className="running-deck-collapse"
              aria-label="Hide running tasks"
              onFocus={() => { focusedId.current = COLLAPSE_ID; }}
              onClick={() => {
                pendingFocus.current = "chip";
                onCollapsedChange(true);
              }}
            >
              Hide
            </Button>
          </div>
          <Button
            variant="ghost"
            className="running-deck-chip-only"
            aria-label={`${live.length} running${shown[0] ? `: ${shown[0].title}` : ""}${shown[0] !== undefined && blockIdOf(shown[0]) !== undefined ? ", jump to its card" : ""}`}
            aria-disabled={shown[0] === undefined || blockIdOf(shown[0]) === undefined || undefined}
            onClick={() => {
              const first = shown[0];
              const id = first === undefined ? undefined : blockIdOf(first);
              if (id !== undefined) {
                onJumpToBlock(id);
              }
            }}
          >
            {`${live.length} running`}
          </Button>
        </>
      )}
    </div>
  );
}

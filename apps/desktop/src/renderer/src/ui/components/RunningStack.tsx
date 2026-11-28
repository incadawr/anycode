import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Button } from "./Button.js";
import { IconSpinner } from "./icons.js";

/** How long an expanded row stays expanded after the pointer leaves it, so a pass to the next row does not skip. */
const COLLAPSE_DELAY_MS = 100;
/** `--ak-rs-open` when no row is expanded: larger than any `--ak-rs-i`, so no row shifts. */
const NO_OPEN_INDEX = 9999;
const COLLAPSE_ID = "\u0000collapse";
const CHIP_ID = "\u0000chip";
const INTERACTIVE = "button, a, input, select, textarea";
const POPUP_ROLES = '[role="dialog"], [role="menu"], [role="listbox"]';

/**
 * Whether the element that has the key owns an open popup, so Escape is the popup's to take. A popup the element sits inside of is
 * the plain case. A combobox-style control (the composer's textarea with its slash menu) keeps focus on itself and points at the popup
 * instead: it announces one with `aria-haspopup` and names it with `aria-controls`, or says `aria-expanded="true"`.
 */
function ownsOpenPopup(target: Element | null): boolean {
  if (target === null) {
    return false;
  }
  if (target.closest(POPUP_ROLES) !== null) {
    return true;
  }
  const haspopup = target.getAttribute("aria-haspopup");
  if (haspopup === null || haspopup === "false") {
    return false;
  }
  // `aria-expanded` is authoritative when the control states it: a closed popup that stays mounted is still named by `aria-controls`.
  const expanded = target.getAttribute("aria-expanded");
  if (expanded !== null) {
    return expanded === "true";
  }
  return (target.getAttribute("aria-controls") ?? "").split(/\s+/).some(id => id !== "" && document.getElementById(id) !== null);
}

export interface RunningStackItem {
  /** Stable identity: the row keeps its place and its expanded state across updates. */
  readonly key: string;
  /** Decorative glyph for the kind of thing the row is. Give it its own size. */
  readonly icon: ReactNode;
  /** Short kind label shown as a small pill ("Bash", "general-purpose"). */
  readonly typeLabel: string;
  readonly title: string;
  /** Preformatted trailing text, such as an elapsed time. The caller owns its updates. */
  readonly meta?: string;
  /** Extra text, shown when the row is expanded or focused: up to three lines, and when it is longer the LAST lines show, since the latest are the ones that matter. Line breaks are kept. */
  readonly detail?: string;
  /** The row can be activated (click or Enter calls `onActivate`). A row that cannot is announced as such and does nothing. */
  readonly activatable?: boolean;
  /** Opaque value for the caller, handed back with the item to `onActivate`. The stack freezes its list under the pointer, so a row can be activated after the caller dropped it: the item it shows is then the only place the caller's own data for it still lives. */
  readonly target?: string;
}

/** Every string the stack shows or announces. Pass only what differs from the English defaults. */
export interface RunningStackLabels {
  /** Accessible name of the region. */
  readonly region: string;
  /** What each row is doing, in the row's accessible name: "{type}: {title}, {state}". The order and the ", " separators are fixed; only the words are yours. */
  readonly state: string;
  /** Appended to the accessible name of a row that can be activated. */
  readonly activateHint: string;
  /** Visible cue on a row that can be activated. */
  readonly activateCue: string;
  /** Visible text of the control that folds the stack. */
  readonly fold: string;
  /** Accessible name of the control that folds the stack. */
  readonly foldName: string;
  /** Text of the folded chip and of the chip-only mode. */
  readonly count: (n: number) => string;
  /** Text of the overflow chip. */
  readonly more: (n: number) => string;
}

const DEFAULT_LABELS: RunningStackLabels = {
  region: "Running",
  state: "running",
  activateHint: "jump to its card",
  activateCue: "↑ jump",
  fold: "Hide",
  foldName: "Hide running tasks",
  count: n => `${n} running`,
  more: n => `+${n} running`,
};

export interface RunningStackProps {
  /** The rows to show, in order. The stack decides how many peek out; an empty list renders nothing. */
  readonly items: readonly RunningStackItem[];
  /** Folded into one count chip. Controlled by the parent. */
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  /** Click or Enter on an activatable row, with the item as the stack shows it. */
  readonly onActivate?: (key: string, item: RunningStackItem) => void;
  /** No room for rows: only the count chip shows, and it activates the first row. */
  readonly chipOnly?: boolean;
  /** How many rows peek out while the stack is closed. */
  readonly maxVisible?: number;
  readonly labels?: Partial<RunningStackLabels>;
  readonly className?: string;
}

const cssVars = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

/**
 * RunningStack: a Sonner-style stack of running rows. Collapsed, at most `maxVisible` rows peek out behind the front one and an overflow
 * chip counts the rest; hovering a row, or keyboard focus inside, opens every row; Escape closes it; the fold control folds the whole
 * stack into one count chip. Presentational and controlled: it owns only hover, focus and expansion state, and the parent owns the
 * rows, the fold flag and where the stack sits. While the pointer is on the open stack its rows are frozen, so nothing moves or
 * vanishes under it; with keyboard focus alone they follow `items`. Escape is consumed only while the stack is open, so a global
 * Escape handler still sees it otherwise.
 */
export function RunningStack(props: RunningStackProps): React.ReactElement | null {
  const idBase = useId();
  const { items, collapsed, onCollapsedChange, onActivate, chipOnly = false, maxVisible = 3, className } = props;
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<readonly RunningStackItem[] | null>(null);

  const open = (hovered || focusWithin) && !dismissed && !collapsed;
  // While the pointer is on the open stack, the rendered list is frozen so nothing moves or vanishes under it; changes apply when the
  // pointer leaves. Keyboard focus alone does not freeze: a row whose work ended is dropped at once, so it never reads as running for
  // as long as focus stays, and it cannot come back from an old snapshot when the pointer arrives later. Derived state set during render.
  const freezing = open && hovered;
  if (freezing && frozen === null) {
    setFrozen(items);
  } else if (!freezing && frozen !== null) {
    setFrozen(null);
  }
  const latest = new Map(items.map(r => [r.key, r] as const));
  const shown = (freezing ? frozen ?? items : items).map(r => latest.get(r.key) ?? r);
  const front = shown.slice(0, maxVisible);
  const more = Math.max(0, shown.length - maxVisible);
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

  // Focus bookkeeping: which element held focus, so an unmount never leaves it on body.
  const focusInside = useRef(false);
  const focusedId = useRef<string | null>(null);
  const prevKeys = useRef<readonly string[]>([]);
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const collapseEl = useRef<HTMLButtonElement | null>(null);
  const chipEl = useRef<HTMLButtonElement | null>(null);
  const chipOnlyEl = useRef<HTMLButtonElement | null>(null);
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
      // Runs before the node leaves the DOM: hand focus to the nearest focusable ancestor.
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
      // In chip-only mode the rows and the foot are `display: none` and cannot take focus; the chip-only button is what shows.
      const target = pending === "chip" ? chipEl.current : chipOnly ? chipOnlyEl.current : collapseEl.current ?? [...rowEls.current.values()][0];
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) {
          prevKeys.current = mounted.map(r => r.key);
          return;
        }
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
          : [nextRow, collapseEl.current, chipOnlyEl.current, chipEl.current];
      const candidates: readonly (HTMLElement | null | undefined)[] = [...chain, regionEl.current];
      // An element that is not rendered (the rows in chip-only mode) accepts no focus: take the first one that does.
      for (const el of candidates) {
        if (el === null || el === undefined || !el.isConnected) {
          continue;
        }
        el.focus({ preventScroll: true });
        if (document.activeElement === el) {
          break;
        }
      }
    }
    prevKeys.current = mounted.map(r => r.key);
  });

  // Scroll containment only while the open stack really overflows, so wheel scrolling of what is behind is never trapped.
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

  // Hover content must be dismissable without moving the pointer (WCAG 1.4.13): while only the pointer has the stack open, focus is
  // elsewhere, so the region's own handler never sees the key. Listen on the document in the capture phase so a global Escape
  // handler (cancel the turn) sees a key that was already used here, and only while that is the case.
  const pointerOnly = open && hovered && !focusWithin;
  useEffect(() => {
    if (!pointerOnly) {
      return;
    }
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      // An open dialog, menu or popover owns Escape: a modal closes through the key's default action, and a menu handles it
      // itself. This listener runs first (capture), so it must not take the key from them.
      const target = event.target instanceof Element ? event.target : null;
      if (document.querySelector("dialog[open]") !== null || ownsOpenPopup(target)) {
        return;
      }
      event.preventDefault();
      clearTimer();
      setExpandedKey(null);
      setDismissed(true);
    };
    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => document.removeEventListener("keydown", onDocumentKeyDown, true);
  }, [pointerOnly]);
  if (empty) {
    return null;
  }

  // Like hover, only a row opens the stack: pressing the fold control or the chip focuses them, and opening then would move the foot away mid-click.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    focusInside.current = true;
    if (event.target instanceof Element && event.target.closest(".ak-runningstack__stack") !== null) {
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
  // Only the row stack opens it: the foot (fold control, overflow chip) must not move away under the pointer.
  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(".ak-runningstack__stack") !== null) {
      setHovered(true);
    }
  };
  // A click on the region's own background, or on a row that cannot be activated, must not focus anything: that would count as
  // focus within and pin the stack open over the transcript after the pointer left. Keyboard focus is not affected.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const hit = event.target instanceof Element ? event.target.closest(INTERACTIVE) : null;
    if (hit === null || !event.currentTarget.contains(hit) || hit.getAttribute("aria-disabled") === "true") {
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
      // A global Escape handler (cancel the turn) must not also see a key that closed this.
      event.preventDefault();
      clearTimer();
      setExpandedKey(null);
      setDismissed(true);
      // Closing leaves only the front rows peeking, clipped, with all but the first out of the tab order: focus on a row behind the
      // front one would stay on something the user cannot see, and Enter would activate it. Bring it to the front row.
      const frontRow = first === undefined ? undefined : rowEls.current.get(first.key);
      const active = document.activeElement;
      // Only from a row: the fold control and the chip are in the foot, visible and in the tab order, and keep the focus they have.
      if (frontRow !== undefined && active !== frontRow && active instanceof Element && active.closest(".ak-runningstack__stack") !== null) {
        const target = chipOnly ? chipOnlyEl.current : frontRow;
        target?.focus({ preventScroll: true });
      }
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
  const rowName = (item: RunningStackItem): string =>
    `${item.typeLabel}: ${item.title}, ${labels.state}${item.activatable === true ? `, ${labels.activateHint}` : ""}`;
  const first = shown[0];
  const firstActivatable = first?.activatable === true;
  const classes = ["ak-runningstack", className ?? ""].filter(Boolean).join(" ");

  return (
    <div
      ref={setRegion}
      className={classes}
      role="region"
      aria-label={labels.region}
      tabIndex={-1}
      data-open={open || undefined}
      data-expanding={expanding || undefined}
      data-chip-only={chipOnly || undefined}
      style={cssVars({ "--ak-rs-n": mounted.length, "--ak-rs-open": expanding ? expandedIndex : NO_OPEN_INDEX })}
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
          className="ak-runningstack__chip"
          aria-expanded={false}
          onFocus={() => { focusedId.current = CHIP_ID; }}
          onClick={() => {
            pendingFocus.current = "foot";
            onCollapsedChange(false);
          }}
        >
          <IconSpinner size={12} className="ak-runningstack__spin" />
          {labels.count(items.length)}
        </Button>
      ) : (
        <>
          <div className="ak-runningstack__stack" ref={stackEl}>
            {mounted.map((item, i) => {
              const activatable = item.activatable === true;
              const detailId = `${idBase}-${i}`;
              return (
                <Button
                  key={item.key}
                  variant="ghost"
                  ref={el => {
                    if (el === null) {
                      return;
                    }
                    rowEls.current.set(item.key, el);
                    return () => {
                      if (rowEls.current.get(item.key) === el) {
                        rowEls.current.delete(item.key);
                      }
                    };
                  }}
                  className="ak-runningstack__row"
                  aria-label={rowName(item)}
                  aria-describedby={item.detail === undefined ? undefined : detailId}
                  aria-disabled={!activatable || undefined}
                  tabIndex={open || i === 0 ? undefined : -1}
                  data-front={i === 0 || undefined}
                  data-expanded={(open && expandedKey === item.key) || undefined}
                  style={cssVars({ "--ak-rs-i": i })}
                  onPointerEnter={() => expand(item.key)}
                  onPointerLeave={() => collapseLater(item.key)}
                  onFocus={() => {
                    focusedId.current = item.key;
                    expand(item.key);
                  }}
                  onClick={() => {
                    if (activatable) {
                      onActivate?.(item.key, item);
                      // Activating a row sends the user to its card, so the stack closes: with the pointer still on it, the frozen
                      // list would keep showing a row whose card is now in view.
                      clearTimer();
                      setExpandedKey(null);
                      setDismissed(true);
                    }
                  }}
                >
                  <span className="ak-runningstack__card">
                    <span className="ak-runningstack__line">
                      <IconSpinner size={12} className="ak-runningstack__spin ak-runningstack__glyph" />
                      <span className="ak-runningstack__glyph" aria-hidden="true">{item.icon}</span>
                      <span className="ak-runningstack__type">{item.typeLabel}</span>
                      <span className="ak-runningstack__title">{item.title}</span>
                      {item.meta !== undefined && <span className="ak-runningstack__meta">{item.meta}</span>}
                      {activatable && <span className="ak-runningstack__cue">{labels.activateCue}</span>}
                    </span>
                    {item.detail !== undefined && (
                      <span className="ak-runningstack__detail" id={detailId}>
                        <span className="ak-runningstack__detail-text">{item.detail.trimEnd()}</span>
                      </span>
                    )}
                  </span>
                </Button>
              );
            })}
          </div>
          <div className="ak-runningstack__foot">
            {!open && more > 0 && <span className="ak-runningstack__more">{labels.more(more)}</span>}
            <Button
              ref={collapseEl}
              variant="ghost"
              size="sm"
              className="ak-runningstack__fold"
              aria-label={labels.foldName}
              onFocus={() => { focusedId.current = COLLAPSE_ID; }}
              onClick={() => {
                pendingFocus.current = "chip";
                onCollapsedChange(true);
              }}
            >
              {labels.fold}
            </Button>
          </div>
          <Button
            ref={chipOnlyEl}
            variant="ghost"
            className="ak-runningstack__chip-only"
            aria-label={`${labels.count(items.length)}${first ? `: ${first.title}` : ""}${first !== undefined && firstActivatable ? `, ${labels.activateHint}` : ""}`}
            aria-disabled={first === undefined || !firstActivatable || undefined}
            onClick={() => {
              if (first !== undefined && firstActivatable) {
                onActivate?.(first.key, first);
              }
            }}
          >
            {labels.count(items.length)}
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * Collapsible bottom terminal panel for the ACTIVE tab (design
 * slice-2.4-cut.md §4/§7-U2). Mounted once by App.tsx alongside `ActiveTab` —
 * NOT per-tab — because its whole point is to host the xterm DOM-reparent
 * dance: `containerRef` is a single, stable `<div>` that every tab's terminal
 * takes turns being shown inside (`terminal-view.ts`'s `attachHolder` evicts
 * whatever was there before without touching that other tab's `Terminal`
 * instance or buffer), so switching tabs — or toggling the panel closed and
 * back open — never recreates the xterm instance.
 *


 * run once `open` is true AND the tab has a `tabId` — a tab that never opens
 * its terminal never spawns a shell.
 *
 * Pure-logic exports (height clamp/storage-parse helpers below) are
 * independently node-testable — see TerminalPanel.test.ts — but the rest of
 * this file is DOM/effect wiring, same "no jsdom in this package" situation as
 * SettingsScreen.tsx/PermissionModal.tsx — see their .test.ts headers).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import "../terminal.css";
import { tabRegistry } from "../tab-registry.js";
import { terminalView } from "../terminal-view.js";
import { TERM_DEFAULT_COLS, TERM_DEFAULT_ROWS } from "../../../shared/terminal.js";
import { Check, Clear, Copy } from "./icons.js";

/** localStorage key for the drag-resized panel height (px integer), App-wide like SIDEBAR_COLLAPSED_KEY. */
export const TERMINAL_HEIGHT_KEY = "anycode.terminal.height";
export const TERMINAL_PANEL_MIN_VH = 0.08;
export const TERMINAL_PANEL_MAX_VH = 0.6;
/** terminal.css's `height: 16rem` at the 16px root — aria/keyboard baseline when no override is stored. */
export const TERMINAL_PANEL_DEFAULT_PX = 256;
export const TERMINAL_RESIZE_STEP_PX = 16;
const TERMINAL_REVEAL_DURATION_MS = 320;

export function clampPanelHeight(px: number, viewportHeight: number): number {
  const min = Math.round(viewportHeight * TERMINAL_PANEL_MIN_VH);
  const max = Math.round(viewportHeight * TERMINAL_PANEL_MAX_VH);
  return Math.min(Math.max(Math.round(px), min), max);
}

/** Parses a stored height; null for absent/garbage/non-positive (fresh-profile safe). */
export function readStoredPanelHeight(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/** Local private copy of components/Markdown.tsx's `tryClipboardWrite` (not
 * exported there — importing a component into a component to reuse an
 * 8-line helper would be the wrong direction of coupling). Swallows clipboard
 * rejection; no error theater for a clipboard edge. */
function tryClipboardWrite(text: string, onSuccess: () => void): void {
  const write = navigator.clipboard?.writeText(text);
  if (!write) {
    return;
  }
  void write.then(onSuccess).catch(() => {});
}

/** Persists (or clears, for `null`) the drag-resized height; swallows storage errors (App.tsx SIDEBAR_COLLAPSED_KEY idiom). */
function persistHeight(px: number | null): void {
  try {
    if (px === null) {
      localStorage.removeItem(TERMINAL_HEIGHT_KEY);
    } else {
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(px));
    }
  } catch {
    // ignore
  }
}

export interface TerminalPanelProps {
  /** The active tab's id, or null when no tab is open. */
  tabId: string | null;
  /** The active tab's `terminalOpen` flag (tabs-store) — this component renders nothing when false. */
  open: boolean;
}

export function TerminalPanel({ tabId, open }: TerminalPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dead, setDead] = useState(false);
  const [heightPx, setHeightPx] = useState<number | null>(() => {
    try {
      return readStoredPanelHeight(localStorage.getItem(TERMINAL_HEIGHT_KEY));
    } catch {
      return null;
    }
  });
  const [resizing, setResizing] = useState(false);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; moved: boolean } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // R17 a11y: track the previous open state so the close transition can restore
  // focus. This component is unconditionally mounted (App.tsx passes `open`), so
  // the close is an `open` flip, not an unmount.
  const wasOpenRef = useRef(false);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  // Exit needs one rendered frame span: an immediate `return null` prevents
  // the bottom panel from visibly collapsing at all.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) {
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, TERMINAL_REVEAL_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  // Ensure + reparent + (first-open) term_open, and mirror the dead flag into
  // React state for the Reopen button. Re-runs whenever the shown tab changes
  // (tab switch) or the panel opens for the first time.
  useEffect(() => {
    if (!tabId || !open || !mounted || !containerRef.current) {
      return;
    }
    terminalView.ensure(tabId, (data) => tabRegistry.sendToTerminal(tabId, { type: "term_input", data }));
    terminalView.attachHolder(tabId, containerRef.current);
    const dims = terminalView.fitNow(tabId) ?? { cols: TERM_DEFAULT_COLS, rows: TERM_DEFAULT_ROWS };
    tabRegistry.openTerminal(tabId, dims);
    setDead(terminalView.isDead(tabId));
    setHasSelection(terminalView.hasSelection(tabId));
    // Copy feedback is per-tab: a pending Check from a copy on the previous tab
    // must not bleed onto this tab's Copy button (which may even be disabled).
    setCopied(false);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    const unsubDead = terminalView.subscribeDead(tabId, setDead);
    const unsubSelection = terminalView.subscribeSelection(tabId, setHasSelection);
    return () => {
      unsubDead();
      unsubSelection();
    };
  }, [tabId, open, mounted]);

  // Viewport/panel resizes re-fit and tell the host the new geometry

  useEffect(() => {
    if (!tabId || !open || !mounted || !containerRef.current) {
      return;
    }
    const el = containerRef.current;
    const observer = new ResizeObserver(() => {
      const dims = terminalView.fitNow(tabId);
      if (dims) {
        tabRegistry.sendToTerminal(tabId, { type: "term_resize", cols: dims.cols, rows: dims.rows });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabId, open, mounted]);

  // R17 a11y: on close, if focus was stranded on <body> — it lived in the xterm
  // textarea, which unmounts with the panel — hand it back to the SessionHeader
  // terminal toggle (the control that reopens the panel). Guarded so a close via
  // that toggle itself (focus already on it, not <body>) is never disturbed, and
  // so it never fires on the initial mount's closed state.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.querySelector<HTMLElement>(".session-header-terminal-toggle")?.focus();
    }
  }, [open]);

  if (!mounted || !tabId) {
    return null;
  }

  function handleReopen(): void {
    if (!tabId) {
      return;
    }
    const dims = terminalView.fitNow(tabId) ?? { cols: TERM_DEFAULT_COLS, rows: TERM_DEFAULT_ROWS };
    tabRegistry.sendToTerminal(tabId, { type: "term_open", cols: dims.cols, rows: dims.rows });
  }

  function handleClear(): void {
    if (!tabId) {
      return;
    }
    terminalView.clear(tabId);
  }

  function handleCopy(): void {
    if (!tabId) {
      return;
    }
    const text = terminalView.getSelection(tabId);
    if (!text) {
      return;
    }
    tryClipboardWrite(text, () => {
      setCopied(true);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }

  function resetHeight(): void {
    setHeightPx(null);
    persistHeight(null);
  }

  // Pointer capture (Chromium) keeps both move/up events AND the ns-resize
  // cursor on the handle for the whole drag — no body-cursor hack needed.
  // Measure-then-persist (not derived from state) avoids stale closures.
  function onResizePointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0 || !panelRef.current) {
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: panelRef.current.getBoundingClientRect().height,
      moved: false,
    };
    setResizing(true);
  }

  function onResizePointerMove(e: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) {
      return;
    }
    const delta = drag.startY - e.clientY;
    if (delta === 0 && !drag.moved) {
      return;
    }
    drag.moved = true;
    setHeightPx(clampPanelHeight(drag.startHeight + delta, window.innerHeight));
  }

  function onResizePointerUp(e: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) {
      return;
    }
    dragRef.current = null;
    setResizing(false);
    // A click-without-drag must NOT convert the 16rem default into a pinned 256px.
    if (drag.moved && panelRef.current) {
      persistHeight(clampPanelHeight(panelRef.current.getBoundingClientRect().height, window.innerHeight));
    }
  }

  function onResizeDoubleClick(): void {
    resetHeight();
  }

  function onResizeKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const measured = panelRef.current?.getBoundingClientRect().height ?? TERMINAL_PANEL_DEFAULT_PX;
      const delta = e.key === "ArrowUp" ? TERMINAL_RESIZE_STEP_PX : -TERMINAL_RESIZE_STEP_PX;
      const next = clampPanelHeight(measured + delta, window.innerHeight);
      setHeightPx(next);
      persistHeight(next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      resetHeight();
    }
  }

  return (
    <div
      ref={panelRef}
      className={`terminal-panel${closing ? " terminal-panel-closing" : ""}`}
      role="region"
      aria-labelledby="terminal-panel-title"
      style={heightPx === null ? undefined : { height: `clamp(8vh, ${heightPx}px, 60vh)` }}
    >
      <div
        className="terminal-panel-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        tabIndex={0}
        aria-valuemin={Math.round(window.innerHeight * TERMINAL_PANEL_MIN_VH)}
        aria-valuemax={Math.round(window.innerHeight * TERMINAL_PANEL_MAX_VH)}
        aria-valuenow={clampPanelHeight(heightPx ?? TERMINAL_PANEL_DEFAULT_PX, window.innerHeight)}
        data-resizing={resizing || undefined}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onDoubleClick={onResizeDoubleClick}
        onKeyDown={onResizeKeyDown}
      />
      <div className="terminal-panel-header">
        <span id="terminal-panel-title" className="terminal-panel-title">Terminal</span>
        <div className="terminal-panel-actions">
          {dead && (
            <button type="button" className="terminal-panel-reopen" onClick={handleReopen}>
              Reopen
            </button>
          )}
          <button
            type="button"
            className="terminal-panel-action"
            data-copied={copied}
            aria-label="Copy selection"
            title="Copy selection"
            disabled={!hasSelection}
            onClick={handleCopy}
          >
            {copied ? <Check /> : <Copy />}
          </button>
          <button
            type="button"
            className="terminal-panel-action"
            aria-label="Clear terminal"
            title="Clear terminal"
            onClick={handleClear}
          >
            <Clear />
          </button>
        </div>
      </div>
      <div className="terminal-panel-body" ref={containerRef} />
    </div>
  );
}

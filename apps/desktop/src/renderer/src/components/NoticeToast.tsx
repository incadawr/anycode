/**
 * Toast stack over the renderer toast queue (ui-roadmap §4-R8(a,b); pure
 * logic in ../toasts.ts). Presentational: App owns the queue state and the
 * enqueue/exit/remove transitions; this file renders the capped stack
 * (newest on top, anchored bottom-right), runs each item's pausable
 * auto-hide clock, and reports lifecycle up via callbacks.
 *
 * TabNoticeCapture is the bridge from the store's one-slot notice channel:
 * it READS transitions and never writes the store (automation.ts projects
 * state.notice — the slot's write side stays byte-identical to pre-R8).
 */
import { useEffect, useRef, useState } from "react";
import type { Notice } from "../store.js";
import { useTabStore } from "../tab-context.js";
import { TOAST_AUTO_HIDE_MS, toastGlyph, toastTone, type Toast } from "../toasts.js";
import { Info, Warning, X } from "./icons.js";

export interface NoticeStackProps {
  /** Newest-first queue (from ../toasts.js helpers). */
  toasts: readonly Toast[];
  /** Begin exit motion (X click or auto-hide expiry) — App maps to beginToastExit. */
  onHide(id: number): void;
  /** Exit animation finished — App maps to removeToast. */
  onExited(id: number): void;
  /** Auto-hide delay in ms; 0 disables (manual close only). Default TOAST_AUTO_HIDE_MS. */
  autoHideMs?: number;
}

interface ToastItemProps {
  toast: Toast;
  paused: boolean;
  autoHideMs: number;
  onHide(id: number): void;
  onExited(id: number): void;
}

function ToastItem({ toast, paused, autoHideMs, onHide, onExited }: ToastItemProps) {
  // Pausable auto-hide clock: `remaining` survives pause/resume cycles in a
  // ref; the timer effect's CLEANUP banks elapsed time, so React's
  // cleanup-then-run ordering makes re-subscribes (pause flips, handler
  // identity churn, StrictMode) drift-free.
  const remainingRef = useRef(autoHideMs);
  const startedAtRef = useRef(0);

  // Coalesce refresh (toasts.ts law 1): a revision bump means the text was
  // replaced in place — the toast earns a full new auto-hide window. Declared
  // BEFORE the timer effect: cleanups run first, then this reset, then the
  // timer restarts at full length (React runs effects in declaration order).
  useEffect(() => {
    remainingRef.current = autoHideMs;
  }, [toast.revision, autoHideMs]);

  useEffect(() => {
    if (autoHideMs <= 0 || paused || toast.leaving) {
      return;
    }
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => onHide(toast.id), Math.max(0, remainingRef.current));
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    };
  }, [paused, autoHideMs, toast.id, toast.leaving, toast.revision, onHide]);

  const tone = toastTone(toast.kind);
  const glyph = toastGlyph(toast.kind);
  return (
    <div
      className={`notice-toast notice-toast-${toast.kind} notice-toast-tone-${tone}${
        toast.leaving ? " notice-toast-leaving" : ""
      }`}
      // Refusals interrupt (assertive); everything else politely queues.
      role={tone === "danger" ? "alert" : "status"}
      // The base class's ENTER animation also ends here — the name guard is
      // load-bearing (only the exit keyframe may unmount the item).
      onAnimationEnd={(event) => {
        if (event.animationName === "fade-out-down") {
          onExited(toast.id);
        }
      }}
    >
      {glyph === "warning" ? <Warning className="notice-toast-icon" /> : <Info className="notice-toast-icon" />}
      <span className="notice-toast-text">{toast.text}</span>
      <button type="button" className="notice-toast-dismiss" aria-label="Dismiss notice" onClick={() => onHide(toast.id)}>
        <X />
      </button>
    </div>
  );
}

export function NoticeStack({ toasts, onHide, onExited, autoHideMs = TOAST_AUTO_HIDE_MS }: NoticeStackProps) {
  // Hover/focus-within pauses EVERY item's clock (ruling §3.3): aiming at one
  // toast's dismiss must not let its neighbor vanish and reflow under the
  // cursor. The container is pointer-events: none (items opt back in), so
  // enter/leave fire from the items — crossing the gap between two toasts
  // blips resume for a few ms, which is harmless.
  const [paused, setPaused] = useState(false);

  // A toast can be removed while hovered (X click) leaving `paused` latched
  // true with no mouseleave to clear it — the next toast would never expire.
  useEffect(() => {
    if (toasts.length === 0) {
      setPaused(false);
    }
  }, [toasts.length]);

  if (toasts.length === 0) {
    return null;
  }
  return (
    <div
      className="notice-stack"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          paused={paused}
          autoHideMs={autoHideMs}
          onHide={onHide}
          onExited={onExited}
        />
      ))}
    </div>
  );
}

/**
 * Capture guard OUTSIDE the component so remounts (tab switches) cannot
 * re-toast a notice that was already shown. Keyed by tabId: a notice raised
 * in a background tab (store updates while unmounted) IS captured on the next
 * switch to that tab — same visibility the old always-render slot gave it.
 * Entries for closed tabs linger (a few strings — accepted).
 */
const capturedNotices = new Map<string, Notice>();

/**
 * Store→queue bridge for the ACTIVE tab (mounted once, inside TabContext).
 * Read-only over the store: identity change on the slot enqueues exactly
 * once; the slot itself is never cleared (automation projection unchanged).
 */
export function TabNoticeCapture({ tabId, onNotice }: { tabId: string; onNotice(notice: Notice): void }) {
  const notice = useTabStore((state) => state.notice);
  useEffect(() => {
    if (notice && capturedNotices.get(tabId) !== notice) {
      capturedNotices.set(tabId, notice);
      onNotice(notice);
    }
    // onNotice identity churn re-runs this harmlessly: the map guard no-ops.
  }, [tabId, notice, onNotice]);
  return null;
}

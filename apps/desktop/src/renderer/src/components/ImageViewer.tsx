import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface ViewerImage {
  mediaType: string;
  data: string;
}

/**
 * Wrap-around index step for the viewer's prev/next controls (Taskana 4091).
 * Pure so the node-env logic test can pin it without a DOM: `-1` at 0 wraps to
 * the last image, `+1` at the end wraps to 0, and a degenerate `count <= 1`
 * (single image or empty) always stays at 0 — there is nothing to navigate.
 */
export function nextIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 1) return 0;
  return (current + delta + count) % count;
}

/**
 * Taskana 4091 follow-up — pure Esc routing for the viewer's native "cancel"
 * (Esc) event. The dialog's `onCancel` prevents the browser's own close so
 * the caller's state (not the DOM) stays the single source of truth for
 * visibility (same intent-not-DOM discipline as ConfirmDialog/PermissionModal)
 * AND marks the event handled, so the shell's bubble-phase Esc-to-interrupt
 * (App.tsx) never sees it — Esc closes the viewer without cancelling a
 * running turn. A stopped-propagation isn't needed on top of preventDefault:
 * the shell's listener ignores defaultPrevented Esc outright.
 */
export function runViewerCancel(
  event: { preventDefault(): void; defaultPrevented?: boolean },
  onClose: () => void,
): void {
  event.preventDefault();
  onClose();
}

/**
 * Taskana 4091 follow-up — pure backdrop predicate: true only when the
 * click's target IS the dialog element itself (the ::backdrop area a modal
 * dialog paints around its box), never for clicks that bubbled up from
 * dialog children. Same shape as ConfirmDialog's isBackdropClick.
 */
export function isViewerBackdropClick(dialog: unknown, target: unknown): boolean {
  return dialog !== null && dialog !== undefined && dialog === target;
}

/**
 * Taskana 4091 follow-up — pure key routing for the viewer's in-dialog
 * keydown: ArrowLeft/ArrowRight step the wrap-around index (nextIndex),
 * everything else is left untouched (Esc arrives as the native "cancel"
 * event, not here). Returns the next index, or null when nothing changed.
 */
export function viewerKeyIndex(
  key: string,
  index: number,
  count: number,
): number | null {
  if (key === "ArrowLeft") {
    const next = nextIndex(index, -1, count);
    return next === index ? null : next;
  }
  if (key === "ArrowRight") {
    const next = nextIndex(index, 1, count);
    return next === index ? null : next;
  }
  return null;
}

/**
 * Taskana 4091 follow-up: the internal full-size image viewer as a REAL modal
 * dialog. A plain div overlay let Tab reach elements behind it and app
 * shortcuts (e.g. Cmd+W) still fired; a native `<dialog>` opened with
 * `showModal()` (the exact pattern of every other modal in this app —
 * PermissionModal/ConfirmDialog/SettingsScreen) gets the browser's focus
 * trap, inert background, Esc-cancel and its own airspace: App.tsx's global
 * keydown ignores both Esc and mod-combos whenever a `dialog[open]` exists.
 * On close (however it happens) focus returns to the thumbnail that opened
 * it — captured before showModal() steals it, restored on unmount.
 */
export function ImageViewer({ images, startIndex, onClose }: {
  images: readonly ViewerImage[];
  startIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Capture the pre-modal focus (the clicked thumbnail) BEFORE showModal()
  // steals it, restore it on unmount — the caller clears the viewer state,
  // which unmounts this dialog wholesale and would otherwise drop focus to
  // <body> (mirrors PermissionModal R17 / CommandPalette capture-restore).
  // Effects run in declaration order within a commit, so this reads
  // document.activeElement before the showModal effect below runs.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Fresh mount → open modally (PermissionModal/ConfirmDialog lifecycle: the
  // component only exists while open, so only the way in needs showModal()).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  // Initial focus lands on the Close button — arrow keys keep working even
  // if nothing else is focused, and Enter dismisses.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDialogElement>) => {
    const next = viewerKeyIndex(e.key, index, images.length);
    if (next !== null) {
      setIndex(next);
    }
  };

  const src = `data:${images[index]!.mediaType};base64,${images[index]!.data}`;
  return (
    <dialog
      ref={dialogRef}
      className="image-viewer"
      aria-label="Image viewer"
      onKeyDown={onKey}
      onCancel={(e) => {
        runViewerCancel(e, onClose);
      }}
      onClick={(e) => {
        if (isViewerBackdropClick(dialogRef.current, e.target)) {
          onClose();
        }
      }}
    >
      <img
        className="image-viewer-img"
        src={src}
        alt={`Attached image ${index + 1} of ${images.length}`}
      />
      <div className="image-viewer-bar">
        {images.length > 1 && (
          <>
            <button
              type="button"
              className="image-viewer-nav"
              onClick={() => setIndex((i) => nextIndex(i, -1, images.length))}
              aria-label="Previous image"
            >
              ‹
            </button>
            <span className="image-viewer-count">
              {index + 1} / {images.length}
            </span>
            <button
              type="button"
              className="image-viewer-nav"
              onClick={() => setIndex((i) => nextIndex(i, 1, images.length))}
              aria-label="Next image"
            >
              ›
            </button>
          </>
        )}
        <button type="button" className="image-viewer-close" ref={closeRef} onClick={onClose}>
          Close (Esc)
        </button>
      </div>
    </dialog>
  );
}

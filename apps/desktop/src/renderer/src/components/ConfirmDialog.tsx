/**
 * TASK.126 — fully controlled presentational confirm dialog (native
 * `<dialog>`, GitConfirmDialog's `.git-confirm-*` CSS verbatim). The caller
 * owns the pending request state; this component only renders and reports
 * Confirm/Cancel. Cancel is the initially focused button (fail-closed, the
 * same posture as GitConfirmDialog/PermissionModal), Confirm alone runs the
 * destructive action, and the same intent-not-DOM discipline applies: the
 * native "cancel" event (Esc) and a backdrop click only report Cancel —
 * visibility stays the caller's state.
 */
import { useEffect, useRef } from "react";
import { useOverlayFlag } from "../preview/overlay-flag.js";

export interface ConfirmDialogRequest {
  title: string;
  body: string;
  confirmLabel: string;
}

export interface ConfirmDialogProps {
  request: ConfirmDialogRequest | null;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Native "cancel" (Esc) handler: prevent the browser's own close so the
 * caller's request state (not the DOM) stays the single source of truth for
 * visibility, then report Cancel.
 */
export function runDialogCancel(event: { preventDefault(): void }, onCancel: () => void): void {
  event.preventDefault();
  onCancel();
}

/**
 * True only when the click's target IS the dialog element itself (the
 * backdrop), never for clicks that bubbled up from dialog children.
 */
export function isBackdropClick(dialog: unknown, target: unknown): boolean {
  return dialog !== null && dialog !== undefined && dialog === target;
}

export function ConfirmDialog({ request, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // D8 overlay wiring: the preview WebContentsView must hide while a
  // confirm dialog is up.
  useOverlayFlag(request !== null);

  // Mirrors GitConfirmDialog/PermissionModal's showModal effect: mounts+opens
  // on a fresh request, unmounts wholesale once cleared.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && request && !dialog.open) {
      dialog.showModal();
    }
  }, [request]);

  // A new pending request arms Cancel, never Confirm.
  useEffect(() => {
    if (request) {
      cancelRef.current?.focus();
    }
  }, [request]);

  if (!request) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      className="git-confirm-dialog"
      aria-label={request.title}
      onCancel={(event) => {
        runDialogCancel(event, onCancel);
      }}
      onClick={(event) => {
        if (isBackdropClick(dialogRef.current, event.target)) {
          onCancel();
        }
      }}
    >
      <div className="git-confirm-header">
        <span className="git-confirm-title">{request.title}</span>
      </div>
      <div className="git-confirm-body">{request.body}</div>
      <div className="git-confirm-actions">
        <button type="button" ref={cancelRef} className="git-confirm-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="git-confirm-confirm" onClick={onConfirm}>
          {request.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

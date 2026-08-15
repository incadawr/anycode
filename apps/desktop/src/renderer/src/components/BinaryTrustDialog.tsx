/**
 * Binary-trust consent dialog (TASK.103, CUT-S4.md §3.6/§3.8/§8/D-S4-8): the
 * per-path off-switch for the codex/claude binary-trust wall. Shown from
 * either engine pane's status card once its doctor report carries a
 * structured `trustRefusal` — never inferred from string-matching `error`.
 *
 * Deliberately the `ConsentDialog.tsx` skeleton byte-for-byte (fully
 * controlled native `<dialog>`, `useOverlayFlag(open)`, pre-open focus
 * capture/restore, Cancel focused on open, Esc/`onCancel` treated as an
 * explicit decline that writes nothing) — reusing its `consent-dialog*`
 * classes wholesale so `app.css` (S2's file) is never touched by this slice.
 *
 * CUSTODY: the fingerprint pinned by an accepted grant is computed entirely
 * main-side (`handleBinaryTrustGrant`, settings-ipc.ts) — this component and
 * its caller never construct, see, or transmit one; `onAccept` only signals
 * "the user agreed", the caller's IPC call carries nothing but the path.
 */
import { useEffect, useRef } from "react";
import { useOverlayFlag } from "../preview/overlay-flag.js";

export interface BinaryTrustDialogProps {
  open: boolean;
  binaryPath: string;
  reason: string;
  /** TASK.103 fix wave (D-S4-17): true iff this refusal is a DRIFTED consent (the file changed since it was granted) — names the risk at the exact re-consent moment. */
  staleConsent: boolean;
  /** "Trust this binary" — the caller invokes the grant bridge and then its recheck. */
  onAccept(): void;
  /** Cancel / Esc / close — nothing is written. */
  onDecline(): void;
}

/**
 * The consent card source: the report's structured trust refusal, or null.
 * Shared by both engine panes (D-S4-6) — one reader, no string matching.
 * `report` is deliberately typed as the narrow shape this function actually
 * reads, not the full `CodexDoctorReport`/`ClaudeDoctorReport` union, so
 * either report type (and a bare snapshot's `.report`) satisfies it
 * structurally without an import cycle back into `shared/**`.
 */
export function binaryTrustRefusalOf(
  report: { trustRefusal?: { binaryPath: string; reason: string; staleConsent?: boolean } } | undefined,
): { binaryPath: string; reason: string; staleConsent: boolean } | null {
  const refusal = report?.trustRefusal;
  if (refusal === undefined) return null;
  // `=== true` is deliberate: a field absent on the wire degrades to the
  // NON-stale copy — fail-safe direction for a copy line, no wrong offer.
  return { binaryPath: refusal.binaryPath, reason: refusal.reason, staleConsent: refusal.staleConsent === true };
}

export interface BinaryTrustGrantCopy {
  title: string;
  refusalLine: string;
  attackerLine: string;
  pinLine: string;
  acceptLabel: string;
  declineLabel: string;
  /** TASK.103 fix wave (D-S4-17): the drift warning, non-null iff staleConsent — §6 string, verbatim. */
  changedLine: string | null;
}

/**
 * Dialog copy (CUT-S4.md §8, TASK.103 fix wave §6) as data, so the node-env
 * tests pin the exact strings the live-DoD smoke greps for — never
 * re-derived or paraphrased at the render call site.
 */
export function describeBinaryTrustGrant(binaryPath: string, reason: string, staleConsent = false): BinaryTrustGrantCopy {
  return {
    title: "Trust this binary?",
    refusalLine: `AnyCode refused to run ${binaryPath}: ${reason}`,
    attackerLine:
      "Anyone who can write to that location can replace this binary, and AnyCode would run their code with your permissions.",
    pinLine:
      "If you trust it, AnyCode pins the binary exactly as it is right now (owner, permissions, size, modification time). If anything about it changes, AnyCode will ask again before running it.",
    acceptLabel: "Trust this binary",
    declineLabel: "Cancel",
    changedLine: staleConsent
      ? "You trusted this binary before, but it has changed since that grant. If you did not update it yourself, do not trust it again."
      : null,
  };
}

export function BinaryTrustDialog({ open, binaryPath, reason, staleConsent, onAccept, onDecline }: BinaryTrustDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  useOverlayFlag(open);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      declineRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const copy = describeBinaryTrustGrant(binaryPath, reason, staleConsent);

  return (
    <dialog
      ref={dialogRef}
      className="consent-dialog"
      aria-label={copy.title}
      // TASK.103: `data-binary-trust-dialog` disambiguates this dialog from
      // ConsentDialog.tsx's (weak-storage) OWN `.consent-dialog` node — the
      // automation facade (`realBinaryTrustDialogDom`) queries on this
      // attribute, never on class name alone. `data-trust-binary-path`/
      // `data-trust-reason` carry the structured facts (never a string-match
      // on the rendered copy — same discipline as the pane's Trust button).
      data-binary-trust-dialog="true"
      data-trust-binary-path={binaryPath}
      data-trust-reason={reason}
      data-trust-stale-consent={String(staleConsent)}
      onCancel={(event) => {
        event.preventDefault();
        onDecline();
      }}
    >
      <div className="consent-dialog-header">
        <span className="consent-dialog-title">{copy.title}</span>
      </div>

      <div className="consent-dialog-body">
        <p>{copy.refusalLine}</p>
        {copy.changedLine !== null && <p>{copy.changedLine}</p>}
        <p>{copy.attackerLine}</p>
        <p>{copy.pinLine}</p>
      </div>

      <div className="consent-dialog-actions">
        <button type="button" ref={declineRef} className="consent-decline-button" onClick={onDecline}>
          {copy.declineLabel}
        </button>
        <button type="button" className="consent-accept-button" onClick={onAccept}>
          {copy.acceptLabel}
        </button>
      </div>
    </dialog>
  );
}

/**
 * Weak-storage consent dialog (ruling reviews/slice-2.2-forks-ruling.md §1,
 * design/slice-2.2-cut.md §4): shown when a `secret-set` is refused with
 * `weak_storage_needs_consent` — no OS-encrypted vault is available on this
 * machine (Linux without a real secret-service/keyring backend, or a
 * headless box where `isEncryptionAvailable()===false`). Honest about what
 * accepting means (the key is written obfuscated or plain-text to
 * `~/.anycode/secrets.json` at 0600 — design §1.1) and about the
 * alternative (the `ANYCODE_API_KEY` env var, which always wins over the

 *
 * Fully controlled, the same native-`<dialog>` pattern as PermissionModal/
 * SessionPicker: visibility is driven entirely by `open`, Esc is treated as
 * an explicit decline (fail-closed — an unconfirmed Esc must never leave a
 * secret half-written), and the caller (SettingsScreen, backed by
 * settings-store's `pendingConsent`) owns the actual accept/decline logic —
 * persisting `security.allowWeakSecretStorage` and retrying the `secret-set`
 * happen in settings-store.ts's `acceptWeakStorageConsent`, not here.
 */
import { useEffect, useRef } from "react";

export interface ConsentDialogProps {
  /** Show the dialog — mirrors settings-store's `pendingConsent !== null`. */
  open: boolean;
  /** "Store anyway" — the caller persists the consent flag and retries the parked secret-set. */
  onAccept(): void;
  /** Cancel / Esc / close — the caller discards the parked secret without ever retrying the write. */
  onDecline(): void;
}

export function ConsentDialog({ open, onAccept, onDecline }: ConsentDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);

  // R17 a11y: capture the pre-open focus when the dialog opens and restore it
  // when it closes. ProviderSettings renders this unconditionally (the instance
  // stays mounted while `open` toggles), and on close the `if (!open) return
  // null` below React-unmounts the <dialog> before its own close()/return-focus
  // can run — so focus would otherwise drop to <body>. Keyed on `open`, and
  // declared before the showModal effect so the capture precedes showModal()'s
  // focus steal.
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

  // Fail-closed focus (R12 §3 I-1 analog): opening always arms Cancel.
  useEffect(() => {
    if (open) {
      declineRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      className="consent-dialog"
      aria-label="Store your API key without a keychain?"
      onCancel={(event) => {
        // Esc fires the dialog's native "cancel" event; prevent the
        // browser's own close so `open` (not the DOM) stays the single
        // source of truth for visibility, then treat it as an explicit
        // decline — same fail-closed pattern as PermissionModal's Esc=deny.
        event.preventDefault();
        onDecline();
      }}
    >
      <div className="consent-dialog-header">
        <span className="consent-dialog-title">Store your API key without a keychain?</span>
      </div>

      <div className="consent-dialog-body">
        <p>
          This system has no OS-encrypted secret storage available right now — common on Linux
          without a running secret-service/keyring, or in a headless environment.
        </p>
        <p>
          If you continue, your API key will be written to <code>~/.anycode/secrets.json</code>{" "}
          <strong>obfuscated or in plain text</strong> (file permissions restricted to your user,
          0600) — not protected by an OS keychain.
        </p>
        <p>
          Alternative: set the <code>ANYCODE_API_KEY</code> environment variable instead. It
          always takes priority over the vault, and this app never writes it to disk.
        </p>
      </div>

      <div className="consent-dialog-actions">
        <button type="button" ref={declineRef} className="consent-decline-button" onClick={onDecline}>
          Cancel
        </button>
        <button type="button" className="consent-accept-button" onClick={onAccept}>
          Store anyway
        </button>
      </div>
    </dialog>
  );
}

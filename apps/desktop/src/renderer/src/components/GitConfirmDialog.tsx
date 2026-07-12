/**
 * Confirm dialog for destructive git operations (design /working-docs/build/

 * (`PermissionModal.tsx` `:187`-precedent), mounted whenever `git.confirm` is
 * non-null. Self-connecting like `GitPanel.tsx`/`EnvironmentMenu.tsx` — there is no
 * separate presentational/connected split here (unlike PermissionModal) since
 * this dialog has exactly one caller-independent job: stage → confirm → send.
 *

 * a `confirmed: true` wire command; this dialog is the SOLE place that calls
 * it. Confirm sends the command and clears the staged intent; Cancel/Esc only
 * clear it. Default focus lands on Cancel (fail-closed — the same posture as
 * PermissionModal's Deny), so a stray Enter or an impatient click on the
 * dialog's own body never fires the destructive action.
 */
import { useEffect, useRef } from "react";
import { buildConfirmedGitCommand, type GitDestructiveIntent } from "../store.js";
import { useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";

export interface GitConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * Pure per-intent copy (design §2.6): factored out for the unit gate (no DOM).
 * `reset --hard` gets the harshest wording (discards staged AND unstaged
 * changes, irreversibly) since it's the single most destructive op in the v1

 * worktree+index). Pluralizes "file(s)" on the discard count.
 */
export function confirmDialogCopy(intent: GitDestructiveIntent): GitConfirmCopy {
  switch (intent.op) {
    case "discard": {
      const n = intent.paths.length;
      return {
        title: "Discard changes",
        body: `Discard changes to ${n} file${n === 1 ? "" : "s"}? This cannot be undone.`,
        confirmLabel: "Discard",
      };
    }
    case "stash_push":
      return {
        title: "Stash changes",
        body: intent.includeUntracked
          ? "Stash all changes, including untracked files? Your worktree will be reverted to HEAD until you pop it back."
          : "Stash tracked changes? Your worktree will be reverted to HEAD until you pop it back.",
        confirmLabel: "Stash",
      };
    case "stash_pop":
      return {
        title: "Restore stashed changes",
        body: "Apply the most recent stash to the worktree and remove it from the stash list? A conflicting apply leaves the stash in place.",
        confirmLabel: "Pop",
      };
    case "reset":
      return intent.mode === "hard"
        ? {
            title: "Reset — hard",
            body: "Discard ALL staged and unstaged changes and reset the worktree to HEAD? This cannot be undone.",
            confirmLabel: "Reset --hard",
          }
        : {
            title: "Reset — mixed",
            body: "Unstage all changes and reset to HEAD? Your working-tree files are kept as-is.",
            confirmLabel: "Reset",
          };
    default: {
      const exhaustive: never = intent;
      throw new Error(`unreachable git confirm intent: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function GitConfirmDialog() {
  const intent = useTabStore((state) => state.git.confirm);
  const tabStore = useTabStoreApi();
  const send = useTabSend();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Mirrors PermissionModal's showModal effect: mounts+opens on a fresh
  // intent, unmounts wholesale (no "present but closed" state) once cleared.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && intent && !dialog.open) {
      dialog.showModal();
    }
  }, [intent]);


  // new staged intent arms Cancel, never Confirm.
  useEffect(() => {
    if (intent) {
      cancelRef.current?.focus();
    }
  }, [intent]);

  if (!intent) {
    return null;
  }

  const copy = confirmDialogCopy(intent);

  function handleCancel(): void {
    tabStore.getState().gitClearConfirm();
  }

  function handleConfirm(): void {
    // buildConfirmedGitCommand(null) is the only way this could yield null,
    // and `intent` is non-null here by construction (early return above) —
    // the guard is defensive, not a reachable branch.
    const command = buildConfirmedGitCommand(intent);
    if (!command) {
      return;
    }
    const requestId = crypto.randomUUID();
    tabStore.getState().gitRequestStarted(requestId, { kind: "mutation", label: copy.confirmLabel.toLowerCase() });
    send({ type: "git_command", requestId, command });
    tabStore.getState().gitClearConfirm();
  }

  return (
    <dialog
      ref={dialogRef}
      className="git-confirm-dialog"
      aria-label={copy.title}
      onCancel={(event) => {
        // Esc fires the dialog's native "cancel" event; prevent the browser's
        // own close so `intent` (not the DOM) stays the single source of
        // truth for visibility, same discipline as PermissionModal.
        event.preventDefault();
        handleCancel();
      }}
    >
      <div className="git-confirm-header">
        <span className="git-confirm-title">{copy.title}</span>
      </div>
      <div className="git-confirm-body">{copy.body}</div>
      <div className="git-confirm-actions">
        <button type="button" ref={cancelRef} className="git-confirm-cancel" onClick={handleCancel}>
          Cancel
        </button>
        <button type="button" className="git-confirm-confirm" onClick={handleConfirm}>
          {copy.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

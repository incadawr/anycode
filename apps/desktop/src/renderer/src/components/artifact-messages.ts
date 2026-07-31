/**
 * Human-readable text for the artifact IPC's refusal reasons, split out of
 * Markdown.tsx so it is reachable from the renderer's node-environment tests
 * (the vitest project collects `*.test.ts` only).
 *
 * Two mappers, because the two failures are not the same event: a preview can
 * be unavailable while the file is perfectly openable, and an action can be
 * refused while the preview above it renders fine.
 *
 * TASK.77-A also puts the blocked-chip's pure state machine here
 * (`artifactChipState`): ALL testable chip logic lives in this file so
 * Markdown.tsx stays a thin renderer of whatever it returns (the vitest
 * project only collects `*.test.ts`, never `*.test.tsx` — see this package's
 * vitest.config.ts).
 */

/** Inline preview (`artifact-read-image`) could not be produced. */
export function artifactFailureMessage(reason: string): string {
  switch (reason) {
    case "not_found":
      return "File not found (deleted or never created)";
    case "outside_allowed_roots":
      // TASK.77-A frozen copy: this exact string is also the blocked-chip's
      // row text (paired with the "Allow preview" button in Markdown.tsx).
      return "Preview blocked — outside allowed roots";
    case "not_previewable":
      return "Preview not available for this format — use Open / Reveal";
    case "too_large":
      return "File too large for an inline preview — use Open / Reveal";
    case "no_workspace":
      return "No workspace is attached to this tab";
    default:
      return "Preview unavailable";
  }
}

/**
 * Open/Reveal was refused by the main process. Naming the reason is the whole
 * point — a button that silently does nothing reads as broken. `declined` is
 * the user's own answer at the outside-the-roots confirmation, so it is stated
 * flatly rather than dressed up as an error.
 */
export function artifactActionFailureMessage(reason: string): string {
  switch (reason) {
    case "not_found":
      return "File not found (deleted or never created)";
    case "declined":
      return "Not opened — you cancelled";
    case "outside_allowed_roots":
      return "Outside the workspace, ~/.anycode and the temp dir — blocked";
    case "not_openable":
      return "AnyCode does not open this format — use Reveal";
    case "no_workspace":
      return "No workspace is attached to this tab";
    case "io_error":
      return "The OS refused to show this file";
    default:
      return "Action failed";
  }
}

/**
 * TASK.77-A: the Allow click's own outcome could not be applied. There is no
 * `outside_allowed_roots` case here (see `ArtifactAllowResult` — an outside
 * path is exactly what Allow exists to unlock, so main never refuses it for
 * that reason); only a vanished file or an unknown tab can fail.
 */
export function artifactAllowFailureMessage(reason: string): string {
  switch (reason) {
    case "not_found":
      return "Couldn't allow — file not found (deleted or never created)";
    case "no_workspace":
      return "Couldn't allow — no workspace is attached to this tab";
    default:
      return "Couldn't allow this file";
  }
}

/** The preview attempt this chip is currently reflecting (mirrors Markdown.tsx's local `ArtifactState["status"]`, kept structural here so this module has no React/component import). */
export type ArtifactPreviewStatus = "idle" | "loading" | "ready" | "unavailable";

/** Where an in-flight/failed "Allow preview" click currently stands. */
export type ConsentAttemptStatus = "idle" | "pending" | "failed";

export interface ArtifactChipState {
  /** Offer the "Allow preview" button — true only for the ONE failure Allow actually fixes (outside the allowed roots). */
  showAllow: boolean;
  /** Open is offered in every status (TASK.77 cut §1(c): the buttons are live today, never guaranteed-fail dead ends — a caller ANDs this with its own extension-openable gate). */
  showOpen: boolean;
  /** Reveal is offered in every status — it is unconfined by design (containment/consent is a preview/open concern only). */
  showReveal: boolean;
  /** Row text for the idle/unavailable states; "" when the caller renders its own content (loading spinner, ready image). */
  label: string;
}

/**
 * Pure chip-state machine for the inline artifact preview (TASK.77-A). Given
 * the CURRENT preview attempt (status + refusal reason, if any) and whatever
 * an "Allow preview" click is doing, decides the blocked-row's copy and
 * whether it offers Allow. Open/Reveal are unconditionally offered — they
 * already carry their own per-call consent path in main (an OS confirmation,
 * or a skip for an already-consented realPath) — so a blocked chip is never a
 * dead end while a fix (Allow) is one click away for the refusal it actually
 * fixes; DoD's "no guaranteed-to-fail button" is satisfied by that per-call
 * path, not by hiding the buttons here.
 */
export function artifactChipState(
  status: ArtifactPreviewStatus,
  reason: string | undefined,
  consentAttempt: ConsentAttemptStatus,
): ArtifactChipState {
  if (status !== "unavailable") {
    return { showAllow: false, showOpen: true, showReveal: true, label: "" };
  }
  const blockedByRoots = reason === "outside_allowed_roots";
  const baseLabel = artifactFailureMessage(reason ?? "");
  const label =
    blockedByRoots && consentAttempt === "failed"
      ? `${baseLabel} — allow failed, try again`
      : baseLabel;
  return { showAllow: blockedByRoots, showOpen: true, showReveal: true, label };
}

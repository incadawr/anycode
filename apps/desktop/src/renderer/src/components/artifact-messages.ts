/**
 * Human-readable text for the artifact IPC's refusal reasons, split out of
 * Markdown.tsx so it is reachable from the renderer's node-environment tests
 * (the vitest project collects `*.test.ts` only).
 *
 * Two mappers, because the two failures are not the same event: a preview can
 * be unavailable while the file is perfectly openable, and an action can be
 * refused while the preview above it renders fine.
 */

/** Inline preview (`artifact-read-image`) could not be produced. */
export function artifactFailureMessage(reason: string): string {
  switch (reason) {
    case "not_found":
      return "File not found (deleted or never created)";
    case "outside_allowed_roots":
      return "Path is outside the allowed roots — preview blocked";
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
 * point: the artifact IPC confines actions to the workspace, ~/.anycode and
 * the OS temp dir, so a file the model wrote to /tmp is blocked even though it
 * exists — and a button that silently does nothing reads as broken.
 */
export function artifactActionFailureMessage(reason: string): string {
  switch (reason) {
    case "not_found":
      return "File not found (deleted or never created)";
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

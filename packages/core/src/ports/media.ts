/**
 * MediaCapabilityPort: the live image-input verdict for the current session
 * model (Phase 6 slice 6.2, design §2-A4). Wired in the CLI as a closure over
 * the mutable session model id, so a /model switch is honored on the next call.
 * Its absence on ToolContext is the fail-closed lock — the image-wrapped Read
 * returns an explicit error instead of attaching.
 */

export interface MediaCapabilityPort {
  /** Live verdict for the CURRENT session model; re-evaluated per call so a /model switch is honored immediately. */
  imageInputEnabled(): boolean;
}

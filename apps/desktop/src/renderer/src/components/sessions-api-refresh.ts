/**
 * Live view refresh for Settings → Sessions API.
 *
 * `bridge.get()` is main-authoritative and recomputes `missingWorkspaces` from
 * disk on every call, so a folder that disappears (or comes back) while the
 * pane is open only needs another read — no restart, no reopen. The pane used
 * to read the view once on mount, which left its "Missing on disk" mark stale
 * for as long as Settings stayed open.
 *
 * Two triggers, both cheap: a fixed interval while the pane is mounted, and a
 * window `focus` event — the moment the user returns from Finder/Explorer,
 * where the folder was most likely deleted or restored.
 */
import type { CommunicationGetResult } from "../../../shared/communication-config.js";

/** How often an open pane re-reads the view (folder marks, status, sessions). */
export const SESSIONS_API_REFRESH_MS = 5_000;

export interface SessionsApiRefreshOptions {
  get(): Promise<CommunicationGetResult>;
  /** Every successful read; a refusal leaves the last view in place. */
  onView(result: Extract<CommunicationGetResult, { ok: true }>): void;
  intervalMs?: number;
}

/**
 * Starts the refresh loop and returns its stop function. Reads never overlap
 * (one refetch in flight at a time) and a read that lands after `stop()` is
 * dropped, so a closed pane is never repainted.
 */
export function startSessionsApiRefresh(options: SessionsApiRefreshOptions): () => void {
  const { get, onView, intervalMs = SESSIONS_API_REFRESH_MS } = options;
  let stopped = false;
  let inFlight = false;

  const read = (): void => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    void get()
      .then((result) => {
        if (stopped || !result.ok) {
          return;
        }
        onView(result);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(read, intervalMs);
  // A focus listener on the window, not on document: coming back from
  // Finder/Explorer fires exactly this. Resolved per start (not at module
  // load) so a test can supply its own target, and absent outside a window.
  const target = typeof window !== "undefined" ? window : undefined;
  const onFocus = (): void => read();
  target?.addEventListener("focus", onFocus);

  return () => {
    stopped = true;
    clearInterval(timer);
    target?.removeEventListener("focus", onFocus);
  };
}

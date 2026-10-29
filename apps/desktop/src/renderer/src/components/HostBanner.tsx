import type { ConnectionPhase } from "../store.js";

/**
 * The terminal-connection banners above the transcript (design phase-2 §2.4).
 * Extracted from `App.tsx`'s `SessionSurface` so the states can be asserted
 * without mounting the whole surface.
 *
 * A fatal message is always shown. Only `workspaceMissing` — the terminal
 * GitHub #6 condition, where main refused to fork because the tab's folder no
 * longer exists — also suppresses the connection lines: no amount of waiting
 * brings that host back, so "reconnecting…" would be a lie. Every OTHER fatal
 * (a failed turn, a failed compaction) leaves a live host that may well exit
 * and respawn, so the connection status must keep showing.
 */
export function HostBanner({
  connection,
  lastFatal,
  workspaceMissing,
  hostFailure = null,
}: {
  connection: ConnectionPhase;
  lastFatal: string | null;
  /** The tab is stopped for good: its workspace folder is gone (GitHub #6). */
  workspaceMissing: boolean;
  hostFailure?: import("../../../shared/host-failure.js").HostFailure | null;
}) {
  return (
    <>
      {hostFailure && <div className="banner banner-host-exited" role="alert">{hostFailure.message}</div>}
      {!workspaceMissing && !hostFailure && (
        <>
          {connection === "host_exited" && (
            <div className="banner banner-host-exited" role="alert">
              Host process exited — reconnecting…
            </div>
          )}
          {connection === "awaiting_port" && <div className="banner banner-info">Waiting for the host connection…</div>}
          {connection === "awaiting_host_ready" && <div className="banner banner-info">Connecting to host…</div>}
        </>
      )}
      {lastFatal !== null && (
        <div className="banner banner-fatal" role="alert">
          Host fatal: {lastFatal}
        </div>
      )}
    </>
  );
}

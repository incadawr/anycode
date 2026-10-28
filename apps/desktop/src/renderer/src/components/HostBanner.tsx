import type { ConnectionPhase } from "../store.js";

/**
 * The terminal-connection banners above the transcript (design phase-2 §2.4).
 * Extracted from `App.tsx`'s `SessionSurface` so the states can be asserted
 * without mounting the whole surface.
 *
 * `lastFatal` wins over the connection-phase lines: when the cause is known,
 * the surface must not also claim it is "reconnecting…" — the GitHub #6 shape
 * (a workspace folder that no longer exists never gets a host, so no amount of
 * waiting brings the tab back).
 */
export function HostBanner({
  connection,
  lastFatal,
}: {
  connection: ConnectionPhase;
  lastFatal: string | null;
}) {
  if (lastFatal !== null) {
    return (
      <div className="banner banner-fatal" role="alert">
        Host fatal: {lastFatal}
      </div>
    );
  }
  return (
    <>
      {connection === "host_exited" && (
        <div className="banner banner-host-exited" role="alert">
          Host process exited — reconnecting…
        </div>
      )}
      {connection === "awaiting_port" && <div className="banner banner-info">Waiting for the host connection…</div>}
      {connection === "awaiting_host_ready" && <div className="banner banner-info">Connecting to host…</div>}
    </>
  );
}

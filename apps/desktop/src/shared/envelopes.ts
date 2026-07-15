/**
 * Control-plane window-message envelopes between preload and the page


 *
 * Deliberately a VALUE-ONLY module with zero imports: unlike protocol.ts
 * (whose runtime side pulls in zod + @anycode/core and is therefore
 * host-only), this file is safe to value-import from the sandboxed preload
 * (CJS build) and the renderer web bundle alike.
 *
 * Contract (MVP.2 preload implements the sending side, renderer/port.ts the
 * receiving side):
 *  - The ipcRenderer channel names main uses with `webContents.postMessage` /
 *    `webContents.send` are the SAME strings as the page envelope `type`
 *    values — one name per signal end to end.
 *  - Port delivery: main -> `webContents.postMessage(PORT_ENVELOPE_TYPE,
 *    { tabId, workspace }, [port])`; preload -> `window.postMessage({ type:
 *    PORT_ENVELOPE_TYPE, tabId, workspace }, "*", event.ports)`; renderer takes
 *    `event.ports[0]` and reads tabId/workspace off the envelope.
 *  - Host exit: main -> `webContents.send(HOST_EXITED_ENVELOPE_TYPE,
 *    { tabId })`; preload -> `window.postMessage({ type:
 *    HOST_EXITED_ENVELOPE_TYPE, tabId }, "*")` (no ports); renderer shows the
 *    host-exited banner for that tab and awaits a replacement port.
 *
 * Phase-2 delta (§3.1, refrozen by task 2.1.1): both envelopes carry a `tabId`
 * (the routing key — channel-per-tab means the data plane stays tab-agnostic,
 * so addressing lives here in the control plane), and the port envelope also
 * carries the `workspace` (known before the host forks). Additive-by-type only:
 * both ends ship in one slice, no external consumers. Task 2.1.1 threads a
 * single hardcoded PRIMARY tab through these fields; multi-tab routing is 2.1.4.
 */

/** Envelope type / IPC channel for delivering the host MessagePort into the page. */
export const PORT_ENVELOPE_TYPE = "anycode:port" as const;

/** Envelope type / IPC channel notifying the page that the host process exited. */
export const HOST_EXITED_ENVELOPE_TYPE = "anycode:host-exited" as const;

/** Page envelope carried alongside the transferred MessagePort. */
export interface PortEnvelope {
  type: typeof PORT_ENVELOPE_TYPE;
  /** Routing key: which tab this port belongs to (§3.1). */
  tabId: string;
  /** The tab's workspace (= host cwd), known before the host forks. */
  workspace: string;
  /**
   * The provider connection this tab is pinned to (TASK.45 W10-FIX F2), so the
   * renderer's ModelPill can target the PINNED connection's catalog + write-target
   * instead of the current active one. Additive control-plane metadata — this is
   * NOT the session-stream (shared/protocol.ts stays byte-untouched); absent for
   * an unpinned/legacy tab (ModelPill then falls back to the active connection).
   * `providerId` is main-derived from the connection at delivery time (a
   * connection's `providerId` is immutable), so the renderer never guesses it.
   */
  connectionId?: string;
  providerId?: string;
}

/** Page envelope for the host-exited notification (no ports attached). */
export interface HostExitedEnvelope {
  type: typeof HOST_EXITED_ENVELOPE_TYPE;
  /** Routing key: which tab's host exited (§3.1). */
  tabId: string;
}

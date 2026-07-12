/**
 * Renderer-side port acquisition and typed send/subscribe wrapper (design

 * re-posts the MessagePort it receives from main into the page via
 * window.postMessage, tagged with `{tabId, workspace}` (§3.1) since the
 * channel-per-tab topology makes the envelope the sole routing key — the
 * data plane itself (`HostToUiMessage`/`UiToHostMessage`) stays tab-agnostic.
 *
 * This module owns only the CONNECTION PRIMITIVES (wrapping a raw port,
 * listening for envelopes) and the top-level `ConnectionManager` that routes
 * each envelope to the right tab. It does NOT know about stores or the tab
 * list — that's tab-registry.ts/tabs-store.ts — so `startConnectionManager`
 * takes a small registry interface as a parameter instead of importing the
 * registry singleton directly, avoiding a port.ts <-> tab-registry.ts import
 * cycle (tab-registry.ts imports `connectHost`/`HostConnection` from here).
 *
 * Slice 2.4 (design slice-2.4-cut.md §3.1/§3.4/§4) adds the SECOND,
 * disjoint term-channel per tab (renderer<->host PTY bridge): `connectTerminal`/
 * `TerminalConnection`/`onTerminalPort` below mirror `connectHost`/
 * `HostConnection`/`onHostPort` 1:1 for the `TermToHostMessage`/
 * `TermToUiMessage` vocabulary (shared/terminal.ts, frozen by task 2.4.1) —
 * same envelope-forwarding pattern, same tabId-is-the-routing-key discipline,
 * just a different port and a different word list. `startConnectionManager`
 * wires both listeners into the one `ConnectionRegistry` tab-registry.ts hands
 * it, so a single teardown call stops both.
 */
import type { HostToUiMessage, UiToHostMessage } from "../../shared/protocol.js";
import { HOST_EXITED_ENVELOPE_TYPE, PORT_ENVELOPE_TYPE } from "../../shared/envelopes.js";
import type { TermToHostMessage, TermToUiMessage } from "../../shared/terminal.js";
import { TERMINAL_PORT_ENVELOPE_TYPE } from "../../shared/terminal.js";

export interface HostConnection {
  send(message: UiToHostMessage): void;
  subscribe(cb: (message: HostToUiMessage) => void): () => void;
}

/** Wraps a raw MessagePort with the typed send/subscribe surface used by the store/components. */
export function connectHost(port: MessagePort): HostConnection {
  const listeners = new Set<(message: HostToUiMessage) => void>();

  port.onmessage = (event: MessageEvent<HostToUiMessage>) => {
    for (const listener of listeners) {
      listener(event.data);
    }
  };
  // DOM MessagePort auto-starts once `.onmessage` is assigned (unlike Electron's

  // host-side-only gotcha).

  return {
    send(message: UiToHostMessage): void {
      port.postMessage(message);
    },
    subscribe(cb: (message: HostToUiMessage) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * The term-channel counterpart of `HostConnection` (design slice-2.4-cut.md
 * §3.1/§4): same wrap-a-raw-port shape, disjoint message vocabulary
 * (`TermToHostMessage`/`TermToUiMessage`) — the two channels are never mixed,
 * by construction of the types alone.
 */
export interface TerminalConnection {
  send(message: TermToHostMessage): void;
  subscribe(cb: (message: TermToUiMessage) => void): () => void;
}

/** Wraps a raw term-port with the typed send/subscribe surface — the term-channel twin of `connectHost`. */
export function connectTerminal(port: MessagePort): TerminalConnection {
  const listeners = new Set<(message: TermToUiMessage) => void>();

  port.onmessage = (event: MessageEvent<TermToUiMessage>) => {
    for (const listener of listeners) {
      listener(event.data);
    }
  };

  return {
    send(message: TermToHostMessage): void {
      port.postMessage(message);
    },
    subscribe(cb: (message: TermToUiMessage) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Tab metadata carried on the port envelope (Phase-2 §3.1). */
export interface HostPortMeta {
  tabId: string;
  workspace: string;
}

/**
 * Subscribes to every MessagePort the preload bridge forwards via
 * `window.postMessage({type:"anycode:port", tabId, workspace}, "*", ports)` —

 * delivers a brand new port for the SAME tabId that must replace that tab's
 * connection in place, and opening a new tab delivers a port for a brand new
 * tabId. This listener stays attached for the whole app lifetime; the
 * per-tabId routing is `ConnectionManager`'s job below (§2.4/§4.3).
 */
export function onHostPort(cb: (port: MessagePort, meta: HostPortMeta) => void): () => void {
  function handleMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    const isPortEnvelope =
      typeof data === "object" && data !== null && (data as { type?: unknown }).type === PORT_ENVELOPE_TYPE;
    if (!isPortEnvelope || event.ports.length === 0) {
      return;
    }
    const port = event.ports[0];
    if (port) {
      const envelope = data as { tabId?: unknown; workspace?: unknown };
      const tabId = typeof envelope.tabId === "string" ? envelope.tabId : "";
      const wsFromEnvelope = typeof envelope.workspace === "string" ? envelope.workspace : "";
      cb(port, { tabId, workspace: wsFromEnvelope });
    }
  }
  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}

/**
 * Subscribes to every term-port the preload bridge forwards via
 * `window.postMessage({type:"anycode:terminal-port", tabId}, "*", ports)`
 * (design slice-2.4-cut.md §3.4) — the term-channel twin of `onHostPort`. No
 * `workspace` on this envelope (§3.1: the tab is already known by the time its
 * term-port arrives, since it's always delivered paired with a UI port), so
 * the callback carries just the raw tabId string instead of a meta object.
 */
export function onTerminalPort(cb: (port: MessagePort, tabId: string) => void): () => void {
  function handleMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    const isTerminalPortEnvelope =
      typeof data === "object" && data !== null && (data as { type?: unknown }).type === TERMINAL_PORT_ENVELOPE_TYPE;
    if (!isTerminalPortEnvelope || event.ports.length === 0) {
      return;
    }
    const port = event.ports[0];
    if (port) {
      const tabId = typeof (data as { tabId?: unknown }).tabId === "string" ? (data as { tabId: string }).tabId : "";
      cb(port, tabId);
    }
  }
  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}

/**
 * Subscribes to the host-exited notification forwarded by preload (design

 * preload -> `window.postMessage({type: HOST_EXITED_ENVELOPE_TYPE, tabId})`,
 * no ports — mirroring the `anycode:port` pattern 1:1). Phase-2 §3.1: the
 * tabId identifies which tab's host exited; per-tab routing is
 * `ConnectionManager`'s job below.
 */
export function onHostExited(cb: (tabId: string) => void): () => void {
  function handleMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    const isExitEnvelope =
      typeof data === "object" && data !== null && (data as { type?: unknown }).type === HOST_EXITED_ENVELOPE_TYPE;
    if (isExitEnvelope) {
      const tabId = typeof (data as { tabId?: unknown }).tabId === "string" ? (data as { tabId: string }).tabId : "";
      cb(tabId);
    }
  }
  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}

/**
 * The minimal surface `ConnectionManager` needs from a tab registry (design

 * this structurally — no import needed, which is what keeps this module free
 * of a dependency cycle back to tab-registry.ts.
 */
export interface ConnectionRegistry {
  /**
   * Registers (auto-registering an unknown tabId, §2.2 reload-restore) and
   * attaches a fresh port for `tabId`. Returns false when the tabId belongs

   * race a closeTab that beat it to the punch) — the caller drops it with a
   * warn instead of resurrecting a closed tab.
   */
  registerPort(tabId: string, workspace: string, port: MessagePort): boolean;
  /** Flips the given tab's connection/banner state to host-exited; a no-op for a tab that isn't registered. */
  markHostExited(tabId: string): void;
  /**
   * Attaches a fresh term-port for `tabId` (design slice-2.4-cut.md §4).
   * Unlike `registerPort`, an unknown tabId is NOT auto-registered — the
   * term-port always arrives paired with an already-registered UI port, so
   * false here means "drop it" (the caller warns), never "resurrect a tab
   * that doesn't exist".
   */
  registerTerminalPort(tabId: string, port: MessagePort): boolean;
}

/**
 * Owns the renderer<->host connection lifecycle end to end for ALL tabs
 * (design §2.4, generalizing the old single-tab `startHostConnection`): every
 * port envelope and host-exited notification is routed to `registry` keyed by
 * its tabId. Switching which tab is active in the UI has zero effect here —
 * this listener (and the registry's per-tab store subscriptions it drives)
 * keeps running for every tab regardless of what's currently rendered, so
 * background tabs keep accumulating deltas (§4.3 test criterion).
 *
 * Call once from App.tsx; the returned teardown is for tests/HMR-disposal
 * only (there is exactly one ConnectionManager for the app's lifetime otherwise).
 */
export function startConnectionManager(registry: ConnectionRegistry): () => void {
  const stopPortListener = onHostPort((port, meta) => {
    if (!meta.tabId) {
      console.warn("[port] dropping port envelope with no tabId", meta);
      return;
    }
    const attached = registry.registerPort(meta.tabId, meta.workspace, port);
    if (!attached) {
      console.warn("[port] dropping port for a closed/unknown tab", meta.tabId);
    }
  });

  const stopTerminalPortListener = onTerminalPort((port, tabId) => {
    if (!tabId) {
      console.warn("[port] dropping terminal port envelope with no tabId");
      return;
    }
    const attached = registry.registerTerminalPort(tabId, port);
    if (!attached) {
      console.warn("[port] dropping terminal port for a closed/unknown tab", tabId);
    }
  });

  const stopExitListener = onHostExited((tabId) => {
    if (!tabId) {
      return;
    }
    registry.markHostExited(tabId);
  });

  return () => {
    stopPortListener();
    stopTerminalPortListener();
    stopExitListener();
  };
}

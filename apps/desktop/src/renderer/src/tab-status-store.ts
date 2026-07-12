/**
 * Cross-tab coarse-status mirror (ui-roadmap §4-R10, slice-R10-cut §2.1).
 * One tiny zustand store the Sidebar subscribes to INSTEAD of subscribing to
 * every background tab's full DesktopStore: tab-registry.ts pipes each tab
 * store's coarse status (turn running / permission pending / connection
 * liveness) through `applyCoarse`, which writes the map ONLY when the tuple
 * actually flips — a transcript delta, a context_usage tick, or any other
 * high-frequency setState on a tab store bails here without touching the map,
 * so the map's identity (and therefore Sidebar's re-render cadence) moves at
 * human speed: turn start/stop, permission open/settle, visit, host lifecycle.
 *
 * Deliberately a SEPARATE store, not fields on tabs-store's `TabInfo`:
 * (1) Sidebar refetches the persisted-session index (an IPC `listSessions()`)
 *     whenever the `tabs` array identity changes — putting running/permission
 *     on TabInfo would fire that IPC on every turn boundary of every tab;
 * (2) automation.ts's `snapshot()` projects `TabInfo[]` + per-tab
 *     `DesktopState` — a separate store is structurally invisible to the
 *     byte-snapshot contract (slice-R10-cut §2.5 hard invariant).
 *
 * Attention ("unseen completion") semantics — the R8 pairing:
 * `isTurnCompletion` below is the ONE shared atom (running→idle edge) that
 * both R8's OS notification (window-level unseen: hidden/unfocused) and R10's
 * sidebar dot (tab-level unseen: not the active tab) consume. The two gates
 * are different "unseen" conditions and are deliberately NOT unified.
 *
 * Factory-plus-singleton, mirroring tabs-store.ts: `createTabStatusStore`
 * for test isolation, `useTabStatusStore` for the app. Pure renderer module:
 * imports zustand + store.ts TYPES only — safe in the node test env, safe to
 * import from Sidebar.tsx (which must never import tab-registry.ts and its
 * port/xterm graph).
 */
import { create } from "zustand";
import type { DesktopState, TurnState } from "./store.js";

/** One tab's mirrored coarse status — the exact roadmap tuple. */
export interface TabStatus {
  /** Turn running on a live (`connection === "ready"`) host. */
  running: boolean;
  /** Permission pending on a live host — the agent is blocked on the user. */
  needsApproval: boolean;
  /** Turn completed while the tab was backgrounded; cleared on visit or on the next turn start. */
  attention: boolean;
}

/**
 * Raw coarse projection of one tab store's state (input to `applyCoarse`).
 * `live` gates BOTH rendering (a dead/handshaking host neither "runs" nor
 * "needs approval" — host_exited already has its own danger channel via
 * TabInfo.hostExited) AND completion detection (a running→idle edge caused by
 * a host exit or a respawn's `host_ready` session reset is NOT a completion —
 * without this gate every background crash/respawn would mint a phantom
 * attention dot).
 */
export interface CoarseStatus {
  turn: TurnState["status"];
  needsApproval: boolean;
  live: boolean;
}

/**
 * The shared "turn completed" edge — R8's OS notification and R10's attention
 * dot agree on this one definition (ui-roadmap §4-R10: "one pure helper").
 * Consumers add their own "unseen" gate on top: R8 = window hidden/unfocused,
 * R10 = tab not active.
 */
export function isTurnCompletion(prev: TurnState["status"], next: TurnState["status"]): boolean {
  return prev === "running" && next === "idle";
}

/** Dumb projection DesktopState → CoarseStatus; all transition semantics live in `applyCoarse`. */
export function deriveCoarse(state: Pick<DesktopState, "turn" | "connection" | "permission">): CoarseStatus {
  return {
    turn: state.turn.status,
    needsApproval: state.permission !== null,
    live: state.connection === "ready",
  };
}

/** The one indicator kind an open sidebar row shows (slice-R10-cut §2.4 precedence). */
export type RowStatusKind = "host-exited" | "permission" | "running" | "attention";

/**
 * Row-indicator precedence — urgency-to-act descending (slice-R10-cut §3.1):
 * dead session (danger) > blocked on you (warning) > working (quiet motion) >
 * unseen result (accent invitation) > nothing. `hostExited` comes from
 * TabInfo (the rare-flip mirror that already exists); `status` from this
 * store; `undefined` status = tab not (yet) mirrored → only hostExited can
 * apply. Exactly one kind (or null) — a row never stacks indicators.
 */
export function rowStatusKind(status: TabStatus | undefined, hostExited: boolean): RowStatusKind | null {
  if (hostExited) {
    return "host-exited";
  }
  if (status === undefined) {
    return null;
  }
  if (status.needsApproval) {
    return "permission";
  }
  if (status.running) {
    return "running";
  }
  if (status.attention) {
    return "attention";
  }
  return null;
}

export interface TabStatusState {
  /** tabId → coarse status. REPLACED (new Map) on every real flip; never mutated in place. */
  statuses: ReadonlyMap<string, TabStatus>;

  /**
   * Applies one coarse snapshot for `tabId`. THE STORM GUARD LIVES HERE
   * (slice-R10-cut §2.2): the stored entry is the last-written tuple; if the
   * derived {running, needsApproval, attention} equals it field-by-field,
   * return WITHOUT calling set() — no zustand notification, no Sidebar
   * re-render. tab-registry.ts calls this on EVERY setState of every tab
   * store; the per-call cost on the bail path is one Map.get plus at most
   * four boolean compares.
   *
   * Transition semantics:
   *  - running       = next.live && next.turn === "running"
   *  - needsApproval = next.live && next.needsApproval
   *  - completion    = stored.running && next.live && isTurnCompletion(...)
   *    (the `next.live` gate suppresses host-exit / respawn-reset edges)
   *  - attention     = running ? false            // a new turn clears it
   *                  : completion ? background     // set only when unseen
   *                  : stored.attention            // otherwise sticky
   * `background` (activeTabId !== tabId) is read by the CALLER at event time —
   * the completion moment decides, not registration order.
   */
  applyCoarse(tabId: string, next: CoarseStatus, background: boolean): void;

  /** Marks a visit: clears `attention` for `tabId`. No-op (no set, same map identity) when nothing to clear. */
  clearAttention(tabId: string): void;

  /** Removes the tab's entry entirely (disposeTab teardown). No-op for an unknown tabId. */
  remove(tabId: string): void;

  /** Test-only escape hatch, mirroring tab-registry's own `reset()`. Production code never calls this. */
  reset(): void;
}

/** Builds a tab-status store instance; the factory exists so tests get an isolated store instead of sharing the singleton. */
export function createTabStatusStore() {
  return create<TabStatusState>()((set, get) => ({
    statuses: new Map<string, TabStatus>(),

    applyCoarse(tabId, next, background): void {
      const prev = get().statuses.get(tabId);
      const running = next.live && next.turn === "running";
      const needsApproval = next.live && next.needsApproval;
      const completed =
        prev !== undefined && next.live && isTurnCompletion(prev.running ? "running" : "idle", next.turn);
      const attention = running ? false : completed ? background : (prev?.attention ?? false);
      if (
        prev !== undefined &&
        prev.running === running &&
        prev.needsApproval === needsApproval &&
        prev.attention === attention
      ) {
        return;
      }
      const statuses = new Map(get().statuses);
      statuses.set(tabId, { running, needsApproval, attention });
      set({ statuses });
    },

    clearAttention(tabId): void {
      const prev = get().statuses.get(tabId);
      if (prev === undefined || !prev.attention) {
        return;
      }
      const statuses = new Map(get().statuses);
      statuses.set(tabId, { ...prev, attention: false });
      set({ statuses });
    },

    remove(tabId): void {
      if (!get().statuses.has(tabId)) {
        return;
      }
      const statuses = new Map(get().statuses);
      statuses.delete(tabId);
      set({ statuses });
    },

    reset(): void {
      set({ statuses: new Map<string, TabStatus>() });
    },
  }));
}

export type TabStatusStoreApi = ReturnType<typeof createTabStatusStore>;

/** The app's single tab-status store (mirrors tabs-store.ts's `useTabsStore`). */
export const useTabStatusStore = createTabStatusStore();

/**
 * Per-tab connection registry (design phase-2.md §2.4/§4.3): one DesktopStore
 * instance + one HostConnection per live tabId, held outside React so
 * background tabs keep accumulating agent state whether or not they're
 * mounted. This is the "reload-restore" source of truth described in §2.2:
 * main is the source of truth for WHICH tabs exist, and this registry catches
 * up by auto-registering any tabId it hasn't seen yet.
 *
 * Dispose discipline (the whole reason this is its own module and not just
 * inline state in port.ts): closing a tab must remove its store entry, drop
 * its connection, and unsubscribe its message listener in one atomic step —
 * `disposeTab` below is the only place that happens, and it's the only way an
 * entry ever leaves the map (aside from replacement, which reuses the entry).
 *
 * Factory-plus-singleton, mirroring store.ts/tabs-store.ts: `createTabRegistry`
 * for test isolation with injected fakes, `tabRegistry` for the app.
 *
 * Slice 2.4 (design slice-2.4-cut.md §4) folds the term-channel connection
 * into the SAME per-tab entry, alongside (not instead of) the UI connection:
 * `terminal`/`unsubscribeTerminalMessages` mirror `connection`/
 * `unsubscribeMessages` 1:1 for the term-port, and `registerTerminalPort`/
 * `openTerminal`/`sendToTerminal` are this registry's term-channel analogues
 * of `registerPort`/`sendToTab`. This module owns the term CONNECTION
 * lifecycle; the xterm instance itself (buffer, DOM holder, fit-addon) lives
 * in terminal-view.ts, a one-directional dependency (terminal-view.ts knows
 * nothing about ports/tabs-store) — every incoming `TermToUiMessage` this
 * registry receives is routed straight into `terminalView.write`/
 * `markOpened`/`markDead`, and `disposeTab`/`markHostExited` call
 * `terminalView.dispose`/`markDead` to keep the two lifecycles in lockstep.
 */
import { createDesktopStore, type DesktopState } from "./store.js";
import { transcriptTextWithImages } from "./queue-format.js";
import type { PermissionMode } from "@anycode/core";
import { connectHost, connectTerminal, type HostConnection, type TerminalConnection } from "./port.js";
import { useTabsStore, type TabsStoreApi } from "./tabs-store.js";
import { deriveCoarse, useTabStatusStore, type TabStatusStoreApi } from "./tab-status-store.js";
import { terminalView as defaultTerminalView, type TerminalDims, type TerminalView } from "./terminal-view.js";
import type { UiToHostMessage } from "../../shared/protocol.js";
import { TERM_DEFAULT_COLS, TERM_DEFAULT_ROWS, type TermToHostMessage } from "../../shared/terminal.js";
import { loadUsageLimitNotices, parseUsageLimitNotice, saveUsageLimitNotice } from "./provider-notices.js";

/** Convenience alias for the store instance type `createDesktopStore()` returns. */
export type DesktopStoreApi = ReturnType<typeof createDesktopStore>;

interface TabEntry {
  store: DesktopStoreApi;
  connection: HostConnection | null;
  unsubscribeMessages: (() => void) | null;
  terminal: TerminalConnection | null;
  unsubscribeTerminalMessages: (() => void) | null;
  /** R10 status-mirror subscription on this tab's own store; lives for the STORE's lifetime (survives respawns), dies in disposeTab. */
  unsubscribeStatus: (() => void) | null;
  /** P7.14 prompt-queue drainer subscription on this tab's own store; store-lifetime (survives respawns), dies in disposeTab (symmetry with `unsubscribeStatus`). */
  unsubscribeQueue: (() => void) | null;
}

export interface TabRegistry {
  /**
   * Attaches `port` to `tabId`, creating a fresh per-tab store (and
   * registering the tab in the tabs-store) the first time this tabId is
   * seen — covers both a brand-new tab and renderer-reload restoration
   * (§2.2: main redelivers a port to every live tab on `did-finish-load`,
   * and the renderer has no prior memory of them after a reload).
   *
   * Replaces the connection in place on subsequent calls for a KNOWN tabId

   * store/transcript. Returns false — and registers nothing — if `tabId` has

   * delivery); the caller is expected to drop the port with a warn.
   */
  registerPort(tabId: string, workspace: string, port: MessagePort): boolean;
  /**
   * Flips the tab's own store into `host_exited` and mirrors that onto the
   * tabs-store's `hostExited` flag (for the TabBar dot) — ONLY for this
   * tabId; every other tab's store/banner state is untouched. Drops the dead
   * connection reference; a later `registerPort` (respawn) clears the flag
   * again and reconnects. No-op for an unknown/disposed tabId.
   */
  markHostExited(tabId: string): void;
  /**
   * Tears the tab down completely: unsubscribes its message listener, drops
   * the entry from the map, and removes it from the tabs-store. Marks the
   * tabId as closed so a stray in-flight port for it is dropped rather than
   * resurrecting the tab. No-op (beyond marking closed) for an unknown tabId.
   */
  disposeTab(tabId: string): void;
  /** Sends to the tab's live connection; warns and drops if the tab has no connection (unknown tab, or mid-reconnect/exited). */
  sendToTab(tabId: string, message: UiToHostMessage): void;
  /** The tab's store instance, or undefined if the tab isn't registered (yet, or anymore). */
  getStore(tabId: string): DesktopStoreApi | undefined;
  /** Whether `tabId` has been disposed (closeTab already ran for it). */
  isClosed(tabId: string): boolean;
  /**
   * Attaches a fresh term-port for `tabId` (design slice-2.4-cut.md §4).
   * Unlike `registerPort`, an unknown/closed tabId is NOT auto-registered —
   * the term-port always arrives paired with an already-registered UI port,
   * so it returns false (the caller warns+drops) instead of resurrecting a
   * tab that doesn't exist. Every incoming `TermToUiMessage` on the new
   * connection is routed straight into terminal-view.ts's xterm instance for
   * this tab. If the tab's terminal panel is already open (tabs-store's
   * `terminalOpen` flag), immediately resends `term_open` — this is the
   * reattach path a host respawn or a page reload takes while the panel
   * stayed visible (the host's `term_open` handling is reattach-idempotent:
   * a live shell just replies with its ring-buffer tail again).
   */
  registerTerminalPort(tabId: string, port: MessagePort): boolean;
  /**
   * Marks the tab's terminal panel open (idempotent in the tabs-store) and,
   * if there's a live terminal connection, sends `term_open` with the given
   * geometry. Safe to call with no live connection yet — `registerTerminalPort`
   * above sends the deferred `term_open` once the port arrives, gated on the
   * very flag this method just set. This is the ONLY place a `term_open` is


   */
  openTerminal(tabId: string, dims: TerminalDims): void;
  /** Sends a term-plane message to the tab's live terminal connection; warns and drops if there is none (mirrors `sendToTab`). */
  sendToTerminal(tabId: string, message: TermToHostMessage): void;
  /** Test-only escape hatch: wipes every entry and the closed-set. Production code never calls this. */
  reset(): void;
  /**
   * Queues text to dispatch as the tab's first user turn once its connection is
   * "ready" (slice P7.12 §4.2). Dispatch mirrors Composer's `handleSend`
   * exactly: `appendUserText(requestId, text)` + a `user_message` send, so the
   * transcript echo and the wire message stay byte-parity with a normal send.
   * An unknown/closed tabId drops the request; an already-ready tab dispatches
   * immediately.
   *
   * `model` is an additive task-scoped pick: if given and it
   * differs from the boot model the tab's `host_ready` reports, a `set_model`
   * is sent on the SAME port immediately before the initial `user_message` —
   * in-order delivery, host idle at `host_ready` so the busy-guard passes.
   * Omitted/undefined preserves the prior behavior exactly (no set_model).
   * `mode` follows the same recipe for the start screen's permission-mode
   * chip; it is sent before model and user_message, so the host persists it
   * before the first turn begins.
   */
  queueInitialPrompt(tabId: string, text: string, model?: string, mode?: PermissionMode): void;
}

/**
 * Builds a tab registry bound to `tabsStore`. `createStore` is injectable
 * (defaults to the real `createDesktopStore`) so tests can hand each tab a
 * store wired to a manual FrameScheduler, the same DI pattern store.test.ts
 * already uses for deterministic delta-flush assertions. `terminalView` is
 * injectable the same way (defaults to the app's real singleton) so
 * tab-registry.test.ts can assert on the term-plane routing without touching
 * `@xterm/xterm` or `document` — the terminal-view.test.ts suite already
 * covers the xterm-instance/DOM-reparent logic in isolation.
 */
export function createTabRegistry(
  tabsStore: TabsStoreApi,
  createStore: () => DesktopStoreApi = () => createDesktopStore(),
  terminalView: TerminalView = defaultTerminalView,
  statusStore: TabStatusStoreApi = useTabStatusStore,
): TabRegistry {
  const entries = new Map<string, TabEntry>();
  const closedTabIds = new Set<string>();
  /**
   * Slice P7.12 §4.2 / F5#1b D3: text (+ optional task-scoped model pick)
   * queued via `queueInitialPrompt`, waiting for its tab's `host_ready`.
   */
  const pendingInitialPrompts = new Map<string, { text: string; model?: string; mode?: PermissionMode }>();

  /**
   * First-turn picks must reach the host before the first user message. The
   * MessagePort preserves order, and host_ready guarantees that the session is
   * idle, so the host can persist mode/model before it starts the turn.
   */
  function applyInitialPicks(
    entry: TabEntry,
    model: string | undefined,
    mode: PermissionMode | undefined,
    current: { model: string | null; mode: PermissionMode | null },
  ): void {
    if (mode !== undefined && mode !== current.mode) {
      entry.connection?.send({ type: "set_mode", mode });
    }
    if (model !== undefined && model !== current.model) {
      entry.connection?.send({ type: "set_model", model });
    }
  }

  /** Dispatch recipe byte-parity with Composer.tsx's `handleSend`: echo the block, then send the wire message. */
  function dispatchInitialPrompt(entry: TabEntry, text: string): void {
    const requestId = crypto.randomUUID();
    entry.store.getState().appendUserText(requestId, text);
    entry.connection?.send({ type: "user_message", requestId, text });
  }

  /**
   * Drains ONE prompt from the tab's queue (slice P7.14 §2.1). `takeQueueHead`
   * mints the in-flight slot synchronously, so re-entrant `maybeDrain` calls
   * fired by the `appendUserText` set() below see a non-null inFlight and bail —
   * exactly one item leaves per idle period (FIFO). Wire send is byte-parity
   * with Composer's image send: images only when present. Returns early if the
   * head couldn't be taken (queue emptied/paused/inFlight by a racing update).
   */
  function dispatchQueuedPrompt(entry: TabEntry): void {
    const requestId = crypto.randomUUID();
    const item = entry.store.getState().takeQueueHead(requestId);
    if (item === null) {
      return;
    }
    entry.store.getState().appendUserText(requestId, transcriptTextWithImages(item.text, item.images.length));
    entry.connection?.send({
      type: "user_message",
      requestId,
      text: item.text,
      ...(item.images.length > 0 ? { images: item.images.map((image) => image.attachment) } : {}),
    });
  }

  // R10 visit-clear (slice-R10-cut §2.3): a tab BECOMING ACTIVE is the "visit"
  // that marks its unseen completion seen — watched here, at the store level,
  // because setActiveTab has many callers (sidebar click, ⌘1-9, palette
  // switch, tab-create focus, close-neighbor activation, automation) and a
  // UI-side clear would miss some. tabsStore notifies on every tabs mutation;
  // the prevState compare gates this to real activeTabId flips (zustand v5
  // passes (state, prevState) to plain subscribe listeners). Factory-lifetime
  // subscription, deliberately never unsubscribed — it lives exactly as long
  // as the registry itself (app lifetime for the singleton; per-instance in
  // tests, which build isolated store pairs anyway).
  tabsStore.subscribe((state, prevState) => {
    if (state.activeTabId !== prevState.activeTabId && state.activeTabId !== null) {
      statusStore.getState().clearAttention(state.activeTabId);
    }
  });

  /** (Re)connects `port` to an existing entry: tears down the old subscription, wires the new one, kicks off the handshake. */
  function attach(entry: TabEntry, tabId: string, port: MessagePort): void {
    entry.unsubscribeMessages?.();
    const connection = connectHost(port);
    entry.connection = connection;
    entry.unsubscribeMessages = connection.subscribe((message) => {
      // sessionId lands on host_ready but isn't part of the frozen DesktopState
      // shape (store.ts §3.3) — the registry is the natural place to lift it
      // into the tabs-store for the TabBar/picker, alongside forwarding the
      // message to the tab's own reducer.
      if (message.type === "host_ready") {
        tabsStore.getState().setSessionId(tabId, message.sessionId);
      }
      // Phase 4 slice 4.4-T (design feature-session-titles.md §4): title lives
      // in the tabs-store (Sidebar reads it from there), not the per-tab
      // DesktopState — lift it here the same way host_ready's sessionId is.
      if (message.type === "title_changed") {
        tabsStore.getState().setTitle(tabId, message.title);
      }
      // host_ready's own applyHostMessage case resets the transcript (store.ts
      // §3.3 respawn semantics) — dispatch AFTER that reset, or a queued
      // initial prompt appended before it would be wiped along with it (§4.2).
      entry.store.getState().applyHostMessage(message);
      if (message.type === "host_ready") {
        // Renderer-only quota diagnostics are restored after host_ready's
        // session reset. They are intentionally not part of session_history.
        for (const notice of loadUsageLimitNotices(message.sessionId)) {
          entry.store.getState().appendUsageLimitNotice(notice);
        }
        const pending = pendingInitialPrompts.get(tabId);
        if (pending !== undefined) {
          // Delete BEFORE dispatch: a respawn's second host_ready must not
          // re-send a prompt (or model switch) that already went out on the
          // first one — the resumed session persisted its own model.
          pendingInitialPrompts.delete(tabId);
          // F5#1b D3: a task-scoped model pick that differs from the boot
          // model is switched BEFORE the initial prompt, same port ⇒ in-order
          // delivery; the host is idle at host_ready so the busy-guard passes.
          applyInitialPicks(entry, pending.model, pending.mode, { model: message.model, mode: message.mode });
          dispatchInitialPrompt(entry, pending.text);
        }
      }
      if (message.type === "agent_event" && message.event.type === "error") {
        const notice = parseUsageLimitNotice(message.event.error);
        const sessionId = tabsStore.getState().tabs.find((tab) => tab.tabId === tabId)?.sessionId;
        if (notice !== null && sessionId !== null && sessionId !== undefined) {
          saveUsageLimitNotice(sessionId, notice);
        }
      }
    });
    tabsStore.getState().setHostExited(tabId, false);
    entry.store.getState().setAwaitingHostReady();
    connection.send({ type: "ui_ready" });
  }

  /** (Re)connects a term-port to an existing entry: tears down the old subscription, routes every message into terminal-view.ts for this tabId. */
  function attachTerminal(entry: TabEntry, tabId: string, port: MessagePort): void {
    entry.unsubscribeTerminalMessages?.();
    const connection = connectTerminal(port);
    entry.terminal = connection;
    entry.unsubscribeTerminalMessages = connection.subscribe((message) => {
      switch (message.type) {
        case "term_opened":
          terminalView.markOpened(tabId, message.replay);
          break;
        case "term_data":
          terminalView.write(tabId, message.data);
          break;
        case "term_exited": {
          const signalPart = message.signal !== undefined ? `, signal ${message.signal}` : "";
          terminalView.markDead(tabId, `process exited (code ${message.exitCode}${signalPart})`);
          break;
        }
        case "term_error":
          terminalView.markDead(tabId, message.message);
          break;
      }
    });
  }

  return {
    registerPort(tabId, workspace, port): boolean {
      if (!tabId || closedTabIds.has(tabId)) {
        return false;
      }
      let entry = entries.get(tabId);
      if (!entry) {
        entry = {
          store: createStore(),
          connection: null,
          unsubscribeMessages: null,
          terminal: null,
          unsubscribeTerminalMessages: null,
          unsubscribeStatus: null,
          unsubscribeQueue: null,
        };
        entries.set(tabId, entry);
        tabsStore.getState().addTab({ tabId, workspace });
        // R10 status mirror (slice-R10-cut §2.2): ONE store-lifetime
        // subscription per tabId, wired at store birth. The storm guard lives
        // in applyCoarse (no mirror write unless the coarse tuple flips);
        // this callback is a thin projection that runs on every setState of
        // this tab's store. Background-ness is read HERE, at event time — the
        // activeTabId at the completion moment decides whether the completion
        // was "unseen". Seeded synchronously so the mirror never has a gap
        // between a tab existing and its status being readable.
        const mirrorStatus = (state: DesktopState): void => {
          statusStore.getState().applyCoarse(tabId, deriveCoarse(state), tabsStore.getState().activeTabId !== tabId);
        };
        entry.unsubscribeStatus = entry.store.subscribe(mirrorStatus);
        mirrorStatus(entry.store.getState());

        // P7.14 prompt-queue drainer: a SECOND store-lifetime subscription
        // (mirror of mirrorStatus). Covers every drain trigger through one
        // point — turn-end flips idle, resumeQueue clears paused, an
        // enqueue-at-idle lands immediately. The guard admits exactly one drain
        // at a time (inFlight === null); takeQueueHead inside dispatch flips
        // inFlight synchronously so the re-entrant fire this dispatch causes
        // bails. `entry` is captured (not reassigned) so it always points at
        // the live connection after a respawn's `attach`.
        const capturedEntry = entry;
        const maybeDrain = (state: DesktopState): void => {
          if (
            state.connection === "ready" &&
            state.turn.status === "idle" &&
            !state.queuePaused &&
            state.queueInFlight === null &&
            state.promptQueue.length > 0
          ) {
            dispatchQueuedPrompt(capturedEntry);
          }
        };
        entry.unsubscribeQueue = entry.store.subscribe(maybeDrain);
      }
      attach(entry, tabId, port);
      return true;
    },

    markHostExited(tabId): void {
      const entry = entries.get(tabId);
      if (!entry) {
        return;
      }
      entry.unsubscribeMessages?.();
      entry.unsubscribeMessages = null;
      entry.connection = null;
      entry.store.getState().setHostExited();
      tabsStore.getState().setHostExited(tabId, true);


      // drop the dead term connection too and paint the banner. A later
      // registerTerminalPort (respawn) reattaches and, if the panel is still
      // open, resends term_open automatically.
      entry.unsubscribeTerminalMessages?.();
      entry.unsubscribeTerminalMessages = null;
      entry.terminal = null;
      terminalView.markDead(tabId, "host process exited");
    },

    disposeTab(tabId): void {
      closedTabIds.add(tabId);
      const entry = entries.get(tabId);
      if (!entry) {
        return;
      }
      entry.unsubscribeMessages?.();
      entry.unsubscribeTerminalMessages?.();
      entry.unsubscribeStatus?.();
      entry.unsubscribeQueue?.();
      entries.delete(tabId);
      pendingInitialPrompts.delete(tabId);
      tabsStore.getState().removeTab(tabId);
      terminalView.dispose(tabId);
      statusStore.getState().remove(tabId);
    },

    sendToTab(tabId, message): void {
      const entry = entries.get(tabId);
      if (!entry?.connection) {
        console.warn("[tab-registry] dropping outgoing message, no active connection for tab", tabId, message);
        return;
      }
      entry.connection.send(message);
    },

    getStore(tabId): DesktopStoreApi | undefined {
      return entries.get(tabId)?.store;
    },

    isClosed(tabId): boolean {
      return closedTabIds.has(tabId);
    },

    registerTerminalPort(tabId, port): boolean {
      if (!tabId || closedTabIds.has(tabId)) {
        return false;
      }
      const entry = entries.get(tabId);
      if (!entry) {
        // Term-ports always arrive paired with an already-registered UI port
        // (design §4) — an unknown tabId here means the pairing broke, not a
        // tab to resurrect. Drop it; the caller (port.ts) warns.
        return false;
      }
      attachTerminal(entry, tabId, port);
      const tab = tabsStore.getState().tabs.find((t) => t.tabId === tabId);
      if (tab?.terminalOpen) {
        const dims = terminalView.currentDims(tabId) ?? { cols: TERM_DEFAULT_COLS, rows: TERM_DEFAULT_ROWS };
        entry.terminal?.send({ type: "term_open", cols: dims.cols, rows: dims.rows });
      }
      return true;
    },

    openTerminal(tabId, dims): void {
      tabsStore.getState().setTerminalOpen(tabId, true);
      entries.get(tabId)?.terminal?.send({ type: "term_open", cols: dims.cols, rows: dims.rows });
    },

    sendToTerminal(tabId, message): void {
      const entry = entries.get(tabId);
      if (!entry?.terminal) {
        console.warn(
          "[tab-registry] dropping outgoing terminal message, no active terminal connection for tab",
          tabId,
          message,
        );
        return;
      }
      entry.terminal.send(message);
    },

    reset(): void {
      entries.clear();
      closedTabIds.clear();
      pendingInitialPrompts.clear();
      statusStore.getState().reset();
    },

    queueInitialPrompt(tabId, text, model, mode): void {
      if (!tabId || closedTabIds.has(tabId)) {
        return;
      }
      const entry = entries.get(tabId);
      if (entry?.store.getState().connection === "ready") {
        // F5#1b D3 (already-ready shortcut): mirror the host_ready branch's
        // set_model-before-prompt — the tab's store already tracks the live
        // model (set at host_ready, kept current by model_changed), so compare
        // against THAT instead of a boot-time message.
        const state = entry.store.getState();
        applyInitialPicks(entry, model, mode, { model: state.model, mode: state.mode });
        dispatchInitialPrompt(entry, text);
        return;
      }
      pendingInitialPrompts.set(tabId, { text, model, mode });
    },
  };
}

/** The app's single tab registry, bound to the singleton tabs-store (mirrors store.ts's per-tab `createDesktopStore` factory pattern). */
export const tabRegistry = createTabRegistry(useTabsStore);

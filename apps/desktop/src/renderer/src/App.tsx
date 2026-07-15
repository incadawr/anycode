/**
 * Root renderer component (design phase-2.md §2.4/§4.3, redesigned shell
 * ui-redesign-direction.md §2.1). Owns the `ConnectionManager` lifecycle
 * (delegated to port.ts's `startConnectionManager`, bound to the app's
 * `tabRegistry`) and lays out the grid shell: a `<Sidebar>` (session switching
 * + resume + new-session, the surface that replaced the old TabBar/NewTabMenu/
 * SessionPicker dialog) alongside the ACTIVE tab's whole chat UI wrapped in a
 * `<TabContext.Provider>` — background tabs are never mounted; their state
 * lives purely in their own store instance (tab-registry.ts), so switching
 * tabs is a pure re-render and never interrupts their delta accumulation.
 *
 * Preload's tab invoke-API (`window.anycode.{createTab,closeTab,listSessions}`,
 * design §3.2) is task 2.1.2; its ambient type lives at
 * `./anycode-window.d.ts` (task 2.1.6 dedupe — this file used to declare its
 * own local copy). `createTab`/`listSessions` are driven by the Sidebar's
 * new-session button + resumable rows; `closeTab` is wired to the Sidebar's
 * per-row close (with this component's running-turn confirm).
 *
 * Slice 2.2 (ruling reviews/slice-2.2-forks-ruling.md §2, design
 * /working-docs/build/design/slice-2.2-cut.md §6) adds the Welcome-screen
 * gate: `shouldShowWelcome` below decides, off the settings-store's
 * `SettingsSnapshot` + the tabs-store's own tab count, whether to render
 * `WelcomeScreen` instead of the normal tab UI. Once a provider becomes ready,
 * the app shows the shell with zero tabs until the user opens or resumes a
 * session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "zustand";
import { startConnectionManager } from "./port.js";
import { useTabsStore } from "./tabs-store.js";
import { tabRegistry, type DesktopStoreApi } from "./tab-registry.js";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "./tab-context.js";
import { useSettingsStore } from "./settings-store.js";
import { applyThemePreference } from "./theme.js";
import type { SettingsSnapshot } from "../../shared/settings.js";
import type { DesktopPlatform, WindowState } from "../../shared/window.js";
import { bindingFor, formatBinding, matchKeymap, resolveKeymap, type ActionId } from "./keymap.js";
import { CommandPalette, type PaletteAction, type PaletteMode } from "./components/CommandPalette.js";
import { handleCreateTabResult } from "./components/SessionPicker.js";
import { Sidebar, SIDEBAR_SEARCH_EVENT } from "./components/Sidebar.js";
import { WindowControls } from "./components/WindowControls.js";
import { SessionHeader } from "./components/SessionHeader.js";
import { MessageList } from "./components/MessageList.js";
import { Composer, shouldEnqueue } from "./components/Composer.js";
import { transcriptTextWithImages } from "./queue-format.js";
import type { UiToHostMessage } from "../../shared/protocol.js";
import { FOCUS_MODE_MENU_EVENT } from "./components/ModeMenu.js";
import { RUN_ACTION_EVENT } from "./slash-menu.js";
import { ConnectedPermissionModal } from "./components/PermissionModal.js";
import { GitPanel } from "./components/GitPanel.js";
import { GitConfirmDialog } from "./components/GitConfirmDialog.js";
import { LspPanel } from "./components/LspPanel.js";
import { HooksPanel } from "./components/HooksPanel.js";
import { TimelinePanel } from "./components/TimelinePanel.js";
import { NoticeStack, TabNoticeCapture } from "./components/NoticeToast.js";
import { beginToastExit, enqueueToast, removeToast, rewriteToastText, type Toast, type ToastKind } from "./toasts.js";
import { notificationBody, useTurnCompletionNotification } from "./notifications.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { StartScreen } from "./components/StartScreen.js";
import { SettingsDialog } from "./components/SettingsScreen.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import "./settings.css";

/** localStorage key for the renderer-only sidebar collapse flag (design §2.1). */
const SIDEBAR_COLLAPSED_KEY = "anycode.sidebar.collapsed";
const REVIEW_WIDTH_STORAGE_KEY = "anycode.review.width";
const REVIEW_WIDTH_DEFAULT = 560;
const REVIEW_WIDTH_MIN = 360;
const REVIEW_WIDTH_MAX = 960;

function readReviewWidth(): number {
  const stored = Number(window.localStorage.getItem(REVIEW_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= REVIEW_WIDTH_MIN && stored <= REVIEW_WIDTH_MAX
    ? stored
    : REVIEW_WIDTH_DEFAULT;
}

/**
 * Welcome-gate decision (ruling §2 step 5/7): show Welcome only once the
 * FIRST settings snapshot has actually loaded (`snapshot !== null` — avoids
 * flashing Welcome during the brief unknown-readiness window right after
 * mount), no engine is ready, AND no tab is open yet. Once any tab
 * exists, Welcome yields to the tab UI even if `providerReady` later flips back
 * to false (e.g. the user clears the secret while a tab is open); that case is
 * handled by `createTab`'s `not_ready` guard/notice instead (shared/tabs.ts),
 * not by hiding an already-open tab.
 */
export function shouldShowWelcome(
  snapshot: SettingsSnapshot | null,
  tabCount: number,
  hasExternalEngine: boolean | null = false,
): boolean {
  // `null` is deliberately non-blocking while main's narrow availability
  // snapshot is in flight: never flash a provider-only Welcome over a usable
  // subscription engine.
  return snapshot !== null && !snapshot.providerReady && hasExternalEngine === false && tabCount === 0;
}

export type MainPaneView = "start" | "active" | "empty";

/** Main-pane render precedence (slice P7.12 §4.6): the start screen wins over an active tab, which wins over the empty-shell fallback. */
export function selectMainPaneView(draftActive: boolean, hasActiveTab: boolean): MainPaneView {
  if (draftActive) {
    return "start";
  }
  return hasActiveTab ? "active" : "empty";
}

/** Esc-guard decision (slice P7.12 §4.6): Esc must be swallowed while the start screen is up — it has no cancel-worthy turn of its own, and letting Esc fall through to `activeTabId` would cancel a BACKGROUND tab's turn instead. */
export function shouldSuppressEscForDraft(draftActive: boolean): boolean {
  return draftActive;
}

/**
 * Whether the Review (Git) panel should actually render (design TASK.40
 * §2(f)): gated on the SHELL's own read-only Git capability, NOT the active
 * engine's tool-mutation capability — the Review panel is AnyCode chrome,
 * independent of which agent is running. `undefined` (core, or a
 * not-yet-wired engine) defaults to `true`, byte-identical to core's
 * pre-TASK.40 behavior (the panel was previously gated on
 * `engine?.capabilities.supportsGitMutations ?? true`, which likewise always
 * fell back to `true` for a null-engine core session). Exported for unit
 * testing.
 */
export function computeGitPanelOpen(panelOpen: boolean, shellGitReadOnly: boolean | undefined): boolean {
  return panelOpen && (shellGitReadOnly ?? true);
}

/**
 * TASK.33 W8 Try-again dispatch: consumes the one-shot offer (`consumeRetry`
 * — a no-op on a stale/double click once already consumed) and re-sends its
 * text+images through the EXACT SAME enqueue-vs-direct-send decision as
 * Composer.handleSend (`shouldEnqueue`), so busy/queue/cancel/permission/
 * max-turns behave for a retry exactly as they do for any other turn. Records
 * the resend via `recordSentMessage` too, same as every other send site — if
 * THIS retry also fails retryably-with-no-output, a fresh offer arms again.
 * Exported for unit testing against a real `createDesktopStore()` instance
 * (no jsdom in this package — see App.test.ts's header).
 *
 * TASK.33 W8-FIX #1: `setHostExited` deliberately preserves an armed `retry`
 * (store.ts) so the offer survives a host restart, but that also means the
 * button can still be showing (or a stale click can still land) while
 * `connection !== "ready"` — with no active port, a direct `sendToHost` would
 * be silently dropped. Bail out BEFORE consuming the offer so a click made
 * while disconnected leaves it armed for when the connection comes back,
 * matching every other send site's readiness gate (automation.ts's
 * `sendPrompt`, SessionHeader.tsx, ModelPill.tsx). TASK.33 FIX-A: the offer
 * surviving in `store.ts` only makes the state layer "survive a host
 * restart" — the standalone fallback Try-again row (`MessageList.tsx`'s
 * `showStandaloneRetry`) is what makes that true at the UI level too, once
 * `host_ready`'s hydration has dropped the anchored button's `loop_end` block.
 */
export function dispatchTryAgain(store: DesktopStoreApi, sendToHost: (message: UiToHostMessage) => void): void {
  if (store.getState().connection !== "ready") {
    return;
  }
  const offer = store.getState().consumeRetry();
  if (offer === null) {
    return;
  }
  const state = store.getState();
  if (shouldEnqueue(state.turn.status, state.queueInFlight)) {
    state.enqueuePrompt({ text: offer.text, images: offer.images });
    return;
  }
  const requestId = crypto.randomUUID();
  state.appendUserText(requestId, transcriptTextWithImages(offer.text, offer.images.length));
  state.recordSentMessage(offer.text, offer.images);
  sendToHost({
    type: "user_message",
    requestId,
    text: offer.text,
    ...(offer.images.length > 0 ? { images: offer.images.map((image) => image.attachment) } : {}),
  });
}

interface ActiveTabBodyProps {
  tabId: string;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  /** R8: push one toast into the App-level queue (kind → tone/glyph in toasts.ts). */
  onToast(kind: ToastKind, text: string): void;
}

/** The active tab's whole chat UI — mounted exactly once, inside that tab's TabContext.Provider. */
function ActiveTabBody({ tabId, sidebarCollapsed, onToggleSidebar, onToast }: ActiveTabBodyProps) {
  const connection = useTabStore((state) => state.connection);
  const transcript = useTabStore((state) => state.transcript);
  const turn = useTabStore((state) => state.turn);
  const lastFatal = useTabStore((state) => state.lastFatal);
  const workspace = useTabStore((state) => state.workspace);
  // TASK.33 W8: the armed one-shot Try-again offer (null when nothing to
  // offer) — MessageList shows the button only on the loop_end block it names.
  const retry = useTabStore((state) => state.retry);
  const tabStoreApi = useTabStoreApi();
  const sendToHost = useTabSend();
  const handleTryAgain = useCallback(() => dispatchTryAgain(tabStoreApi, sendToHost), [tabStoreApi, sendToHost]);
  const engine = useTabStore((state) => state.engine);
  const shell = useTabStore((state) => state.shell);
  const gitPanelOpenRequested = useTabStore((state) => state.git.panelOpen);
  // Design TASK.40 §2(f): shell-owned, not engine.capabilities.supportsGitMutations
  // (that flag now describes only the agent's OWN tool-mutation capability).
  const gitPanelOpen = computeGitPanelOpen(gitPanelOpenRequested, shell?.gitReadOnly);
  const supportsCorePanels = engine === null;
  const supportsRewind = engine?.capabilities.supportsRewind ?? true;
  const tabTitle = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId)?.title);
  const reviewRootRef = useRef<HTMLDivElement>(null);
  const [reviewWidth, setReviewWidth] = useState(readReviewWidth);

  // R8(c): OS notification on running→idle while hidden/blurred (active tab
  // only — cross-tab completion is R10).
  useTurnCompletionNotification(turn, notificationBody(tabTitle, workspace), tabId);

  function beginReviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = reviewWidth;
    const rootWidth = reviewRootRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    // Leave the conversation enough room for its readable measure and composer.
    const maxWidth = Math.max(REVIEW_WIDTH_MIN, Math.min(REVIEW_WIDTH_MAX, rootWidth - 320));
    let nextWidth = startWidth;

    function onMove(moveEvent: PointerEvent): void {
      nextWidth = Math.min(maxWidth, Math.max(REVIEW_WIDTH_MIN, startWidth + startX - moveEvent.clientX));
      setReviewWidth(nextWidth);
    }

    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.localStorage.setItem(REVIEW_WIDTH_STORAGE_KEY, String(nextWidth));
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  return (
    <>
      <SessionHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} />

      <div
        ref={reviewRootRef}
        className={`session-content${gitPanelOpen ? " session-content-review-open" : ""}`}
        style={gitPanelOpen ? { gridTemplateColumns: `minmax(0, 1fr) 8px ${reviewWidth}px` } : undefined}
      >
        <div className="session-conversation">
          {connection === "host_exited" && (
            <div className="banner banner-host-exited" role="alert">
              Host process exited — reconnecting…
            </div>
          )}
          {connection === "awaiting_port" && (
            <div className="banner banner-info">Waiting for the host connection…</div>
          )}
          {connection === "awaiting_host_ready" && <div className="banner banner-info">Connecting to host…</div>}
          {lastFatal && (
            <div className="banner banner-fatal" role="alert">
              Host fatal: {lastFatal}
            </div>
          )}

          <MessageList
            key={tabId}
            blocks={transcript}
            turn={turn}
            workspace={workspace}
            connection={connection}
            retry={retry}
            onTryAgain={handleTryAgain}
          />

          <Composer />
        </div>

        {gitPanelOpen && (
          <div
            className="review-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Review panel"
            onPointerDown={beginReviewResize}
          />
        )}
        {gitPanelOpen && <GitPanel />}
      </div>

      {/* Permission modal: self-connecting wrapper, renders only when the
          ACTIVE tab's store has a pending permission request. */}
      <ConnectedPermissionModal />
      {gitPanelOpen && <GitConfirmDialog />}
      {supportsCorePanels && <LspPanel />}
      {supportsCorePanels && <HooksPanel />}
      {supportsRewind && <TimelinePanel />}
      {/* R8: store notice slot → App toast queue (render-less bridge). */}
      <TabNoticeCapture tabId={tabId} onNotice={(notice) => onToast(notice.kind, notice.text)} />
    </>
  );
}

function ActiveTab({
  tabId,
  store,
  sidebarCollapsed,
  onToggleSidebar,
  onToast,
}: { store: DesktopStoreApi } & ActiveTabBodyProps) {
  return (
    <TabContext.Provider value={{ tabId, store }}>
      <ActiveTabBody tabId={tabId} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} onToast={onToast} />
    </TabContext.Provider>
  );
}

export function App() {
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const draftActive = useTabsStore((state) => state.draftActive);
  const settingsSnapshot = useStore(useSettingsStore, (state) => state.snapshot);
  const [hasExternalEngine, setHasExternalEngine] = useState<boolean | null>(null);
  const hasExternalEngineRef = useRef<boolean | null>(null);
  // Effective keymap (F20): recompiled only when the settings snapshot changes,
  // never per-keydown — the palette hints and CommandPalette's own matcher both
  // read this, so an override takes effect on the very next render.
  const effectiveKeymap = useMemo(
    () => resolveKeymap(settingsSnapshot?.settings.keybindings?.overrides),
    [settingsSnapshot],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("actions");
  // R8 toast queue (slice-R8-cut §2): App owns the state, toasts.ts owns the
  // transitions. Ids are a monotonic per-mount counter (R7 nextPasteIdRef
  // precedent). Handlers are useCallback([]) — they close over only stable
  // refs/setters — so ToastItem timer effects don't churn on App renders.
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextToastIdRef = useRef(1);
  const pushToast = useCallback((kind: ToastKind, text: string): void => {
    const id = nextToastIdRef.current++;
    setToasts((list) => enqueueToast(list, { id, kind, text: rewriteToastText(kind, text) }));
  }, []);
  const hideToast = useCallback((id: number): void => {
    setToasts((list) => beginToastExit(list, id));
  }, []);
  const exitedToast = useCallback((id: number): void => {
    setToasts((list) => removeToast(list, id));
  }, []);
  const platform: DesktopPlatform = window.anycode?.platform ?? "darwin";
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  // Custom titlebar (design/ui-track custom-titlebar §2/§4): App is the single
  // owner of the live `WindowState` — `maximized` is threaded to WindowControls
  // as a prop (both return branches below); this component also stamps the
  // `data-fullscreen` attr below (macOS drops the traffic-light clearance in
  // fullscreen, app.css).
  const [windowState, setWindowState] = useState<WindowState>({ maximized: false, fullscreen: false });

  useEffect(() => {
    const stop = startConnectionManager(tabRegistry);
    return stop;
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.anycode
      .listAvailableEngines()
      .then(({ engineIds }) => {
        if (!cancelled) {
          const available = engineIds.some((engine: "core" | "codex") => engine !== "core");
          hasExternalEngineRef.current = available;
          setHasExternalEngine(available);
        }
      })
      .catch(() => {
        // A bridge failure remains fail-closed: only the configured Core path
        // can bypass Welcome in this case.
        if (!cancelled) {
          hasExternalEngineRef.current = false;
          setHasExternalEngine(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Guarded for the partial `window.anycode` stub used by tests (no `window`
    // sub-object) — chrome then just keeps its initial non-maximized/non-
    // fullscreen default, a graceful no-op rather than a crash.
    const api = window.anycode?.window;
    if (!api) {
      return;
    }
    function apply(state: WindowState): void {
      setWindowState(state);
      document.documentElement.dataset.fullscreen = String(state.fullscreen);
    }
    // getState() on mount covers the state at boot (main also re-pushes once
    // on did-finish-load — belt-and-braces, not the only path); onWindowState
    // covers every later maximize/unmaximize/enter-full-screen/leave-full-screen.
    api
      .getState()
      .then(apply)
      .catch((error: unknown) => {
        console.warn("[App] window.getState failed", error);
      });
    return api.onWindowState(apply);
  }, []);

  useEffect(() => {
    // Persist the sidebar collapse flag (renderer-only, design §2.1). A failed
    // write (private mode / stripped renderer) just means it won't survive a
    // reload — not worth surfacing.
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    // The one place this store's `load()` is triggered (WelcomeScreen/
    // SettingsScreen only ever READ the singleton reactively) — App.tsx is
    // the single owner of the settings-snapshot lifecycle, same as it's the
    // sole owner of `startConnectionManager` above.
    void useSettingsStore.getState().load();
  }, []);

  useEffect(() => {
    // Single writer for `<html data-theme>` (design §2.5): applies the theme on
    // boot (snapshot null → "dark", matching index.html's pre-boot default) and
    // re-applies on every settings mutation as the snapshot changes. theme.ts
    // resolves "system" via matchMedia and manages the OS-preference listener.
    applyThemePreference(settingsSnapshot?.settings.ui.theme ?? "dark");
  }, [settingsSnapshot]);

  useEffect(() => {
    // Shell-level global keydown owner — the renderer's single window-level
    // keydown, home to two owners:
    //  · R3 Esc-to-interrupt (ui-roadmap §4-R3(b)) — the Escape branch below is
    //    byte-identical in behavior to its original body (defaultPrevented /
    //    dialog[open] / .terminal-panel / activeTabId / turn.status → cancel_turn).
    //  · R5 keymap combos (ui-roadmap §4-R5) — the mod-combo branch, gated by
    //    the SAME dialog[open] airspace guard so combos never fire under a modal.
    // Bubble phase so every local Esc consumer runs first; local consumers
    // signal ownership via preventDefault (ModeMenu) or via an open <dialog>
    // (all modals + the command palette use showModal). The listener stays
    // state-free (empty deps): every runner reads live state via getState().
    function onGlobalKeydown(event: KeyboardEvent): void {
      if (event.repeat || event.isComposing) {
        return;
      }

      if (event.key === "Escape") {
        if (event.defaultPrevented) {
          return;
        }
        if (document.querySelector("dialog[open]") !== null) {
          return;
        }
        if (shouldSuppressEscForDraft(useTabsStore.getState().draftActive)) {
          // slice-start-composer-cut §6: the start screen has no Cancel
          // affordance anymore — Esc discards the draft (the local project/
          // model popovers call preventDefault on their own Esc and never
          // reach here; a closed <dialog> still wins above). Suppressing the
          // fall-through to activeTabId (which would cancel a BACKGROUND
          // tab's turn) is unchanged — that guard is the seam's real job.
          useTabsStore.getState().discardDraft();
          return;
        }
        if (event.target instanceof Element && event.target.closest(".terminal-panel") !== null) {
          return;
        }
        const currentTabId = useTabsStore.getState().activeTabId;
        if (!currentTabId) {
          return;
        }
        if (tabRegistry.getStore(currentTabId)?.getState().turn.status !== "running") {
          return;
        }
        tabRegistry.sendToTab(currentTabId, { type: "cancel_turn" });
        return;
      }

      // R5 mod-combos.
      if (event.defaultPrevented) {
        return;
      }
      const match = matchKeymap(
        event,
        window.anycode?.platform ?? "darwin",
        resolveKeymap(useSettingsStore.getState().snapshot?.settings.keybindings?.overrides),
      );
      if (!match) {
        return;
      }
      // Ruling G — palette/modals own their airspace; combos are fail-closed.
      if (document.querySelector("dialog[open]") !== null) {
        return;
      }
      // Ruling F — on win/linux Ctrl+combos are meaningful PTY bytes; exclude
      // the terminal. On darwin ⌘-combos never reach the PTY, so they pass.
      if (
        (window.anycode?.platform ?? "darwin") !== "darwin" &&
        event.target instanceof Element &&
        event.target.closest(".terminal-panel") !== null
      ) {
        return;
      }
      // Ruling H — combos are dead on the Welcome screen (no sidebar/terminal/sessions).
      if (shouldShowWelcome(
        useSettingsStore.getState().snapshot,
        useTabsStore.getState().tabs.length,
        hasExternalEngineRef.current,
      )) {
        return;
      }
      event.preventDefault();
      switch (match.action) {
        case "palette.toggle":
          openPalette("actions");
          break;
        case "palette.sessions":
          openPalette("sessions");
          break;
        case "session.new":
          void runNewSession();
          break;
        case "terminal.toggle":
          runToggleTerminal();
          break;
        case "settings.open":
          setSettingsOpen(true);
          break;
        case "sidebar.toggle":
          handleToggleSidebarCollapsed();
          break;
        case "sidebar.search":
          runFocusSidebarSearch();
          break;
        case "tab.activate":
          runActivateTab(match.tabIndex ?? 0);
          break;
        case "mode.focus":
          runFocusModeMenu();
          break;
        case "turn.interrupt":
          // docOnly — matcher never returns it; keeps the switch exhaustive.
          break;
      }
    }
    window.addEventListener("keydown", onGlobalKeydown);
    return () => window.removeEventListener("keydown", onGlobalKeydown);
  }, []);

  // P7.23/F24 W2 run-action seam (cut §4.5): a second doorway into the SAME
  // per-action code paths the keydown switch above already runs — no new
  // capability. State-free (empty deps), same discipline as every R5 runner
  // above: every branch here reads/calls only stable functions declared
  // later in this component (hoisted) or stable setters.
  useEffect(() => {
    function onRunAction(event: Event): void {
      const detail = (event as CustomEvent<string>).detail;
      switch (detail) {
        case "session.new":
          void runNewSession();
          break;
        case "palette.sessions":
          openPalette("sessions");
          break;
        case "terminal.toggle":
          runToggleTerminal();
          break;
        case "settings.open":
          setSettingsOpen(true);
          break;
        default:
          break;
      }
    }
    window.addEventListener(RUN_ACTION_EVENT, onRunAction);
    return () => window.removeEventListener(RUN_ACTION_EVENT, onRunAction);
  }, []);

  function handleCloseTab(tabId: string): void {

    // a running turn — main executes without asking. Best-effort read of the
    // tab's own turn state; if the tab isn't registered for some reason, fall
    // straight through to the close request.
    const running = tabRegistry.getStore(tabId)?.getState().turn.status === "running";
    if (running && !window.confirm("This tab has a turn in progress. Close it anyway?")) {
      return;
    }
    window.anycode
      .closeTab(tabId)
      .then((result) => {
        // CloseTabResult is now frozen (shared/tabs.ts, task 2.1.6): only an
        // explicit ok:true disposes the tab. A refusal (last_tab/unknown_tab)
        // leaves it exactly as-is — there's nothing stale to clean up.
        if (result.ok) {
          tabRegistry.disposeTab(tabId);
        } else {
          console.warn("[App] closeTab refused", tabId, result.reason);
        }
      })
      .catch((error: unknown) => {
        console.warn("[App] closeTab failed", tabId, error);
      });
  }

  /**
   * A tab was just created via the Sidebar (new-session / resume, design §4.3). Main
   * delivers the new tab's MessageChannel port to the renderer immediately
   * after spawn (not gated on did-finish-load, §3.1), and port.ts's
   * ConnectionManager auto-registers an unknown tabId off that port envelope
   * (tab-registry.ts's `registerPort` -> tabs-store's `addTab`) — so this
   * handler does NOT register the store/connection itself (that would race
   * or double-register); it only seeds/confirms the tabs-store row and makes
   * the new tab active. `addTab` is idempotent on tabId, so calling it here
   * is a harmless no-op if the port's own registration already ran first.
   */
  function handleTabCreated({ tabId, workspace, title }: { tabId: string; workspace: string; title?: string }): void {
    useTabsStore.getState().addTab({ tabId, workspace });
    useTabsStore.getState().setActiveTab(tabId);
    if (title !== undefined) {
      useTabsStore.getState().setTitle(tabId, title);
    }
  }

  /* */
  function handleFocusTab(tabId: string): void {
    useTabsStore.getState().setActiveTab(tabId);
  }

  /**
   * Toggles the App-level sidebar collapse flag (design §2.1). Shared by the
   * sidebar footer's own collapse button and, while collapsed, the session
   * header's re-expand affordance (UI-4) — both just flip the same flag.
   */
  function handleToggleSidebarCollapsed(): void {
    setCollapsed((prev) => !prev);
  }

  /**
   * R5 keymap/palette action runners (ui-roadmap §4-R5). Every body reads state
   * EXCLUSIVELY via getState() / stable setters / document — none closes over a
   * render-scope value — so the empty-deps keydown effect's first-render capture
   * behaves identically to the latest render (the same discipline that makes the
   * R3 Esc body safe). Each is self-guarding at execution.
   */
  function openPalette(mode: PaletteMode): void {
    setPaletteMode(mode);
    setPaletteOpen(true);
  }

  /** Slice P7.12 (§4.6): "New session" no longer fires the folder dialog directly — it opens the start-screen draft, which fires it only on Send/folder-click. */
  function runNewSession(): void {
    useTabsStore.getState().openDraft();
  }

  function runResumeSession(sessionId: string, title: string | undefined): void {
    window.anycode
      .createTab({ kind: "resume", sessionId })
      .then((result) => {
        const message = handleCreateTabResult(
          result,
          { onTabCreated: handleTabCreated, onFocusTab: handleFocusTab },
          { title },
        );
        if (message) {
          pushToast("shell_error", message);
        }
      })
      .catch((error: unknown) => {
        pushToast("shell_error", error instanceof Error ? error.message : "Failed to resume task.");
      });
  }

  function runToggleTerminal(): void {
    const { activeTabId: currentTabId, tabs: currentTabs } = useTabsStore.getState();
    if (!currentTabId) {
      return;
    }
    const tab = currentTabs.find((t) => t.tabId === currentTabId);
    if (!tab) {
      return;
    }
    useTabsStore.getState().setTerminalOpen(currentTabId, !tab.terminalOpen);
  }

  function runFocusModeMenu(): void {
    // R7 seam (slice-R7-cut §3): broadcast to the single mounted ModeMenu,
    // which owns its own focus/open response — replaces the R5 `.mode-chip`
    // DOM query (ruling D residual). Stays state-free like every runner.
    window.dispatchEvent(new Event(FOCUS_MODE_MENU_EVENT));
  }

  function runFocusSidebarSearch(): void {
    // R9 (slice-R9-cut ruling 1): expand a collapsed sidebar first — a focus
    // request into `visibility: hidden` is a silent no-op. setCollapsed is a
    // stable setter (runner discipline holds); the broadcast waits one frame
    // so the expand commit lands before the Sidebar listener calls focus().
    setCollapsed(false);
    requestAnimationFrame(() => window.dispatchEvent(new Event(SIDEBAR_SEARCH_EVENT)));
  }

  function runInterrupt(): void {
    const currentTabId = useTabsStore.getState().activeTabId;
    if (!currentTabId) {
      return;
    }
    if (tabRegistry.getStore(currentTabId)?.getState().turn.status !== "running") {
      return;
    }
    tabRegistry.sendToTab(currentTabId, { type: "cancel_turn" });
  }

  function runActivateTab(tabIndex: number): void {
    const t = useTabsStore.getState().tabs[tabIndex];
    if (t) {
      useTabsStore.getState().setActiveTab(t.tabId);
    }
  }

  if (shouldShowWelcome(settingsSnapshot, tabs.length, hasExternalEngine)) {
    // Welcome renders full-window with no sidebar (design §2.1) — the
    // `app-welcome` modifier drops the shell grid back to a plain column.
    return (
      <main key="welcome" className="app app-welcome">
        <div className="welcome-titlebar" aria-hidden="true" />
        <WelcomeScreen />
        {window.anycode?.platform !== "darwin" && <WindowControls maximized={windowState.maximized} />}
      </main>
    );
  }

  const activeTab = activeTabId ? tabs.find((t) => t.tabId === activeTabId) : undefined;
  const activeStore = activeTab ? tabRegistry.getStore(activeTab.tabId) : undefined;

  // Palette action rows (ui-roadmap §4-R5). Built inline: App re-renders on every
  // tabs/activeTabId/collapsed change (tabs-store replaces the array on
  // setTerminalOpen), so the state-aware labels + enabled flags stay truthful. The
  // hint is the keystroke that skips the palette next time (the signature invariant).
  // Reads `effectiveKeymap` (F20 overrides) — an Unassigned/rebound-away action
  // yields no hint rather than crashing.
  const hintFor = (action: ActionId): string | null => {
    const binding = bindingFor(action, effectiveKeymap);
    return binding ? formatBinding(binding, platform) : null;
  };
  const paletteActions: PaletteAction[] = [
    {
      id: "session.new",
      label: "New Task",
      hint: hintFor("session.new"),
      enabled: true,
      run: () => void runNewSession(),
    },
    {
      id: "palette.sessions",
      label: "Switch task…",
      hint: hintFor("palette.sessions"),
      enabled: true,
      keepOpen: true,
      run: () => setPaletteMode("sessions"),
    },
    {
      id: "sidebar.search",
      label: "Filter tasks…",
      hint: hintFor("sidebar.search"),
      enabled: true,
      run: () => runFocusSidebarSearch(),
    },
    {
      id: "terminal.toggle",
      label: activeTab?.terminalOpen ? "Hide terminal" : "Show terminal",
      hint: hintFor("terminal.toggle"),
      enabled: activeTab !== undefined,
      run: () => runToggleTerminal(),
    },
    {
      id: "sidebar.toggle",
      label: collapsed ? "Expand sidebar" : "Collapse sidebar",
      hint: hintFor("sidebar.toggle"),
      enabled: true,
      run: () => handleToggleSidebarCollapsed(),
    },
    {
      id: "mode.focus",
      label: "Change permission mode…",
      hint: hintFor("mode.focus"),
      enabled: activeTab !== undefined,
      run: () => runFocusModeMenu(),
    },
    {
      id: "turn.interrupt",
      label: "Interrupt turn",
      hint: hintFor("turn.interrupt"),
      enabled: activeStore?.getState().turn.status === "running",
      run: () => runInterrupt(),
    },
    {
      id: "settings.open",
      label: "Open settings",
      hint: hintFor("settings.open"),
      enabled: true,
      run: () => setSettingsOpen(true),
    },
  ];

  return (
    <main key="shell" className={`app${collapsed ? " app-sidebar-collapsed" : ""}`}>
      <Sidebar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={(tabId) => useTabsStore.getState().setActiveTab(tabId)}
        onCloseTab={handleCloseTab}
        onTabCreated={handleTabCreated}
        onFocusTab={handleFocusTab}
        onOpenSettings={() => setSettingsOpen(true)}
        collapsed={collapsed}
        onToggleCollapsed={handleToggleSidebarCollapsed}
      />

      <div className="main-pane">
        {selectMainPaneView(draftActive, Boolean(activeTab && activeStore)) === "start" ? (
          <StartScreen onToast={pushToast} />
        ) : activeTab && activeStore ? (
          <ActiveTab
            tabId={activeTab.tabId}
            store={activeStore}
            sidebarCollapsed={collapsed}
            onToggleSidebar={handleToggleSidebarCollapsed}
            onToast={pushToast}
          />
        ) : (
          <div className="main-empty">Open or resume a task from the sidebar.</div>
        )}

        {/* The active tab's terminal must not float over the start screen (§4.6). */}
        <TerminalPanel tabId={activeTab?.tabId ?? null} open={!draftActive && (activeTab?.terminalOpen ?? false)} />
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {paletteOpen && (
        <CommandPalette
          mode={paletteMode}
          actions={paletteActions}
          tabs={tabs}
          platform={platform}
          keymapTable={effectiveKeymap}
          onSwitchMode={setPaletteMode}
          onSelectTab={(tabId) => useTabsStore.getState().setActiveTab(tabId)}
          onResumeSession={runResumeSession}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      <NoticeStack toasts={toasts} onHide={hideToast} onExited={exitedToast} />

      {window.anycode?.platform !== "darwin" && <WindowControls maximized={windowState.maximized} />}
    </main>
  );
}

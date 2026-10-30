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
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useStore } from "zustand";
import { startConnectionManager } from "./port.js";
import { startTabBootstrap } from "./tab-bootstrap.js";
import { useTabsStore } from "./tabs-store.js";
import { tabRegistry, type DesktopStoreApi } from "./tab-registry.js";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "./tab-context.js";
import { replayStore, childVisible } from "./replay.js";
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
import { HostBanner } from "./components/HostBanner.js";
import { Composer, shouldEnqueue } from "./components/Composer.js";
import type { UiToHostMessage } from "../../shared/protocol.js";
import { FOCUS_MODE_MENU_EVENT } from "./components/ModeMenu.js";
import { RUN_ACTION_EVENT } from "./slash-menu.js";
import { ConnectedPermissionModal } from "./components/PermissionModal.js";
import { ParentChildPermissionModal } from "./components/ParentChildPermissionModal.js";
import { Collapse as CollapseIcon } from "./components/icons.js";
import { GitPanel } from "./components/GitPanel.js";
import { GitConfirmDialog } from "./components/GitConfirmDialog.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { LspPanel } from "./components/LspPanel.js";
import { HooksPanel } from "./components/HooksPanel.js";
import { buildRewindRequest } from "./components/checkpoint-model.js";
import { countUserTurns } from "./components/TranscriptMinimap.js";
import { BackgroundTasksPanel } from "./components/BackgroundTasksPanel.js";
import { NoticeStack, TabNoticeCapture } from "./components/NoticeToast.js";
import { WorkspaceTrustPrompt } from "./components/WorkspaceTrustDialog.js";
import { beginToastExit, enqueueToast, removeToast, rewriteToastText, type Toast, type ToastKind } from "./toasts.js";
import { notificationBody, useTurnCompletionNotification } from "./notifications.js";
import { watchExternalEngines } from "./engine-availability.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { StartScreen } from "./components/StartScreen.js";
import { SettingsDialog } from "./components/SettingsScreen.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { DockPanel } from "./components/DockPanel.js";
import { useOverlayFlag } from "./preview/overlay-flag.js";
import { usePanelMountState } from "./preview/panel-bridge.js";
import { computePreviewPanelOpen, usePreviewStore } from "./preview/preview-store.js";
import type { PreviewPanelInfo } from "../../shared/preview-panel.js";
import {
  buildChildBreadcrumb,
  childLayoutStore,
} from "./child-layout.js";
import {
  childRelationKey,
  childRelationStore,
  spawnToolCallIdForChild,
  type ChildRelation,
} from "./child-sessions.js";
import { projectChildSplitRows } from "./child-split-projection.js";
import { projectChildHistoryResult, type ChildHistoryResult, type ChildHistoryViewState } from "./child-history.js";
import { ChildSplitPane, type ChildSplitRow } from "./components/ChildSplitPane.js";
import { canSplit, clampDockWidth, computeDockMode, derivePreviewTabs, dockMinWidth, DOCK_HANDLE_PX, type DockMode } from "./dock/dock-layout.js";
import { selectDockOpenFor, selectDockView, useDockStore } from "./dock/dock-store.js";
import { isSessionBusy, type SubagentSubStatus, type TranscriptBlock } from "./store.js";
import "./settings.css";

/** localStorage key for the renderer-only sidebar collapse flag (design §2.1). */
const SIDEBAR_COLLAPSED_KEY = "anycode.sidebar.collapsed";

// Taskana 4703: the retired per-panel width keys (`anycode.review.width`,
// `anycode.preview.width`, `anycode.childSplit.width`) are superseded by the
// ONE dock width (dock-layout.ts's DOCK_WIDTH_STORAGE_KEY). The legacy keys
// stay in users' storage, never read again — except the one-time
// `anycode.preview.width` seed inside readDockWidth.

// Stable empty-array identity for the "no previews yet" selector default —
// a fresh `[]` literal on every render would make zustand see a "changed"
// value on every ActiveTabBody re-render even when nothing actually moved.
const EMPTY_PREVIEWS: readonly PreviewPanelInfo[] = [];

/** Stable empty identity for the split stack's row list when the layout isn't `split` at all (mirrors EMPTY_PREVIEWS above). */
const EMPTY_CHILD_SPLIT_ROWS: readonly ChildSplitRow[] = [];
const EMPTY_IDS: readonly string[] = [];

/**
 * Welcome-gate decision (ruling §2 step 5/7): show Welcome only once the
 * FIRST settings snapshot has actually loaded (`snapshot !== null` — avoids
 * flashing Welcome during the brief unknown-readiness window right after
 * mount), no engine is ready, no tab is open yet, AND at most one connection
 * exists. Once any tab exists, Welcome yields to the tab UI even if
 * `providerReady` later flips back to false (e.g. the user clears the secret
 * while a tab is open); that case is handled by `createTab`'s `not_ready`
 * guard/notice instead (shared/tabs.ts), not by hiding an already-open tab.
 *
 * The connection-count bound (dogfood 16.07): Welcome is first-run/mid-setup
 * UI — its embedded form edits the SINGLE existing connection (or creates the
 * first one), so it can only represent states with ≤ 1 connection. A
 * configured user who activates a not-ready connection (e.g. a keyless custom
 * endpoint) keeps the normal shell, where Settings stays reachable — the old
 * gate dropped them into onboarding with no way to switch back (a lockout:
 * the form was bound to `connections[0]`, not the failing active connection).
 */
export function shouldShowWelcome(
  snapshot: SettingsSnapshot | null,
  tabCount: number,
  hasExternalEngine: boolean | null = false,
): boolean {
  // `null` is deliberately non-blocking while main's narrow availability
  // snapshot is in flight: never flash a provider-only Welcome over a usable
  // subscription engine.
  if (snapshot === null || snapshot.providerReady || hasExternalEngine !== false || tabCount !== 0) {
    return false;
  }
  return snapshot.settings.provider.connections.length <= 1;
}

export type MainPaneView = "start" | "active" | "empty";

/** Main-pane render precedence (slice P7.12 §4.6): the start screen wins over an active tab, which wins over the empty-shell fallback. */
export function selectMainPaneView(draftActive: boolean, hasActiveTab: boolean): MainPaneView {
  if (draftActive) {
    return "start";
  }
  return hasActiveTab ? "active" : "empty";
}

/**
 * TASK.129: the empty main pane's way back to a collapsed sidebar. With no
 * tab open there is no session header — and so no expand button — and the app
 * has no native menu, so a collapsed sidebar would be unrecoverable by mouse.
 * The pane then shows its own expand button and names the CURRENT binding
 * (`hint`, off the effective keymap — it is user-editable), or none when the
 * action is unassigned.
 */
export function emptyPaneSidebarAffordance(
  collapsed: boolean,
  hint: string | null,
): { showExpand: boolean; text: string } {
  if (!collapsed) {
    return { showExpand: false, text: "Open or resume a task from the sidebar." };
  }
  return {
    showExpand: true,
    text: hint
      ? `The sidebar is hidden — press ${hint} or the button above to show it.`
      : "The sidebar is hidden — use the button above to show it.",
  };
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
 * Grid-column composer for `.session-content-split-open` (Taskana 4703,
 * docs/development/dock.md): the conversation column is ALWAYS
 * `minmax(min(420px,100%), 1fr)` — a real floor (the old `minmax(0,1fr)`
 * collapsed to ~0 under stacked fixed columns, the root cause of the
 * squash) — plus the ONE dock's `8px` handle + width columns when the dock
 * is open in column mode. Drawer mode passes `dockOpen:false` (the dock is
 * an absolute overlay; the conversation keeps full width). Exported for the
 * unit gate.
 */
export function computeSessionContentColumns(dockOpen: boolean, dockWidth: number): string {
  const columns = ["minmax(min(420px,100%), 1fr)"];
  if (dockOpen) {
    columns.push("8px", `${dockWidth}px`);
  }
  return columns.join(" ");
}

/**
 * TASK.56 W3-FIX text for a retry blocked by the live model image verdict —
 * same semantics as Composer's `MODEL_IMAGE_SEND_BLOCKED_TEXT`, adapted to
 * the retry offer's own recovery path (switch model or send fresh, since an
 * armed offer's images can't be individually removed the way a draft's can).
 */
export const RETRY_BLOCKED_IMAGES_TEXT =
  "This model does not accept image attachments — the retry still has images attached. Switch back to a vision-capable model to send it, or send a new message without attachments.";

/** `dispatchTryAgain`'s outcome (TASK.56 W3-FIX): distinguishes a blocked retry from every other exit so automation's `tryAgain` facade can report it truthfully instead of a blanket `{ok:true}`. */
export type TryAgainOutcome = "sent" | "queued" | "blocked_images" | "not_ready" | "no_offer";

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
 *
 * TASK.56 W3-FIX (fable-task56-w3-codex-ruling.md finding 2 §(c)): an entry
 * gate runs BEFORE `consumeRetry`, ahead of the enqueue-vs-direct-send
 * branch, so it covers both. `dispatchTryAgain` was the one W3-gated send
 * site the cut missed (Composer blocks upfront, the drainer is a deliberate
 * host-backstop path per finding 1) — an image-bearing offer clicked after
 * the live model swings to non-vision was consumed and lost with no way to
 * restore it (no `queueInFlight` to key a restore off, on the direct-send
 * branch). The gate PEEKS `state.retry` rather than consuming it: a blocked
 * click leaves the offer armed, so the button stays live and a later click —
 * after switching back to a vision model — replays the exact same offer.
 */
export function dispatchTryAgain(
  store: DesktopStoreApi,
  sendToHost: (message: UiToHostMessage) => void,
): TryAgainOutcome {
  if (store.getState().connection !== "ready") {
    return "not_ready";
  }
  const state = store.getState();
  const pending = state.retry;
  if (pending === null) {
    return "no_offer";
  }
  // TASK.198 срез D: a configured recognizer fallback (`imageFallback`,
  // mirrored off the same host_ready/model_changed wire as `imageInput`)
  // unblocks this gate too — same pair semantics as the composer's own
  // `isImageAttachBlockedByModel`/`isSendBlockedByModelImages` predicates.
  if (pending.images.length > 0 && state.imageInput === false && state.imageFallback !== true) {
    state.setNotice({ kind: "retry_blocked", text: RETRY_BLOCKED_IMAGES_TEXT });
    return "blocked_images";
  }
  const offer = state.consumeRetry();
  if (offer === null) {
    return "no_offer";
  }
  if (shouldEnqueue(state.turn.status, state.queueInFlight)) {
    state.enqueuePrompt({ text: offer.text, images: offer.images });
    return "queued";
  }
  const requestId = crypto.randomUUID();
  state.appendUserText(requestId, offer.text, offer.images.length > 0 ? offer.images.map((image) => image.attachment) : undefined);
  state.recordSentMessage(offer.text, offer.images);
  sendToHost({
    type: "user_message",
    requestId,
    text: offer.text,
    ...(offer.images.length > 0 ? { images: offer.images.map((image) => image.attachment) } : {}),
  });
  return "sent";
}

/**
 * Taskana 4111: fixed continuation text — the click is the one action; the
 * model sees it as an ordinary user message.
 */
export const CONTINUE_AFTER_CEILING_TEXT = "Continue from the turn limit — resume with the same history.";

/**
 * Taskana 4111 (TASK.124 remainder 1): the max_turns stop's one-action
 * continue — the Try-again seam, minus the replay payload: the click sends
 * ONE fixed user message, which restarts the turn budget over the intact
 * history. No images on this path, but the same enqueue-vs-direct-send
 * decision as `dispatchTryAgain` still applies: the offer is painted while
 * the turn is idle, and a click that races a turn going busy must be queued
 * rather than sent into the host's `turn_rejected "busy"` (which restores
 * nothing on the direct-send path — the text would be lost from the wire).
 */
export function dispatchContinue(
  store: DesktopStoreApi,
  sendToHost: (message: UiToHostMessage) => void,
): "not_ready" | "no_offer" | "sent" | "queued" {
  if (store.getState().connection !== "ready") return "not_ready";
  const offer = store.getState().consumeContinue();
  if (offer === null) return "no_offer";
  if (shouldEnqueue(store.getState().turn.status, store.getState().queueInFlight)) {
    store.getState().enqueuePrompt({ text: CONTINUE_AFTER_CEILING_TEXT, images: [] });
    return "queued";
  }
  const requestId = crypto.randomUUID();
  store.getState().appendUserText(requestId, CONTINUE_AFTER_CEILING_TEXT);
  store.getState().recordSentMessage(CONTINUE_AFTER_CEILING_TEXT, []);
  sendToHost({ type: "user_message", requestId, text: CONTINUE_AFTER_CEILING_TEXT });
  return "sent";
}

export interface SessionSurfaceProps {
  tabId: string;
  suppressPermissionModal?: boolean;
  /** R8: push one toast into the App-level queue (kind → tone/glyph in toasts.ts). */
  onToast(kind: ToastKind, text: string): void;
}

/**
 * TASK.102 CUT-S2 §2.5 Produces: the one session surface — transcript,
 * composer, and permission-modal binding — resolved ENTIRELY off
 * `<TabContext>` (no store prop at all), so wrapping it in a DIFFERENT tab's
 * `TabContext.Provider` makes it render THAT tab's live conversation with
 * zero code changes here. `ActiveTabBody` below uses it for the master pane
 * (byte-equivalent output to the pre-extraction inline JSX this slice
 * replaced — same `.session-conversation` div, same banners, same
 * `MessageList`/`Composer`/`ConnectedPermissionModal`/`TabNoticeCapture`);
 * `ChildSessionPane` below wraps the SAME component in the child tab's own
 * Provider for layout B's child view (§2.5's "child-view — та же
 * SessionSurface поверх child-store"). S3's split/accordion layouts (§6)
 * reuse this component unchanged — it is this slice's actual hand-off, not
 * an implementation detail of `ActiveTabBody`.
 */
export function SessionSurface({ tabId, onToast, suppressPermissionModal = false }: SessionSurfaceProps) {
  const connection = useTabStore((state) => state.connection);
  const transcript = useTabStore((state) => state.transcript);
  const todoReminderState = useTabStore((state) => state.todoReminderState);
  const turn = useTabStore((state) => state.turn);
  const lastFatal = useTabStore((state) => state.lastFatal);
  const hostFailure = useTabStore((state) => state.hostFailure);
  // GitHub #6: the terminal missing-folder condition — the only case where the
  // banner drops the connection lines instead of reporting a reconnect.
  const workspaceMissing = useTabStore((state) => state.workspaceMissing);
  const workspace = useTabStore((state) => state.workspace);
  // Taskana 4736 xfix D4: a child surface never shows the workspace-trust
  // dialog — the child shares the parent's workspace and booted with the
  // parent's current decision (the host's childSurface boot option already
  // suppressed the pending report), so any dialog here would be unsatisfiable.
  const childSurface = useTabStore((state) => state.childSurface);
  // TASK.33 W8: the armed one-shot Try-again offer (null when nothing to
  // offer) — MessageList shows the button only on the loop_end block it names.
  const retry = useTabStore((state) => state.retry);
  // Taskana 4111: the one-shot Continue offer armed by a max_turns loop_end;
  // suppressed while the prompt queue holds anything (Resume is the continue then).
  const continueOffer = useTabStore((s) => s.continueOffer);
  const promptQueueLength = useTabStore((s) => s.promptQueue.length);
  const tabStoreApi = useTabStoreApi();
  const sendToHost = useTabSend();
  const handleTryAgain = useCallback(() => dispatchTryAgain(tabStoreApi, sendToHost), [tabStoreApi, sendToHost]);
  const handleContinue = useCallback(() => dispatchContinue(tabStoreApi, sendToHost), [tabStoreApi, sendToHost]);
  // Taskana 4772: a turn parked on a transient network failure. Stop is the
  // composer's own cancel (the turn is still `running`); Retry now asks the host to probe at once.
  const waitingForNetwork = useTabStore((state) => state.waitingForNetwork);
  const handleRetryNow = useCallback(() => sendToHost({ type: "network_retry_now" }), [sendToHost]);
  // Taskana 4742 §2.5: rewind plumbing for the tick rail's popover action.
  // `supportsRewind` gates the prop (absent -> no Rewind buttons at all,
  // same expression the old TimelinePanel mount used); `onRewind` sends the
  // SAME rewind_request the removed dock panel sent (buildRewindRequest,
  // moved verbatim to checkpoint-model.ts — no new wire message). This
  // surface serves the root tab AND live child panes (each mounted inside
  // its own TabContext.Provider, so `checkpoints` resolves against that
  // pane's own session); read-only history panes render MessageList
  // directly with no `rewind` prop and never see a button.
  const engine = useTabStore((state) => state.engine);
  const supportsRewind = engine?.capabilities.supportsRewind ?? true;
  const checkpoints = useTabStore((state) => state.checkpoints);
  const lastRewindResult = useTabStore((state) => state.lastRewindResult);
  const handleRewind = useCallback(
    (checkpointId: string) => sendToHost(buildRewindRequest(checkpointId, crypto.randomUUID())),
    [sendToHost],
  );
  const rewindProp = supportsRewind ? { checkpoints, onRewind: handleRewind } : undefined;
  // Taskana 4742 §2.5: checkpoint-list refresh — the store's `checkpoints`
  // field is filled ONLY on demand (host replies to checkpoint_list_request),
  // so the rail asks (a) once when it first appears (>=2 user turns), (b)
  // every time the turn goes running -> idle (the finished turn's checkpoint
  // exists by then), (c) after a rewind_result lands (the list is now
  // stale). Fire-and-forget: the host already replies {checkpoints:[]} when
  // the seam is disabled. No polling.
  const turnStatus = turn.status;
  const userTurnCount = useMemo(() => countUserTurns(transcript), [transcript]);
  const railVisible = userTurnCount >= 2;
  useEffect(() => {
    if (!railVisible || !supportsRewind) {
      return;
    }
    sendToHost({ type: "checkpoint_list_request" });
  }, [railVisible, supportsRewind, turnStatus, lastRewindResult, sendToHost]);

  // TASK.188 S12: this mount IS the replay's definition of "the root is in
  // frame". Every way the root transcript can leave the screen — another tab
  // active, the start screen over the pane, layout B rendering the child pane
  // instead of the master, and any future replacement of the main pane —
  // unmounts this component, so the store derives the fact instead of the
  // facade enumerating the routes to it (§11 findings D3, D4).
  //
  // StrictMode double-invokes this in dev (main.tsx): mount → unmount → mount,
  // all in one commit. The store keeps a SET of mounted ids, so the pair
  // cancels out — a parked-then-released root inside a single tick, ending
  // "mounted", with the cursor where it was.
  useEffect(() => {
    replayStore.getState().surfaceMounted(tabId);
    return () => replayStore.getState().surfaceUnmounted(tabId);
  }, [tabId]);

  return (
    <>
      <div className="session-conversation">
        <ApprovalStatus />
        <HostBanner connection={connection} lastFatal={lastFatal} workspaceMissing={workspaceMissing} hostFailure={hostFailure} />

        <MessageList
          key={tabId}
          blocks={transcript}
          todoReminderState={todoReminderState}
          turn={turn}
          workspace={workspace}
          connection={connection}
          retry={retry}
          onTryAgain={handleTryAgain}
          continueOffer={continueOffer}
          onContinue={handleContinue}
          promptQueueLength={promptQueueLength}
          {...(rewindProp !== undefined ? { rewind: rewindProp } : {})}
        />

        {waitingForNetwork && turn.status === "running" && (
          <div className="banner banner-info network-wait-line" role="status">
            <span>Waiting for network…</span>{" "}
            <button type="button" className="network-wait-retry" onClick={handleRetryNow}>
              Retry now
            </button>
          </div>
        )}
        <Composer />
      </div>

      {/* Permission modal: self-connecting wrapper, renders only when THIS
          tab's store has a pending permission request. */}
      {!suppressPermissionModal && <ConnectedPermissionModal />}
      {/* R8: store notice slot → App toast queue (render-less bridge). */}
      <TabNoticeCapture tabId={tabId} onNotice={(notice) => onToast(notice.kind, notice.text)} />
      {/* Taskana 4736: this folder's project declarations wait for the user's
          decision. xfix D4: never on a child surface (see childSurface above). */}
      {!childSurface && <WorkspaceTrustPrompt tabId={tabId} />}
    </>
  );
}

interface ActiveTabBodyProps {
  tabId: string;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  /** R8: push one toast into the App-level queue (kind → tone/glyph in toasts.ts). */
  onToast(kind: ToastKind, text: string): void;
}

/** The active tab's whole chat UI — mounted exactly once, inside that tab's TabContext.Provider. */
export function ActiveTabBody({ tabId, sidebarCollapsed, onToggleSidebar, onToast }: ActiveTabBodyProps) {
  const turn = useTabStore((state) => state.turn);
  const workspace = useTabStore((state) => state.workspace);
  const engine = useTabStore((state) => state.engine);
  const shell = useTabStore((state) => state.shell);
  const gitPanelOpenRequested = useTabStore((state) => state.git.panelOpen);
  // Design TASK.40 §2(f): shell-owned, not engine.capabilities.supportsGitMutations
  // (that flag now describes only the agent's OWN tool-mutation capability).
  const gitPanelOpen = computeGitPanelOpen(gitPanelOpenRequested, shell?.gitReadOnly);
  const supportsCorePanels = engine === null;
  // TASK.91: the background-tasks drawer mounts for the native engine only —
  // `engine` is null before host_ready (core default), and claude/codex keep
  // supportsTasks:false.
  const supportsTasks = engine?.capabilities.supportsTasks ?? true;
  const tabTitle = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId)?.title);

  // TASK.102 CUT-S2 §2.5 (slice S2c C3): which surface this root tab's pane
  // shows right now — its own master transcript, one child full-pane (layout
  // B), or the master alongside a stack of children (CUT-S3 §0.1 split,
  // layouts C/D — see child-layout.ts's module doc).
  const childView = childLayoutStore((state) => state.view(tabId));
  const parentSessionId = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId)?.sessionId);
  // CUT-S3 §3.1: `childSplitOpen` names the split layout; the resize handle
  // + `ChildSplitPane` mount off it below, alongside git/preview (`splitOpen`).
  const childSplitOpen = childView.kind === "split";
  // TASK.218 (supervisor correction 3): the relations subscription moved
  // BEFORE every child-id resolution below — the effective-id projection
  // needs it, and each render must read it once, up front.
  const relations = childRelationStore((state) => state.relations);
  // TASK.218: the same LOGICAL child (one childSessionId) may be registered
  // under several spawn ids (one per continue_session call). Every surface
  // below resolves through the EFFECTIVE id — the LATEST spawn id registered
  // for that childSessionId (spawnToolCallIdForChild: Map insertion order,
  // last wins) — so the moment a continuation's port registers, the existing
  // row follows it (live store, relation lookup) with no second Open click.
  // The DISPLAYED row id stays the original view id (React key /
  // data-spawn-id compatibility).
  const childSessionIdOf = (id: string): string | undefined =>
    parentSessionId ? relations.get(childRelationKey(parentSessionId, id))?.childSessionId : undefined;
  const effectiveChildId = (id: string): string => {
    const cs = childSessionIdOf(id);
    return (cs !== undefined && parentSessionId ? spawnToolCallIdForChild(relations, parentSessionId, cs) : undefined) ?? id;
  };
  // The one child id whose SURFACE (live or read-only) needs to be resolved
  // this render — layout B's single child, or split's currently-expanded
  // row (CUT-S3 §3.3: the collapsed rows only need their own Agent card, not
  // a relation lookup — resolved separately below, off the master transcript).
  // Mapped through effectiveChildId: a dead old relation no longer freezes
  // the row — the live continuation's store feeds it.
  const focusedChildId = (() => {
    if (childView.kind === "child") return effectiveChildId(childView.spawnToolCallId);
    if (childView.kind === "split") return effectiveChildId(childView.expandedId);
    return undefined;
  })();
  const childRelation = childRelationStore((state) =>
    focusedChildId !== undefined && parentSessionId !== null && parentSessionId !== undefined
      ? state.getRelation(parentSessionId, focusedChildId)
      : undefined,
  );
  // F11: every split row's (and layout B's) live child store, so each row
  // counts its own child's progress — not only the expanded one. A row whose
  // child host is gone keeps the last card it showed (`lastLiveChildCard`).
  // Keys are EFFECTIVE ids (TASK.218): a continuation's live store feeds the
  // row whose original id went stale.
  const liveChildIds: readonly string[] =
    childView.kind === "split"
      ? childView.order.map(effectiveChildId)
      : focusedChildId !== undefined
        ? [focusedChildId]
        : EMPTY_IDS;
  const liveChildStores = useMemo(() => {
    const stores = new Map<string, DesktopStoreApi>();
    if (parentSessionId === null || parentSessionId === undefined) return stores;
    for (const id of liveChildIds) {
      const relation = relations.get(childRelationKey(parentSessionId, id));
      const store = relation?.live === true ? tabRegistry.getStore(relation.childTabId) : undefined;
      if (store !== undefined) stores.set(id, store);
    }
    return stores;
  }, [liveChildIds, parentSessionId, relations]);
  const subscribeLiveChildren = useCallback(
    (onChange: () => void) => {
      const unsubscribes = [...liveChildStores.values()].map((store) => store.subscribe(onChange));
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    [liveChildStores],
  );
  // A string snapshot (stable between renders) of what the rows read below.
  useSyncExternalStore(subscribeLiveChildren, () =>
    [...liveChildStores.values()]
      .map((store) => {
        const state = store.getState();
        return `${state.transcript.length}:${state.modelTurns}:${state.turn.status}`;
      })
      .join("|"),
  );
  // TASK.102 CUT-S2 §10.8.1 point 3: a NON-live child (relation.live===false,
  // OR no relation at all — the restart-Open case) is no longer a transient
  // error state to self-heal out of. C4's read-only branch (`ChildHistoryPane`
  // below, or CUT-S3's `ChildHistoryContent` in the split stack) is its
  // permanent home: the pre-C4 self-heal effect that used to bounce this tab
  // back to master the instant `childRelation` stopped being live is GONE —
  // the child-view branch below now falls through from the live surface to
  // the read-only one on the exact same render instead.
  // CUT-S3 §3.3: the master's own transcript, read once here so every split
  // row (collapsed or expanded) can resolve its own Agent card by
  // `spawnToolCallId` — the same lookup ChildSessionPane/ChildHistoryPane
  // already do below for layout B's single child.
  const transcript = useTabStore((state) => state.transcript);

  const reviewRootRef = useRef<HTMLDivElement>(null);
  // The .session-content element as STATE: it is absent while a child view
  // swaps the whole body (ActiveTabBody early-returns), so the measure effect
  // below must re-attach when it mounts, not only on the first render.
  const [reviewRootEl, setReviewRootEl] = useState<HTMLDivElement | null>(null);
  const attachReviewRoot = useCallback((node: HTMLDivElement | null) => {
    reviewRootRef.current = node;
    setReviewRootEl(node);
  }, []);
  // Taskana 4738: this conversation tab takes ownership of the dock store's
  // tab set BEFORE paint. The store is a singleton across conversation tabs;
  // without this, the first render of a switched tab reads the PREVIOUS
  // tab's leftover tabs (its own derivation effects run only after that
  // commit) and paints them for one frame. A LAYOUT effect, declared before
  // the derivation effects below: it resets the owned triple synchronously
  // before the browser paints, and `selectDockView` (the read path below)
  // gates the very first render empty even before that. `adopt` touches
  // renderer state only — the per-tab sources (previews/subagents/git) stay
  // in their own stores and the derivation effects re-open them on the clean
  // store right after.
  useLayoutEffect(() => {
    useDockStore.getState().adopt(tabId);
  }, [tabId]);

  // Taskana 4703: the ONE dock width + window-width tracking. `available` is
  // the .session-content width (reviewRootRef measure), kept live by a
  // ResizeObserver so a sidebar collapse/expand (no window resize) re-clamps.
  // Taskana 4738: `tabs`/`activeTabId`/`splitTabId` render ONLY through the
  // owner-gated `selectDockView` — a non-owner (the frame before adopt, or a
  // foreign store state) reads the frozen EMPTY_DOCK_VIEW, never another
  // conversation tab's items. Width/hidden are global, not owner-scoped.
  const dockWidth = useDockStore((state) => state.width);
  const dockTabs = useDockStore((state) => selectDockView(state, tabId).tabs);
  const dockActiveTabId = useDockStore((state) => selectDockView(state, tabId).activeTabId);
  const dockOpen = useDockStore((state) => selectDockOpenFor(state, tabId));
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : (document.querySelector(".session-content") as HTMLElement | null)?.getBoundingClientRect().width || window.innerWidth,
  );
  const dockMode: DockMode = computeDockMode(availableWidth);
  const splitTabId = useDockStore((state) => selectDockView(state, tabId).splitTabId);
  // GitHub #31 review: while a split pane is pinned, the dock's floor rises
  // to DOCK_WIDTH_MIN + DOCK_SPLIT_MIN_PX — the pinned pane (absolute, 320px,
  // over the dock body's right) must never cover the active pane entirely.
  const effectiveDockWidth = clampDockWidth(dockWidth, availableWidth, dockMinWidth(splitTabId !== null));
  // Stage 2 (§3): the split gate over the SAME measured available width.
  const canSplitNow = canSplit(availableWidth);
  // The dock participates in the grid only in column mode — drawer mode is
  // an absolute overlay (conversation full width).
  const splitOpen = dockOpen && dockMode === "column";
  const previews = usePreviewStore((state) => state.byTab[tabId]?.previews ?? EMPTY_PREVIEWS);

  // R8(c): OS notification on running→idle while hidden/blurred (active tab
  // only — cross-tab completion is R10).
  useTurnCompletionNotification(turn, notificationBody(tabTitle, workspace), tabId);

  // D7: feeds panel-bridge's {activeTabId, panelMounted} half of the
  // gating triple. `tabId` here IS the renderer's active tab — ActiveTabBody
  // only ever renders for the currently active one (App.tsx's main-pane
  // branch) — and `previewMounted` mirrors exactly whether a preview body is
  // actually rendered below (dock open AND a preview tab active). The hook's
  // own cleanup (on unmount OR any dependency change) republishes
  // {null, false}, immediately superseded by the next render's fresh values
  // when this is just a tab switch/toggle rather than a real unmount (D7's
  // "never floats over a non-tab screen"). Main keeps hiding the
  // WebContentsView while a non-preview tab is active — D7 semantics preserved.
  const previewMounted = dockOpen && dockTabs.some((tab) => tab.id === dockActiveTabId && tab.kind === "preview");
  usePanelMountState(tabId, previewMounted);

  // Hydration read (CUT §3 96-P2 item 6): on mount AND every tab switch, pull
  // the current preview list for this tab — `onChanged` (subscribed once at
  // App mount) covers every LATER mutation, but a tab that already had
  // previews open before this render needs an initial snapshot.
  useEffect(() => {
    let cancelled = false;
    window.anycode.previewPanel
      .list(tabId)
      .then((payload) => {
        if (!cancelled) {
          usePreviewStore.getState().applyChanged(payload);
        }
      })
      .catch((error: unknown) => {
        console.warn("[ActiveTabBody] previewPanel.list failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  // D11: publish the visible dock width + handle (else 0) so NoticeStack can
  // offset the toast stack instead of letting it sit under the view — column
  // mode only; in drawer mode toasts sit under the dock by design (same as
  // the LSP overlay today).
  useEffect(() => {
    usePreviewStore.getState().setPanelInsetPx(splitOpen ? effectiveDockWidth + DOCK_HANDLE_PX : 0);
  }, [splitOpen, effectiveDockWidth]);

  // Taskana 4703: the ONE dock resize path (mirror of the retired
  // beginPreviewResize, now clamped live against the measured root width —
  // the boot-time clamp is the `effectiveDockWidth` computation above).
  // GitHub #31 review: the drag tracks the INITIATING pointerId (a second
  // finger's moves are ignored), and `pointercancel` ends the drag exactly
  // like `pointerup` — a canceled drag must not leave live listeners behind.
  // The clamp's floor follows the split (dockMinWidth): a pinned pane must
  // never be squeezed over the active tab's body.
  function beginDockResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = effectiveDockWidth;
    const rootWidth = reviewRootRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const minWidth = dockMinWidth(splitTabId !== null);
    let nextWidth = startWidth;

    function onMove(moveEvent: PointerEvent): void {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      nextWidth = clampDockWidth(startWidth + startX - moveEvent.clientX, rootWidth, minWidth);
      useDockStore.setState({ width: nextWidth });
    }

    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      useDockStore.getState().setWidth(nextWidth); // persists on resize-end
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }

  // Available-width tracking: the .session-content width changes on window
  // resize AND on sidebar collapse/expand (--sidebar-w), so observe the
  // element itself; the window listener stays as the belt.
  useEffect(() => {
    if (reviewRootEl === null) {
      return;
    }
    function remeasure(): void {
      const rect = reviewRootEl!.getBoundingClientRect();
      setAvailableWidth(rect.width > 0 ? rect.width : window.innerWidth);
    }
    remeasure();
    const observer = new ResizeObserver(remeasure);
    observer.observe(reviewRootEl);
    window.addEventListener("resize", remeasure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [reviewRootEl]);

  // Stage 2 (§3 item 4): an open split NEVER survives a window too narrow
  // for it — when `available` drops below canSplit's threshold the pinned
  // tab unpins (auto-merge), so no broken split is ever left behind.
  useEffect(() => {
    if (!canSplitNow) {
      useDockStore.getState().mergeSplit();
    }
  }, [canSplitNow]);

  // ── Taskana 4703 tab-derivation effects: mirror each source surface into
  // the dock's tab set. Each effect is [tabId]-scoped so a background tab's
  // preview pushes never touch the dock (only the ACTIVE tab's
  // ActiveTabBody runs them). ──

  // Previews: panel-container previews → preview:<id> tabs. A NEW preview
  // focuses its tab; an EXISTING preview's payload refresh must NOT steal
  // focus. Vanished previews (closed or transferred to a window) drop their
  // tabs; when the dropped one WAS active, focus the neighbor the store
  // picked and select that preview main-side (so the WebContentsView
  // follows the tab the user now sees).
  const previewTabs = derivePreviewTabs(previews);
  useEffect(() => {
    const dock = useDockStore.getState();
    const wanted = new Map(previewTabs.map((tab) => [tab.id, tab]));
    // Cross-review D3: a new preview takes focus only when the user is already
    // on a preview (or the dock is empty). Reading git/subagents, a preview the
    // main side pushes must not unmount that body — it lands in the strip.
    const activeIsPreview = dock.tabs.some((candidate) => candidate.id === dock.activeTabId && candidate.kind === "preview");
    const focusNew = dock.activeTabId === null || activeIsPreview;
    // Open new tabs.
    for (const tab of previewTabs) {
      if (!dock.tabs.some((candidate) => candidate.id === tab.id)) {
        if (focusNew) {
          useDockStore.getState().open(tab);
        } else {
          useDockStore.getState().openBackground(tab);
        }
      }
    }
    // Drop tabs whose preview vanished.
    for (const tab of dock.tabs) {
      if (tab.kind === "preview" && !wanted.has(tab.id)) {
        const wasActive = useDockStore.getState().activeTabId === tab.id;
        useDockStore.getState().close(tab.id);
        if (wasActive) {
          const neighborTabId = useDockStore.getState().activeTabId;
          const neighbor = neighborTabId !== null ? useDockStore.getState().tabs.find((candidate) => candidate.id === neighborTabId) : undefined;
          // Cross-review P1: the dock store is global across conversation tabs,
          // so the neighbour may be ANOTHER tab's preview — select only one that
          // belongs to the tab this effect is for (`wanted`).
          if (neighbor && neighbor.kind === "preview" && wanted.has(neighbor.id)) {
            window.anycode.previewPanel.select(tabId, neighbor.id.slice("preview:".length)).catch((error: unknown) => {
              console.warn("[ActiveTabBody] neighbor select failed", error);
            });
          }
        }
      }
    }
  }, [tabId, previewTabs]);

  // Subagents split: entering split opens+focuses the tab; leaving closes it.
  useEffect(() => {
    if (childSplitOpen) {
      useDockStore.getState().open({ id: "subagents", kind: "subagents", title: "Subagents" });
    } else {
      useDockStore.getState().close("subagents");
    }
  }, [tabId, childSplitOpen]);

  // Git panel: opening opens+focuses the tab; closing drops it.
  useEffect(() => {
    if (gitPanelOpen) {
      useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
    } else {
      useDockStore.getState().close("git");
    }
  }, [tabId, gitPanelOpen]);

  // CUT-S3 §3.3: the split stack's rows, `order`-ordered, each resolved off
  // the master transcript exactly like ChildSessionPane/ChildHistoryPane
  // resolve layout B's single child below — a missing card (an id this
  // renderer never saw a subagent_start for) falls back to
  // FALLBACK_SUBAGENT_CARD, mirroring B's own breadcrumb fallback.
  const childSplitRows: readonly ChildSplitRow[] =
    childView.kind === "split"
      ? projectChildSplitRows(childView.order, {
          parentSessionId,
          relations,
          transcript,
          liveChildStores,
        })
      : EMPTY_CHILD_SPLIT_ROWS;

  // CUT-S3 §3.3: the split stack's expanded row surface — composed here
  // (not in ChildSplitPane, §3.3's "композиция вместо экстракции") so the
  // TabContext.Provider/tabRegistry wiring stays exactly where layout B's
  // own ChildSessionPane/ChildHistoryPane already do it below.
  let childSplitSurface: ReactNode = null;
  if (childView.kind === "split") {
    if (childRelation !== undefined && childRelation.live) {
      const childStore = tabRegistry.getStore(childRelation.childTabId);
      childSplitSurface = childStore ? (
        <div className="session-content">
          <TabContext.Provider value={{ tabId: childRelation.childTabId, store: childStore }}>
            <SessionSurface tabId={childRelation.childTabId} onToast={onToast} suppressPermissionModal />
          </TabContext.Provider>
        </div>
      ) : (
        <div className="main-empty">This child session is no longer available.</div>
      );
    } else {
      childSplitSurface = (
        <div className="session-content">
          <ChildHistoryContent parentSessionId={parentSessionId} spawnToolCallId={childView.expandedId} />
        </div>
      );
    }
  }

  // TASK.102 CUT-S2 §2.5 (C3) / §10.8.1 (C4): layout B's child branch — a
  // breadcrumb bar in place of SessionHeader, above either the LIVE
  // SessionSurface re-scoped to the child's own TabContext (ChildSessionPane,
  // relation still live) or C4's read-only completed transcript
  // (ChildHistoryPane, everything else: no relation yet seen this renderer
  // session — the restart-Open case — or a relation that has flipped
  // live:false). Every hook above this point keeps running for the MASTER tab
  // regardless (background-completion notifications, preview-panel
  // bookkeeping, etc.) — only the JSX choice changes here, so switching back
  // to master via the breadcrumb never lost any of that state to begin with.
  const permissionForwarder = <ParentChildPermissionModal />;

  if (childView.kind === "child") {
    if (childRelation !== undefined && childRelation.live) {
      return (
        <>
          <ApprovalStatus />
          <ConnectedPermissionModal />
          {permissionForwarder}
          <ChildSessionPane
            parentTabId={tabId}
            spawnToolCallId={childView.spawnToolCallId}
            relation={childRelation}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={onToggleSidebar}
            onToast={onToast}
          />
        </>
      );
    }
    return (
      <>
        <ApprovalStatus />
        <ConnectedPermissionModal />
        {permissionForwarder}
        <ChildHistoryPane
          parentTabId={tabId}
          parentSessionId={parentSessionId}
          spawnToolCallId={childView.spawnToolCallId}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
        />
      </>
    );
  }

  return (
    <>
      {permissionForwarder}
      <SessionHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} onToast={onToast} />

      <div
        ref={attachReviewRoot}
        className={`session-content${splitOpen ? " session-content-split-open" : ""}`}
        style={
          splitOpen
            ? {
                gridTemplateColumns: computeSessionContentColumns(splitOpen, effectiveDockWidth),
              }
            : undefined
        }
      >
        <SessionSurface tabId={tabId} onToast={onToast} />

        {/* GitHub #31: the resize handle is a DIRECT grid child filling the
            reserved 8px column (as before the dock refactor) — inside the
            dock <aside> (a column flex) it collapsed to a 0px-tall strip
            with no hit area. Column mode only; the drawer overlay is not
            drag-resizable (same as the LSP overlay posture it mirrors). */}
        {splitOpen && (
          <div
            className="review-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize dock"
            data-testid="dock-resize-handle"
            onPointerDown={beginDockResize}
          />
        )}
        {/* Taskana 4703: ONE dock column replaces the git/preview/subagents
            stack. The mount gate is tabs+visible; drawer mode still mounts
            (absolute overlay) but leaves the grid untouched above. */}
        {dockOpen && (
          <DockPanel
            mode={dockMode}
            width={effectiveDockWidth}
            onToast={onToast}
            canSplitNow={canSplitNow}
            splitTabId={splitTabId}
            subagents={{ rows: childSplitRows, expandedId: childView.kind === "split" ? childView.expandedId : "", surface: childSplitSurface }}
          />
        )}
      </div>

      {gitPanelOpen && <GitConfirmDialog />}

      {supportsCorePanels && <LspPanel />}
      {supportsCorePanels && <HooksPanel />}
      {/* Taskana 4742: the Timeline dock panel is gone — rewind moved into the
          tick rail's popover (SessionSurface's MessageList `rewind` prop). */}
      {/* keyed: the panel's local selected-row state must not leak into another tab */}
      {supportsTasks && <BackgroundTasksPanel key={tabId} />}
    </>
  );
}

interface ChildSessionPaneProps {
  parentTabId: string;
  spawnToolCallId: string;
  /** Guaranteed `live: true` by the caller above — ActiveTabBody only renders this while the child is live. */
  relation: ChildRelation;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  onToast(kind: ToastKind, text: string): void;
}

/**
 * TASK.102 CUT-S2 §2.5 (C3): layout B's child view — a breadcrumb bar
 * (replacing SessionHeader) above the SAME SessionSurface the master pane
 * uses, re-scoped to the child tab's own `<TabContext.Provider>` so its
 * composer sends land on the child's connection. Permission requests are
 * presented by the parent in one shared order. Still rendered
 * from INSIDE the master's own TabContext (ActiveTabBody never re-wraps
 * itself) — `useTabStore`/`useTabsStore` below read the MASTER's title and
 * transcript (to find the Agent card's own agentType/description for the
 * breadcrumb), exactly like SessionHeader already does today.
 *
 * A dead/unknown child (`relation.live` flips between ActiveTabBody's own
 * render-gate above and this component's, effectively the same render) falls
 * back to a plain message rather than crash — belt-and-braces;
 * ActiveTabBody's own effect already reverts the layout view to master on
 * the very next tick for that case.
 */
function ChildSessionPane({
  parentTabId,
  spawnToolCallId,
  relation,
  sidebarCollapsed,
  onToggleSidebar,
  onToast,
}: ChildSessionPaneProps) {
  const masterTitle =
    useTabsStore((state) => state.tabs.find((tab) => tab.tabId === parentTabId)?.title) ?? "Untitled task";
  const card = useTabStore((state) => {
    const block = state.transcript.find((entry) => entry.kind === "tool_call" && entry.toolCallId === spawnToolCallId);
    return block && block.kind === "tool_call" ? block.subagent : null;
  });
  const breadcrumb = buildChildBreadcrumb(masterTitle, card ?? { agentType: "Subagent", description: "" });
  const childStore = tabRegistry.getStore(relation.childTabId);

  return (
    <>
      <header className="session-header child-session-breadcrumb">
        {sidebarCollapsed && (
          <button
            type="button"
            className="session-header-expand"
            aria-label="Expand sidebar"
            onClick={onToggleSidebar}
          >
            <CollapseIcon />
          </button>
        )}
        <button
          type="button"
          className="child-breadcrumb-master"
          onClick={() => childLayoutStore.getState().close(parentTabId)}
        >
          {breadcrumb.masterTitle}
        </button>
        <span className="child-breadcrumb-sep" aria-hidden="true">
          ›
        </span>
        <span className="child-breadcrumb-current" title={breadcrumb.description || undefined}>
          {breadcrumb.agentType}
        </span>
        <button
          type="button"
          className="child-breadcrumb-split"
          onClick={() => childLayoutStore.getState().enterSplit(parentTabId)}
        >
          Split
        </button>
      </header>

      <div className="session-content">
        {childStore ? (
          <TabContext.Provider value={{ tabId: relation.childTabId, store: childStore }}>
            <SessionSurface tabId={relation.childTabId} onToast={onToast} suppressPermissionModal />
          </TabContext.Provider>
        ) : (
          <div className="main-empty">This child session is no longer available.</div>
        )}
      </div>
    </>
  );
}

interface ChildHistoryPaneProps {
  parentTabId: string;
  /** The master's own sessionId (ambient — NEVER a card-payload id, CUT-S2 §2.3's identity discipline mirrored renderer-side). Null/undefined only if this tab's own session row hasn't hydrated yet — treated as unavailable rather than crashing. */
  parentSessionId: string | null | undefined;
  spawnToolCallId: string;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
}

/** Placeholder view-state before the channel round-trip resolves — distinct from `ChildHistoryViewState`'s three settled states (that type has no "loading" member: a channel response is always eventually one of ok+items/ok+empty/refused, never "still waiting" — this is purely a pre-response UI moment). */
const CHILD_HISTORY_LOADING = { kind: "loading" as const };

/**
 * TASK.102 CUT-S2 §10.8.1 (slice S2c C4): layout B's READ-ONLY child view —
 * the home for a child this tab's relation-store does NOT show as live
 * (never seen live in this renderer process at all — the restart-Open case —
 * or seen live and since exited). Fetches the completed transcript over
 * `CHILD_HISTORY_CHANNEL`, keyed ONLY by the ambient `(parentSessionId,
 * spawnToolCallId)` pair this component's own props carry — NEVER by any id
 * riding a card's persisted `target` payload (the renderer mirror of §2.3's
 * "identity from the actual sender, not the payload": a forged/stale blob
 * gets main's honest authorization refusal, never someone else's history).
 *
 * Deliberately NOT `SessionSurface`: that component resolves entirely off a
 * LIVE `TabContext` (a real per-tab zustand store from `tabRegistry`), which
 * a completed child does not have (main reaps its host on the terminal
 * transition, CUT-S2 §0). This pane instead feeds the SAME `MessageList` the
 * live surface uses (identical React/Markdown rendering tract — XSS law, no
 * second renderer) with a one-shot fetched block array, and never mounts
 * `Composer` at all — "composer disabled" per §10.8.1 point 3's normative
 * §2.5 rule, since there is no live connection to send a composer draft on.
 */
function ChildHistoryPane({ parentTabId, parentSessionId, spawnToolCallId, sidebarCollapsed, onToggleSidebar }: ChildHistoryPaneProps) {
  const masterTitle =
    useTabsStore((state) => state.tabs.find((tab) => tab.tabId === parentTabId)?.title) ?? "Untitled task";
  const card = useTabStore((state) => {
    const block = state.transcript.find((entry) => entry.kind === "tool_call" && entry.toolCallId === spawnToolCallId);
    return block && block.kind === "tool_call" ? block.subagent : null;
  });
  const breadcrumb = buildChildBreadcrumb(masterTitle, card ?? { agentType: "Subagent", description: "" });

  return (
    <>
      <header className="session-header child-session-breadcrumb">
        {sidebarCollapsed && (
          <button
            type="button"
            className="session-header-expand"
            aria-label="Expand sidebar"
            onClick={onToggleSidebar}
          >
            <CollapseIcon />
          </button>
        )}
        <button
          type="button"
          className="child-breadcrumb-master"
          onClick={() => childLayoutStore.getState().close(parentTabId)}
        >
          {breadcrumb.masterTitle}
        </button>
        <span className="child-breadcrumb-sep" aria-hidden="true">
          ›
        </span>
        <span className="child-breadcrumb-current" title={breadcrumb.description || undefined}>
          {breadcrumb.agentType}
        </span>
        <span className="child-breadcrumb-readonly" title="This child session has ended — its transcript is read-only.">
          Read-only
        </span>
        <button
          type="button"
          className="child-breadcrumb-split"
          onClick={() => childLayoutStore.getState().enterSplit(parentTabId)}
        >
          Split
        </button>
      </header>

      <div className="session-content">
        <ChildHistoryContent parentSessionId={parentSessionId} spawnToolCallId={spawnToolCallId} />
      </div>
    </>
  );
}

interface ChildHistoryContentProps {
  parentSessionId: string | null | undefined;
  spawnToolCallId: string;
}

/**
 * CUT-S3 §3.3: C4's read-only fetch/loading/unavailable/empty/blocks states,
 * extracted from `ChildHistoryPane`'s body (everything below its breadcrumb
 * header) so layout B (`ChildHistoryPane` above, unchanged rendering) and the
 * split stack's read-only row (`ActiveTabBody`'s `childSplitSurface`, wrapped
 * in its own `.session-content`) share the identical fetch/render logic
 * instead of two tracts. Not exported — an implementation detail of this file.
 */
function ChildHistoryContent({ parentSessionId, spawnToolCallId }: ChildHistoryContentProps) {
  const [state, setState] = useState<ChildHistoryViewState | typeof CHILD_HISTORY_LOADING>(CHILD_HISTORY_LOADING);
  const rootTabId = useContext(TabContext)?.tabId ?? null;
  const replayBlocks = useStore(replayStore, (s) => childVisible(s, rootTabId, spawnToolCallId));

  useEffect(() => {
    if (state.kind !== "blocks" || rootTabId === null) return;
    if (!replayStore.getState().offerChild(rootTabId, spawnToolCallId, state.blocks)) return;
    return () => replayStore.getState().withdrawChild(spawnToolCallId);
  }, [state, rootTabId, spawnToolCallId]);

  useEffect(() => {
    let cancelled = false;
    setState(CHILD_HISTORY_LOADING);
    if (parentSessionId === undefined || parentSessionId === null) {
      setState({ kind: "unavailable" });
      return;
    }
    window.anycode
      .childHistory(parentSessionId, spawnToolCallId)
      .then((result: ChildHistoryResult) => {
        if (!cancelled) {
          setState(projectChildHistoryResult(result));
        }
      })
      .catch((error: unknown) => {
        console.warn("[ChildHistoryContent] childHistory failed", error);
        if (!cancelled) {
          setState({ kind: "unavailable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [parentSessionId, spawnToolCallId]);

  return (
    <>
      {state.kind === "loading" && <div className="main-empty">Loading transcript…</div>}
      {state.kind === "unavailable" && <div className="main-empty">This child session's transcript is unavailable.</div>}
      {state.kind === "empty" && <div className="main-empty">This child session has no transcript yet.</div>}
      {state.kind === "blocks" && (
        <div className="session-conversation">
          <MessageList
            blocks={replayBlocks ?? state.blocks}
            turn={{ status: "idle", turnId: null, requestId: null }}
            workspace={null}
            connection="host_exited"
            retry={null}
            onTryAgain={() => {}}
            continueOffer={null}
            onContinue={() => {}}
            promptQueueLength={0}
            readOnly={true}
          />
        </div>
      )}
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

export const CLOSE_TAB_CONFIRM = {
  title: "Close tab",
  body: "This tab has a turn in progress. Close it anyway?",
  confirmLabel: "Close tab",
} as const;

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
  // TASK.126: pending close-tab confirm (tabId of the tab awaiting the user's
  // verdict) — replaces the blocking window.confirm in handleCloseTab.
  const [closeTabConfirm, setCloseTabConfirm] = useState<string | null>(null);
  const welcomeEngineRef = useRef<"core" | "codex" | "claude">("core");
  const welcomeVisible = shouldShowWelcome(settingsSnapshot, tabs.length, hasExternalEngine);
  const wasWelcomeVisible = useRef(false);
  useEffect(() => {
    if (wasWelcomeVisible.current && !welcomeVisible && tabs.length === 0 &&
        (settingsSnapshot?.providerReady || hasExternalEngine === true)) {
      const state = useTabsStore.getState();
      state.openDraft();
      state.setDraftEngine(settingsSnapshot?.providerReady ? "core" : welcomeEngineRef.current);
      setSettingsOpen(false);
    }
    wasWelcomeVisible.current = welcomeVisible;
  }, [welcomeVisible, settingsSnapshot?.providerReady, hasExternalEngine, tabs.length]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("actions");
  // D8: App's own overlay wiring — the command palette and Settings dialog
  // both float above everything, so the preview WebContentsView must hide
  // while either is open (folded into panel-bridge's setState via one flag).
  useOverlayFlag(paletteOpen || settingsOpen);
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
    const api = window.anycode;
    if (!api?.tabBootstrap || !api.selectTab) return;
    return startTabBootstrap(api, useTabsStore, tabRegistry);
  }, []);

  // CUT.md §3 96-P2 item 6: the `onChanged` push subscription lives at App
  // mount (once for the whole app lifetime) — every tab's preview-store
  // entry is fed through this ONE listener, independent of which tab is
  // active or whether its panel region happens to be mounted right now.
  useEffect(() => {
    const api = window.anycode?.previewPanel;
    if (!api) {
      return;
    }
    return api.onChanged((payload) => {
      usePreviewStore.getState().applyChanged(payload);
    });
  }, []);

  useEffect(() => watchExternalEngines(window.anycode, (available, engineIds) => {
    if (available && !engineIds.includes(welcomeEngineRef.current)) {
      welcomeEngineRef.current = engineIds.find((engine) => engine !== "core") ?? "core";
    }
    hasExternalEngineRef.current = available;
    setHasExternalEngine(available);
  }), []);

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
        // TASK.146: Esc mirrors the composer's Stop button, which is shown
        // for the whole busy window — a running turn OR a manual compaction
        // (isSessionBusy). Its title literally reads "Stop (Esc)", so the two
        // must agree; `cancel_turn` aborts either one host-side.
        if (!isSessionBusy(tabRegistry.getStore(currentTabId)?.getState().turn.status ?? "idle")) {
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
        case "dock.toggle":
          // Taskana 4703: hide/show the dock (the ⌘\ hint rides ACTION_CATALOG).
          useDockStore.getState().toggleHidden();
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
    if (running) {
      setCloseTabConfirm(tabId);
      return;
    }
    closeTabNow(tabId);
  }

  /** The committed close (TASK.126): the ConfirmDialog's Confirm path. */
  function closeTabNow(tabId: string): void {
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
    // TASK.146: same busy window as the Esc branch above — this runner IS the
    // bound-key/palette path to the identical gesture.
    if (!isSessionBusy(tabRegistry.getStore(currentTabId)?.getState().turn.status ?? "idle")) {
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

  if (welcomeVisible) {
    // Welcome renders full-window with no sidebar (design §2.1) — the
    // `app-welcome` modifier drops the shell grid back to a plain column.
    return (
      <main key="welcome" className="app app-welcome">
        <div className="welcome-titlebar" aria-hidden="true" />
        <WelcomeScreen onOpenSettings={() => setSettingsOpen(true)} settingsOpen={settingsOpen}
          onSelectEngine={(engine) => { welcomeEngineRef.current = engine; }} />
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
  const emptyAffordance = emptyPaneSidebarAffordance(collapsed, hintFor("sidebar.toggle"));
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
      // TASK.146: mirrors `runInterrupt`'s own gate (this row calls it); a
      // narrower predicate here would gray out a row whose action still works.
      enabled: isSessionBusy(activeStore?.getState().turn.status ?? "idle"),
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
          <div className="main-empty">
            {emptyAffordance.showExpand && (
              <button
                type="button"
                className="session-header-expand main-empty-expand"
                aria-label="Expand sidebar"
                onClick={handleToggleSidebarCollapsed}
              >
                <CollapseIcon />
              </button>
            )}
            <span>{emptyAffordance.text}</span>
          </div>
        )}

        {/* The active tab's terminal must not float over the start screen (§4.6). */}
        <TerminalPanel tabId={activeTab?.tabId ?? null} open={!draftActive && (activeTab?.terminalOpen ?? false)} />
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* TASK.126: close-with-running-turn confirm (replaces window.confirm). */}
      <ConfirmDialog
        request={closeTabConfirm === null ? null : CLOSE_TAB_CONFIRM}
        onCancel={() => setCloseTabConfirm(null)}
        onConfirm={() => {
          const tabId = closeTabConfirm;
          setCloseTabConfirm(null);
          if (tabId !== null) {
            closeTabNow(tabId);
          }
        }}
      />

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

function ApprovalStatus() {
  const unattended = useTabStore((state) => state.unattended);
  const send = useTabSend();
  if (!unattended) return null;
  return <div className="banner banner-info approval-status" role="status">An unanswered request expired. New approval requests are being denied automatically. <button type="button" onClick={() => send({ type: "approval_recover" })}>Ask me again</button></div>;
}

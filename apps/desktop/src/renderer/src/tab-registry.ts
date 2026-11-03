import { clearPendingInitial, clearRecovery, loadPendingInitial, loadRecovery, savePendingInitial, saveRecovery } from "./orchestration-recovery-storage.js";
import { useDockStore } from "./dock/dock-store.js";
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
 *
 * (CUT-S2 §2.5/§5.3, slice S2c C2) adds a SECOND `registerPort`
 * path, taken when the incoming envelope carries a `child` field
 * (`classifyPortEnvelope`, `child-sessions.ts`): a child session still gets
 * an entry in `entries` (store+connection+ui_ready — the child host needs
 * `ui_ready` to emit `child-ready`, §2.6.3), but never the root-tab
 * bootstrap `tabsStore.addTab`/the R10 status-mirror/the P7.14
 * queue-drainer perform for every other port — a child session must never
 * surface in the Sidebar/StartScreen/CommandPalette (design §0.4's
 * skip-hide contract). `TabEntry.isChild` remembers the branch taken at
 * creation so `markHostExited` can route a child's exit to the
 * child-relation store (`live: false`) instead of a root-tab banner nobody
 * would ever see.
 */
import { createDesktopStore, recoveryAdmissionBlocked, systemRetrySafe, type DesktopState, type QueuedPrompt, type QueuedPromptImage } from "./store.js";
import type { PermissionMode, ReasoningEffort } from "@anycode/core";
import { connectHost, connectTerminal, type HostConnection, type TerminalConnection } from "./port.js";
import { useTabsStore, type TabsStoreApi } from "./tabs-store.js";
import { deriveCoarse, useTabStatusStore, type TabStatusStoreApi } from "./tab-status-store.js";
import { terminalView as defaultTerminalView, type TerminalDims, type TerminalView } from "./terminal-view.js";
import type { UiToHostMessage } from "../../shared/protocol.js";
import type { PortEnvelope } from "../../shared/envelopes.js";
import { TERM_DEFAULT_COLS, TERM_DEFAULT_ROWS, type TermToHostMessage } from "../../shared/terminal.js";
import { loadUsageLimitNotices, saveUsageLimitNotice } from "./provider-notices.js";
import { loadConnectionSwitches } from "./provider-switch-log.js";
import {
  classifyPortEnvelope,
  childRelationStore as defaultChildRelationStore,
  type ChildRelationStoreApi,
} from "./child-sessions.js";
// the SAME model-level image gate Composer's own send-path uses
// (`canSend`'s `!attachmentsBlockedByModel`), reused here — not re-derived —
// for the one send site with no live composer to react from beforehand (the
// FIRST turn of a brand-new tab).
import { isSendBlockedByModelImages, MODEL_IMAGE_ATTACH_BLOCKED_TEXT } from "./components/Composer.js";

/** Convenience alias for the store instance type `createDesktopStore()` returns. */
export type DesktopStoreApi = ReturnType<typeof createDesktopStore>;

interface TabEntry {
  store: DesktopStoreApi;
  connection: HostConnection | null;
  unsubscribeMessages: (() => void) | null;
  unsubscribeExpiry: (() => void) | null;
  terminal: TerminalConnection | null;
  unsubscribeTerminalMessages: (() => void) | null;
  /** R10 status-mirror subscription on this tab's own store; lives for the STORE's lifetime (survives respawns), dies in disposeTab. */
  unsubscribeStatus: (() => void) | null;
  /** P7.14 prompt-queue drainer subscription on this tab's own store; store-lifetime (survives respawns), dies in disposeTab (symmetry with `unsubscribeStatus`). */
  unsubscribeQueue: (() => void) | null;
  unsubscribeRecovery: (() => void) | null;
  /**
   * CUT-S2 §2.5/§5.3: true iff this tabId was classified `"child"`
   * (`classifyPortEnvelope`) on its FIRST `registerPort` — fixed for the
   * entry's lifetime, decided once at creation the same way `store` is.
   * Gates the root-tab-only side effects in `registerPort`/`markHostExited`
   * (tabsStore bootstrap/banner, status-mirror, queue-drainer) without a
   * second lookup into the child-relation store just to ask "is this one of
   * mine".
   */
  isChild: boolean;
  /**
   * the relation meta of a child tab (`PortEnvelope["child"]`,
   * parent/spawn/child session ids), recorded at `registerPort`; null for a
   * root tab. Lets `/state`'s `childStates` carry the parent relation without
   * a second lookup into the child-relation store.
   */
  child: NonNullable<PortEnvelope["child"]> | null;
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
   *
   * W10-FIX F2: `pinnedConnection` (additive) records the tab's pinned
   * provider connection on its per-tab store so the ModelPill targets it.
   *
   * CUT-S2 §2.5/§5.3: `child` (additive), present only for a
   * child-session tab's port delivery (`port.ts`'s `HostPortMeta.child`,
   * carried from the envelope's own `child` field). Its presence is the
   * branch condition — `classifyPortEnvelope` — for a SECOND registration
   * path that deliberately skips `tabsStore.addTab`, the R10 status-mirror,
   * and the P7.14 queue-drainer: a child session must never surface in the
   * Sidebar/StartScreen/CommandPalette (design §0.4's skip-hide contract;
   * this is the anti-facade CUT-S2 §5.3 names — today ANY delivered port
   * takes the root-tab path unconditionally). The store+connection+ui_ready
   * mechanism below is otherwise unchanged: a child tab still gets its own
   * store, still gets `ui_ready` sent (the child host needs it to emit
   * `child-ready`, §2.6.3), and is still torn down by `disposeTab` like any
   * other entry. When `child` is present, this also (re-)registers the
   * relation in the child-relation store (`child-sessions.ts`) that C3's
   * Open button and breadcrumb resolve through.
   */
  registerPort(
    tabId: string,
    workspace: string,
    port: MessagePort,
    pinnedConnection?: { connectionId: string; providerId: string },
    child?: PortEnvelope["child"],
    /** the envelope's `openedByAgent` marker; root tabs only. */
    openedByAgent?: boolean,
    agentTitle?: string,
  ): boolean;
  /**
   * Flips the tab's own store into `host_exited` and mirrors that onto the
   * tabs-store's `hostExited` flag (for the TabBar dot) — ONLY for this
   * tabId; every other tab's store/banner state is untouched. Drops the dead
   * connection reference; a later `registerPort` (respawn) clears the flag
   * again and reconnects. No-op for an unknown/disposed tabId.
   *
   * CUT-S2 §2.5/§0: for a CHILD tabId (`TabEntry.isChild`), the
   * tabs-store mirror is skipped entirely (there is no root-tab banner to
   * paint — a child was never added there) and the child-relation store's
   * entry is flipped to `live: false` instead (main's reap-on-terminal
   * verdict, §0: a terminated child host never respawns, so this is a
   * one-way flip, not a "wait for reconnect" state like a root tab's).
   *
   * `missingWorkspacePath` marks the GitHub #6 case: main could not start a
   * host because the tab's workspace folder is gone. The store's `lastFatal`
   * then names the folder and the way out, so the surface shows an error
   * instead of a connecting state that never resolves.
   */
  markHostExited(tabId: string, missingWorkspacePath?: string, failure?: import("../../shared/host-failure.js").HostFailure): void;
  /**
   * Tears the tab down completely: unsubscribes its message listener, drops
   * the entry from the map, and removes it from the tabs-store. Marks the
   * tabId as closed so a stray in-flight port for it is dropped rather than
   * resurrecting the tab. No-op (beyond marking closed) for an unknown tabId.
   */
  disposeTab(tabId: string): void;
  /** Sends to the tab's live connection; warns and drops if the tab has no connection (unknown tab, or mid-reconnect/exited). */
  sendToTab(tabId: string, message: UiToHostMessage): void;
  /** Current renderer connection identity, only for this ready tab/store. */
  getLiveHostConnection(tabId: string, store: DesktopStoreApi): object | null;
  /** The tab's store instance, or undefined if the tab isn't registered (yet, or anymore). */
  getStore(tabId: string): DesktopStoreApi | undefined;
  /**
   * every registered child tab (entry still live) with its
   * relation meta, in registration order. A child tab's store lives in this
   * registry but never in tabsStore, so this is the only enumeration seam the
   * automation snapshot (`childStates`) has; a host-exited child's entry is
   * deleted by `markHostExited`, so it disappears here the same way.
   */
  listChildTabs(): Array<{ tabId: string; child: NonNullable<PortEnvelope["child"]> }>;
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
   *
   * `effort` follows the identical in-order-before-first-turn
   * recipe but targets a NON-core engine's own wire message
   * (`set_engine_effort`, never `set_model`'s `ReasoningEffort` vocabulary —
   * host/session.ts's `set_engine_effort` case only fires through
   * `engineSettings`, which core never wires) — sent last, after model/mode,
   * compared against the boot model's own resolved effort
   * (`host_ready.engine.model.effort`) so an unchanged pick sends nothing.
   * `reasoningEffort` is the CORE engine's own half of the same
   * split: core has no `set_engine_effort` case at all, its wire message is
   * `set_reasoning_effort` — so the two travel as separate parameters rather
   * than one "effort" a receiver would have to guess the vocabulary of. Sent
   * on the same before-the-first-turn recipe, after the model switch so the
   * host validates it against the model actually active by then.
   * `images` ride the first `user_message` exactly like a queued
   * prompt's images (`dispatchQueuedPrompt`'s recipe) — a boot model that
   * cannot accept them (`host_ready.imageInput === false`) drops them and
   * raises an `image_attach_rejected` notice instead of silently sending
   * them or losing the whole turn (the text half still goes out).
   * `orchestrate` (start-screen Orchestrate, core only) rides the same
   * before-the-first-turn recipe as the last pick: `set_orchestrate` is sent
   * after mode/model/effort, so the host's own plan-mode flip (onSetOrchestrate)
   * lands before the first `user_message` — the in-tab order exactly.
   */
  queueInitialPrompt(
    tabId: string,
    text: string,
    model?: string,
    mode?: PermissionMode,
    effort?: string,
    images?: readonly QueuedPromptImage[],
    reasoningEffort?: string,
    orchestrate?: boolean,
  ): void;
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
 *
 * `childRelationStore` (CUT-S2 §2.5, slice S2c C2) is injectable
 * the same way: defaults to `child-sessions.ts`'s app singleton, isolated
 * per test the same way `statusStore` is.
 */
export function createTabRegistry(
  tabsStore: TabsStoreApi,
  createStore: () => DesktopStoreApi = () => createDesktopStore(),
  terminalView: TerminalView = defaultTerminalView,
  statusStore: TabStatusStoreApi = useTabStatusStore,
  childRelationStore: ChildRelationStoreApi = defaultChildRelationStore,
): TabRegistry {
  const entries = new Map<string, TabEntry>();
  const unusableHostConnections = new WeakSet<HostConnection>();
  const closedHostConnections = new WeakSet<HostConnection>();
  const agentTitles = new Map<string, string>();
  const closedTabIds = new Set<string>();
  /**
   * Slice P7.12 §4.2 / F5#1b D3: text (+ optional task-scoped model/mode
   * picks) queued via `queueInitialPrompt`, waiting for its tab's
   * `host_ready`. `effort`/`images` join the same slot.
   */
  type InitialPrompt = { requestId?: string; text: string; model?: string; mode?: PermissionMode; effort?: string; images?: readonly QueuedPromptImage[]; reasoningEffort?: string; orchestrate?: boolean };
  const pendingInitialPrompts = new Map<string, InitialPrompt>();
  const pendingInitialModels = new Map<string, { requestId: string; prompt: InitialPrompt; timer: ReturnType<typeof setTimeout>; connection: HostConnection }>();
  const liveConnection = (entry: TabEntry): HostConnection | null => entry.connection && !unusableHostConnections.has(entry.connection) && entry.store.getState().connection === "ready" ? entry.connection : null;

  function holdInitial(entry: TabEntry, prompt: InitialPrompt, text: string): void {
    entry.store.getState().enqueuePrompt({ text: prompt.text, images: prompt.images ?? [], requiresRestore: true,
      ...(prompt.orchestrate ? { orchestrate: "enable" as const } : {}),
      initialPicks: { model: prompt.model, mode: prompt.mode, effort: prompt.effort, reasoningEffort: prompt.reasoningEffort } });
    entry.store.getState().setNotice({ kind: "image_attach_rejected", text });
  }
  function cancelPendingModel(tabId: string, entry: TabEntry): void {
    const pending = pendingInitialModels.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingInitialModels.delete(tabId);
    holdInitial(entry, pending.prompt, "A model switch was requested; the current model and effective reasoning effort are not confirmed. Restore the draft to review its settings.");
    clearPendingInitial(tabId);
  }

  /**
   * core's reasoning-effort vocabulary is CLOSED (core's own
   * `ReasoningEffort`), while a draft's effort pick is a free-form string
   * (it also serves the non-core engines' own per-model vocabularies). This
   * narrows one to the other and returns `undefined` for anything else, so
   * an unrecognized level is dropped here instead of riding the wire.
   */
  function asReasoningEffort(value: string): ReasoningEffort | undefined {
    const levels: readonly string[] = ["off", "low", "medium", "high", "xhigh", "max"];
    return levels.includes(value) ? (value as ReasoningEffort) : undefined;
  }

  /**
   * First-turn picks must reach the host before the first user message. The
   * MessagePort preserves order, and host_ready guarantees that the session is
   * idle, so the host can persist mode/model/effort before it starts the turn.
   */
  function applyInitialPicks(
    entry: TabEntry,
    model: string | undefined,
    mode: PermissionMode | undefined,
    effort: string | undefined,
    current: {
      model: string | null;
      mode: PermissionMode | null;
      effort: string | undefined;
      reasoningEffort: ReasoningEffort | undefined;
    },
    reasoningEffort?: string,
    orchestrate?: boolean,
  ): void {
    const connection = liveConnection(entry);
    const sendPick = (message: UiToHostMessage): void => {
      if (!connection || liveConnection(entry) !== connection) throw new Error("connection unavailable");
      connection.send(message);
    };
    if (mode !== undefined && mode !== current.mode) {
      sendPick({ type: "set_mode", mode });
    }
    if (model !== undefined && model !== current.model) {
      sendPick({ type: "set_model", model });
    }
    // sent last (after a model switch, if any) so a validated effort
    // always targets the model actually active by then — moot for the START
    // flow today, since a non-core draft's model is fixed at CreateTabRequest
    // spawn time and never switched through this path, but keeps the
    // ordering correct if that ever changes.
    if (effort !== undefined && effort !== current.effort) {
      sendPick({ type: "set_engine_effort", effort });
    }
    // core's own effort message, on the same after-the-model
    // ordering. The level is checked against core's closed vocabulary here
    // (an unrecognized string never reaches the wire) and the host then
    // re-validates it against the ACTIVE MODEL's declared levels
    // (`resolveReasoningEffort`, fail-closed), so a pick resolved against a
    // stale catalog can only be ignored, never misapplied.
    const level = reasoningEffort === undefined ? undefined : asReasoningEffort(reasoningEffort);
    if (level !== undefined && (level !== current.reasoningEffort || (model !== undefined && model !== current.model))) {
      sendPick({ type: "set_reasoning_effort", effort: level });
    }
    // Orchestration intent rides atomically with the initial user message.
  }

  /**
   * Dispatch recipe byte-parity with Composer.tsx's `handleSend`: echo the
   * block, then send the wire message. `imageInput` is the boot
   * model's live vision verdict (`host_ready.imageInput`, or the tab's
   * already-live store field for the already-ready shortcut) — gated through
   * the SAME `isSendBlockedByModelImages` predicate Composer's own send-gate
   * uses. If the model cannot accept the images, retain the whole draft for
   * explicit recovery instead of sending only its text.
   */
  function dispatchInitialPrompt(
    entry: TabEntry,
    tabId: string,
    text: string,
    images: readonly QueuedPromptImage[],
    imageInput: boolean | undefined,
    imageFallback: boolean | undefined,
    orchestrate?: boolean,
    picks?: QueuedPrompt["initialPicks"],
    stagedModel?: { model: string; reasoningEffort: ReasoningEffort },
    initialRequestId?: string,
  ): void {
    const blocked = isSendBlockedByModelImages(imageInput, imageFallback, images.length);
    if (blocked) {
      entry.store.getState().enqueuePrompt({ text, images, requiresRestore: true, ...(picks !== undefined ? { initialPicks: picks } : {}), ...(orchestrate === true ? { orchestrate: "enable" as const } : {}) });
      entry.store.getState().setNotice({ kind: "image_attach_rejected", text: stagedModel ? `${MODEL_IMAGE_ATTACH_BLOCKED_TEXT} Model switched to ${stagedModel.model}; effective reasoning effort is ${stagedModel.reasoningEffort}.` : MODEL_IMAGE_ATTACH_BLOCKED_TEXT });
      return;
    }
    const state = entry.store.getState();
    if (state.orchestration.posture === "transitioning" || state.orchestration.posture === "quarantined" || (orchestrate && (!state.orchestration.available || !state.orchestration.protocol?.atomicSubmit))) {
      holdInitial(entry, { text, images, orchestrate, ...picks }, "Session policy is unavailable. Restore the draft before sending; close the tab if policy cannot be verified.");
      return;
    }
    const deliveredImages = images;
    const requestId = initialRequestId ?? crypto.randomUUID();
    const connectionId = orchestrate ? entry.store.getState().beginOrchestrationSubmit(requestId) : null;
    if (orchestrate && !connectionId) { holdInitial(entry, { text, images, orchestrate, ...picks }, "Session policy is unavailable. Restore the draft before sending."); return; }
    entry.store.getState().appendUserText(requestId, text, deliveredImages.length > 0 ? deliveredImages.map((image) => image.attachment) : undefined);
    // W8: snapshot what actually went on the wire so a later terminal
    // retryable failure can offer to replay this same content.
    entry.store.getState().recordSentMessage(text, deliveredImages, requestId, orchestrate ? "enable" : undefined, picks ?? {});
    const connection = liveConnection(entry);
    try {
      if (!connection || !saveRecovery(tabId, entry.store.getState())) throw new Error("connection or recovery storage unavailable");
      connection.send({ type: "user_message", requestId, text, ...(deliveredImages.length > 0 ? { images: deliveredImages.map((image) => image.attachment) } : {}), ...(connectionId ? { orchestrate: "enable" as const, connectionId } : {}) });
      if (liveConnection(entry) !== connection) entry.store.getState().markOrchestrationDeliveryUnknown(requestId);
    } catch {
      entry.store.getState().markOrchestrationDeliveryUnknown(requestId);
      if (connection) {
        unusableHostConnections.add(connection);
        if (entry.connection === connection) entry.store.getState().setAwaitingPort();
      }
    }
  }

  /**
   * Drains ONE prompt from the tab's queue (slice P7.14 §2.1). `takeQueueHead`
   * mints the in-flight slot synchronously, so re-entrant `maybeDrain` calls
   * fired by the `appendUserText` set() below see a non-null inFlight and bail —
   * exactly one item leaves per idle period (FIFO). Wire send is byte-parity
   * with Composer's image send: images only when present. Returns early if the
   * head couldn't be taken (queue emptied/paused/inFlight by a racing update).
   */
  function dispatchQueuedPrompt(entry: TabEntry, tabId: string): void {
    const connection = liveConnection(entry);
    if (!connection) return;
    const candidateId = crypto.randomUUID();
    const item = entry.store.getState().takeQueueHead(candidateId);
    if (item === null) {
      return;
    }
    const inFlight = entry.store.getState().queueInFlight;
    if (!inFlight || inFlight.item !== item || liveConnection(entry) !== connection) return;
    const requestId = inFlight.requestId;
    const retryStillRejected = () => !item.retryOf || (systemRetrySafe(entry.store.getState().orchestrationDeliveries,item.retryOf,requestId) && entry.store.getState().orchestrationDeliveries.some(delivery => delivery.requestId === item.retryOf && delivery.retryQueued && delivery.originId === item.originId));
    const recoveryStillSafe = () => !item.recoverySourceId || !recoveryAdmissionBlocked(entry.store.getState(),item.recoverySourceId,{ignoreInFlightId:requestId,ignorePendingId:requestId});
    const cancelRetry = () => entry.store.getState().cancelUnsentSystemRetry(requestId);
    if (!retryStillRejected()) { cancelRetry(); return; }
    if (!recoveryStillSafe()) { entry.store.getState().holdBlockedRecovery(requestId); return; }
    // срез 2: `item.origin` (set only for a detached-child report,
    // QueuedPrompt.origin's own doc) rides onto BOTH the local transcript
    // append (live system-card render) and the wire `user_message` (host
    // stamps the persisted HistoryItem with it, so a reload renders the SAME
    // card — see protocol.ts's `user_message.origin` doc).
    entry.store
      .getState()
      .appendUserText(requestId, item.text, item.images.length > 0 ? item.images.map((image) => image.attachment) : undefined, item.origin);
    // W8: snapshot what actually went on the wire so a later terminal
    // retryable failure can offer to replay this same content.
    entry.store.getState().recordSentMessage(item.text, item.images, requestId, item.orchestrate, item.trackDelivery || item.retryOf || item.origin === "system" ? item.initialPicks ?? {} : undefined, item.recoverySourceId ?? item.retryOf, item.origin === "system" ? item.originId : undefined);
    if (liveConnection(entry) !== connection) { entry.store.getState().markOrchestrationDeliveryUnknown(requestId); return; }
    if (!retryStillRejected()) { cancelRetry(); return; }
    if (!recoveryStillSafe()) { entry.store.getState().holdBlockedRecovery(requestId); return; }
    try {
      if (!saveRecovery(tabId, entry.store.getState())) throw new Error("recovery storage unavailable");
      connection.send({
        type: "user_message", requestId, text: item.text,
        ...(item.images.length > 0 ? { images: item.images.map((image) => image.attachment) } : {}),
        ...(item.origin !== undefined ? { origin: item.origin } : {}),
      });
    } catch {
      unusableHostConnections.add(connection);
      if (entry.connection === connection) entry.store.getState().setPortClosed();
    }
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

  function startInitial(entry: TabEntry, tabId: string, prompt: InitialPrompt, current: { model: string | null; mode: PermissionMode | null; effort: string | undefined; reasoningEffort: ReasoningEffort | undefined }, imageInput: boolean | undefined, imageFallback: boolean | undefined, stagedModel?: { model: string; reasoningEffort: ReasoningEffort }): void {
    const retain = (reason: string): void => { holdInitial(entry, prompt, reason); if (saveRecovery(tabId, entry.store.getState())) clearPendingInitial(tabId); };
    cancelPendingModel(tabId, entry);
    if (!liveConnection(entry)) { retain("Connection unavailable. Restore the draft to review it before sending."); return; }
    const state = entry.store.getState();
    if (state.orchestration.posture === "transitioning" || state.orchestration.posture === "quarantined" || (prompt.orchestrate && (!state.orchestration.available || !state.orchestration.protocol?.atomicSubmit))) {
      retain("Session policy is unavailable. Restore the draft before sending; close the tab if policy cannot be verified."); return;
    }
    if ((prompt.images?.length ?? 0) > 0 && prompt.model !== undefined && prompt.model !== current.model) {
      if (!entry.connection) { retain("A model switch was requested; the current model and effective reasoning effort are not confirmed. Restore the draft to review its settings."); return; }
      const requestId = crypto.randomUUID();
      const connection = entry.connection;
      const timer = setTimeout(() => cancelPendingModel(tabId, entry), 10_000);
      pendingInitialModels.set(tabId, { requestId, prompt, timer, connection });
      try { connection.send({ type: "set_model", model: prompt.model, requestId }); }
      catch { cancelPendingModel(tabId, entry); }
      return;
    }
    const blocked = isSendBlockedByModelImages(imageInput, imageFallback, prompt.images?.length ?? 0);
    // Model selection may already have been staged to obtain its image verdict.
    // All remaining picks and the turn are committed only after that verdict passes.
    if (!blocked) {
      try { applyInitialPicks(entry, prompt.model, prompt.mode, prompt.effort, current, prompt.reasoningEffort, prompt.orchestrate); }
      catch { retain("Connection failed while applying settings. Restore the draft and review the current settings."); return; }
      if (!liveConnection(entry)) { retain("Connection closed while applying settings. Restore the draft and review the current settings."); return; }
    }
    dispatchInitialPrompt(entry, tabId, prompt.text, prompt.images ?? [], imageInput, imageFallback, prompt.orchestrate,
      { model: prompt.model, mode: prompt.mode, effort: prompt.effort, reasoningEffort: prompt.reasoningEffort }, stagedModel, prompt.requestId);
    clearPendingInitial(tabId);
  }

  /** (Re)connects `port` to an existing entry: tears down the old subscription, wires the new one, kicks off the handshake. */
  function attach(entry: TabEntry, tabId: string, port: MessagePort): void {
    cancelPendingModel(tabId, entry);
    if (entry.connection && entry.store.getState().queueInFlight) entry.store.getState().setPortClosed();
    entry.unsubscribeMessages?.();
    entry.unsubscribeExpiry?.();
    entry.unsubscribeExpiry = null;
    const connection = connectHost(port);
    entry.connection = connection;
    const onConnectionClosed = () => {
      unusableHostConnections.add(connection);
      closedHostConnections.add(connection);
      if (entry.connection !== connection) return;
      entry.store.getState().setPortClosed();
      cancelPendingModel(tabId, entry);
      const pending = pendingInitialPrompts.get(tabId);
      if (pending) { pendingInitialPrompts.delete(tabId); holdInitial(entry, pending, "Connection closed before the first turn. Restore the draft before sending."); }
    };
    if (typeof port.addEventListener === "function") port.addEventListener("close", onConnectionClosed, {once:true});
    else unusableHostConnections.add(connection);
    if (entry.isChild) {
      // The host-exit envelope and the UI port are independent channels. Keep
      // this small relation-only listener until expiry arrives or the port
      // closes, even if the child store has already been disposed.
      const unsubscribe = connection.subscribe((message) => {
        if (message.type === "approval_state" && message.unattended) {
          childRelationStore.getState().noteApprovalExpired(tabId);
          cleanup();
        }
      });
      const cleanup = (): void => {
        unsubscribe();
        port.removeEventListener("close", cleanup);
      };
      port.addEventListener("close", cleanup, { once: true });
      entry.unsubscribeExpiry = cleanup;
    }
    const cleanupExpiry = entry.unsubscribeExpiry;
    entry.unsubscribeExpiry = () => { cleanupExpiry?.(); port.removeEventListener?.("close", onConnectionClosed); };
    entry.unsubscribeMessages = connection.subscribe((message) => {
      if (entry.connection !== connection || closedHostConnections.has(connection)) return;
      // sessionId lands on host_ready but isn't part of the frozen DesktopState
      // shape (store.ts §3.3) — the registry is the natural place to lift it
      // into the tabs-store for the TabBar/picker, alongside forwarding the
      // message to the tab's own reducer.
      if (message.type === "host_ready") {
        tabsStore.getState().setSessionId(tabId, message.sessionId);
        tabsStore.getState().setWorkspaceIdentity(tabId, {
          workspace: message.workspace,
          ...(message.projectRoot !== undefined ? { projectRoot: message.projectRoot } : {}),
          ...(message.worktree !== undefined ? { worktree: message.worktree } : {}),
        });
      }
      // Phase 4 slice 4.4-T (design feature-session-titles.md §4): title lives
      // in the tabs-store (Sidebar reads it from there), not the per-tab
      // DesktopState — lift it here the same way host_ready's sessionId is.
      if (message.type === "title_changed") {
        // This pins automatic titles only; a future explicit user rename must win over the handle.
        tabsStore.getState().setTitle(tabId, agentTitles.get(tabId) ?? message.title);
      }
      // host_ready's own applyHostMessage case resets the transcript (store.ts
      // §3.3 respawn semantics) — dispatch AFTER that reset, or a queued
      // initial prompt appended before it would be wiped along with it (§4.2).
      entry.store.getState().applyHostMessage(message);
      if (message.type === "model_changed") {
        const pending = pendingInitialModels.get(tabId);
        if (pending && pending.connection === connection && message.requestId !== pending.requestId) {
          cancelPendingModel(tabId, entry);
        } else if (pending && pending.connection === connection && message.requestId === pending.requestId) {
          clearTimeout(pending.timer); pendingInitialModels.delete(tabId);
          if (message.model !== pending.prompt.model || (message.imageInput === undefined && message.imageFallback !== true)) holdInitial(entry, pending.prompt, `Image capability or requested model could not be confirmed. Host reports model ${message.model}; effective reasoning effort ${message.reasoningEffort}. Restore the draft to review its settings.`);
          else {
            const state = entry.store.getState();
            if (state.turn.status !== "idle" || state.queueInFlight !== null) holdInitial(entry, pending.prompt, `Session became busy. Host reports model ${message.model}; effective reasoning effort ${message.reasoningEffort}. Restore the draft to review its settings.`);
            else startInitial(entry, tabId, pending.prompt, { model: message.model, mode: state.mode, effort: state.engine?.model?.effort, reasoningEffort: state.reasoningEffort }, message.imageInput, message.imageFallback, { model: message.model, reasoningEffort: message.reasoningEffort });
          }
          if (!pendingInitialModels.has(tabId) && saveRecovery(tabId, entry.store.getState())) clearPendingInitial(tabId);
        }
      }
      // renderer-local provider-switch markers are restored at
      // their recorded history boundaries right after the hydrated history
      // lands (chronological insert, ids already present skipped) — same
      // renderer-only posture as the quota notices restored on host_ready.
      if (message.type === "session_history") {
        entry.store.getState().insertConnectionChangedAt(loadConnectionSwitches(message.sessionId));
      } else if (message.type === "presentation_snapshot") {
        const sessionId = entry.store.getState().sessionId;
        if (sessionId !== null) entry.store.getState().insertConnectionChangedAt(loadConnectionSwitches(sessionId));
      }
      if (message.type === "child_report") {
        // Acknowledge enqueue only after the renderer recovery state is saved.
        // This is not evidence that the model consumed the report.
        if (liveConnection(entry) === connection && saveRecovery(tabId, entry.store.getState())) connection.send({ type: "child_report_ack", id: message.id });
      }
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
          startInitial(entry, tabId, pending, { model: message.model, mode: message.mode, effort: message.engine?.model?.effort, reasoningEffort: message.reasoningEffort ?? "off" }, message.imageInput, message.imageFallback);
        }
      }
      if (message.type === "agent_event" && message.event.type === "error") {
        // The notice is parsed host-side and rides the wire event (W7b-FIX #2).
        const notice = message.event.notice;
        const sessionId = tabsStore.getState().tabs.find((tab) => tab.tabId === tabId)?.sessionId;
        if (notice !== undefined && sessionId !== null && sessionId !== undefined) {
          saveUsageLimitNotice(sessionId, notice);
        }
      }
    });
    tabsStore.getState().setHostExited(tabId, false);
    entry.store.getState().setAwaitingHostReady();
    connection.send({ type: "ui_ready", orchestrationProtocol: 1 });
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
    registerPort(tabId, workspace, port, pinnedConnection, child, openedByAgent, agentTitle): boolean {
      if (!tabId || closedTabIds.has(tabId)) {
        return false;
      }
      if (openedByAgent && agentTitle !== undefined) agentTitles.set(tabId, agentTitle);
      const kind = classifyPortEnvelope({ child });
      let entry = entries.get(tabId);
      if (!entry) {
        entry = {
          store: createStore(),
          connection: null,
          unsubscribeMessages: null,
          unsubscribeExpiry: null,
          terminal: null,
          unsubscribeTerminalMessages: null,
          unsubscribeStatus: null,
          unsubscribeQueue: null,
          unsubscribeRecovery: null,
          isChild: kind === "child",
          child: null,
        };
        entries.set(tabId, entry);
        const recovered = loadRecovery(tabId);
        if (recovered) entry.store.setState(recovered);
        const initial = loadPendingInitial(tabId) as InitialPrompt | null;
        if (!pendingInitialPrompts.has(tabId) && initial && typeof initial.text === "string") {
          if (!initial.requestId || !recovered?.orchestrationDeliveries.some(delivery => delivery.requestId === initial.requestId)) holdInitial(entry, initial, "The initial draft was restored after reload. Review it before sending.");
          if (saveRecovery(tabId, entry.store.getState())) clearPendingInitial(tabId);
        }
        entry.unsubscribeRecovery = entry.store.subscribe((state, previous) => {
          if (state.promptQueue !== previous.promptQueue || state.queueInFlight !== previous.queueInFlight || state.orchestrationDeliveries !== previous.orchestrationDeliveries || state.restoredComposerDraft !== previous.restoredComposerDraft || state.composerRolePicker !== previous.composerRolePicker || state.queuePaused !== previous.queuePaused || state.queuePauseReason !== previous.queuePauseReason) saveRecovery(tabId, state);
        });
        if (kind === "child") {
          // CUT-S2 §2.5/§5.3: a child session gets the SAME
          // store+connection+ui_ready mechanism (below/attach()) but never
          // the root-tab bootstrap — no Sidebar/StartScreen/CommandPalette
          // entry, no status-mirror, no prompt-queue-drainer (the child's
          // steer-queue is host-side, §1 п.1 of the cut, not this
          // renderer-side one). This is the discriminator against the
          // pre-S2 facade, where ANY delivered port took the branch below
          // unconditionally.
          //
          // §10.15.1: marks the store so the composer forces the direct-send
          // path for this tab instead of parking a steer message in the
          // (undrained, for a child) renderer prompt queue.
          entry.store.getState().setChildSurface();
        } else {
          // Enqueue is the submission boundary for queued user messages. Clear
          // before the synchronous drainer runs, and leave system reports alone.
          const store = entry.store;
          const enqueuePrompt = store.getState().enqueuePrompt;
          const enqueueRecoveryPrompt = store.getState().enqueueRecoveryPrompt;
          store.setState({
            enqueuePrompt(item) {
              if (item.origin === undefined) {
                const sessionId = store.getState().sessionId;
                if (sessionId) childRelationStore.getState().dismissFinishedApprovals(sessionId);
              }
              return enqueuePrompt(item);
            },
            enqueueRecoveryPrompt(sourceId,item) {
              const queued = enqueueRecoveryPrompt(sourceId,item);
              if (queued) { const sessionId = store.getState().sessionId; if (sessionId) childRelationStore.getState().dismissFinishedApprovals(sessionId); }
              return queued;
            },
          });
          tabsStore.getState().addTab({ tabId, workspace, ...(openedByAgent === true ? { openedByAgent: true as const } : {}) });
          if (agentTitles.has(tabId)) tabsStore.getState().setTitle(tabId, agentTitles.get(tabId)!);
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
          //
          // срез 2 (spec §4 point 2): `queuePaused` alone no longer
          // means "nothing to drain" — a detached child's SYSTEM-origin report
          // must still leave the queue while paused (takeQueueHead enforces
          // the actual per-kind eligibility; this is only the cheap pre-check
          // that decides whether it's even worth calling dispatch).
          const capturedEntry = entry;
          const maybeDrain = (state: DesktopState): void => {
            const hasDeliverableItem =
              !state.queuePaused || state.promptQueue.some((prompt) => prompt.origin === "system");
            if (
              state.connection === "ready" &&
              state.orchestration.posture !== "transitioning" && state.orchestration.posture !== "quarantined" &&
              !state.orchestrationDeliveries.some(item => ((item.orchestrate === "enable" && (item.status === "pending" || item.status === "unknown") && !item.reviewed) || ((item.orchestrate === "enable" || item.origin === "system") && item.status === "started" && !item.terminalReason))) &&
              state.turn.status === "idle" &&
              hasDeliverableItem &&
              state.queueInFlight === null &&
              state.promptQueue.length > 0
            ) {
              dispatchQueuedPrompt(capturedEntry, tabId);
            }
          };
          entry.unsubscribeQueue = entry.store.subscribe(maybeDrain);
        }
      }
      // W10-FIX F2: record the tab's pinned connection (stable for the tab's life;
      // re-delivered on every respawn, so re-applying it is a harmless no-op).
      if (pinnedConnection !== undefined) {
        entry.store.getState().setPinnedConnection(pinnedConnection);
      }
      if (child !== undefined) {
        // remembered on the entry itself so `listChildTabs()`
        // (the automation snapshot's child enumeration seam) can carry the
        // relation without a child-relation-store lookup.
        entry.child = child;
        // CUT-S2 §2.5: records (or re-records) the relation C3's
        // Open button and breadcrumb resolve through. Re-registering an
        // already-known (parent, spawn) pair resets `live` to true —
        // child-sessions.ts's own doc: a fresh port delivery only ever
        // happens for a running host.
        childRelationStore
          .getState()
          .registerChild(child.parentSessionId, child.spawnToolCallId, tabId, child.childSessionId);
      }
      attach(entry, tabId, port);
      return true;
    },

    markHostExited(tabId, missingWorkspacePath, failure): void {
      const entry = entries.get(tabId);
      if (!entry) {
        return;
      }
      cancelPendingModel(tabId, entry);
      const pending = pendingInitialPrompts.get(tabId);
      if (pending) { pendingInitialPrompts.delete(tabId); holdInitial(entry, pending, "Connection exited before the first turn. Restore the draft before sending."); }
      entry.unsubscribeMessages?.();
      entry.unsubscribeMessages = null;
      entry.connection = null;
      // GitHub #6: the path argument is the terminal missing-folder condition, and
      // only that one may hide the surface's connection lines (HostBanner).
      entry.store.getState().setHostExited(missingWorkspacePath !== undefined, failure);
      if (missingWorkspacePath !== undefined) {
        entry.store.getState().applyHostMessage({
          type: "fatal",
          message: `Workspace folder does not exist: ${missingWorkspacePath}. Close this tab and choose another folder.`,
        });
      }

      if (entry.isChild) {
        // CUT-S2 §0/§2.5: no root-tab banner to paint (a child was
        // never added to the tabs-store) — flip the relation instead, so
        // C3's Open/breadcrumb read `live: false` and fall back to the
        // read-only history channel (C4) instead of a dead port.
        childRelationStore.getState().markChildGone(tabId, entry.store.getState().unattended);
        // CUT-S2 §10.10.2 (R2, O4/F3-R): a terminated child host
        // never respawns (main's own reap-on-terminal verdict, §0), and a
        // child's own tabId can never reach `disposeTab` — main's `closeTab`
        // rejects any `childOf` tabId (`main/tabs.ts`, `unknown_tab`) — so
        // this is the only disposal point this entry will ever get. Leaving
        // it in `entries` would hold the child's whole store+transcript for
        // the rest of the renderer process's life; nothing reads it after
        // exit (C4 resolves "Open completed" through the durable
        // `childHistory` IPC channel, never this registry — only the LIVE
        // branch, gated on `relation.live`, ever calls `getStore` at all).
        // `closedTabIds.add` fail-closes against a late/duplicate port
        // delivery for this tabId: no legitimate one exists for a child.
        entries.delete(tabId);
        pendingInitialPrompts.delete(tabId);
        agentTitles.delete(tabId);
        closedTabIds.add(tabId);
      } else {
        tabsStore.getState().setHostExited(tabId, true);
      }

      // drop the dead term connection too and paint the banner. A later
      // registerTerminalPort (respawn) reattaches and, if the panel is still
      // open, resends term_open automatically. (A child tab never has a live
      // term connection to begin with — no PTY — so this is a harmless no-op
      // for it, same as `terminalView.markDead` below.)
      entry.unsubscribeTerminalMessages?.();
      entry.unsubscribeTerminalMessages = null;
      entry.terminal = null;
      terminalView.markDead(tabId, "host process exited");
    },

    disposeTab(tabId): void {
      useDockStore.getState().clearActivity(tabId);
      agentTitles.delete(tabId);
      closedTabIds.add(tabId);
      const entry = entries.get(tabId);
      if (!entry) {
        tabsStore.getState().removeTab(tabId);
        return;
      }
      entry.store.setState((state) => ({ pendingComposerImages: [], completedComposerImages: [], composerImageGeneration: state.composerImageGeneration + 1 }));
      const pendingModel = pendingInitialModels.get(tabId);
      if (pendingModel) { clearTimeout(pendingModel.timer); pendingInitialModels.delete(tabId); }
      entry.unsubscribeMessages?.();
      entry.unsubscribeExpiry?.();
      entry.unsubscribeTerminalMessages?.();
      entry.unsubscribeStatus?.();
      entry.unsubscribeQueue?.();
      entry.unsubscribeRecovery?.();
      clearRecovery(tabId);
      clearPendingInitial(tabId);
      entries.delete(tabId);
      pendingInitialPrompts.delete(tabId);
      // CUT-S2 §2.5 (review wave R, F11 fix): a child's own tabId
      // never reaches this point (main's `closeTab` rejects a `childOf`
      // tabId by construction — see `child-sessions.ts`'s own doc on
      // `removeRelationsForParentSession`), so `tabId` here is always a ROOT
      // tab's. Captured BEFORE `removeTab` deletes its tabs-store record —
      // that record is the only place this registry can still read the
      // closing root's sessionId (a child tab is never in tabsStore at all,
      // so this is a no-op read for one, same as the finally-unused branch
      // below). Once a root tab is gone, none of its children can ever be
      // Opened again, so every relation it owns is pruned right along with it
      // — otherwise child-sessions.ts's `relations` Map would keep every
      // relation of every closed root tab for the rest of the process's life.
      const parentSessionId = tabsStore.getState().tabs.find((tab) => tab.tabId === tabId)?.sessionId;
      if (parentSessionId !== null && parentSessionId !== undefined) {
        childRelationStore.getState().removeRelationsForParentSession(parentSessionId);
      }
      tabsStore.getState().removeTab(tabId);
      terminalView.dispose(tabId);
      statusStore.getState().remove(tabId);
    },

    sendToTab(tabId, message): void {
      const entry = entries.get(tabId);
      if (!entry?.connection || unusableHostConnections.has(entry.connection)) {
        console.warn("[tab-registry] dropping outgoing message, no active connection for tab", tabId, message);
        return;
      }
      // A newer model choice invalidates the staged initial request before the
      // choice reaches the host; a late acknowledgement must never dispatch it.
      if (message.type === "set_model") cancelPendingModel(tabId, entry);
      if (!entry.isChild && (message.type === "user_message" || message.type === "steer_message")) {
        const sessionId = entry.store.getState().sessionId;
        if (sessionId) childRelationStore.getState().dismissFinishedApprovals(sessionId);
      }
      entry.connection.send(message);
    },

    getLiveHostConnection(tabId, store): object | null {
      const entry = entries.get(tabId);
      return entry?.store === store && entry.connection !== null && !unusableHostConnections.has(entry.connection) && store.getState().connection === "ready" ? entry.connection : null;
    },

    getStore(tabId): DesktopStoreApi | undefined {
      return entries.get(tabId)?.store;
    },

    listChildTabs(): Array<{ tabId: string; child: NonNullable<PortEnvelope["child"]> }> {
      const children: Array<{ tabId: string; child: NonNullable<PortEnvelope["child"]> }> = [];
      for (const [tabId, entry] of entries) {
        if (entry.isChild && entry.child !== null) {
          children.push({ tabId, child: entry.child });
        }
      }
      return children;
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
      for (const pending of pendingInitialModels.values()) clearTimeout(pending.timer);
      pendingInitialModels.clear();
      for (const entry of entries.values()) {
        entry.store.setState((state) => ({ pendingComposerImages: [], completedComposerImages: [], composerImageGeneration: state.composerImageGeneration + 1 }));
        entry.unsubscribeRecovery?.();
      }
      entries.clear();
      closedTabIds.clear();
      agentTitles.clear();
      pendingInitialPrompts.clear();
      statusStore.getState().reset();
    },

    queueInitialPrompt(tabId, text, model, mode, effort, images, reasoningEffort, orchestrate): void {
      if (!tabId || closedTabIds.has(tabId)) {
        return;
      }
      const entry = entries.get(tabId);
      const requestId = crypto.randomUUID();
      if (entry && (entry.store.getState().connection === "host_exited" || (entry.connection && unusableHostConnections.has(entry.connection)))) {
        holdInitial(entry, {text,model,mode,effort,images,reasoningEffort,orchestrate}, "Connection unavailable. Restore the draft before sending.");
        return;
      }
      if (entry?.store.getState().connection === "ready") {
        const state = entry.store.getState();
        savePendingInitial(tabId, { requestId, text, model, mode, effort, images, reasoningEffort, orchestrate });
        startInitial(entry, tabId, { requestId, text, model, mode, effort, images, reasoningEffort, orchestrate },
          { model: state.model, mode: state.mode, effort: state.engine?.model?.effort, reasoningEffort: state.reasoningEffort }, state.imageInput, state.imageFallback);
        return;
      }
      const pending = { requestId, text, model, mode, effort, images, reasoningEffort, orchestrate };
      savePendingInitial(tabId, pending);
      pendingInitialPrompts.set(tabId, pending);
    },
  };
}

/** The app's single tab registry, bound to the singleton tabs-store (mirrors store.ts's per-tab `createDesktopStore` factory pattern). */
export const tabRegistry = createTabRegistry(useTabsStore);

import { modelSettingsTarget } from "../model-settings-target.js";
/**
 * ModelPill (design slice-P7.15-cut.md §2.2, F14) — the single footer pill
 * that replaces the old effort-`<select>` chip + display-only model `<span>`
 * (Composer.tsx, pre-P7.15). Clicking opens a popover with two root rows,
 * `Model` and `Effort` (the Effort row is hidden when the current model
 * isn't reasoning-capable — the same `availableEffortLevels !== undefined`
 * predicate that hid the old `<select>`), each drilling into an in-panel
 * "page": a flat list with a checkmark on the current value + a `‹ Back`
 * row. No Speed row (no provider in the catalog exposes a speed axis — §6
 * R3) and no "Reset to default" (§6 R4). Popover mechanics (outside-click,
 * Esc-to-close, roving focus) mirror `ModeMenu.tsx`; `nextRovingIndex` is
 * reused as-is rather than re-derived.
 *
 * Wire: picking a model sends `set_model`; picking an effort sends the
 * existing `set_reasoning_effort` (since TASK.37 `set_mode` accepts a mid-turn
 * change; since Taskana 4895 the CORE engine accepts `set_model` /
 * `set_reasoning_effort` mid-turn too — it queues them and applies them at the
 * next turn boundary, so the pill stays live while a turn runs and says
 * plainly that a pick applies from the next turn). A foreign engine keeps its
 * between-turns discipline. `modelPickDisabled` is the client-side mirror of
 * that availability (F15's `shouldEnqueue` for engines without a mid-turn
 * path, plus `!ready`), so the chip never offers a pick the host would reject.
 *
 * Persist (§2.4, the owner-pain half): a pick does NOT persist optimistically.
 * The component remembers the pending pick in a ref and only writes the
 * connection's model/effort (TASK.45 W10: a main-authoritative `connection-update`
 * IPC by the ACTIVE connection id, off the retired v1-patch `defaults[pid]` shim)
 * once the corresponding store field (`model` / `reasoningEffort`) actually lands
 * the picked value — i.e. once the host has ACKed it via `model_changed` /
 * `reasoning_effort_changed` (store.ts already turns those into the plain field
 * updates this component watches). A busy-rejected pick, a resume's `host_ready`,
 * or an unrelated field update can never match a stale/absent pending pick, so
 * none of them ever persists — closing the clobber race the design calls out. The
 * pending record captures its target connection id at PICK time (not recomputed
 * from the settings snapshot at ACK time — the active connection can change in
 * between), and every ack-triggered write is chained through `chainWrite` so fast
 * back-to-back picks persist in ack order rather than write-completion order.
 *
 * TASK.106 cut-2 (§D4, DoD 6): the popover's own root/model/effort pages are
 * gone — the chip now renders the SHARED drill-down (`ModelDrillMenu`, the same
 * component the New Session screen renders), whose rows span EVERY connected
 * connection rather than this tab's alone. Picking a model from the tab's own
 * connection is still the `set_model` path above, byte-for-byte; picking one
 * from another connection is a REBIND (§D1/§D6): the target connection is
 * written first (model + the effort §D3 resolves), then `tab-rebind` shuts the
 * host down and respawns it on the resume path. The switch is named in the
 * transcript once the new host is up (§D5) and a refusal is named in a toast —
 * nothing about it is silent.
 */
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ReasoningEffort } from "@anycode/core";
import type { CatalogSummary, ConnectionUpdateRequest, CustomProviderRecord } from "../../../shared/settings.js";
import { activeProviderView, connectionById, mergeModelIds } from "../../../shared/settings.js";
import type { SessionSummary } from "../../../shared/tabs.js";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { useSettingsStore } from "../settings-store.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import type { DesktopState, TurnState } from "../store.js";
// Reuse, not re-derive (design §2.1): the exact F15 guard predicate that
// decides enqueue-vs-direct-send in Composer's own handleSend also decides
// whether a pick is safe to offer here. Composer.tsx mounts <ModelPill/>, so
// this is a two-file cycle — safe because `shouldEnqueue` is a hoisted
// function declaration only ever invoked from event handlers (long after
// both modules have finished evaluating), never at module top-level.
import { shouldEnqueue } from "./Composer.js";
import { Chevron } from "./icons.js";
import { nextRovingIndex } from "./ModeMenu.js";
// GitHub #33: the same controlled confirm dialog the git/session flows use —
// the running-children gate on a cross-connection pick is a question, and this
// component only ever renders it (the caller owns the pending state).
import { ConfirmDialog } from "./ConfirmDialog.js";
// TASK.106 cut-2 §D4: the shared drill-down (markup) over the shared decision
// layers (rows + verbs). None of it is re-derived here — this file only wires
// the running tab's own axes (its pin, its live model/effort) into them.
import { connectionDisplayName } from "./ConnectionTile.js";
import { ModelDrillMenu } from "./model-drill-menu.js";
import {
  buildSessionDrillRows,
  isForeignPick,
  pickSessionDrillRow,
  type ModelDrillPage,
  type ModelDrillRow,
} from "./model-drill-rows.js";
import { deriveRecentModelIds, startModelMenuMaxHeightPx } from "./start-model-picker.js";
// P7.23/F24 W2 seam (cut §2 row 3): byte-for-byte mirror of ModeMenu's own
// FOCUS_MODE_MENU_EVENT listener below — the slash menu's "Model" row
// summons this popover the same way ⇧⌘M summons ModeMenu's.
import { FOCUS_MODEL_PILL_EVENT, openSettingsAddConnection } from "../slash-menu.js";
// Reuse, not re-derive: the same fixed-position viewport-clamp Sidebar's
// project-menu popover uses to escape an ancestor `overflow:hidden` (design

// (`.composer-footer-left` gained `overflow:hidden` in the P7.13 narrow-width
// containment fix, which clips ANY absolutely-positioned popover inside it,
// upward or downward, regardless of which descendant establishes its
// containing block). `position:fixed` is the only escape (its containing
// block is the viewport, not `.composer-footer-left`), so the popover's
// coordinates must be computed from the chip's real screen position rather
// than expressed via a static CSS `bottom: 100%` (ModeMenu.tsx's own popover
// hit the identical clip and was fixed with this same pattern).
import { clampMenuLeft } from "./Sidebar.js";

/**
 * Human-readable labels for the reasoning-effort selector (moved here from
 * Composer.tsx in P7.15 — nothing else imported the old Composer-local
 * const, so there is nothing left to re-export from there).
 */
export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "No thinking",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Nominal popover width (px) used only for right-edge clamping before the popover measures itself — mirrors Sidebar's `PROJECT_MENU_WIDTH` (matches `.model-pill-popover`'s CSS `min-width: 15rem` at the standard 16px root). */
const MODEL_PILL_POPOVER_WIDTH = 240;

/**
 * The gap (px) the popover keeps from its chip — `--sp-2`'s base value,
 * hardcoded the same way the fixed-position anchor below already hardcodes it
 * (Sidebar's own popover sets the precedent) rather than read from CSS at
 * runtime.
 */
export const MODEL_PILL_MENU_GAP_PX = 8;

/**
 * TASK.106 cut-2 §D4 (DoD 5): how tall the drill-down may grow over a RUNNING
 * session's chip.
 *
 * That chip lives at the bottom of the composer, so unlike the start screen's
 * the popover never has a side to choose: it always hangs UP, and the room it
 * has is everything between the window's top edge and the chip, less the gap it
 * keeps from the chip and the margin it keeps from the edge. That is exactly
 * `startModelMenuMaxHeightPx`'s flipped branch (whose viewport argument is
 * unused there, hence the 0), reused rather than re-derived — including its
 * one-row floor. A MAX, never a height: a level shorter than the room renders
 * at its natural size with no scrollbar. Exported for unit testing.
 */
export function modelPillMenuMaxHeightPx(chipTopPx: number): number {
  return startModelMenuMaxHeightPx(0, { top: chipTopPx, bottom: chipTopPx }, true, MODEL_PILL_MENU_GAP_PX);
}

/**
 * Narrows a catalog effort level to the wire's `ReasoningEffort`, or
 * `undefined` for a level the protocol does not carry. The picker's pure layer
 * types levels as plain strings (a catalog model may declare any vocabulary),
 * while `set_reasoning_effort` and `ProviderConnection.reasoningEffort` take
 * the closed union — this is the one place the two meet, and it fails closed
 * (an unknown level is neither sent nor persisted). Exported for unit testing.
 */
export function asReasoningEffort(level: string): ReasoningEffort | undefined {
  return level in EFFORT_LABELS ? (level as ReasoningEffort) : undefined;
}

/**
 * TASK.106 cut-2 §D5: whether the tab's pin just MOVED — the trigger for the
 * transcript's provider-switch line.
 *
 * Only a transition between two known connections counts. The first pin a tab
 * ever receives (`prev === null` — port attach on a fresh tab) is not a switch,
 * and neither is a pin disappearing; and a re-delivered identical pin (every
 * respawn re-sends it, W10-FIX F2) is the documented no-op it has always been.
 * Exported for unit testing.
 */
export function shouldMarkConnectionChange(
  prev: { connectionId: string } | null,
  next: { connectionId: string } | null,
): boolean {
  return prev !== null && next !== null && prev.connectionId !== next.connectionId;
}

/**
 * TASK.153: whether a pin change seen by the pill is a switch IN THIS TAB.
 * Switching tabs is a pure re-render (tab-context.tsx), so the same pill
 * instance sees tab A's pin replaced by tab B's — two different tabs, not a
 * switch; reporting it wrote a false "Provider switched" line into B. Only a
 * pin that moved while the pill stayed on the same tab is a switch.
 * Exported for unit testing.
 */
export function isPinSwitchInTab(
  prev: { tabId: string | undefined; pin: { connectionId: string } | null },
  tabId: string | undefined,
  next: { connectionId: string } | null,
): boolean {
  return prev.tabId === tabId && shouldMarkConnectionChange(prev.pin, next);
}

interface PendingPick {
  kind: "model" | "effort";
  value: string;
  requestId: string;
  // The connection id this pick was made against, captured at PICK time (codex
  // P2 defect: recomputing it from the settings snapshot again at ACK time is
  // wrong — the active connection can change in Settings between the send and
  // the ack, so the ack must persist to the connection it was actually picked
  // for, never whatever is current now). Undefined = no active connection at
  // pick time (env-override / fresh) — the pick still sends to the host, but
  // there is nothing to persist against, so the ack skips the write.
  connectionId?: string;
}

/**
 * `settings.provider.id ?? "custom"` — the per-provider defaults key (design
 * §2.4), mirroring `main/host-env.ts`'s `buildHostEnv` resolution exactly.
 * Exported for unit testing.
 */
export function resolvePid(providerId: string | undefined): string {
  return providerId ?? "custom";
}

/**
 * Resolves the ModelPill's provider catalog + write-target for a tab (TASK.45
 * W10-FIX F2): a PINNED tab follows its pin's providerId (catalog) and
 * connectionId (write-target); an unpinned/legacy tab falls back to the ACTIVE
 * connection (the prior behaviour). Both axes move together — the catalog the pill
 * offers and the connection its pick persists to are always the SAME connection,
 * so a default-switch never retargets a pinned session's model/effort writes.
 * Exported for unit testing.
 */
export function resolvePillTarget(
  pinnedConnection: { connectionId: string; providerId: string } | null | undefined,
  activeProviderId: string | undefined,
  activeConnectionId: string | undefined,
): { providerId: string | undefined; writeTargetConnectionId: string | undefined } {
  return {
    providerId: pinnedConnection?.providerId ?? activeProviderId,
    writeTargetConnectionId: pinnedConnection?.connectionId ?? activeConnectionId,
  };
}

/**
 * Catalog display name for a model id: the catalog entry's `name` when the
 * id matches one of the provider's models, else the raw id (a free-text /
 * env-boot model with no catalog entry falls back to itself). Exported for
 * unit testing.
 */
export function modelDisplayName(
  modelId: string,
  models: readonly { id: string; name?: string }[] | undefined,
): string {
  const match = models?.find((m) => m.id === modelId);
  return match?.name ?? modelId;
}

/**
 * Pill label (design §2.2): display name, plus ` · <EffortLabel>` when the
 * model is reasoning-capable (`availableEffortLevels !== undefined` — the
 * same predicate that hid the old effort `<select>`), INCLUDING "No
 * thinking" — the owner-pain was the invisibility of that state, not its
 * value. A non-reasoning model shows only its name. Exported for unit
 * testing.
 */
export function pillLabel(
  displayName: string,
  reasoningEffort: ReasoningEffort,
  availableEffortLevels: readonly ReasoningEffort[] | undefined,
): string {
  return availableEffortLevels === undefined ? displayName : `${displayName} · ${EFFORT_LABELS[reasoningEffort]}`;
}

/**
 * The chip's own display label (Taskana 4237): an empty/whitespace model id
 * shows the "No model" placeholder with NO effort suffix — there is no model
 * to qualify, so appending ` · <effort>` there would be misleading. Every
 * real (non-blank) model keeps the pre-existing `modelDisplayName` /
 * `pillLabel` composition byte-for-byte. Exported for unit testing.
 */
export function pillDisplayLabel(
  model: string,
  catalogModels: readonly { id: string; name?: string }[] | undefined,
  reasoningEffort: ReasoningEffort,
  availableEffortLevels: readonly ReasoningEffort[] | undefined,
): string {
  if (model.trim() === "") {
    return "No model";
  }
  return pillLabel(modelDisplayName(model, catalogModels), reasoningEffort, availableEffortLevels);
}

/**
 * Resolves the model list a provider offers its pickers (F2, codex-profiles
 * cut lane FXH review; union semantics from TASK.183). Base hints come from a
 * builtin catalog hit; failing that, the `custom:<slug>` record's own curated
 * `models[]` (cut §9.2 — the user-picked subset a custom endpoint's fetch
 * surfaced); anything else (unknown id, or `providerId` itself `undefined` —
 * the legacy free-text config with no provider selected at all) yields
 * `undefined`, exactly like today's plain `catalog.find(...)?.models`.
 *
 * `connectionModels` — the target connection's OWN ids (`ProviderConnection.
 * models`: manual additions plus connection-scoped fetched ids, TASK.183) —
 * when non-empty is unioned with the base hints, connection ids FIRST and the
 * catalog/curated hints after (stable primary-first, deduped by exact id via
 * the shared `mergeModelIds`). The base hints only DECORATE matching ids with
 * display names — a connection id with no catalog hint still appears (as a
 * bare `{id}`), and a custom record's fallback is included even when no
 * synthesized catalog entry exists. Absent/empty `connectionModels` keeps
 * every pre-fetch behavior byte-identical. Exported for unit testing.
 */
export function providerModelsFor(
  providerId: string | undefined,
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
  connectionModels?: readonly string[],
): readonly { id: string; name?: string }[] | undefined {
  const catalogHit = catalog?.find((entry) => entry.id === providerId)?.models;
  const customHit = custom?.find((entry) => entry.id === providerId);
  const baseHints: readonly { id: string; name?: string }[] | undefined =
    catalogHit ?? (customHit !== undefined ? customHit.models.map((id) => ({ id })) : undefined);
  if (connectionModels !== undefined && connectionModels.length > 0) {
    const union = mergeModelIds(
      connectionModels,
      (baseHints ?? []).map((hint) => hint.id),
    );
    return union.map((id) => {
      const hint = baseHints?.find((m) => m.id === id);
      return hint?.name !== undefined ? { id, name: hint.name } : { id };
    });
  }
  if (catalogHit !== undefined) {
    return catalogHit;
  }
  if (customHit !== undefined) {
    return customHit.models.map((id) => ({ id }));
  }
  return undefined;
}

/**
 * The Model page's flat list (design §2.2): the provider's offered models
 * (a union of the connection's own ids and the catalog/curated hints, see
 * `providerModelsFor`), plus the currently active model appended if it isn't
 * already among them (a free-text/env-boot model, or an empty catalog for a
 * custom provider — the list then holds just that one current entry).
 * Exported for unit testing.
 */
export function modelMenuItems(
  currentModel: string,
  catalogModels: readonly { id: string; name?: string }[] | undefined,
): { id: string; name: string }[] {
  const items = (catalogModels ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
  if (!items.some((m) => m.id === currentModel)) {
    items.push({ id: currentModel, name: currentModel });
  }
  return items;
}

/**
 * Client-side mirror of the host's model/effort availability guard.
 *
 * Taskana 4895: the CORE engine accepts a `set_model` / `set_reasoning_effort`
 * mid-turn and applies it at the next turn boundary (host/session.ts's
 * `applyPendingModelSelection`), so a running turn no longer disables the pill
 * there — `midTurnChangeSupported` is the caller's engine fact (the tab store's
 * `engine === null`, i.e. core). A foreign engine (codex/claude) keeps its own
 * between-turns discipline, and `engineControlDisabled` is still its gate.
 *
 * `ready` stays absolute: without a live host there is nothing to send to.
 * `shouldEnqueue` (the F15 predicate: a running turn OR the queue in-flight
 * window both count as busy) still decides for an engine that cannot take a
 * mid-turn change. Exported for unit testing.
 */
export function modelPickDisabled(
  turnStatus: TurnState["status"],
  queueInFlight: DesktopState["queueInFlight"],
  ready: boolean,
  midTurnChangeSupported = false,
): boolean {
  if (!ready) {
    return true;
  }
  return midTurnChangeSupported ? false : shouldEnqueue(turnStatus, queueInFlight);
}

/**
 * Ack-gating decision (design §2.4): true only when there IS a pending pick
 * of exactly this `kind` whose value matches what the host just echoed back
 * into the store. A `host_ready` boot value, a busy-rejected pick (no field
 * ever changes, so nothing here fires), or an ack of the OTHER kind never
 * matches — none of them ever persists. Exported for unit testing.
 */
export function shouldPersistOnAck(
  pending: Pick<PendingPick, "kind" | "value"> | null,
  kind: PendingPick["kind"],
  ackValue: string,
): boolean {
  return pending !== null && pending.kind === kind && pending.value === ackValue;
}

/**
 * Persist only the user's choice after its ack. A model pick changes the
 * default model; its incidental effective effort is never a user selection.
 * An effort pick names the tab's model without retargeting the default, which
 * may already have changed in another tab.
 */
export function buildConnectionUpdate(
  connectionId: string,
  isModelPick: boolean,
  model: string,
  reasoningEffort: ReasoningEffort,
): ConnectionUpdateRequest {
  return {
    id: connectionId,
    ...(isModelPick ? { model } : { modelOverrideModel: model, reasoningEffort }),
  };
}

/**
 * Serializes persist writes onto a running chain (codex P2 defect: two quick
 * picks each fire an unawaited `setPatch` against main's unlocked
 * load/merge/save settings store; without ordering, a slower earlier write
 * can land after a faster later one and leave `defaults[pid]` on the older
 * value). Chaining each write off the previous one guarantees writes run —
 * and settle — in ack order, so the last ack's value is always the final
 * persisted one. Fail-soft: a rejected write is swallowed here so it can
 * never wedge the chain for the writes queued after it. Exported for unit
 * testing.
 */
export function chainWrite(chain: Promise<unknown>, write: () => Promise<unknown>): Promise<unknown> {
  return chain.then(write).catch(() => {
    // Intentionally swallowed: a failed persist must not block subsequent
    // queued writes (fail-soft), and there is no UI surface for this error.
  });
}

/**
 * Taskana 4895: what the chip says while a turn is running — a core model or
 * effort pick is accepted right away but only takes effect at the next turn
 * boundary (the host queues it; see host/session.ts's
 * `applyPendingModelSelection`). Exported so the copy is unit-testable and the
 * menu note and the chip title can never drift apart.
 */
export const MID_TURN_CHANGE_NOTE = "Model and effort changes apply from the next turn";

export function modelSettingsPick(
  kind: "model" | "effort", value: string,
  hostId: string | null | undefined, pinnedId: string | undefined, activeId: string | undefined, requestId: string,
): PendingPick {
  return { kind, value, requestId, connectionId: modelSettingsTarget(hostId, pinnedId, activeId) };
}

export function modelSettingsWrites(
  pending: { model?: PendingPick; effort?: PendingPick },
  ack: { model: string; effort: ReasoningEffort; requestId?: string; effortRequestId?: string; kind: "model" | "effort" },
): ConnectionUpdateRequest[] {
  const modelPick = ack.kind === "model" && ack.requestId !== undefined && pending.model?.requestId === ack.requestId ? pending.model : undefined;
  const effortId = ack.kind === "effort" ? ack.requestId : ack.effortRequestId;
  const effortPick = effortId !== undefined && pending.effort?.requestId === effortId ? pending.effort : undefined;
  if (modelPick !== undefined) delete pending.model;
  if (effortPick !== undefined) delete pending.effort;
  const writes = new Map<string, ConnectionUpdateRequest>();
  if (modelPick?.connectionId !== undefined) writes.set(modelPick.connectionId, { id: modelPick.connectionId, model: ack.model });
  if (effortPick?.connectionId !== undefined) writes.set(effortPick.connectionId, {
    ...writes.get(effortPick.connectionId), id: effortPick.connectionId,
    modelOverrideModel: ack.model, reasoningEffort: ack.effort,
  });
  return [...writes.values()];
}

/**
 * Turns a main-side rebind refusal into the sentence the toast shows.
 * Exported for unit testing: every refusal must read as a reason, not as a
 * code name (a silent or cryptic refusal reads as a switch that happened).
 */
export function rebindRefusalText(reason: string): string {
  switch (reason) {
    case "spawn_failed":
      return "host failed to start";
    case "children_running":
      return "subagents are running in this session";
    default:
      return reason;
  }
}

export function ModelPill() {
  const sendToHost = useTabSend();
  const storeApi = useTabStoreApi();
  // The tab this pill belongs to — the context's own id, NOT the tabs-store's
  // `activeTabId`: a child surface (TASK.102) mounts its own composer under its
  // own provider, and a rebind must address the tab it was picked in.
  const tabId = useContext(TabContext)?.tabId;
  const model = useTabStore((state) => state.model);
  const reasoningEffort = useTabStore((state) => state.reasoningEffort);
  const modelSelectionAck = useTabStore((state) => state.modelSelectionAck);
  const effortSelectionAck = useTabStore((state) => state.effortSelectionAck);
  const availableEffortLevels = useTabStore((state) => state.availableEffortLevels);
  const turnStatus = useTabStore((state) => state.turn.status);
  const queueInFlight = useTabStore((state) => state.queueInFlight);
  const connection = useTabStore((state) => state.connection);
  const pinnedConnection = useTabStore((state) => state.pinnedConnection);
  const modelSettingsConnectionId = useTabStore((state) => state.modelSettingsConnectionId);
  const ready = connection === "ready";
  // Taskana 4895: the tab store's engine projection is `null` ONLY for the core
  // engine (`host_ready` carries no `engine` block for core). Core accepts a
  // mid-turn model/effort pick and applies it at the next turn boundary, so the
  // pill stays live while a turn runs. A foreign engine (codex/claude) keeps its
  // between-turns rules untouched — in practice its own `EngineModelMenu` is the
  // picker there, and `engineControlDisabled` its gate.
  const enginePresentation = useTabStore((state) => state.engine);
  const midTurnChange = enginePresentation === null;
  // "The host is busy right now" — the exact axis a mid-turn pick rides over.
  // The note below is honest only while this is true.
  const turnInProgress = shouldEnqueue(turnStatus, queueInFlight);
  const idle = !turnInProgress;

  const snapshot = useSettingsStore((state) => state.snapshot);
  const connectionUpdate = useSettingsStore((state) => state.connectionUpdate);

  // TASK.45 W10-FIX F2: both the model catalog AND the write-target follow this
  // tab's PINNED connection (delivered on the tab-port envelope, control plane —
  // NOT the session wire), falling back to the ACTIVE connection for an
  // unpinned/legacy tab (the prior behaviour, preserved). This closes the F2
  // defect where a pinned session offered the active provider's catalog to its
  // pinned host and persisted the pick into the WRONG (active) connection after a
  // default-switch. Undefined write-target = no connection configured (env-override
  // / fresh) — the pick still reaches the host, but the ack skips the persist.
  const activeProviderId = snapshot ? activeProviderView(snapshot.settings).id : undefined;
  const writeTargetConnectionId = modelSettingsTarget(
    modelSettingsConnectionId, pinnedConnection?.connectionId,
    modelSettingsConnectionId === undefined ? snapshot?.settings.provider.activeConnectionId : undefined,
  );
  const providerId = snapshot?.settings.provider.connections.find(
    (connection) => connection.id === writeTargetConnectionId,
  )?.providerId ?? (modelSettingsConnectionId === undefined ? pinnedConnection?.providerId ?? activeProviderId : undefined);
  // Live-fetched ids on the TARGET connection (same pinned-else-active target
  // as the write path above) take precedence over static catalog hints.
  const targetConnection =
    snapshot && writeTargetConnectionId !== undefined
      ? connectionById(snapshot.settings, writeTargetConnectionId)
      : undefined;
  const catalogModels = providerModelsFor(
    providerId,
    snapshot?.catalog,
    snapshot?.settings.provider.custom,
    targetConnection?.models,
  );

  const [open, setOpen] = useState(false);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // composer dropdown is up.
  useOverlayFlag(open);
  // TASK.106 cut-2 §D4: which LEVEL of the shared drill-down is on screen
  // (root → a connection's models → the effort vocabulary), replacing the
  // pill's own root/model/effort pages.
  const [drillPage, setDrillPage] = useState<ModelDrillPage>({ kind: "root" });
  const [focusIndex, setFocusIndex] = useState(0);
  // Measured once per open (see the anchor effect): the room the popover may
  // grow into. `flipUp` is always false — the wrapper below is already placed
  // ABOVE the chip by its own fixed coordinates, so the menu inside it must not
  // re-anchor itself a second time.
  const [placement, setPlacement] = useState<{ flipUp: boolean; maxHeightPx: number } | null>(null);
  // Recent sessions, for the root level's popular picks (TASK.131 D6:
  // popularity is measured from the user's OWN history). One fetch per mount,
  // fail-soft — an empty list just means the strip is topped up from the first
  // group's catalog order, exactly as it is for a user with no history.
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  // Fixed-position anchor for the popover (viewport `left`/`bottom` px),
  // computed from the chip's real screen position on open — null before the
  // first open (or once closed; a stale value is harmless since the popover
  // unmounts with `open`). Needed because the popover escapes
  // `.composer-footer-left`'s `overflow:hidden` via `position:fixed`, whose
  // containing block is the viewport rather than `.model-pill` — a plain
  // `bottom:100%` (ModeMenu's approach) stays clipped there. See the
  // `clampMenuLeft` import comment above.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // GitHub #33: a cross-connection pick whose rebind would cancel RUNNING
  // children is not committed — it parks here as an explicit choice. Nothing
  // has been written when this is set (main's gate runs before its model
  // write), so declining leaves the session and the target connection exactly
  // as they were. `tabId` is the ORIGIN: the consent answers a question about
  // that tab's children and must never be spent on another one.
  const [childCancelPending, setChildCancelPending] = useState<{
    tabId: string;
    connectionId: string;
    modelId: string;
    runningChildren: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Model and effort picks are independent until their acknowledgements arrive.
  const pendingPickRef = useRef<{model?: PendingPick; effort?: PendingPick}>({});
  // Serializes the ack-triggered persist writes below (codex P2 defect fix):
  // guarantees writes run in ack order even though `setPatch` itself is an
  // unawaited, unlocked load/merge/save.
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // The pin this component last reported in the transcript (§D5). Seeded with
  // the pin the tab already had, so a mount is never mistaken for a switch.
  // Tagged with its tab (TASK.153): a pin inherited from another tab is a
  // new baseline, never a switch.
  const lastPinRef = useRef<{ tabId: string | undefined; pin: { connectionId: string; providerId: string } | null }>({
    tabId,
    pin: pinnedConnection,
  });
  // The tab the per-pick slots below were filled in (TASK.153): a pending pick
  // or effort reset belongs to the tab it was made in and is dropped, not
  // replayed into the next tab, when the pill is re-rendered for another tab.
  const slotsTabRef = useRef<string | undefined>(tabId);
  // GitHub #33: the tab this pill represents RIGHT NOW. An in-flight question
  // resumes with the closure of the render that started it, so the live id has
  // to come from a ref — otherwise consent given for one tab's children could
  // be applied to another tab whose tree reused this component.
  const liveTabRef = useRef<string | undefined>(tabId);
  liveTabRef.current = tabId;
  if (slotsTabRef.current !== tabId) {
    slotsTabRef.current = tabId;
    pendingPickRef.current = {};
  }
  // Carries the effort reset a rebind decided (§D3) from the pick to the ledger
  // line the pin-watching effect writes once the new host is up; cleared as
  // soon as it is spent or the rebind fails.
  const effortResetRef = useRef<string | undefined>(undefined);

  const pickDisabled = modelPickDisabled(turnStatus, queueInFlight, ready, midTurnChange);

  // GitHub #33: a pending "these subagents will be cancelled" question belongs
  // to the tab it was asked in. The active tab's tree is reused when the user
  // switches tabs, so the question is dropped with the tab rather than left
  // for another one to answer — an answer here would be consent for children
  // the user is no longer looking at.
  useEffect(() => {
    setChildCancelPending(null);
  }, [tabId]);

  // TASK.106 cut-2 §D4: the drill-down's rows for THIS tab — groups over every
  // connected connection, the tab's own pin first with its live model
  // checkmarked, popular picks from the user's recent sessions, and the effort
  // level of the current pair. All of it decided by the shared pure layer.
  const drill = buildSessionDrillRows({
    connections: snapshot?.settings.provider.connections ?? [],
    catalog: snapshot?.catalog,
    custom: snapshot?.settings.provider.custom,
    currentConnectionId: writeTargetConnectionId,
    currentModelId: model ?? "",
    recentModelIds: deriveRecentModelIds(sessions),
    page: drillPage,
    currentEffort: reasoningEffort,
    availableEffortLevels,
  });
  const openGroup =
    drillPage.kind === "group"
      ? drill.groups.find((group) => group.connectionId === drillPage.connectionId)
      : undefined;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setDrillPage({ kind: "root" });
    if (returnFocus) {
      chipRef.current?.focus();
    }
  }, []);

  /**
   * A connection's display name — `connectionDisplayName`'s auto-naming, the
   * SAME label Settings, Welcome and the picker's own group rows show. Falls
   * back to the raw id for a connection the snapshot no longer carries (a
   * switch away from a connection deleted in the meantime).
   */
  function connectionLabel(connectionId: string): string {
    const connections = snapshot?.settings.provider.connections ?? [];
    const hit = connections.find((connection) => connection.id === connectionId);
    if (hit === undefined) {
      return connectionId;
    }
    const catalogName = snapshot?.catalog?.find((entry) => entry.id === hit.providerId)?.name ?? "Custom";
    return connectionDisplayName(hit, catalogName, connections);
  }

  // Compute the fixed-position anchor once, at the moment the popover opens
  // (mirrors Sidebar's `openProjectMenu`, just keyed off `open` instead of a
  // click handler since the chip toggles via click AND arrow keys). `bottom`
  // is measured from the viewport's bottom edge up to the chip's top edge
  // (design §the popover opens ABOVE the chip, ModeMenu's convention) plus an
  // 8px gap matching `--sp-2`'s base value — Sidebar's own popover hardcodes
  // its gap the same way (`rect.bottom + 4`) rather than reading the CSS
  // variable at runtime. `left` is clamped so a 15rem-wide popover never
  // overflows either viewport edge (same clamp Sidebar's project-menu uses).
  useEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setAnchor({
      left: clampMenuLeft(rect.left, MODEL_PILL_POPOVER_WIDTH, window.innerWidth),
      bottom: window.innerHeight - rect.top + MODEL_PILL_MENU_GAP_PX,
    });
    // TASK.106 cut-2 §D4 (DoD 5): the popover already hangs above the chip by
    // construction (the `bottom` anchor above), so there is no side to choose —
    // only a ceiling to respect, measured from the room above the chip. `max`,
    // not `height`: a short level renders with no scrollbar at all.
    setPlacement({ flipUp: false, maxHeightPx: modelPillMenuMaxHeightPx(rect.top) });
  }, [open]);

  // Outside mousedown closes (mirrors ModeMenu's listener).
  useEffect(() => {
    if (!open) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setDrillPage({ kind: "root" });
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // If picks become disabled (a turn starts, the queue drains into its
  // in-flight window, or the connection drops) while the popover is open,
  // close it — it must not float over a now-inert chip (mirrors ModeMenu).
  useEffect(() => {
    if (pickDisabled) {
      setOpen(false);
      setDrillPage({ kind: "root" });
    }
  }, [pickDisabled]);

  // P7.23/F24 W2 seam: summon semantics — focus the chip and open, mirroring
  // ModeMenu's FOCUS_MODE_MENU_EVENT listener exactly (ModeMenu.tsx:138-148).
  // A pick-disabled chip ignores the request, same silent no-op as a
  // disabled chip's own click/focus. Re-subscribes on pickDisabled flips.
  useEffect(() => {
    function onFocusRequest(): void {
      if (pickDisabled) {
        return;
      }
      chipRef.current?.focus();
      setOpen(true);
    }
    window.addEventListener(FOCUS_MODEL_PILL_EVENT, onFocusRequest);
    return () => window.removeEventListener(FOCUS_MODEL_PILL_EVENT, onFocusRequest);
  }, [pickDisabled]);

  // One-shot recent-session fetch for the root level's popular picks (the same
  // call, and the same fail-soft posture, StartScreen's own popover uses).
  useEffect(() => {
    let cancelled = false;
    window.anycode
      .listSessions()
      .then((list) => {
        if (!cancelled) {
          setSessions(list);
        }
      })
      .catch((error: unknown) => {
        console.warn("[ModelPill] listSessions failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed the popover whenever it opens: the level is reset to the root (a level
  // left open last time must not leak into this open) and focus lands on the
  // quick pick for the model in use when the root offers one, else the first row.
  useEffect(() => {
    if (!open) {
      return;
    }
    setDrillPage({ kind: "root" });
    setFocusIndex(Math.max(0, drill.popular.findIndex((row) => row.current)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on an
    // open transition (mirrors StartScreen's own seeding effect and ModeMenu's
    // narrow deps); recomputing on every store tick would fight the user's
    // roving-arrow input.
  }, [open]);

  // Move DOM focus to the roving item whenever the index changes while open.
  useEffect(() => {
    if (open) {
      itemRefs.current[focusIndex]?.focus();
    }
  }, [open, focusIndex, drillPage]);

  // TASK.106 cut-2 §D5: the transcript's provider-switch line.
  //
  // A rebind delivers the new port with the NEW pin already recorded and the
  // tab parked in `awaiting_host_ready`; the respawned host's `host_ready` then
  // runs `performReset`, which wipes the transcript. So the line is written on
  // the `ready` edge — the ref deliberately keeps the PREVIOUS pin until then,
  // and a pin that moves while the tab is not ready is reported once it is,
  // never lost and never written into a transcript about to be cleared.
  //
  // Taskana 4234: the write also passes the tab's sessionId from the
  // tabs-store so the store can stage the marker renderer-locally until the
  // respawned host's `session_history` boundary, and persist it there — the
  // marker never enters host/model history.
  const markerSessionId = useTabsStore((state) => state.tabs.find((tab) => tab.tabId === tabId)?.sessionId ?? null);
  useEffect(() => {
    if (!ready) {
      return;
    }
    const prevEntry = lastPinRef.current;
    const prev = prevEntry.pin;
    const next = pinnedConnection;
    lastPinRef.current = { tabId, pin: next };
    if (prevEntry.tabId !== tabId) {
      effortResetRef.current = undefined;
      return;
    }
    // The two null checks are the ones `shouldMarkConnectionChange` itself
    // makes, spelled out here so both ends narrow for the labels below.
    if (prev === null || next === null || !isPinSwitchInTab(prevEntry, tabId, next)) {
      return;
    }
    const effortResetTo = effortResetRef.current;
    effortResetRef.current = undefined;
    storeApi.getState().appendConnectionChanged({
      fromLabel: connectionLabel(prev.connectionId),
      toLabel: connectionLabel(next.connectionId),
      model: model ?? "",
      ...(effortResetTo !== undefined ? { effortResetTo } : {}),
      ...(markerSessionId !== null ? { sessionId: markerSessionId } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two
    // axes the rule is about (the pin, and whether the new host is up), plus
    // the session id the marker persists under; the labels/model are read at
    // write time from the same render.
  }, [pinnedConnection, ready, tabId, markerSessionId]);

  function pickModel(id: string): void {
    if (pickDisabled) {
      return;
    }
    // Taskana 4895: a mid-turn pick is QUEUED host-side (last-value-wins), so
    // re-picking the model still on screen must travel too: it replaces the
    // queued pick instead of being mistaken for a no-op. `pendingPickRef` is
    // the only record of a pick the host has not acked yet.
    if (id !== model || (pendingPickRef.current.model !== undefined || pendingPickRef.current.effort !== undefined)) {
      const requestId = crypto.randomUUID();
      pendingPickRef.current.model = modelSettingsPick("model", id, modelSettingsConnectionId, pinnedConnection?.connectionId, snapshot?.settings.provider.activeConnectionId, requestId);
      sendToHost({ type: "set_model", model: id, requestId });
    }
    close(true);
  }

  function pickEffort(effort: ReasoningEffort): void {
    if (pickDisabled) {
      return;
    }
    const requestId = crypto.randomUUID();
    pendingPickRef.current.effort = modelSettingsPick("effort", effort, modelSettingsConnectionId, pinnedConnection?.connectionId, snapshot?.settings.provider.activeConnectionId, requestId);
    sendToHost({ type: "set_reasoning_effort", effort, requestId });
    close(true);
  }

  /** Names a refused provider switch in the toast channel (§D6 step 4) — a silent refusal would read as a switch that happened. */
  function failRebind(reason: string): void {
    storeApi.getState().setNotice({ kind: "rebind_failed", text: `Provider switch failed: ${rebindRefusalText(reason)}` });
  }

  /**
   * TASK.106 cut-2 §D3/§D6: picking a model from ANOTHER connection.
   *
   * The provider is baked into the host's fork env, so this is not a message to
   * the running host but a rebind: the pair is written onto the TARGET
   * connection first (the respawned host boots from that env — §D3), and only
   * then is `tab-rebind` asked to shut the host down and bring it back on the
   * resume path. Fail-closed at every step: a refused settings write aborts
   * before the rebind (rebinding then would boot the target on its OLD model),
   * and a refused rebind leaves the session exactly where it was running.
   *
   * The idle gate (§D2) is NOT `pickDisabled` since Taskana 4895 (that one is
   * live mid-turn for core): a rebind tears the host down, so it keeps the
   * between-turns `idle` predicate and refuses loudly while a turn runs.
   *
   * GitHub #33: a rebind also cancels the tab's RUNNING children (background
   * executors, session-tier subagents) — terminal for work the parent's idle
   * composer gives no hint of. So the pick is split in two: this function
   * resolves the target and hands off to `switchForeignConnection`, which asks
   * main first (a `dryRun` rebind — validation only) and turns a live-children
   * answer into an explicit choice instead of a silent cancellation.
   */
  async function pickForeignModel(connectionId: string, modelId: string): Promise<void> {
    if (pickDisabled) {
      return;
    }
    // Taskana 4895: the chip itself now stays live during a running turn (a
    // same-connection pick is queued), but a FOREIGN connection pick is a
    // rebind — it shuts the host down and respawns it, which would cut the
    // running turn. That stays between-turns only; name the refusal instead of
    // silently doing nothing.
    if (!idle) {
      close(false);
      failRebind("wait for the running turn to finish before switching provider");
      return;
    }
    if (tabId === undefined) {
      failRebind("unknown_tab");
      return;
    }
    const target = snapshot ? connectionById(snapshot.settings, connectionId) : undefined;
    if (target === undefined) {
      failRebind("connection_missing");
      return;
    }
    // The target model keeps its own saved effort; a rebind must not replace
    // that choice with the source model's effective tier.
    close(false);
    await switchForeignConnection(tabId, connectionId, modelId, false);
  }

  /**
   * GitHub #33: the rebind itself, gated on the running-children answer.
   *
   * `cancelChildren` is the user's consent, carried on BOTH the dry run and
   * the real rebind — the first ask passes it as false, the confirmed retry as
   * true, so main's own gate (`children_running`) is satisfied by exactly the
   * click the user made and never by this component's say-so.
   *
   * GitHub #33 review: the consent belongs to the TAB it was asked in. The
   * active tab's tree is reused when the user switches tabs, so an answer that
   * arrives (or a click on a dialog that is still open) after `tabId` moved on
   * must not be applied to the new tab — main's gate is per-tab, and handing it
   * another tab's id with `cancelChildren: true` would cancel children nobody
   * was asked about. `forTabId` is the originating tab and every step re-checks
   * it; a mismatch drops the whole attempt silently, having written nothing.
   *
   * Nothing here writes settings: main owns the target connection's model write
   * now, inside the locked rebind (after the child gate). So a switch that is
   * asked about and declined — or that a late child blocks — leaves no saved
   * value changed.
   */
  async function switchForeignConnection(
    forTabId: string,
    connectionId: string,
    modelId: string,
    cancelChildren: boolean,
  ): Promise<void> {
    // Read LIVE, from a ref the next render refreshes: the async continuation
    // resumes with the closure of the render that STARTED it, so comparing
    // against that closure's `tabId` could never notice a tab change. The ref
    // is what this pill currently represents.
    const stillThisTab = (): boolean => liveTabRef.current === forTabId;
    if (!stillThisTab()) {
      return;
    }
    const consent = cancelChildren ? { cancelChildren: true } : {};
    const checked = await window.anycode.tabRebind({ tabId: forTabId, connectionId, dryRun: true, ...consent });
    if (!stillThisTab()) {
      return;
    }
    if (!checked.ok) {
      if (checked.reason === "children_running" && !cancelChildren) {
        // Not a failure — a question. The count is main's live one.
        setChildCancelPending({ tabId: forTabId, connectionId, modelId, runningChildren: checked.runningChildren });
        return;
      }
      failRebind(checked.reason);
      return;
    }
    setChildCancelPending(null);
    effortResetRef.current = undefined;
    const result = await window.anycode.tabRebind({
      tabId: forTabId,
      connectionId,
      model: modelId,
      priorEffort: reasoningEffort,
      ...consent,
    });
    if (!result.ok && !stillThisTab()) {
      return;
    }
    if (!result.ok) {
      effortResetRef.current = undefined;
      if (result.reason === "children_running" && !cancelChildren) {
        // A child was admitted between the dry run and the rebind: same
        // question, now with the live count. Main refused before writing
        // anything, so the tab, its children and the target connection are all
        // exactly as they were.
        setChildCancelPending({ tabId: forTabId, connectionId, modelId, runningChildren: result.runningChildren });
        return;
      }
      failRebind(result.reason);
      return;
    }
    // The switch HAPPENED — that is settled main-side and does not depend on
    // which tab this pill now renders. Main wrote the target connection's model
    // as part of it, so the shared settings snapshot is stale until it is
    // re-read (Settings' connection tile shows that saved model); refresh it
    // BEFORE the tab check below, or a completed switch made just as the user
    // moved to another tab would leave every view on the old default.
    // Fail-soft: the switch itself already succeeded.
    void Promise.resolve(useSettingsStore.getState().load()).catch(() => undefined);
    if (!stillThisTab()) {
      return;
    }
    // The transcript line is written by the pin-watching effect above once the
    // respawned host's `host_ready` has landed (§D5) — writing it now would put
    // it in a transcript `performReset` is about to wipe.
  }

  /** Backs out one level, landing focus on the row the open level was entered from (StartScreen's own back grammar). */
  function drillBack(): void {
    const originIndex =
      drillPage.kind === "group"
        ? drill.popular.length +
          Math.max(0, drill.groups.findIndex((group) => group.connectionId === drillPage.connectionId))
        : drillPage.kind === "effort"
          ? drill.popular.length + drill.groups.length
          : 0;
    setDrillPage({ kind: "root" });
    setFocusIndex(originIndex);
  }

  /**
   * What activating a row does — the one place this picker's verbs live.
   * Opening a level is local state; a model row's verb is `pickSessionDrillRow`'s
   * ruling (§D3): the tab's own connection keeps the cheap `set_model` path,
   * any other connection is a rebind.
   */
  function activateRow(row: ModelDrillRow): void {
    switch (row.kind) {
      case "group": {
        const group = drill.groups.find((candidate) => candidate.connectionId === row.connectionId);
        setDrillPage({ kind: "group", connectionId: row.connectionId });
        setFocusIndex(Math.max(0, group?.items.findIndex((item) => item.current) ?? 0));
        break;
      }
      case "effort-open":
        setDrillPage({ kind: "effort" });
        setFocusIndex(Math.max(0, (drill.efforts ?? []).indexOf(row.value)));
        break;
      case "effort": {
        const level = asReasoningEffort(row.value);
        if (level !== undefined) {
          pickEffort(level);
        }
        break;
      }
      case "popular":
      case "model": {
        const pick = pickSessionDrillRow({ currentConnectionId: writeTargetConnectionId, row });
        if (pick.kind === "set_model") {
          pickModel(pick.modelId);
        } else {
          void pickForeignModel(pick.connectionId, pick.modelId);
        }
        break;
      }
      default:
        break;
    }
  }

  // One model acknowledgement can include both queued choices. Persist only
  // axes the user actually picked, even if the acknowledged value is unchanged.
  function persistAck(ack: typeof modelSelectionAck): void {
    if (ack == null || ack.model === null) return;
    for (const request of modelSettingsWrites(pendingPickRef.current, { model: ack.model, effort: ack.effort, requestId: ack.requestId, effortRequestId: ack.effortRequestId, kind: ack.kind })) {
      writeChainRef.current = chainWrite(writeChainRef.current, () => connectionUpdate(request));
    }
  }
  useEffect(() => { persistAck(effortSelectionAck); }, [effortSelectionAck]);
  useEffect(() => { persistAck(modelSelectionAck); }, [modelSelectionAck]);

  function onChipKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (pickDisabled) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Every level is ONE flat row list, so the roving index is one code path —
    // the same keyboard StartScreen's copy of this popover speaks.
    const count = drill.rows.length;
    const row = drill.rows[focusIndex];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusIndex((i) => nextRovingIndex(i, 1, count));
        break;
      case "ArrowUp":
        event.preventDefault();
        setFocusIndex((i) => nextRovingIndex(i, -1, count));
        break;
      // The drill-down's own axis: right descends into a level, left backs out.
      case "ArrowRight":
        if (row?.kind === "group" || row?.kind === "effort-open") {
          event.preventDefault();
          activateRow(row);
        }
        break;
      case "ArrowLeft":
        if (drillPage.kind !== "root") {
          event.preventDefault();
          drillBack();
        }
        break;
      case "Home":
        event.preventDefault();
        setFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setFocusIndex(count - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (row) {
          activateRow(row);
        }
        break;
      case "Escape":
        // Esc unwinds one level at a time; only the root closes the popover.
        event.preventDefault();
        if (drillPage.kind === "root") {
          close(true);
        } else {
          drillBack();
        }
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  if (model === null) {
    // Mirrors the old `{model && ...}` guard: nothing to show before
    // host_ready has landed a model at all.
    return null;
  }

  const label = pillDisplayLabel(model, catalogModels, reasoningEffort, availableEffortLevels);

  return (
    <div className="model-pill" ref={rootRef}>
      <button
        ref={chipRef}
        type="button"
        className="model-pill-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pickDisabled}
        title={turnInProgress ? `${label} — ${MID_TURN_CHANGE_NOTE}` : label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onChipKeyDown}
      >
        <span className="model-pill-label">{label}</span>
        {/* Taskana 4895: plainly says WHEN a pick lands while a turn runs —
            the running turn itself keeps the model it started with. */}
        {turnInProgress && <span className="model-pill-midturn">next turn</span>}
        <Chevron className="model-pill-chevron" />
      </button>

      {open && (
        <div
          className="model-pill-popover"
          role="menu"
          aria-label="Model and effort"
          onKeyDown={onMenuKeyDown}
          style={
            anchor
              ? {
                  left: anchor.left,
                  bottom: anchor.bottom,
                  // DoD 5: the room actually available above the chip — a MAX,
                  // never a height, so a level shorter than the room renders
                  // with no scrollbar at all. The wrapper owns it (the shared
                  // menu inside is in-flow, see app.css).
                  ...(placement ? { maxHeight: `${placement.maxHeightPx}px` } : {}),
                }
              : undefined
          }
        >
          {/* TASK.106 cut-2 §D4 (DoD 6): the SHARED drill-down — the same
              component the New Session screen renders, spanning every
              connected connection. The popover wrapper above keeps the pill's
              own fixed-position escape from `.composer-footer-left`'s
              `overflow:hidden`; the maxHeight below is the room actually
              available above the chip, a MAX never a height, so a short level
              renders with no scrollbar at all (DoD 5). */}
          <ModelDrillMenu
            rows={drill.rows}
            page={drillPage}
            placement={placement}
            backLabel={drillPage.kind === "effort" ? "Effort" : (openGroup?.label ?? "Models")}
            focusIndex={focusIndex}
            emptyText="No connected providers yet."
            // Taskana 4895: same wording as the chip's own note — a pick is
            // accepted now and rides the NEXT turn, never the running one.
            {...(turnInProgress ? { note: MID_TURN_CHANGE_NOTE } : {})}
            itemRefs={itemRefs}
            onKeyDown={onMenuKeyDown}
            onActivateRow={activateRow}
            onBack={drillBack}
            onAddConnection={() => {
              close(false);
              openSettingsAddConnection();
            }}
            isCurrentConnection={(connectionId) => !isForeignPick(connectionId, writeTargetConnectionId)}
          />
        </div>
      )}

      {/* GitHub #33: the switch a foreign pick would perform is destructive
          while subagents run — named here, with the live count, and only the
          explicit "Switch anyway" proceeds (it re-runs the same flow with the
          user's `cancelChildren` consent). Cancel is the focused button. */}
      <ConfirmDialog
        request={
          childCancelPending === null
            ? null
            : {
                title: "Subagents are running",
                body:
                  childCancelPending.runningChildren === 1
                    ? "1 subagent is running in this session and will be cancelled. Switch connection anyway?"
                    : `${childCancelPending.runningChildren} subagents are running in this session and will be cancelled. Switch connection anyway?`,
                confirmLabel: "Switch anyway",
                cancelLabel: "Wait",
              }
        }
        onConfirm={() => {
          const pending = childCancelPending;
          setChildCancelPending(null);
          if (pending !== null) {
            // Consent is spent on the tab it was asked about, never on
            // whichever tab happens to be active at click time.
            void switchForeignConnection(pending.tabId, pending.connectionId, pending.modelId, true);
          }
        }}
        onCancel={() => setChildCancelPending(null)}
      />
    </div>
  );
}

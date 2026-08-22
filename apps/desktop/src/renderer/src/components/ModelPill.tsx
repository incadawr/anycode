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
 * existing `set_reasoning_effort` (host guard silently drops both while
 * busy; since TASK.37 `set_mode` is the exception — mode changes are
 * accepted mid-turn). `modelPickDisabled` is the
 * client-side mirror of that guard (F15's `shouldEnqueue` plus `!ready`) so
 * the chip itself goes unclickable rather than offering a pick the host
 * would reject.
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
import { activeProviderView, connectionById } from "../../../shared/settings.js";
import type { SessionSummary } from "../../../shared/tabs.js";
import { TabContext, useTabSend, useTabStore, useTabStoreApi } from "../tab-context.js";
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
// TASK.106 cut-2 §D4: the shared drill-down (markup) over the shared decision
// layers (rows + verbs). None of it is re-derived here — this file only wires
// the running tab's own axes (its pin, its live model/effort) into them.
import { connectionDisplayName } from "./ConnectionTile.js";
import { ModelDrillMenu } from "./model-drill-menu.js";
import {
  buildSessionDrillRows,
  isForeignPick,
  pickSessionDrillRow,
  resolveRebindEffort,
  type ModelDrillPage,
  type ModelDrillRow,
} from "./model-drill-rows.js";
import { deriveRecentModelIds, startModelMenuMaxHeightPx } from "./start-model-picker.js";
// P7.23/F24 W2 seam (cut §2 row 3): byte-for-byte mirror of ModeMenu's own
// FOCUS_MODE_MENU_EVENT listener below — the slash menu's "Model" row
// summons this popover the same way ⇧⌘M summons ModeMenu's.
import { FOCUS_MODEL_PILL_EVENT } from "../slash-menu.js";
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

interface PendingPick {
  kind: "model" | "effort";
  value: string;
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
 * Resolves the model list a provider offers its pickers (F2, codex-profiles
 * cut lane FXH review): a builtin catalog hit returns its own `models`
 * byte-for-byte (the pre-existing path, untouched); a `custom:<slug>`
 * provider with no catalog entry falls back to its own curated `models[]`
 * (cut §9.2 — the user-picked subset a custom endpoint's fetch surfaced);
 * anything else (unknown id, or `providerId` itself `undefined` — the legacy
 * free-text config with no provider selected at all) yields `undefined`,
 * exactly like today's plain `catalog.find(...)?.models`.
 *
 * `connectionModels` — the target connection's LIVE-fetched ids
 * (`ProviderConnection.models`, the connection-scoped guarded fetch) — takes
 * precedence when non-empty: the live list decides WHAT is shown, the static
 * catalog hints only decorate matching ids with display names. Absent/empty
 * keeps every pre-fetch behavior byte-identical. Exported for unit testing.
 */
export function providerModelsFor(
  providerId: string | undefined,
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
  connectionModels?: readonly string[],
): readonly { id: string; name?: string }[] | undefined {
  const catalogHit = catalog?.find((entry) => entry.id === providerId)?.models;
  if (connectionModels !== undefined && connectionModels.length > 0) {
    return connectionModels.map((id) => {
      const hint = catalogHit?.find((m) => m.id === id);
      return hint?.name !== undefined ? { id, name: hint.name } : { id };
    });
  }
  if (catalogHit !== undefined) {
    return catalogHit;
  }
  const customHit = custom?.find((entry) => entry.id === providerId);
  if (customHit !== undefined) {
    return customHit.models.map((id) => ({ id }));
  }
  return undefined;
}

/**
 * The Model page's flat list (design §2.2): the provider's catalog models,
 * plus the currently active model appended if it isn't already among them
 * (a free-text/env-boot model, or an empty catalog for a custom provider —
 * the list then holds just that one current entry). Exported for unit
 * testing.
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
 * Client-side mirror of the host's authoritative between-turns guard (design
 * §2.1): a pick is offered only when the tab is truly idle — NOT
 * `shouldEnqueue` (the F15 predicate: a running turn OR the queue in-flight
 * window both count as busy) — AND the connection is `ready` (no host to
 * send to otherwise). The host's `!busy` check is the real backstop; this
 * only keeps the UI from offering a pick it knows would be silently
 * dropped. Exported for unit testing.
 */
export function modelPickDisabled(
  turnStatus: TurnState["status"],
  queueInFlight: DesktopState["queueInFlight"],
  ready: boolean,
): boolean {
  return shouldEnqueue(turnStatus, queueInFlight) || !ready;
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
 * The connection-update request persisted on an acked pick (TASK.45 W10): the
 * ACTIVE connection's `reasoningEffort` is always written (the connection is the
 * source of truth the readiness gate + host-env ladder read, so it doubles as
 * the former top-level `provider.model`); `model` is written only on a MODEL
 * pick — an effort-only pick must not retarget the model. `id` is the connection
 * captured at pick time. Exported for unit testing.
 */
export function buildConnectionUpdate(
  connectionId: string,
  isModelPick: boolean,
  model: string,
  reasoningEffort: ReasoningEffort,
): ConnectionUpdateRequest {
  return {
    id: connectionId,
    ...(isModelPick ? { model } : {}),
    reasoningEffort,
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

export function ModelPill() {
  const sendToHost = useTabSend();
  const storeApi = useTabStoreApi();
  // The tab this pill belongs to — the context's own id, NOT the tabs-store's
  // `activeTabId`: a child surface (TASK.102) mounts its own composer under its
  // own provider, and a rebind must address the tab it was picked in.
  const tabId = useContext(TabContext)?.tabId;
  const model = useTabStore((state) => state.model);
  const reasoningEffort = useTabStore((state) => state.reasoningEffort);
  const availableEffortLevels = useTabStore((state) => state.availableEffortLevels);
  const turnStatus = useTabStore((state) => state.turn.status);
  const queueInFlight = useTabStore((state) => state.queueInFlight);
  const connection = useTabStore((state) => state.connection);
  const pinnedConnection = useTabStore((state) => state.pinnedConnection);
  const ready = connection === "ready";

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
  const { providerId, writeTargetConnectionId } = resolvePillTarget(
    pinnedConnection,
    activeProviderId,
    snapshot?.settings.provider.activeConnectionId,
  );
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
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The one pending-pick slot (design §2.4) — never holds more than one pick
  // at a time (a second pick before the first acks would overwrite it, but
  // the chip is closed/disabled between send and ack in practice since a
  // pick immediately closes the popover).
  const pendingPickRef = useRef<PendingPick | null>(null);
  // Serializes the ack-triggered persist writes below (codex P2 defect fix):
  // guarantees writes run in ack order even though `setPatch` itself is an
  // unawaited, unlocked load/merge/save.
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // The pin this component last reported in the transcript (§D5). Seeded with
  // the pin the tab already had, so a mount is never mistaken for a switch.
  const lastPinRef = useRef<{ connectionId: string; providerId: string } | null>(pinnedConnection);
  // Carries the effort reset a rebind decided (§D3) from the pick to the ledger
  // line the pin-watching effect writes once the new host is up; cleared as
  // soon as it is spent or the rebind fails.
  const effortResetRef = useRef<string | undefined>(undefined);

  const pickDisabled = modelPickDisabled(turnStatus, queueInFlight, ready);

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
  useEffect(() => {
    if (!ready) {
      return;
    }
    const prev = lastPinRef.current;
    const next = pinnedConnection;
    lastPinRef.current = next;
    // The two null checks are the ones `shouldMarkConnectionChange` itself
    // makes, spelled out here so both ends narrow for the labels below.
    if (prev === null || next === null || !shouldMarkConnectionChange(prev, next)) {
      return;
    }
    const effortResetTo = effortResetRef.current;
    effortResetRef.current = undefined;
    storeApi.getState().appendConnectionChanged({
      fromLabel: connectionLabel(prev.connectionId),
      toLabel: connectionLabel(next.connectionId),
      model: model ?? "",
      ...(effortResetTo !== undefined ? { effortResetTo } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two
    // axes the rule is about (the pin, and whether the new host is up); the
    // labels/model are read at write time from the same render.
  }, [pinnedConnection, ready]);

  function pickModel(id: string): void {
    if (pickDisabled) {
      return;
    }
    if (id !== model) {
      pendingPickRef.current = { kind: "model", value: id, connectionId: writeTargetConnectionId };
      sendToHost({ type: "set_model", model: id });
    }
    close(true);
  }

  function pickEffort(effort: ReasoningEffort): void {
    if (pickDisabled) {
      return;
    }
    if (effort !== reasoningEffort) {
      pendingPickRef.current = { kind: "effort", value: effort, connectionId: writeTargetConnectionId };
      sendToHost({ type: "set_reasoning_effort", effort });
    }
    close(true);
  }

  /** Names a refused provider switch in the toast channel (§D6 step 4) — a silent refusal would read as a switch that happened. */
  function failRebind(reason: string): void {
    storeApi.getState().setNotice({ kind: "rebind_failed", text: `Provider switch failed: ${reason}` });
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
   * The idle gate (§D2) is the same `pickDisabled` predicate that mutes the
   * chip — a switch mid-turn is refused, never queued.
   */
  async function pickForeignModel(connectionId: string, modelId: string): Promise<void> {
    if (pickDisabled) {
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
    // §D3: the running effort travels only when the TARGET model's own
    // vocabulary accepts it; otherwise it is reset — and the reset is named in
    // the ledger line the switch appends, never substituted silently.
    const decision = resolveRebindEffort({
      currentEffort: reasoningEffort,
      targetProviderId: target.providerId,
      targetModelId: modelId,
      catalog: snapshot?.catalog,
      targetConnectionEffort: target.reasoningEffort,
    });
    const resolvedEffort = decision.carried ?? decision.resetTo;
    // A model with no vocabulary at all leaves the connection's effort alone:
    // writing one the host would reject helps nobody.
    const nextEffort = resolvedEffort === undefined ? undefined : asReasoningEffort(resolvedEffort);
    close(false);
    const written = await connectionUpdate({
      id: connectionId,
      model: modelId,
      ...(nextEffort !== undefined ? { reasoningEffort: nextEffort } : {}),
    });
    if (!written.ok) {
      // settings-store already raised its own notice for the write itself; this
      // one says what the write was FOR.
      failRebind(written.reason);
      return;
    }
    effortResetRef.current = decision.dropped ? decision.resetTo : undefined;
    const result = await window.anycode.tabRebind({ tabId, connectionId });
    if (!result.ok) {
      effortResetRef.current = undefined;
      failRebind(result.reason);
    }
    // Success needs nothing here: the transcript line is written by the
    // pin-watching effect above once the respawned host's `host_ready` has
    // landed (§D5) — writing it now would put it in a transcript
    // `performReset` is about to wipe.
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

  // Ack-gated persist half 1/2: fires only when `model` just landed the
  // value THIS component asked for via a model pick.
  useEffect(() => {
    if (model === null) {
      return;
    }
    const pending = pendingPickRef.current;
    if (pending && shouldPersistOnAck(pending, "model", model)) {
      pendingPickRef.current = null;
      const connectionId = pending.connectionId;
      if (connectionId !== undefined) {
        writeChainRef.current = chainWrite(writeChainRef.current, () =>
          connectionUpdate(buildConnectionUpdate(connectionId, true, model, reasoningEffort)),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // keyed on `model` alone: this effect's job is "did `model` just become
    // the pending pick's value", not a generic recompute-on-anything-changed.
  }, [model]);

  // Ack-gated persist half 2/2: fires only when `reasoningEffort` just
  // landed the value THIS component asked for via an effort pick.
  useEffect(() => {
    if (model === null) {
      return;
    }
    const pending = pendingPickRef.current;
    if (pending && shouldPersistOnAck(pending, "effort", reasoningEffort)) {
      pendingPickRef.current = null;
      const connectionId = pending.connectionId;
      if (connectionId !== undefined) {
        writeChainRef.current = chainWrite(writeChainRef.current, () =>
          connectionUpdate(buildConnectionUpdate(connectionId, false, model, reasoningEffort)),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same discipline
    // as the model-watching effect above, keyed on `reasoningEffort` alone.
  }, [reasoningEffort]);

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

  const displayName = modelDisplayName(model, catalogModels);
  const label = pillLabel(displayName, reasoningEffort, availableEffortLevels);

  return (
    <div className="model-pill" ref={rootRef}>
      <button
        ref={chipRef}
        type="button"
        className="model-pill-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pickDisabled}
        title={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onChipKeyDown}
      >
        <span className="model-pill-label">{label}</span>
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
            itemRefs={itemRefs}
            onKeyDown={onMenuKeyDown}
            onActivateRow={activateRow}
            onBack={drillBack}
            isCurrentConnection={(connectionId) => !isForeignPick(connectionId, writeTargetConnectionId)}
          />
        </div>
      )}
    </div>
  );
}

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
 * busy — mirrors ModeMenu's `set_mode`). `modelPickDisabled` is the
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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ReasoningEffort } from "@anycode/core";
import type { ConnectionUpdateRequest } from "../../../shared/settings.js";
import { activeProviderView } from "../../../shared/settings.js";
import { useTabSend, useTabStore } from "../tab-context.js";
import { useSettingsStore } from "../settings-store.js";
import type { DesktopState, TurnState } from "../store.js";
// Reuse, not re-derive (design §2.1): the exact F15 guard predicate that
// decides enqueue-vs-direct-send in Composer's own handleSend also decides
// whether a pick is safe to offer here. Composer.tsx mounts <ModelPill/>, so
// this is a two-file cycle — safe because `shouldEnqueue` is a hoisted
// function declaration only ever invoked from event handlers (long after
// both modules have finished evaluating), never at module top-level.
import { shouldEnqueue } from "./Composer.js";
import { Check, Chevron } from "./icons.js";
import { nextRovingIndex } from "./ModeMenu.js";
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

type PillPage = "root" | "model" | "effort";

/** Nominal popover width (px) used only for right-edge clamping before the popover measures itself — mirrors Sidebar's `PROJECT_MENU_WIDTH` (matches `.model-pill-popover`'s CSS `min-width: 15rem` at the standard 16px root). */
const MODEL_PILL_POPOVER_WIDTH = 240;

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
  const catalogModels = snapshot?.catalog?.find((entry) => entry.id === providerId)?.models;

  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PillPage>("root");
  const [focusIndex, setFocusIndex] = useState(0);
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

  const pickDisabled = modelPickDisabled(turnStatus, queueInFlight, ready);
  const effortRowVisible = availableEffortLevels !== undefined;
  const modelItems = modelMenuItems(model ?? "", catalogModels);
  const effortItems = availableEffortLevels ?? [];

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPage("root");
    if (returnFocus) {
      chipRef.current?.focus();
    }
  }, []);

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
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setAnchor({
      left: clampMenuLeft(rect.left, MODEL_PILL_POPOVER_WIDTH, window.innerWidth),
      bottom: window.innerHeight - rect.top + 8,
    });
  }, [open]);

  // Outside mousedown closes (mirrors ModeMenu's listener).
  useEffect(() => {
    if (!open) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setPage("root");
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
      setPage("root");
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

  // Seed roving focus whenever the popover opens or changes page.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (page === "root") {
      setFocusIndex(0);
    } else if (page === "model") {
      setFocusIndex(Math.max(0, modelItems.findIndex((item) => item.id === model)));
    } else if (page === "effort") {
      setFocusIndex(Math.max(0, effortItems.indexOf(reasoningEffort)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on
    // an open/page transition (mirrors ModeMenu's narrow [open, mode] deps);
    // recomputing on every store tick would fight the user's roving-arrow input.
  }, [open, page]);

  // Move DOM focus to the roving item whenever the index changes while open.
  useEffect(() => {
    if (open) {
      itemRefs.current[focusIndex]?.focus();
    }
  }, [open, focusIndex, page]);

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
    const count = page === "root" ? (effortRowVisible ? 2 : 1) : page === "model" ? modelItems.length : effortItems.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusIndex((i) => nextRovingIndex(i, 1, count));
        break;
      case "ArrowUp":
        event.preventDefault();
        setFocusIndex((i) => nextRovingIndex(i, -1, count));
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
        if (page === "root") {
          if (focusIndex === 0) {
            setPage("model");
          } else if (effortRowVisible && focusIndex === 1) {
            setPage("effort");
          }
        } else if (page === "model") {
          const item = modelItems[focusIndex];
          if (item) {
            pickModel(item.id);
          }
        } else if (page === "effort") {
          const level = effortItems[focusIndex];
          if (level) {
            pickEffort(level);
          }
        }
        break;
      case "Escape":
        event.preventDefault();
        if (page === "root") {
          close(true);
        } else {
          setPage("root");
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
          style={anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
        >
          {page === "root" && (
            <>
              <button
                type="button"
                ref={(el) => {
                  itemRefs.current[0] = el;
                }}
                tabIndex={focusIndex === 0 ? 0 : -1}
                className="model-pill-row"
                onClick={() => setPage("model")}
              >
                <span className="model-pill-row-name">Model</span>
                <span className="model-pill-row-value">{displayName}</span>
                <Chevron className="model-pill-row-chevron" />
              </button>
              {effortRowVisible && (
                <button
                  type="button"
                  ref={(el) => {
                    itemRefs.current[1] = el;
                  }}
                  tabIndex={focusIndex === 1 ? 0 : -1}
                  className="model-pill-row"
                  onClick={() => setPage("effort")}
                >
                  <span className="model-pill-row-name">Effort</span>
                  <span className="model-pill-row-value">{EFFORT_LABELS[reasoningEffort]}</span>
                  <Chevron className="model-pill-row-chevron" />
                </button>
              )}
              <div className="model-pill-divider" />
              <button
                type="button"
                className="model-pill-row model-pill-manage"
                disabled
                title="Provider settings — coming soon"
              >
                <span className="model-pill-row-name">Manage models…</span>
              </button>
            </>
          )}

          {page === "model" && (
            <>
              <button type="button" className="model-pill-back" onClick={() => setPage("root")}>
                <Chevron className="model-pill-back-chevron" />
                Model
              </button>
              {modelItems.map((item, index) => {
                const current = item.id === model;
                return (
                  <button
                    key={item.id}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current}
                    tabIndex={index === focusIndex ? 0 : -1}
                    className={`model-pill-item${current ? " model-pill-item-current" : ""}`}
                    onClick={() => pickModel(item.id)}
                  >
                    <span className="model-pill-item-check" aria-hidden="true">
                      {current ? <Check /> : null}
                    </span>
                    <span className="model-pill-item-name">{item.name}</span>
                  </button>
                );
              })}
            </>
          )}

          {page === "effort" && (
            <>
              <button type="button" className="model-pill-back" onClick={() => setPage("root")}>
                <Chevron className="model-pill-back-chevron" />
                Effort
              </button>
              {effortItems.map((level, index) => {
                const current = level === reasoningEffort;
                return (
                  <button
                    key={level}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current}
                    tabIndex={index === focusIndex ? 0 : -1}
                    className={`model-pill-item${current ? " model-pill-item-current" : ""}`}
                    onClick={() => pickEffort(level)}
                  >
                    <span className="model-pill-item-check" aria-hidden="true">
                      {current ? <Check /> : null}
                    </span>
                    <span className="model-pill-item-name">{EFFORT_LABELS[level]}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renderer-wide "is any overlay open" flag (working-docs/panel-track/CUT.md
 * §2.4/D8): a single module-singleton `Set<string>` of open overlay keys, not
 * React context — every overlay component (dialogs, right-side drawers, the
 * four composer dropdowns) independently registers/deregisters its own key
 * via `useOverlayFlag(open)`, and panel-bridge.ts subscribes to the 0<->non-0
 * transition to fold `overlayOpen` into its `previewPanel.setState` calls
 * (D7: the preview WebContentsView must never float above a modal/dropdown).
 *
 * Exhaustive wiring list (D8): App's paletteOpen/settingsOpen (one combined
 * flag), ConnectedPermissionModal, GitConfirmDialog, LspPanel, HooksPanel,
 * TimelinePanel, ConsentDialog, and the four local-state dropdowns ModeMenu/
 * ModelPill/EnvironmentMenu/SlashMenu (each wires its own open state).
 * TerminalPanel and GitPanel are deliberately EXCLUDED (in-flow layout, not
 * overlays) — see D8's rationale in the cut.
 *
 * `applyOverlayKey` is the pure core (exported for the unit gate); the
 * module `Set` + subscriber list + `useOverlayFlag`/`useOverlayOpenSnapshot`
 * hooks are the untested wiring (D16) that closes over it.
 */
import { useEffect, useId, useSyncExternalStore } from "react";

/**
 * Adds/removes `key` from `keys` per `open`, returning whether the set is
 * non-empty afterward. Pure — touches only the `keys` argument, never module
 * state — so double-add/double-remove idempotence is testable without React.
 */
export function applyOverlayKey(keys: Set<string>, key: string, open: boolean): boolean {
  if (open) {
    keys.add(key);
  } else {
    keys.delete(key);
  }
  return keys.size > 0;
}

const openKeys = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Current overlay-open flag — a plain synchronous read, no subscription. */
export function isOverlayOpen(): boolean {
  return openKeys.size > 0;
}

/** Subscribes to every 0<->non-0 transition of the overlay-open flag; returns an unsubscribe. */
export function subscribeOverlayOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers this component instance's own overlay-open state under a stable
 * per-instance key (`useId()`). Idempotent adds/removes (`applyOverlayKey`)
 * mean a rapid open/close/open sequence never double-counts; the cleanup
 * always clears the key on unmount or dependency change — a component that
 * unmounts while still "open" can never wedge the flag open.
 */
export function useOverlayFlag(open: boolean): void {
  const key = useId();
  useEffect(() => {
    const before = isOverlayOpen();
    applyOverlayKey(openKeys, key, open);
    if (isOverlayOpen() !== before) {
      notify();
    }
    return () => {
      const beforeCleanup = isOverlayOpen();
      applyOverlayKey(openKeys, key, false);
      if (isOverlayOpen() !== beforeCleanup) {
        notify();
      }
    };
  }, [key, open]);
}

/**
 * Reactive snapshot of the overlay-open flag for components that need to
 * re-render on it (PreviewPanel's hidden-state placeholder — the WebContents
 * View is invisible while any overlay is open, D6).
 */
export function useOverlayOpenSnapshot(): boolean {
  return useSyncExternalStore(subscribeOverlayOpen, isOverlayOpen, isOverlayOpen);
}

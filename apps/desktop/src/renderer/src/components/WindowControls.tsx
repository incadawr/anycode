/**
 * Custom titlebar (design/ui-track custom-titlebar §4/§5): win/linux caption
 * buttons (minimize / maximize↔restore / close), fixed top-right. macOS never
 * mounts this — the platform gate lives in App.tsx, matching the sidebar's
 * traffic-light cap instead. Purely presentational: the two bits of branching
 * (maximize↔restore label, and mapping a button's kind to the exposed
 * `window.anycode.window` method it calls) are factored into the plain
 * functions below so they're unit-testable without a DOM (this package's
 * vitest runs `environment: "node"`, no jsdom — same discipline as
 * `Sidebar.tsx`'s `buildSidebarGroups`/`formatAge`).
 */
// "Close" reuses the existing `X` glyph (icons.tsx) rather than duplicating
// an identical path under a new name — it's already the exact 16×16
// currentColor-stroke X the design calls for.
import { Maximize, Minimize, Restore, X as Close } from "./icons.js";

export type WindowControlKind = "minimize" | "maximize" | "close";

/** Maximize/Restore aria-label flip — the one piece of state-driven branching among the three buttons. */
export function maximizeRestoreLabel(maximized: boolean): "Maximize" | "Restore" {
  return maximized ? "Restore" : "Maximize";
}

/** A button's semantic kind → the `window.anycode.window` method name it invokes. */
export function windowControlMethod(kind: WindowControlKind): "minimize" | "toggleMaximize" | "close" {
  switch (kind) {
    case "minimize":
      return "minimize";
    case "maximize":
      return "toggleMaximize";
    case "close":
      return "close";
  }
}

export interface WindowControlsProps {
  maximized: boolean;
}

/** Fires a caption-button's mapped `window.anycode.window` method, ignoring the resolved promise (fire-and-forget, same idiom as Sidebar's create/resume buttons). */
function invoke(kind: WindowControlKind): void {
  void window.anycode.window[windowControlMethod(kind)]();
}

export function WindowControls({ maximized }: WindowControlsProps) {
  const maximizeLabel = maximizeRestoreLabel(maximized);

  return (
    <div className="window-controls">
      <button type="button" className="window-control" aria-label="Minimize" onClick={() => invoke("minimize")}>
        <Minimize className="window-control-icon" />
      </button>
      <button type="button" className="window-control" aria-label={maximizeLabel} onClick={() => invoke("maximize")}>
        {maximized ? <Restore className="window-control-icon" /> : <Maximize className="window-control-icon" />}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label="Close"
        onClick={() => invoke("close")}
      >
        <Close className="window-control-icon" />
      </button>
    </div>
  );
}

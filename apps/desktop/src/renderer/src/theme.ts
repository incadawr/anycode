/**
 * Theme controller (design ui-redesign-direction.md §2.5). Owns the single
 * source of truth for the resolved concrete theme (`"light"|"dark"`) that
 * `<html data-theme>` and CSS consume — the design keeps `data-theme` ALWAYS a
 * concrete value (never `"system"`), resolving the OS preference here via
 * `matchMedia` before stamping so tokens.css needs no `prefers-color-scheme`
 * blocks.
 *
 * Window discipline (same as settings-store.ts's lazy `realBridge`): NOTHING
 * touches `window`/`document`/`matchMedia` at module load — every access is
 * guarded and lazy — so this module imports cleanly under vitest/node, which
 * is where `resolveTheme` (the pure, unit-tested core) is exercised.
 */
import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/**
 * Pure theme resolution — the unit-tested core (theme.test.ts). Explicit
 * `"light"`/`"dark"` pass straight through; `"system"` picks by the OS
 * dark-mode flag (`systemDark`).
 */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  switch (pref) {
    case "light":
      return "light";
    case "dark":
      return "dark";
    case "system":
      return systemDark ? "dark" : "light";
    default: {
      const exhaustive: never = pref;
      return exhaustive;
    }
  }
}

interface ResolvedThemeState {
  resolved: ResolvedTheme;
  setResolved(resolved: ResolvedTheme): void;
}

/**
 * Tiny store mirroring the currently-applied resolved theme. Default `"dark"`
 * matches index.html's pre-boot `data-theme="dark"` flash guard, so the hook
 * agrees with the DOM before `applyThemePreference` has run for the first time.
 */
const useThemeStore = create<ResolvedThemeState>()((set) => ({
  resolved: "dark",
  setResolved(resolved: ResolvedTheme): void {
    set({ resolved });
  },
}));

/** React hook — the resolved concrete theme, updated whenever `applyThemePreference` runs. */
export function useResolvedTheme(): ResolvedTheme {
  return useThemeStore((s) => s.resolved);
}

/**
 * Non-hook accessor for the currently-resolved theme — for the handful of
 * renderer modules that live outside React (e.g. `terminal-view.ts`'s xterm
 * theme sync, UI-8) and so can't call `useResolvedTheme`.
 */
export function getResolvedTheme(): ResolvedTheme {
  return useThemeStore.getState().resolved;
}

/**
 * Subscribes to resolved-theme changes outside React. Returns the
 * unsubscribe. Fires only on subsequent changes (matches zustand's own
 * `subscribe` semantics) — read `getResolvedTheme()` first for the current
 * value.
 */
export function subscribeResolvedTheme(cb: (resolved: ResolvedTheme) => void): () => void {
  return useThemeStore.subscribe((state) => cb(state.resolved));
}

// Bound OS-preference listener state — retained so a later `applyThemePreference`
// call can detach the previous listener (idempotent listener management). Both
// are held together: `removeEventListener` must target the exact MediaQueryList
// the listener was added to (each `matchMedia` call returns a fresh object).
let boundMediaQuery: MediaQueryList | null = null;
let boundListener: ((event: MediaQueryListEvent) => void) | null = null;

/** The OS dark-mode media query, or `null` when `window`/`matchMedia` is unavailable (vitest/node, or a stripped renderer). */
function systemDarkQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia("(prefers-color-scheme: dark)");
}

/** Stamps the resolved theme onto `<html data-theme>` and into the store. */
function stampResolved(resolved: ResolvedTheme): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", resolved);
  }
  useThemeStore.getState().setResolved(resolved);
}

/** Detaches any previously-bound OS-preference listener (no-op when none is bound). */
function unbindListener(): void {
  if (boundMediaQuery && boundListener) {
    boundMediaQuery.removeEventListener("change", boundListener);
  }
  boundMediaQuery = null;
  boundListener = null;
}

/**
 * Applies a theme preference: resolves `"system"` via `matchMedia`, stamps the
 * resulting concrete theme onto `<html data-theme>` + the store, and manages
 * the OS-preference listener. When `pref === "system"` it (re)binds a
 * `matchMedia` `change` listener that re-stamps on OS theme flips; for any
 * explicit preference it drops the listener. Safe to call repeatedly — each
 * call first detaches any prior listener, so a bound listener never leaks or
 * duplicates.
 */
export function applyThemePreference(pref: ThemePreference): void {
  const mql = systemDarkQuery();
  const systemDark = mql?.matches ?? false;
  stampResolved(resolveTheme(pref, systemDark));

  // Idempotent listener management: always clear first, then (re)bind only for
  // `"system"`. This single path covers repeat calls AND the system→explicit
  // transition (which just drops the listener).
  unbindListener();
  if (pref === "system" && mql) {
    const listener = (event: MediaQueryListEvent): void => {
      stampResolved(resolveTheme("system", event.matches));
    };
    mql.addEventListener("change", listener);
    boundMediaQuery = mql;
    boundListener = listener;
  }
}

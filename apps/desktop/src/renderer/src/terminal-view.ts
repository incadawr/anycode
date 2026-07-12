/**
 * Per-tab xterm.js instance registry, living OUTSIDE React (design
 * slice-2.4-cut.md §4). Background tabs are unmounted by App.tsx (phase-2 §2.4:
 * only the active tab's whole chat UI is ever mounted), so an xterm `Terminal`
 * bound to a tab's lifecycle instead of its mount state is the only way its
 * scrollback buffer survives switching away and back. One `{term, fit, holder}`
 * triple lives here per tabId, keyed independently of tab-registry.ts's
 * per-tab store/connection map — this module knows nothing about ports,
 * connections, or the tabs-store; tab-registry.ts (which DOES own the
 * term-port connection lifecycle) is the only caller, routing incoming
 * `TermToUiMessage`s into `write`/`markOpened`/`markDead` below.
 *
 * DOM reparenting, not recreation: `attachHolder(tabId, container)` moves the
 * tab's `holder` div into whatever container is currently showing it
 * (`Element.replaceChildren` — evicts any OTHER tab's holder that used to live
 * there, without touching that other tab's `Terminal`/`FitAddon` instance or
 * its accumulated buffer) and calls `term.open(holder)` exactly ONCE, the
 * first time the tab's terminal is ever shown. A tab whose panel is closed
 * (or backgrounded) keeps its holder detached from the document but still

 * capped by xterm's own `scrollback` terminal option (~5000 lines) rather than
 * any manual trimming here.
 *
 * Testability (no jsdom in this package's vitest config — see
 * apps/desktop/vitest.config.ts, `environment: "node"`): `@xterm/xterm`'s
 * `Terminal` and `@xterm/addon-fit`'s `FitAddon` both construct and respond to
 * `write`/`onData`/`loadAddon`/`dispose`/`fit()` fine under plain Node (only
 * `.open()` needs a real DOM element), so importing them here is safe even
 * under a DOM-less test run. Still, the terminal/fit-addon/holder
 * FACTORIES are injectable (`TerminalFactories`) so tests can swap in
 * lightweight doubles and assert on call counts/identity (the "reparent, not
 * recreate" criterion) without touching `@xterm/xterm` OR `document` at all;
 * production code (the `terminalView` singleton below) uses the real classes.
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getResolvedTheme, subscribeResolvedTheme, type ResolvedTheme } from "./theme.js";

/* */
export const TERMINAL_SCROLLBACK_LINES = 5000;

/**
 * xterm ANSI theme colors per resolved app theme (design ui-redesign-direction.md
 * §2.5/UI-8, best-effort polish). `background`/`foreground`/`cursor` mirror
 * tokens.css's `--bg-inset`/`--text-1`/`--accent` for each theme so the
 * terminal well reads as part of the same surface as the rest of the panel;
 * the remaining ANSI slots are conventional palette colors (tokens.css has no
 * semantic slot for e.g. ANSI magenta/cyan) with `black`/`red`/`green`/`yellow`/
 * `blue` nudged toward `--danger`/`--success`/`--warning`/`--accent` where a
 * token exists. Kept as plain constants (not read from computed CSS custom
 * properties) — this module has no reliable DOM node to read them from at
 * construction time, and hand-rolled xterm addon regressions from
 * `getComputedStyle` timing aren't worth it for a best-effort polish task.
 * Keep in sync with tokens.css's dark/light blocks by hand (same
 * keep-in-sync discipline as the app's other duplicated literals).
 */
const DARK_XTERM_THEME: ITheme = {
  background: "#101010",
  foreground: "#e4e4e4",
  cursor: "#4da3ff",
  cursorAccent: "#101010",
  selectionBackground: "rgba(77, 163, 255, 0.25)",
  black: "#1c1c1c",
  red: "#ff5c5c",
  green: "#46bf72",
  yellow: "#e2a33e",
  blue: "#4da3ff",
  magenta: "#bb80b3",
  cyan: "#56b6c2",
  white: "#e4e4e4",
  brightBlack: "#5a5a5a",
  brightRed: "#ff7a7a",
  brightGreen: "#6fd08c",
  brightYellow: "#f0b854",
  brightBlue: "#6cb4ff",
  brightMagenta: "#d3a4d0",
  brightCyan: "#7ecbd4",
  brightWhite: "#ffffff",
};

const LIGHT_XTERM_THEME: ITheme = {
  background: "#f1f1f1",
  foreground: "#262626",
  cursor: "#0e6fc9",
  cursorAccent: "#f1f1f1",
  selectionBackground: "rgba(14, 111, 201, 0.18)",
  black: "#262626",
  red: "#d92d2d",
  green: "#1e8a3e",
  yellow: "#9a6700",
  blue: "#0e6fc9",
  magenta: "#94578a",
  cyan: "#3a8ea1",
  white: "#d4d4d4",
  brightBlack: "#5c5c5c",
  brightRed: "#e35b5b",
  brightGreen: "#3aa860",
  brightYellow: "#b98a2f",
  brightBlue: "#3a8fd9",
  brightMagenta: "#a877a0",
  brightCyan: "#4fa6ba",
  brightWhite: "#ffffff",
};

function xtermThemeFor(resolved: ResolvedTheme): ITheme {
  return resolved === "dark" ? DARK_XTERM_THEME : LIGHT_XTERM_THEME;
}

/**
 * The subset of xterm.js's `Terminal` surface this module calls. Deliberately
 * loose (`loadAddon`'s parameter is `unknown`) so a real `Terminal` instance is
 * assignable here without a generics fight over `ITerminalAddon`/`IDisposable`
 * — the real class satisfies every method below structurally.
 */
export interface TerminalLike {
  write(data: string, callback?: () => void): void;
  onData(cb: (data: string) => void): { dispose(): void };
  loadAddon(addon: unknown): void;
  open(el: HTMLElement): void;
  dispose(): void;
  readonly cols: number;
  readonly rows: number;
  /**
   * Real xterm's live options object (`terminal.options.theme = {...}`
   * re-themes in place, no reopen needed — see `@xterm/xterm`'s own
   * `ITerminal.options` doc). Optional: this module's test doubles don't
   * implement it, and `applyTheme` below no-ops when it's absent.
   */
  options?: { theme?: ITheme };
  /** Clears the buffer, keeping the prompt line (xterm `clear()`). */
  clear(): void;
  getSelection(): string;
  hasSelection(): boolean;
  /** xterm's `onSelectionChange` IEvent — callable property, structurally a method here (same modeling as `onData`). */
  onSelectionChange(cb: () => void): { dispose(): void };
}

/** The subset of `@xterm/addon-fit`'s `FitAddon` surface this module calls. */
export interface FitAddonLike {
  fit(): void;
}

export interface TerminalFactories {
  createTerminal(): TerminalLike;
  createFitAddon(): FitAddonLike;
  createHolder(): HTMLDivElement;
}

const defaultFactories: TerminalFactories = {
  createTerminal: () =>
    new Terminal({
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: true,
      theme: xtermThemeFor(getResolvedTheme()),
    }) as unknown as TerminalLike,
  createFitAddon: () => new FitAddon() as unknown as FitAddonLike,
  createHolder: () => {
    const div = document.createElement("div");
    div.className = "terminal-holder";
    return div;
  },
};

export interface TerminalDims {
  cols: number;
  rows: number;
}

interface TerminalRecord {
  term: TerminalLike;
  fit: FitAddonLike;
  holder: HTMLDivElement;
  onInput: (data: string) => void;
  inputSub: { dispose(): void };
  dead: boolean;
  opened: boolean;
  deadListeners: Set<(dead: boolean) => void>;
  selectionSub: { dispose(): void };
  selectionListeners: Set<(hasSelection: boolean) => void>;
}

export interface TerminalView {
  /**
   * Gets or creates the tab's `{term, fit, holder}` triple, wiring
   * `term.onData` exactly once to a stable dispatcher that always calls
   * whatever `onInput` this call last supplied (so re-calling `ensure` with a
   * fresh closure — e.g. TerminalPanel re-running its mount effect — updates
   * the sink without re-registering a second listener). A no-op beyond that
   * on every call after the first for a given tabId: same `term`/`fit`
   * objects, same buffer.
   */
  ensure(tabId: string, onInput: (data: string) => void): void;
  /**
   * Moves `tabId`'s holder into `container` (`replaceChildren` — evicts
   * whatever was shown there before, without affecting the evicted tab's own
   * instance) and calls `term.open()` the first time only. No-op if `ensure`
   * hasn't been called for this tabId yet.
   */
  attachHolder(tabId: string, container: HTMLElement): void;
  /** Writes host-sent bytes into the tab's buffer (`term_data`/replay). `onFlushed` (test-only) mirrors xterm's async write-completion callback. */
  write(tabId: string, data: string, onFlushed?: () => void): void;
  /** `term_opened`: clears the dead flag and replays the ring-buffer tail (empty string on a fresh spawn). */
  markOpened(tabId: string, replay: string): void;
  /** `term_exited`/`term_error`: writes a banner line into the buffer and flips the dead flag (drives the Reopen affordance). */
  markDead(tabId: string, reason: string): void;
  /** Runs the fit-addon and returns the resulting geometry, or undefined if the tab has no terminal yet. */
  fitNow(tabId: string): TerminalDims | undefined;
  /** Current geometry without re-fitting (used for the reattach `term_open` in tab-registry.ts). */
  currentDims(tabId: string): TerminalDims | undefined;
  isDead(tabId: string): boolean;
  has(tabId: string): boolean;
  /** Notifies `cb` on every dead-flag transition (immediately-fired snapshot is the caller's job); returns the unsubscribe. No-op unsubscribe for an unknown tabId. */
  subscribeDead(tabId: string, cb: (dead: boolean) => void): () => void;
  /** Clears the tab's buffer keeping the prompt line (R18 header action). No-op for an unknown tabId. */
  clear(tabId: string): void;
  /** Current selection text ("" for unknown tabId / no selection). */
  getSelection(tabId: string): string;
  hasSelection(tabId: string): boolean;
  /** Notifies on every xterm selection change with the new hasSelection; mirrors subscribeDead (no snapshot fire; no-op unsubscribe for unknown tabId). */
  subscribeSelection(tabId: string, cb: (hasSelection: boolean) => void): () => void;
  /** Tears the tab's terminal down: unsubscribes `onData`, `term.dispose()`, detaches+drops the holder. No leak: the record leaves the map entirely. */
  dispose(tabId: string): void;
  /** Test-only escape hatch: disposes every tracked terminal. Production code never calls this. */
  reset(): void;
  /**
   * Pushes fresh xterm ANSI theme colors (§2.5/UI-8) into every currently-open
   * terminal via its live `options.theme` setter. No-op for any tracked
   * `TerminalLike` that doesn't expose `options` (this module's test
   * doubles never do). New terminals created after this call pick up the
   * resolved theme on construction instead (see `defaultFactories`).
   * Optional so existing `TerminalView` test doubles elsewhere
   * (tab-registry.test.ts's `createFakeTerminalView`) keep typechecking
   * without adding an unused stub.
   */
  applyTheme?(resolved: ResolvedTheme): void;
}

/** Builds an isolated terminal-view registry; `factories` is injectable so tests never touch real `@xterm/xterm` or `document`. */
export function createTerminalView(factories: TerminalFactories = defaultFactories): TerminalView {
  const records = new Map<string, TerminalRecord>();

  function notifyDead(record: TerminalRecord, dead: boolean): void {
    if (record.dead === dead) {
      return;
    }
    record.dead = dead;
    for (const listener of record.deadListeners) {
      listener(dead);
    }
  }

  return {
    ensure(tabId, onInput): void {
      const existing = records.get(tabId);
      if (existing) {
        existing.onInput = onInput;
        return;
      }
      const term = factories.createTerminal();
      const fit = factories.createFitAddon();
      term.loadAddon(fit);
      const holder = factories.createHolder();
      const record: TerminalRecord = {
        term,
        fit,
        holder,
        onInput,
        inputSub: { dispose(): void {} },
        dead: false,
        opened: false,
        deadListeners: new Set(),
        selectionSub: { dispose(): void {} },
        selectionListeners: new Set(),
      };
      record.inputSub = term.onData((data) => record.onInput(data));
      record.selectionSub = term.onSelectionChange(() => {
        const has = term.hasSelection();
        for (const listener of record.selectionListeners) {
          listener(has);
        }
      });
      records.set(tabId, record);
    },

    attachHolder(tabId, container): void {
      const record = records.get(tabId);
      if (!record) {
        return;
      }
      if (!record.opened) {
        container.replaceChildren(record.holder);
        record.term.open(record.holder);
        record.opened = true;
      } else if (record.holder.parentElement !== container) {
        container.replaceChildren(record.holder);
      }
    },

    write(tabId, data, onFlushed): void {
      records.get(tabId)?.term.write(data, onFlushed);
    },

    markOpened(tabId, replay): void {
      const record = records.get(tabId);
      if (!record) {
        return;
      }
      notifyDead(record, false);
      if (replay) {
        record.term.write(replay);
      }
    },

    markDead(tabId, reason): void {
      const record = records.get(tabId);
      if (!record) {
        return;
      }
      notifyDead(record, true);
      record.term.write(`\r\n\x1b[31m[terminal exited: ${reason}]\x1b[0m\r\n`);
    },

    fitNow(tabId): TerminalDims | undefined {
      const record = records.get(tabId);
      if (!record) {
        return undefined;
      }
      record.fit.fit();
      return { cols: record.term.cols, rows: record.term.rows };
    },

    currentDims(tabId): TerminalDims | undefined {
      const record = records.get(tabId);
      return record ? { cols: record.term.cols, rows: record.term.rows } : undefined;
    },

    isDead(tabId): boolean {
      return records.get(tabId)?.dead ?? false;
    },

    has(tabId): boolean {
      return records.has(tabId);
    },

    subscribeDead(tabId, cb): () => void {
      const record = records.get(tabId);
      if (!record) {
        return () => {};
      }
      record.deadListeners.add(cb);
      return () => record.deadListeners.delete(cb);
    },

    clear(tabId): void {
      records.get(tabId)?.term.clear();
    },

    getSelection(tabId): string {
      return records.get(tabId)?.term.getSelection() ?? "";
    },

    hasSelection(tabId): boolean {
      return records.get(tabId)?.term.hasSelection() ?? false;
    },

    subscribeSelection(tabId, cb): () => void {
      const record = records.get(tabId);
      if (!record) {
        return () => {};
      }
      record.selectionListeners.add(cb);
      return () => record.selectionListeners.delete(cb);
    },

    dispose(tabId): void {
      const record = records.get(tabId);
      if (!record) {
        return;
      }
      record.inputSub.dispose();
      record.selectionSub.dispose();
      record.term.dispose();
      record.holder.parentElement?.removeChild(record.holder);
      record.deadListeners.clear();
      record.selectionListeners.clear();
      records.delete(tabId);
    },

    reset(): void {
      for (const tabId of [...records.keys()]) {
        this.dispose(tabId);
      }
    },

    applyTheme(resolved): void {
      const theme = xtermThemeFor(resolved);
      for (const record of records.values()) {
        if (record.term.options) {
          record.term.options.theme = theme;
        }
      }
    },
  };
}

/** The app's single terminal-view registry, mirroring tab-registry.ts's own singleton-plus-factory shape. */
export const terminalView = createTerminalView();

// Best-effort xterm theme sync (§2.5/UI-8): wired only for the production
// singleton, not inside `createTerminalView` itself, so the factory stays
// free of any global-store coupling for tests (`createTerminalView(rig.factories)`
// never touches `theme.ts`). Each currently-open terminal's colors flip live;
// terminals created after a flip already pick up the new theme via
// `defaultFactories.createTerminal`'s `getResolvedTheme()` read.
subscribeResolvedTheme((resolved) => terminalView.applyTheme?.(resolved));

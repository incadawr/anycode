/**
 * Command palette (ui-roadmap §4-R5) — the shell's control strip and, by
 * charter, its shortcut sheet: every action wears the keystroke that skips the
 * palette next time. Two modes: "actions" (the command list) and "sessions"
 * (the sidebar's session index in searchable form). A native `<dialog>` opened
 * with `showModal()` (PermissionModal/SettingsDialog lifecycle) supplies the
 * top-layer paint + focus trap; the palette mounts only while open (ruling A),
 * so query/selection reset for free.
 *
 * Roving selection is `aria-activedescendant` on the combobox input — DOM focus
 * never leaves the input (the filter-input idiom, deliberately NOT ModeMenu's
 * real-focus roving). Esc is owned via `onCancel` preventDefault (never falls
 * through to R3's interrupt). Focus is captured on mount and explicitly restored
 * on unmount (ruling B), covering Esc, Enter-run, and backdrop-click uniformly.
 *
 * `buildPaletteRows` is the tested pure core (frozen pure-export law, the
 * Sidebar/`buildSidebarGroups` pattern) — no React, no DOM.
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { TabInfo } from "../tabs-store.js";
import type { SessionSummary } from "../../../shared/tabs.js";
import type { DesktopPlatform } from "../../../shared/window.js";
import { buildSidebarGroups, type SidebarGroup, type SidebarRow } from "./Sidebar.js";
import { nextRovingIndex } from "./ModeMenu.js";
import { fuzzyMatch, type MatchRange } from "../fuzzy.js";
import { highlight } from "./highlight.js";
import { formatTabHint, KEYMAP, matchKeymap, type ActionId, type KeyBinding } from "../keymap.js";

/** Display fallback for a titleless session — mirrors Sidebar's private `UNTITLED` (Sidebar.tsx:19); reversed to recover the raw (undefined) title for resume forwarding. */
const UNTITLED = "Untitled task";

export type PaletteMode = "actions" | "sessions";

export interface PaletteAction {
  id: ActionId;
  label: string;
  /** Preformatted binding hint (App runs formatBinding) — null renders no hint. */
  hint: string | null;
  enabled: boolean;
  /** Row executes but the palette stays open (mode-switch bridge rows). */
  keepOpen?: boolean;
  run(): void;
}

export interface CommandPaletteProps {
  mode: PaletteMode;
  actions: readonly PaletteAction[];
  tabs: readonly TabInfo[];
  platform: DesktopPlatform;
  /** Effective keymap for the palette's own ⌘K-close/⌘P-sessions combos (F20 overrides). Defaults to the built-in KEYMAP. */
  keymapTable?: readonly KeyBinding[];
  onSwitchMode(mode: PaletteMode): void;
  onSelectTab(tabId: string): void;
  onResumeSession(sessionId: string, title: string | undefined): void;
  onClose(): void;
}

export type PaletteRow =
  | { kind: "group"; label: string }
  | { kind: "action"; action: PaletteAction; ranges: readonly MatchRange[] }
  | {
      kind: "tab";
      tabId: string;
      title: string;
      workspaceLabel: string;
      hint: string | null;
      ranges: readonly MatchRange[];
    }
  | {
      kind: "session";
      sessionId: string;
      title: string | undefined;
      displayTitle: string;
      workspaceLabel: string;
      age: string;
      ranges: readonly MatchRange[];
    };

/** ⌘n hint for a tab, or null past the ninth open tab (indexed by tabs-store order, ruling J). */
function tabHint(tabId: string, tabOrder: readonly string[], platform: DesktopPlatform): string | null {
  const idx = tabOrder.indexOf(tabId);
  return idx >= 0 && idx < 9 ? formatTabHint(idx + 1, platform) : null;
}

function makeTabRow(
  row: SidebarRow,
  workspaceLabel: string,
  tabOrder: readonly string[],
  platform: DesktopPlatform,
  ranges: readonly MatchRange[],
): PaletteRow {
  return {
    kind: "tab",
    tabId: row.tabId!,
    title: row.title,
    workspaceLabel,
    hint: tabHint(row.tabId!, tabOrder, platform),
    ranges,
  };
}

function makeSessionRow(row: SidebarRow, workspaceLabel: string, ranges: readonly MatchRange[]): PaletteRow {
  const displayTitle = row.title;
  return {
    kind: "session",
    sessionId: row.sessionId!,
    // Recover the raw (possibly undefined) title so resume forwarding never
    // persists the "Untitled task" display fallback (Sidebar.tsx:249's rule).
    title: displayTitle === UNTITLED ? undefined : displayTitle,
    displayTitle,
    workspaceLabel,
    age: row.age ?? "",
    ranges,
  };
}

function buildActionRows(query: string, actions: readonly PaletteAction[]): PaletteRow[] {
  if (query.length === 0) {
    return actions.map((action): PaletteRow => ({ kind: "action", action, ranges: [] }));
  }
  const scored: Array<{ action: PaletteAction; index: number; score: number; ranges: readonly MatchRange[] }> = [];
  actions.forEach((action, index) => {
    const labelMatch = fuzzyMatch(query, action.label);
    if (labelMatch) {
      scored.push({ action, index, score: labelMatch.score, ranges: labelMatch.ranges });
      return;
    }
    // Hint hit keeps rank but highlights nothing (roadmap c3: searchable by name OR keystroke).
    const hintMatch = action.hint ? fuzzyMatch(query, action.hint) : null;
    if (hintMatch) {
      scored.push({ action, index, score: hintMatch.score, ranges: [] });
    }
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.action.label.length !== b.action.label.length) {
      return a.action.label.length - b.action.label.length;
    }
    return a.index - b.index;
  });
  return scored.map((e): PaletteRow => ({ kind: "action", action: e.action, ranges: e.ranges }));
}

function buildSessionRows(
  query: string,
  groups: readonly SidebarGroup[],
  tabOrder: readonly string[],
  platform: DesktopPlatform,
): PaletteRow[] {
  if (query.length === 0) {
    const rows: PaletteRow[] = [];
    for (const group of groups) {
      rows.push({ kind: "group", label: group.label });
      for (const row of group.rows) {
        rows.push(
          row.kind === "open"
            ? makeTabRow(row, group.label, tabOrder, platform, [])
            : makeSessionRow(row, group.label, []),
        );
      }
    }
    return rows;
  }

  // Non-empty query: flat, ranked, no group rows. Rank on the display title;
  // fall back to the workspace label as a rank-only match (highlight nothing).
  const scored: Array<{ row: SidebarRow; label: string; index: number; score: number; ranges: readonly MatchRange[] }> =
    [];
  let index = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      const titleMatch = fuzzyMatch(query, row.title);
      if (titleMatch) {
        scored.push({ row, label: group.label, index, score: titleMatch.score, ranges: titleMatch.ranges });
      } else {
        const wsMatch = fuzzyMatch(query, group.label);
        if (wsMatch) {
          scored.push({ row, label: group.label, index, score: wsMatch.score, ranges: [] });
        }
      }
      index += 1;
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.row.title.length !== b.row.title.length) {
      return a.row.title.length - b.row.title.length;
    }
    return a.index - b.index;
  });
  return scored.map((e) =>
    e.row.kind === "open"
      ? makeTabRow(e.row, e.label, tabOrder, platform, e.ranges)
      : makeSessionRow(e.row, e.label, e.ranges),
  );
}

/**
 * Pure row builder (exported for CommandPalette.test.ts). `selected` in the
 * component indexes the SELECTABLE rows — `rows.filter(r => r.kind !== "group")`
 * — so group rows must be interleaved without disturbing that count.
 */
export function buildPaletteRows(args: {
  mode: PaletteMode;
  query: string;
  actions: readonly PaletteAction[];
  groups: readonly SidebarGroup[];
  tabOrder: readonly string[];
  platform: DesktopPlatform;
}): PaletteRow[] {
  const { mode, query, actions, groups, tabOrder, platform } = args;
  return mode === "actions"
    ? buildActionRows(query, actions)
    : buildSessionRows(query, groups, tabOrder, platform);
}

export function CommandPalette({
  mode,
  actions,
  tabs,
  platform,
  keymapTable = KEYMAP,
  onSwitchMode,
  onSelectTab,
  onResumeSession,
  onClose,
}: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);

  // Mount: capture focus, open the modal, force focus onto the input (native
  // <dialog> + React autoFocus is historically flaky — belt-and-braces). Cleanup
  // restores focus to the pre-open element if it is still in the document.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    inputRef.current?.focus();
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Fetch the persisted-session index once (fail-soft: a rejection leaves
  // `sessions` null → buildSidebarGroups still lists open tabs; no error banner,
  // the sidebar owns that surface).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await window.anycode.listSessions();
        if (!cancelled) {
          setSessions(list);
        }
      } catch {
        /* fail-soft — leave sessions null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset query + selection whenever the mode changes (⌘P/⌘G bridge, ruling M).
  useEffect(() => {
    setQuery("");
    setSelected(0);
  }, [mode]);

  const groups = buildSidebarGroups(tabs, sessions);
  const tabOrder = tabs.map((t) => t.tabId);
  const rows = buildPaletteRows({ mode, query, actions, groups, tabOrder, platform });
  const selectable = rows.filter((r) => r.kind !== "group");
  const activeIndex = Math.min(selected, Math.max(0, selectable.length - 1));
  const activeId = selectable.length > 0 ? `palette-opt-${activeIndex}` : undefined;

  // Keep the selected row scrolled into view.
  useEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);

  function execute(row: PaletteRow): void {
    if (row.kind === "group") {
      return;
    }
    if (row.kind === "action") {
      if (!row.action.enabled) {
        return;
      }
      if (row.action.keepOpen) {
        row.action.run();
        return;
      }
      // Close first, run after the focus-restore lands (ruling B) — prevents a
      // restore/steal fight with actions that move focus (mode.focus).
      onClose();
      requestAnimationFrame(() => row.action.run());
      return;
    }
    if (row.kind === "tab") {
      onClose();
      const { tabId } = row;
      requestAnimationFrame(() => onSelectTab(tabId));
      return;
    }
    onClose();
    const { sessionId, title } = row;
    requestAnimationFrame(() => onResumeSession(sessionId, title));
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    // Let an in-flight IME composition own its keystrokes (the same discipline
    // the shell-level keydown owner applies, App.tsx): a CJK/complex-script
    // commit fires an Enter keydown with isComposing=true — without this guard
    // it would be swallowed here and execute an unintended row.
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(nextRovingIndex(activeIndex, 1, selectable.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(nextRovingIndex(activeIndex, -1, selectable.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = selectable[activeIndex];
      if (row) {
        execute(row);
      }
      return;
    }
    // Palette-internal mod-combos (ruling G): ⌘K closes, ⌘P/⌘G → sessions mode.
    const match = matchKeymap(event, platform, keymapTable);
    if (match?.action === "palette.toggle") {
      event.preventDefault();
      onClose();
      return;
    }
    if (match?.action === "palette.sessions") {
      event.preventDefault();
      onSwitchMode("sessions");
    }
    // Escape is handled by the native cancel event; everything else falls to the input.
  }

  function onDialogClick(event: MouseEvent<HTMLDialogElement>): void {
    // Padding-0 card ⇒ only ::backdrop clicks hit the dialog element itself.
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  let selectableIndex = -1;

  return (
    <dialog
      ref={dialogRef}
      className="command-palette"
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={onDialogClick}
      onKeyDown={onDialogKeyDown}
    >
      <div className="command-palette-input-row">
        {mode === "sessions" && <span className="command-palette-mode-badge">Tasks</span>}
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          aria-label={mode === "actions" ? "Search commands" : "Search tasks"}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-controls="command-palette-list"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder={mode === "actions" ? "Search commands…" : "Search tasks…"}
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
        />
      </div>

      <ul className="command-palette-list" id="command-palette-list" role="listbox">
        {rows.map((row, i) => {
          if (row.kind === "group") {
            return (
              <li key={`group-${i}`} role="presentation" className="command-palette-group">
                {row.label}
              </li>
            );
          }
          selectableIndex += 1;
          const optIndex = selectableIndex;
          const optId = `palette-opt-${optIndex}`;
          const disabled = row.kind === "action" && !row.action.enabled;
          const key =
            row.kind === "action" ? `action-${row.action.id}` : row.kind === "tab" ? `tab-${row.tabId}` : `session-${row.sessionId}`;
          return (
            <li
              key={key}
              id={optId}
              role="option"
              aria-selected={optIndex === activeIndex}
              aria-disabled={disabled || undefined}
              className="command-palette-row"
              onMouseMove={() => setSelected(optIndex)}
              onClick={() => execute(row)}
            >
              {row.kind === "action" && (
                <>
                  <span className="command-palette-row-label">{highlight(row.action.label, row.ranges)}</span>
                  {row.action.hint && <kbd className="command-palette-hint">{row.action.hint}</kbd>}
                </>
              )}
              {row.kind === "tab" && (
                <>
                  <span className="command-palette-row-label">{highlight(row.title, row.ranges)}</span>
                  <span className="command-palette-row-meta">{row.workspaceLabel}</span>
                  {row.hint && <kbd className="command-palette-hint">{row.hint}</kbd>}
                </>
              )}
              {row.kind === "session" && (
                <>
                  <span className="command-palette-row-label">{highlight(row.displayTitle, row.ranges)}</span>
                  <span className="command-palette-row-meta">{row.workspaceLabel}</span>
                  <span className="command-palette-age">{row.age}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {selectable.length === 0 && (
        <div className="command-palette-empty" role="status">
          {mode === "actions" ? "No matching commands" : "No tasks match"}
        </div>
      )}
    </dialog>
  );
}

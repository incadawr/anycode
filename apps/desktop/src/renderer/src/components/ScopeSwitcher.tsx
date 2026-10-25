/**
 * Taskana 4758: ONE scope dropdown for the Settings panes that read or write a
 * config folder (MCP servers, Language servers, Skills, Subagents). The
 * trigger shows "User · This computer" or a recent folder; the menu lists the
 * user scope first, then the folders main reports (open tabs and recent root
 * sessions). The selection is an opaque id; the renderer never handles a path
 * for a request. Replaces the Taskana 4706 Global/Project switcher.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type Ref } from "react";
import { Check, Chevron, Folder } from "./icons.js";
import type { ScopeWorkspaceEntry } from "../../../shared/scope-workspaces.js";
import {
  disambiguateScopeLabels,
  filterScopeEntries,
  nextActiveIndex,
  userScopeLabel,
  type ScopeSelection,
} from "./scope-model.js";

/** Above this many folders the menu shows a filter input. */
const FILTER_THRESHOLD = 6;

export interface ScopeOption {
  selection: ScopeSelection;
  /** Present for workspace options only. */
  entry?: ScopeWorkspaceEntry;
  enabled: boolean;
}

/** The user option followed by the (filtered) folder options, in display order. */
export function buildScopeOptions(entries: readonly ScopeWorkspaceEntry[], query: string): ScopeOption[] {
  const visible = filterScopeEntries(entries, query);
  return [
    { selection: { kind: "user" }, enabled: true },
    ...visible.map((entry) => ({
      selection: { kind: "workspace" as const, id: entry.id },
      entry,
      enabled: entry.exists,
    })),
  ];
}

function selectionKey(selection: ScopeSelection): string {
  return selection.kind === "user" ? "user" : selection.id;
}

function sameSelection(a: ScopeSelection, b: ScopeSelection): boolean {
  return selectionKey(a) === selectionKey(b);
}

function ComputerGlyph(): ReactElement {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="8" rx="1.5" />
      <path d="M6 13.5h4M8 11v2.5" strokeLinecap="round" />
    </svg>
  );
}

export interface ScopeMenuViewProps {
  selection: ScopeSelection;
  entries: readonly ScopeWorkspaceEntry[];
  query: string;
  activeIndex: number;
  onQueryChange?: (query: string) => void;
  onPick?: (next: ScopeSelection) => void;
  menuRef?: Ref<HTMLDivElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** The open menu's markup. Pure over its props, so tests render it with renderToStaticMarkup. */
export function ScopeMenuView({
  selection,
  entries,
  query,
  activeIndex,
  onQueryChange,
  onPick,
  menuRef,
  onKeyDown,
}: ScopeMenuViewProps): ReactElement {
  const labels = disambiguateScopeLabels(entries);
  const options = buildScopeOptions(entries, query);
  const visibleEntries = options.slice(1).map((option) => option.entry!);
  const showFilter = entries.length > FILTER_THRESHOLD;
  const optionClass = (index: number, enabled: boolean): string =>
    `scope-dropdown-option${index === activeIndex ? " scope-dropdown-option-active" : ""}${enabled ? "" : " scope-dropdown-option-disabled"}`;

  return (
    <div
      ref={menuRef}
      className="scope-dropdown-menu"
      role="listbox"
      aria-label="Settings scope"
      data-scope-menu
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div
        role="option"
        aria-selected={sameSelection(selection, { kind: "user" })}
        data-scope-option="user"
        className={optionClass(0, true)}
        onClick={() => onPick?.({ kind: "user" })}
      >
        <ComputerGlyph />
        <span className="scope-dropdown-name">{userScopeLabel()}</span>
        {sameSelection(selection, { kind: "user" }) && <Check className="scope-dropdown-check" />}
      </div>

      <div className="scope-dropdown-heading" role="presentation">
        Workspaces
      </div>
      {showFilter && (
        <input
          type="search"
          className="settings-search-input scope-dropdown-search"
          aria-label="Filter workspaces"
          data-scope-search
          placeholder="Filter folders"
          value={query}
          onChange={(event) => onQueryChange?.(event.target.value)}
        />
      )}

      {entries.length === 0 && (
        <p className="scope-dropdown-empty">No recent folders yet. Start a session in a folder and it will appear here.</p>
      )}
      {entries.length > 0 && visibleEntries.length === 0 && <p className="scope-dropdown-empty">No matching folders.</p>}

      {options.slice(1).map((option, index) => {
        const entry = option.entry!;
        const selected = sameSelection(selection, option.selection);
        return (
          <div
            key={entry.id}
            role="option"
            aria-selected={selected}
            aria-disabled={entry.exists ? undefined : "true"}
            data-scope-option={entry.id}
            className={optionClass(index + 1, entry.exists)}
            onClick={() => {
              if (entry.exists) onPick?.(option.selection);
            }}
          >
            <Folder />
            <span className="scope-dropdown-name">{labels.get(entry.id) ?? entry.name}</span>
            <span className="scope-dropdown-path">{entry.displayPath}</span>
            {entry.tabIds.length > 0 && <span className="scope-dropdown-badge">open</span>}
            {!entry.exists && <span className="scope-dropdown-missing">folder not found</span>}
            {selected && <Check className="scope-dropdown-check" />}
          </div>
        );
      })}
    </div>
  );
}

export interface ScopeDropdownProps {
  selection: ScopeSelection;
  entries: readonly ScopeWorkspaceEntry[];
  loading: boolean;
  /** Fired each time the menu opens so the parent refetches the list. */
  onOpen(): void;
  onSelect(next: ScopeSelection): void;
  countLabel?: string;
  hint?: string | null;
  fellBackNote?: string | null;
}

export function ScopeDropdown({
  selection,
  entries,
  loading,
  onOpen,
  onSelect,
  countLabel,
  hint,
  fellBackNote,
}: ScopeDropdownProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const labels = disambiguateScopeLabels(entries);
  const triggerLabel =
    selection.kind === "user"
      ? userScopeLabel()
      : (labels.get(selection.id) ?? entries.find((entry) => entry.id === selection.id)?.name ?? "Folder");
  const isWorkspace = selection.kind === "workspace";

  function openMenu(): void {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
    onOpen();
  }

  function closeMenu(restoreFocus: boolean): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  // Focus the menu once it renders so arrow keys work immediately.
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  // Outside pointer closes the menu (EnvironmentMenu pattern).
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  function pick(next: ScopeSelection): void {
    onSelect(next);
    closeMenu(true);
  }

  const options = buildScopeOptions(entries, query);
  const enabledIndexes = options.flatMap((option, index) => (option.enabled ? [index] : []));
  // Keep the active option on a valid index while the filter narrows the list.
  const currentActive = enabledIndexes.includes(activeIndex) ? activeIndex : (enabledIndexes[0] ?? 0);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    const inSearch = event.target instanceof HTMLInputElement;
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[currentActive];
      if (option?.enabled) pick(option.selection);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || (!inSearch && (event.key === "Home" || event.key === "End"))) {
      event.preventDefault();
      setActiveIndex(nextActiveIndex(event.key, currentActive, enabledIndexes));
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
    }
  }

  return (
    <div className="scope-dropdown" ref={rootRef}>
      <div className="scope-dropdown-bar">
        <button
          ref={triggerRef}
          type="button"
          className="settings-field-select scope-dropdown-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          data-scope-trigger
          data-scope-value={selectionKey(selection)}
          aria-busy={loading || undefined}
          onClick={() => (open ? closeMenu(false) : openMenu())}
          onKeyDown={handleTriggerKeyDown}
        >
          {isWorkspace ? <Folder /> : <ComputerGlyph />}
          <span className="scope-dropdown-label">{triggerLabel}</span>
          <Chevron className="scope-dropdown-chevron" />
        </button>
        {countLabel ? (
          <span className="scope-count" data-scope-count>
            {countLabel}
          </span>
        ) : null}
      </div>

      {open && (
        <ScopeMenuView
          menuRef={menuRef}
          selection={selection}
          entries={entries}
          query={query}
          activeIndex={currentActive}
          onQueryChange={(next) => {
            setQuery(next);
            setActiveIndex(0);
          }}
          onPick={pick}
          onKeyDown={handleMenuKeyDown}
        />
      )}

      {fellBackNote ? <p className="scope-hint" role="status">{fellBackNote}</p> : null}
      {hint ? (
        <p className="scope-hint" data-scope-hint>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

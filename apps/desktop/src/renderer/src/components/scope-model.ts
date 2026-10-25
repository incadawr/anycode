/**
 * Taskana 4758: pure model behind the Settings scope dropdown. A selection is
 * either the user scope or an opaque workspace id from the main-side list.
 * No function here takes or returns a filesystem path for a request; the
 * `displayPath` field is for labels only.
 */
import type { ScopeWorkspaceEntry } from "../../../shared/scope-workspaces.js";

/** Name of the machine the user scope lives on. A remote entry would reuse `User · <machine>`. */
export const SCOPE_MACHINE_LABEL = "This computer";

export type ScopeSelection = { kind: "user" } | { kind: "workspace"; id: string };

export const USER_SCOPE: ScopeSelection = { kind: "user" };

export function userScopeLabel(): string {
  return `User · ${SCOPE_MACHINE_LABEL}`;
}

/** Last segment of the parent directory of a display path ("~/work/app" => "work"). */
function parentSegment(displayPath: string): string {
  const parts = displayPath.split("/").filter((part) => part !== "");
  if (parts.length < 2) return "/";
  return parts[parts.length - 2] ?? "/";
}

/**
 * id -> label. Unique basenames stay plain; a duplicated basename becomes
 * `name (parent)`; if that still collides (same name, same parent) the full
 * displayPath is used for the colliding entries.
 */
export function disambiguateScopeLabels(entries: readonly ScopeWorkspaceEntry[]): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, ScopeWorkspaceEntry[]>();
  for (const entry of entries) {
    const group = byName.get(entry.name) ?? [];
    group.push(entry);
    byName.set(entry.name, group);
  }
  for (const group of byName.values()) {
    const [only] = group;
    if (group.length === 1 && only !== undefined) {
      labels.set(only.id, only.name);
      continue;
    }
    const withParent = group.map((entry) => ({ entry, label: `${entry.name} (${parentSegment(entry.displayPath)})` }));
    const counts = new Map<string, number>();
    for (const { label } of withParent) counts.set(label, (counts.get(label) ?? 0) + 1);
    for (const { entry, label } of withParent) {
      labels.set(entry.id, (counts.get(label) ?? 0) > 1 ? entry.displayPath : label);
    }
  }
  return labels;
}

/** Case-insensitive substring match over name and displayPath. Empty query returns every entry. */
export function filterScopeEntries(entries: readonly ScopeWorkspaceEntry[], query: string): ScopeWorkspaceEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...entries];
  return entries.filter(
    (entry) => entry.name.toLowerCase().includes(needle) || entry.displayPath.toLowerCase().includes(needle),
  );
}

export interface ScopeResolution {
  selection: ScopeSelection;
  /** The scope reference passed to the panes: undefined for user, the workspace id otherwise. */
  ref: string | undefined;
  entry: ScopeWorkspaceEntry | undefined;
  /** True when a selected workspace vanished or no longer exists, so the scope fell back to user. */
  fellBack: boolean;
}

export function resolveScopeSelection(
  selection: ScopeSelection,
  entries: readonly ScopeWorkspaceEntry[],
): ScopeResolution {
  if (selection.kind === "user") {
    return { selection, ref: undefined, entry: undefined, fellBack: false };
  }
  const entry = entries.find((candidate) => candidate.id === selection.id);
  if (entry === undefined || !entry.exists) {
    return { selection: USER_SCOPE, ref: undefined, entry: undefined, fellBack: true };
  }
  return { selection, ref: entry.id, entry, fellBack: false };
}

/** The reference the panes receive for a selection (see resolveScopeSelection). */
export function scopeRefFor(selection: ScopeSelection, entries: readonly ScopeWorkspaceEntry[]): string | undefined {
  return resolveScopeSelection(selection, entries).ref;
}

/** MCP live status dots apply only when the selected folder has the active tab open. */
export function mcpStatusActive(entry: ScopeWorkspaceEntry | undefined, activeTabId: string | null): boolean {
  return entry !== undefined && activeTabId !== null && entry.tabIds.includes(activeTabId);
}

export const SCOPE_NO_TAB_HINT =
  "This folder has no open tab. Changes are saved to its config files and apply when a session starts there.";

/** Hint under the bar: only for a selected workspace with no open tab. */
export function scopeHintFor(selection: ScopeSelection, entry: ScopeWorkspaceEntry | undefined): string | null {
  if (selection.kind === "user" || entry === undefined) return null;
  return entry.tabIds.length === 0 ? SCOPE_NO_TAB_HINT : null;
}

export type ScopeCountPane = "mcp" | "language-servers" | "skills" | "subagents";

const COUNT_NOUN: Record<ScopeCountPane, string> = {
  mcp: "Servers",
  "language-servers": "Servers",
  skills: "Skills",
  subagents: "Subagents",
};

/** The count chip text, e.g. "Skills 18". Empty while the count is unknown (loading). */
export function countLabel(pane: string, n: number | null): string {
  if (n === null) return "";
  const noun = COUNT_NOUN[pane as ScopeCountPane];
  return noun === undefined ? "" : `${noun} ${n}`;
}

export type ScopeKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * Next active option index for the dropdown's keyboard model. Arrow keys wrap
 * and skip disabled options; Home/End jump to the first/last enabled option.
 * `enabledIndexes` must be sorted ascending. Other keys leave the index alone.
 */
export function nextActiveIndex(key: string, index: number, enabledIndexes: readonly number[]): number {
  const first = enabledIndexes[0];
  const last = enabledIndexes[enabledIndexes.length - 1];
  if (first === undefined || last === undefined) return index;
  switch (key) {
    case "ArrowDown":
      return enabledIndexes.find((candidate) => candidate > index) ?? first;
    case "ArrowUp": {
      const before = enabledIndexes.filter((candidate) => candidate < index);
      return before[before.length - 1] ?? last;
    }
    case "Home":
      return first;
    case "End":
      return last;
    default:
      return index;
  }
}

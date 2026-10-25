/**
 * Pure view-model for the Language servers pane (Taskana 4743): request
 * builders, arg parsing, extension parsing, form validation, catalog row
 * state (found / enabled-per-scope / badge), the "both claim .py" overlap
 * hint, and notice selection by `projectTrusted`. Every function here is
 * unit-tested directly (language-servers-model.test.ts); the component is a
 * thin shell over them — same ethic as McpServersPane's exported helpers.
 *
 * Renderer-side rules this module encodes:
 *  - Enable/disable requests carry ONLY `{presetId|name, scope, tabId}` —
 *    never a path (path custody lives main-side).
 *  - Args come from a single text field parsed by `splitArgs` (a small
 *    shell-FREE parser with quote support — no shlex, no spawn).
 *  - `projectTrusted === false` changes the trust notice wording (entry
 *    saved but inactive); `null` shows the generic notice.
 */

import type {
  LspCatalogStatusEntry,
  LspConfigRefusalReason,
  LspConfigScope,
  LspConfigStatus,
  LspCustomEntryInput,
  LspCustomUpsertRequest,
  LspDisableRequest,
  LspEnableRequest,
  LspEntryView,
} from "../../../shared/lsp-config.js";

// ── text parsing ──

/**
 * Splits an args text into argv, honoring single and double quotes (a quoted
 * token may contain spaces; a quote mid-token attaches, like a shell — but
 * with NO shell semantics: no escapes beyond the closing quote, no expansion,
 * and nothing is ever executed). Unclosed quotes take the rest of the line.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n") {
      if (started || current !== "") {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current !== "") {
    out.push(current);
  }
  return out;
}

/** Parses a comma/space separated extension list into normalized lowercase dot-form entries. */
export function parseExtensions(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "")
    .map((token) => (token.startsWith(".") ? token : `.${token}`));
}

// ── request builders ──

/** Enable request carries ONLY the preset id + scope + tab — the entry itself is resolved main-side. */
export function buildEnableRequest(tabId: string | undefined, presetId: string, scope: LspConfigScope): LspEnableRequest {
  return { tabId, presetId, scope };
}

export function buildDisableRequest(tabId: string | undefined, name: string, scope: LspConfigScope): LspDisableRequest {
  return { tabId, name, scope };
}

/** Custom form state, mirroring the zod schema the main boundary enforces. */
export interface CustomLspFormFields {
  name: string;
  command: string;
  argsText: string;
  extensionsText: string;
  scope: LspConfigScope;
}

export function blankCustomForm(scope: LspConfigScope): CustomLspFormFields {
  return { name: "", command: "", argsText: "", extensionsText: "", scope };
}

export function buildCustomEntry(fields: CustomLspFormFields): LspCustomEntryInput {
  const entry: LspCustomEntryInput = {
    name: fields.name.trim(),
    command: fields.command.trim(),
    extensions: parseExtensions(fields.extensionsText),
  };
  const args = splitArgs(fields.argsText);
  if (args.length > 0) {
    entry.args = args;
  }
  return entry;
}

export function buildCustomUpsertRequest(tabId: string | undefined, fields: CustomLspFormFields): LspCustomUpsertRequest {
  return { tabId, scope: fields.scope, entry: buildCustomEntry(fields) };
}

// ── form validation (mirrors main's zod + trim rules; renders the message the field shows) ──

export function validateCustomForm(fields: CustomLspFormFields): Partial<Record<"name" | "command" | "extensions", string>> {
  const errors: Partial<Record<"name" | "command" | "extensions", string>> = {};
  if (fields.name.trim() === "") {
    errors.name = "Name is required.";
  } else if (["__proto__", "constructor", "prototype"].includes(fields.name.trim())) {
    errors.name = "That name is reserved.";
  }
  if (fields.command.trim() === "") {
    errors.command = "Command is required — one executable name or absolute path (args go below).";
  }
  if (parseExtensions(fields.extensionsText).length === 0) {
    errors.extensions = "At least one file extension is required, e.g. .rs";
  }
  return errors;
}

export function canSubmitCustomForm(fields: CustomLspFormFields): boolean {
  return Object.keys(validateCustomForm(fields)).length === 0;
}

// ── catalog row view-model ──

/** Which scope(s) already define an entry with this row's name. */
export type EnabledScopes = { project: boolean; user: boolean };

export interface CatalogRowModel {
  entry: LspCatalogStatusEntry;
  /** Badge text: "Found" / "Only in project node_modules — not on PATH" / "Not installed". */
  badge: string;
  /**
   * True when the binary is present only in the project's node_modules/.bin
   * (detection `found: false, foundSource: "project"`): it exists but the app
   * spawns by PATH, so it will not start from there.
   */
  projectOnly: boolean;
  /** Hint line for the project-only state; null otherwise. */
  projectOnlyHint: string | null;
  /** True when the binary was not detected — enabling still allowed, with the warning note. */
  notInstalled: boolean;
  enabled: EnabledScopes;
  /** "Enabled (project)" / "Enabled (all projects)" / "Enabled (project, all projects)". */
  enabledLabel: string | null;
  /** True when another catalog entry shares an extension with this one (the pyright/basedpyright case). */
  extensionOverlap: boolean;
  overlapWith: string | null;
}

/** Extension-overlap detection across the CATALOG rows (not configured entries): ".py claimed by pyright too". */
export function findExtensionOverlap(entry: LspCatalogStatusEntry, catalog: readonly LspCatalogStatusEntry[]): { overlaps: boolean; with: string | null } {
  for (const other of catalog) {
    if (other.id === entry.id) continue;
    const shared = other.extensions.some((ext) => entry.extensions.includes(ext));
    if (shared) {
      return { overlaps: true, with: other.id };
    }
  }
  return { overlaps: false, with: null };
}

/**
 * Builds the row models. `status` is main's snapshot; the runtime servers are
 * not part of this computation (they render in the pane's live-status
 * section instead — the row's own state is config + detection only).
 */
export function buildCatalogRows(status: LspConfigStatus): CatalogRowModel[] {
  const projectNames = new Set((status.entries.project ?? []).map((entry) => entry.name));
  const userNames = new Set(status.entries.user.map((entry) => entry.name));
  return status.catalog.map((entry) => {
    const enabled = { project: projectNames.has(entry.id), user: userNames.has(entry.id) };
    const labels: string[] = [];
    if (enabled.project) labels.push("project");
    if (enabled.user) labels.push("all projects");
    const overlap = findExtensionOverlap(entry, status.catalog);
    const projectOnly = !entry.found && entry.foundSource === "project";
    return {
      entry,
      badge: entry.found ? "Found" : projectOnly ? PROJECT_ONLY_BADGE : "Not installed",
      projectOnly,
      projectOnlyHint: projectOnly ? PROJECT_ONLY_HINT : null,
      notInstalled: !entry.found,
      enabled,
      enabledLabel: labels.length > 0 ? `Enabled (${labels.join(", ")})` : null,
      extensionOverlap: overlap.overlaps,
      overlapWith: overlap.with,
    };
  });
}

/** Badge for a binary present only in the project's node_modules/.bin (never plain "Found"). */
export const PROJECT_ONLY_BADGE = "Only in project node_modules — not on PATH";

/** Hint shown under a project-only row: how to make the server actually startable. */
export const PROJECT_ONLY_HINT = "Install it globally (e.g. npm i -g <package>) or use a custom entry with the full path.";

/** Disabled-reason for the "Enable for this project" button; null when it is clickable. */
export function projectEnableDisabledReason(projectScopeAvailable: boolean): string | null {
  return projectScopeAvailable ? null : "No project is open";
}

/**
 * The one catalog-row action for the scope chosen in the Settings scope
 * dropdown: "User · This computer" (no project resolved) targets the user
 * config = every project; a folder targets that project. Replaces the old
 * pair of "Enable for this project" / "Enable for all projects" buttons.
 */
export interface CatalogRowAction {
  kind: "enable" | "remove";
  scope: LspConfigScope;
  label: string;
  ariaLabel: string;
  /** Shown on the row when viewing a project and the server is already on for every project. */
  inheritedNote: string | null;
}

export function catalogRowAction(
  row: { entry: { label: string }; enabled: { project: boolean; user: boolean } },
  projectScopeAvailable: boolean,
): CatalogRowAction {
  const scope: LspConfigScope = projectScopeAvailable ? "project" : "user";
  const on = scope === "project" ? row.enabled.project : row.enabled.user;
  const where = scope === "project" ? "this project" : "all projects";
  return {
    kind: on ? "remove" : "enable",
    scope,
    label: on ? "Turn off" : "Turn on",
    ariaLabel: `${on ? "Turn off" : "Turn on"} ${row.entry.label} for ${where}`,
    inheritedNote: scope === "project" && !row.enabled.project && row.enabled.user ? "On for all projects" : null,
  };
}

// ── notices (plain text, always rendered by the pane) ──

export const NEW_SESSIONS_NOTICE = "Changes apply to new sessions and tabs; open tabs keep the servers they started with.";

/**
 * The trust notice by `projectTrusted`: false names the state explicitly
 * (saved but inactive); null/true shows the generic sentence.
 */
export function trustNotice(projectTrusted: boolean | null): string {
  if (projectTrusted === false) {
    return "This folder is not trusted yet: project language servers are saved but stay inactive until you trust the folder.";
  }
  return "Project entries start only after you trust this folder.";
}

/** The enable note shown when the user enables a server whose binary was not detected. */
export const NOT_INSTALLED_NOTICE = "Binary not found on PATH — the server will fail to start until you install it.";

/** Refusal reasons mapped to user-facing sentences (mirrors mcpRefusalMessage). */
export function lspRefusalMessage(reason: LspConfigRefusalReason): string {
  switch (reason) {
    case "invalid":
      return "That entry isn't valid — check the name, command, and extensions.";
    case "unknown_preset":
      return "That catalog entry no longer exists — refresh the pane.";
    case "no_workspace":
      return "No project is open — open a workspace first, or use the all-projects scope.";
    case "io_error":
      return "Couldn't save — the config file couldn't be read or written.";
    case "invalid_shape":
      return "Couldn't save — \"lspServers\" in the config file isn't an array; fix it by hand first.";
    default:
      return "Couldn't save.";
  }
}

/** `command + args` joined for display (plain text rendering — never HTML). */
export function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].filter((part) => part !== "").join(" ");
}

/** Sorts configured entries alphabetically by name for stable lists. */
export function sortEntryViews(entries: readonly LspEntryView[]): LspEntryView[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

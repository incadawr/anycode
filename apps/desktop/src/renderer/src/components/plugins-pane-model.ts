/**
 * Plugins pane pure model (design 4732 §6, Taskana 4732 S1-C). Every
 * display decision the PluginsPane renders is a pure function here, unit
 * tested directly (same ethic as McpServersPane's exported helpers): status
 * chips per row, which actions a tier/status combo offers, index-status
 * header text, install-menu options, and the two-phase install sheet's
 * footer labels. The component file (PluginsPane.tsx) only wires these to
 * the bridge and the DOM.
 */

import type {
  IndexEntryView,
  PluginIndexStatus,
  PluginInstallPreview,
  PluginInstallSourceRequest,
  PluginRowView,
  PluginTier,
  PluginsRefusalReason,
  PluginsSnapshot,
} from "../../../shared/plugins-config.js";

// ── tier badges ──

/** Tier badge label (design §6): Official ✓ / Third-party / Local / Project / Legacy. */
export function pluginTierLabel(tier: PluginTier): string {
  switch (tier) {
    case "official":
      return "Official ✓";
    case "third-party":
      return "Third-party";
    case "local":
      return "Local";
    case "project":
      return "Project";
    case "legacy":
      return "Legacy";
    default: {
      const exhaustive: never = tier;
      return exhaustive;
    }
  }
}

/** The source's one-line provenance text (display-only; custody note in plugins-config.ts). */
export function pluginSourceText(source: PluginRowView["source"]): string {
  switch (source.kind) {
    case "official":
      return "AnyCode plugin index (signed)";
    case "url":
      return source.url;
    case "file":
      return source.fileName;
    case "git":
      return source.ref !== undefined ? `${source.url} (${source.ref})` : source.url;
    case "local":
      return source.path;
    case "project":
      return ".anycode/plugins (project)";
    case "legacy":
      return "~/.anycode/plugins (unmanaged)";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

// ── status chips ──

export interface PluginChip {
  /** Chip text — exactly what the row renders. */
  text: string;
  /** Tone drives the CSS class (`warn` = amber, `muted` = grey). */
  tone: "warn" | "muted";
}

/**
 * Ordered status chips for one row (design §6 card grammar). Order is the
 * render order: update → needs-approval → incompatible → inactive →
 * problems. Every input is already main-derived (updateVersion,
 * mcpNeedsApproval, incompatibleRange, active, problems) — this is pure
 * display mapping, no re-derivation of trust or compat.
 */
export function pluginStatusChips(row: PluginRowView): PluginChip[] {
  const chips: PluginChip[] = [];
  if (row.updateVersion !== undefined) {
    chips.push({ text: `Update available ${row.updateVersion}`, tone: "warn" });
  }
  if (row.mcpNeedsApproval) {
    chips.push({ text: "Needs approval", tone: "warn" });
  }
  if (row.incompatibleRange !== undefined) {
    chips.push({ text: `Incompatible (needs ${row.incompatibleRange})`, tone: "warn" });
  }
  if (!row.active) {
    chips.push({ text: "Inactive", tone: "muted" });
  }
  if (row.problems.length > 0) {
    chips.push({ text: `Problems (${row.problems.length})`, tone: "warn" });
  }
  return chips;
}

/** Capability summary line ("skills, agents, workflows · MCP: name1, name2 (needs approval)"). */
export function pluginCapabilitiesText(row: PluginRowView): string {
  const parts: string[] = [];
  const nonMcp = row.capabilities.filter((c) => c !== "mcp");
  if (nonMcp.length > 0) {
    parts.push(nonMcp.join(", "));
  }
  for (const server of row.mcpServers) {
    parts.push(`MCP ${server.name}${server.consented ? "" : " (needs approval)"}`);
  }
  return parts.join(" · ");
}

// ── actions per tier/status ──

export type PluginAction =
  | "update"
  | "rollback"
  | "pin"
  | "unpin"
  | "remove"
  | "reveal"
  | "approve-mcp";

/**
 * Which action buttons one row offers (design §6). Managed tiers
 * (official/third-party/local) get the full set, each gated by its own
 * precondition: update needs `updateVersion`; rollback needs
 * `previousVersion`; reveal is offered for managed + local only (project/
 * legacy have no managed directory to reveal — Reveal stays a Plugins-pane
 * affordance for the tiers main owns); approve-mcp needs `mcpNeedsApproval`;
 * remove is managed-only (project/legacy rows are removed by deleting the
 * directory — the docs say so, the pane does not pretend otherwise).
 * Project/legacy rows get only the enable toggle (component-level) and their
 * problems; `rollback` swaps active/previous AND pins — offered whenever a
 * previous version exists and the row is not already pinned (design §5).
 */
export function pluginRowActions(row: PluginRowView): PluginAction[] {
  const managed = row.tier === "official" || row.tier === "third-party" || row.tier === "local";
  const actions: PluginAction[] = [];
  if (managed && row.updateVersion !== undefined) {
    actions.push("update");
  }
  if (managed && row.previousVersion !== undefined && !row.pinned) {
    actions.push("rollback");
  }
  if (managed) {
    actions.push(row.pinned ? "unpin" : "pin");
  }
  if (row.mcpNeedsApproval) {
    actions.push("approve-mcp");
  }
  if (managed) {
    actions.push("remove");
  }
  if (managed || row.tier === "local") {
    actions.push("reveal");
  }
  return actions;
}

/** Rollback button label names the version it would return to. */
export function rollbackLabel(row: PluginRowView): string {
  return row.previousVersion !== undefined ? `Rollback to ${row.previousVersion}` : "Rollback";
}

// ── index header ──

export type IndexHeaderTone = "ok" | "warn" | "muted";

/** Index status row text + tone (design §6 header). */
export function pluginIndexStatusText(status: PluginIndexStatus): { text: string; tone: IndexHeaderTone } {
  switch (status) {
    case "ok":
      return { text: "Index up to date", tone: "ok" };
    case "offline":
      return { text: "Index offline — using the last verified copy", tone: "warn" };
    case "expired":
      return { text: "Index expired — no new installs or updates until it refreshes", tone: "warn" };
    case "signature_failed":
      return { text: "Index signature failed — refusing it", tone: "warn" };
    case "not_configured":
      return { text: "Official index not configured in this build", tone: "muted" };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** "Last checked" line — honest absent state, not a fake epoch. */
export function pluginIndexCheckedText(checkedAt: string | undefined): string {
  return checkedAt !== undefined ? `Last checked ${checkedAt}` : "Not checked yet";
}

// ── install menu ──

export type InstallMenuOption = {
  /** Menu label. */
  label: string;
  /** The source request this option starts (git is stage 2 — rendered but disabled). */
  source: PluginInstallSourceRequest;
  /** True when the option is not yet available in stage 1. */
  disabled: boolean;
};

/**
 * The "Install…" menu (design §6): file (.tgz) / URL / folder / git. `file`
 * and `folder` carry NO path — main opens its own picker (path custody).
 */
export function installMenuOptions(): InstallMenuOption[] {
  return [
    { label: "From file (.tgz)…", source: { kind: "file" }, disabled: false },
    { label: "From URL…", source: { kind: "url", url: "" }, disabled: false },
    { label: "From folder (dev link)…", source: { kind: "folder" }, disabled: false },
    { label: "From git (coming soon)", source: { kind: "git", url: "" }, disabled: true },
  ];
}

/** The source kind an "Install…" menu option would start, by option index. */
export function installSourceForOption(index: number): PluginInstallSourceRequest | undefined {
  return installMenuOptions()[index]?.source;
}

// ── available (index) rows ──

export interface AvailableRowState {
  /** Install button label. */
  label: string;
  /** Incompatible entries render greyed with the reason (design §6). */
  disabled: boolean;
  /** Why disabled, when they are. */
  reason?: string;
}

/** Available-from-AnyCode row state (design §6). */
export function availableRowState(entry: IndexEntryView): AvailableRowState {
  if (entry.incompatibleRange !== undefined) {
    return { label: "Install", disabled: true, reason: `Needs AnyCode ${entry.incompatibleRange}` };
  }
  if (entry.version === undefined) {
    return { label: "Install", disabled: true, reason: "No compatible version for this app" };
  }
  return { label: "Install", disabled: false };
}

// ── install sheet ──

/** Whether the sheet's footer must offer the "allow MCP servers" variant (design §4). */
export function sheetHasMcpServers(preview: PluginInstallPreview): boolean {
  return preview.mcpServers.length > 0;
}

/** Primary button label — "Install and allow MCP servers" only when MCP servers exist. */
export function sheetPrimaryLabel(preview: PluginInstallPreview, allowMcp: boolean): string {
  if (sheetHasMcpServers(preview)) {
    return allowMcp ? "Install and allow MCP servers" : "Install (MCP servers stay off)";
  }
  return "Install";
}

/**
 * The install button's own refusal copy (design §4 sheet is about consent;
 * a failed prepare never opens the sheet — these strings render inline in the
 * pane while the sheet is closed, or as the sheet's error row when a commit
 * fails).
 */
export function pluginsRefusalMessage(reason: PluginsRefusalReason): string {
  switch (reason) {
    case "invalid":
      return "That request isn't valid — check the URL or file and try again.";
    case "not_found":
      return "That plugin no longer exists — refresh and try again.";
    case "read_only_source":
      return "This plugin's source is read-only — it can't be changed here.";
    case "incompatible":
      return "That version isn't compatible with this version of AnyCode.";
    case "signature":
      return "The official index signature didn't verify — nothing was installed.";
    case "integrity":
      return "The download didn't match its checksum — nothing was installed.";
    case "too_large":
      return "That plugin archive is too large.";
    case "network":
      return "Couldn't reach the source — check your connection and try again.";
    case "io_error":
      return "A filesystem error occurred — nothing was installed.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

// ── pane-level helpers ──

/** Empty-state kind for the installed list. */
export type PluginsEmptyKind = "none" | "no_match" | null;

export function pluginsEmptyKind(total: number, filteredCount: number, query: string): PluginsEmptyKind {
  if (filteredCount > 0) return null;
  if (query.trim().length > 0) return "no_match";
  return "none";
}

/** Case-insensitive substring filter over name/displayName/description. */
export function filterPluginRows(rows: readonly PluginRowView[], query: string): PluginRowView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...rows];
  }
  return rows.filter((row) =>
    [row.name, row.displayName, row.description].some((field) => field.toLowerCase().includes(needle)),
  );
}

/** Whether a snapshot shows ANY third-party-or-lower tier (drives the consent reminder line). */
export function hasNonOfficialPlugins(snapshot: PluginsSnapshot): boolean {
  return snapshot.plugins.some(
    (row) => row.tier === "third-party" || row.tier === "local" || row.tier === "project" || row.tier === "legacy",
  );
}

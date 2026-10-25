/**
 * Plugins pane pure model (design 4732 §6, Taskana 4732 S1-C, reconciled to
 * the S1-B wire contract). Every display decision the PluginsPane renders is
 * a pure function here, unit tested directly (same ethic as McpServersPane's
 * exported helpers): status chips per row, which actions a tier/status combo
 * offers, index-status header text, install-menu options, and the two-phase
 * install sheet's footer labels. The component file (PluginsPane.tsx) only
 * wires these to the bridge and the DOM.
 *
 * ROW SHAPE: `PluginRowView` is S1-B main's row (mirrors core's
 * PluginAdminRow trimmed to the wire): a `status` lifecycle field, optional
 * `managed` bookkeeping (enabled/pinned/previous), `updateAvailable`, and
 * MCP consent as `mcpServerNames` + `mcpConsentGranted`. This model derives
 * the S1-C display vocabulary from those fields — no trust or compat
 * re-derivation happens renderer-side.
 */

import type {
  IndexEntryView,
  PluginInstallPreview,
  PluginInstallSource,
  PluginRowView,
  PluginServiceView,
  PluginTierView,
  PluginsIndexStatus,
  PluginsRefusalReason,
  PluginsSnapshot,
} from "../../../shared/plugins-config.js";

// ── tier badges ──

/** Tier badge label (design §6): Official ✓ / Third-party / Local / Project / Legacy. */
export function pluginTierLabel(tier: PluginTierView): string {
  switch (tier) {
    case "official":
      return "Official ✓";
    case "third-party":
      return "Third-party";
    case "local":
      return "Local";
    case "project":
      return "Project";
    case "legacy-user":
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
      return source.url ?? "";
    case "file":
      return source.fileName ?? "local archive";
    case "git":
      return source.ref !== undefined ? `${source.url ?? ""} (${source.ref})` : source.url ?? "";
    case "local":
      return source.path ?? "linked folder";
    case "dir":
      return "plugin folder (hand-placed)";
    default: {
      // Non-exhaustive on purpose: `kind` is an open string on the wire
      // (core may add kinds); unknown kinds degrade to their literal.
      return String((source as { kind: string }).kind);
    }
  }
}

// ── row derivations (S1-B fields → S1-C display state) ──

/** Whether the row's enable toggle reads ON (managed `enabled`, default true). */
export function pluginEnabled(row: PluginRowView): boolean {
  return row.managed?.enabled ?? true;
}

/** Whether the row is pinned (managed only). */
export function pluginPinned(row: PluginRowView): boolean {
  return row.managed?.pinned ?? false;
}

/** Retained previous version (rollback target), when one exists. */
export function pluginPreviousVersion(row: PluginRowView): string | undefined {
  return row.managed?.previous;
}

/** Whether any MCP server lacks consent (chip "Needs approval"). */
export function pluginMcpNeedsApproval(row: PluginRowView): boolean {
  return row.mcpServerNames.length > 0 && row.mcpConsentGranted !== true;
}

/** Secret NAMES a plugin's services read, sorted and unique (Taskana 4751 part 0; names only). */
export function serviceSecretNamesOf(row: PluginRowView): string[] {
  const names = new Set<string>();
  for (const service of row.services ?? []) {
    for (const name of service.secretNames ?? []) names.add(name);
  }
  return [...names].sort();
}

/** Whether the plugin declares background services that lack consent for their current definition (Taskana 4750a). */
export function servicesNeedApproval(row: PluginRowView): boolean {
  return row.serviceNames.length > 0 && row.servicesConsentGranted !== true;
}

/** Sessions-API state as the pane reads it (`communication.get().state`). */
export type SessionsApiState = "off" | "listening" | "env" | "error";

/**
 * The one-line hint under a plugin's services: only when the plugin declares
 * services and the Sessions API cannot be reached (off, or failed to start).
 */
export function sessionsApiHint(rowHasServices: boolean, communicationState: SessionsApiState): string | undefined {
  if (!rowHasServices) return undefined;
  if (communicationState === "off" || communicationState === "error") {
    return "Sessions API is off — enable it in Settings → Sessions API to let this service reach your sessions.";
  }
  return undefined;
}

/** The chip for one supervised service (Taskana 4750a). Plain display mapping of main's view. */
export function serviceChip(view: PluginServiceView): PluginChip {
  switch (view.state) {
    case "running":
      return { text: "Running", tone: "muted" };
    case "starting":
      return { text: "Starting", tone: "muted" };
    case "stopped":
      return { text: "Stopped", tone: "muted" };
    case "backoff":
      return { text: `Restarting in ${view.restartInSec ?? 0}s`, tone: "warn" };
    case "crash_loop":
      return { text: "Crash loop", tone: "warn" };
    case "blocked":
      switch (view.reason) {
        case "no_consent":
          return { text: "Needs approval", tone: "warn" };
        case "untrusted":
          return { text: "Blocked: untrusted folder", tone: "warn" };
        case "disabled":
          return { text: "Disabled", tone: "muted" };
        case "bad_command":
          return { text: "Blocked: bad command", tone: "warn" };
        case "missing_secret":
          // Names only (Taskana 4751 part 0): the secret VALUE never reaches the renderer.
          return { text: `Missing secret: ${(view.missingSecrets ?? []).join(", ") || "?"}`, tone: "warn" };
        default:
          return { text: "Blocked", tone: "warn" };
      }
    default:
      return { text: String((view as { state: string }).state), tone: "muted" };
  }
}

/** The engines incompatibility range when status says incompatible, extracted from problems. */
export function pluginIncompatibleRange(row: PluginRowView): string | undefined {
  if (row.status !== "inactive") return undefined;
  const problem = row.problems.find((line) => line.startsWith("incompatible with AnyCode"));
  return problem?.match(/needs ([^)]+)\)$/)?.[1];
}

/** Update availability main attached (official, compat-gated, > active, not pinned). */
export function pluginUpdateVersion(row: PluginRowView): string | undefined {
  return row.updateAvailable?.version;
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
 * render order: update → needs-approval → incompatible → inactive/disabled →
 * problems. Every input is already main-derived (`updateAvailable`,
 * `mcpConsentGranted`, `status`, `problems`) — this is pure display mapping,
 * no re-derivation of trust or compat.
 */
export function pluginStatusChips(row: PluginRowView): PluginChip[] {
  const chips: PluginChip[] = [];
  const update = pluginUpdateVersion(row);
  if (update !== undefined) {
    chips.push({ text: `Update available ${update}`, tone: "warn" });
  }
  if (pluginMcpNeedsApproval(row)) {
    chips.push({ text: "Needs approval", tone: "warn" });
  }
  if (servicesNeedApproval(row)) {
    chips.push({ text: "Services need approval", tone: "warn" });
  }
  const incompatible = pluginIncompatibleRange(row);
  if (incompatible !== undefined) {
    chips.push({ text: `Incompatible (needs ${incompatible})`, tone: "warn" });
  }
  if (row.status === "inactive") {
    chips.push({ text: "Inactive", tone: "muted" });
  } else if (row.status === "disabled") {
    chips.push({ text: "Disabled", tone: "muted" });
  }
  if (row.problems.length > 0) {
    chips.push({ text: `Problems (${row.problems.length})`, tone: "warn" });
  }
  return chips;
}

/** Capability summary line ("skills, agents, workflows · MCP: name1, name2 (needs approval)"). */
export function pluginCapabilitiesText(row: PluginRowView): string {
  const parts: string[] = [];
  const caps = row.capabilities;
  if (caps !== undefined) {
    if (caps.skills > 0) parts.push("skills");
    if (caps.agents > 0) parts.push("agents");
    if (caps.workflows > 0) parts.push("workflows");
    if (caps.commands > 0) parts.push("commands");
    if (caps.hooks) parts.push("hooks");
    if (caps.docs) parts.push("docs");
    if (caps.engineSupport.length > 0) parts.push("engine support");
    if (caps.promptOverlays > 0) parts.push("prompt overlays");
  }
  const needsApproval = pluginMcpNeedsApproval(row);
  for (const name of row.mcpServerNames) {
    parts.push(`MCP ${name}${needsApproval ? " (needs approval)" : ""}`);
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
  | "approve-mcp"
  | "approve-services";

/**
 * Which action buttons one row offers (design §6). Managed rows (a
 * `managed` block exists — official/third-party/local installs) get the full
 * set, each gated by its own precondition: update needs main's
 * `updateAvailable`; rollback needs a retained `previous` and no pin;
 * approve-mcp needs missing consent; remove is managed-only (project/legacy
 * rows are removed by deleting the directory — the docs say so, the pane
 * does not pretend otherwise). Reveal is offered for managed/local rows and
 * legacy dirs (main re-resolves the path itself); `rollback` swaps
 * active/previous AND pins (design §5).
 */
export function pluginRowActions(row: PluginRowView): PluginAction[] {
  const managed = row.managed !== undefined;
  const actions: PluginAction[] = [];
  if (managed && row.updateAvailable !== undefined) {
    actions.push("update");
  }
  if (managed && row.managed?.previous !== undefined && row.managed?.pinned !== true) {
    actions.push("rollback");
  }
  if (managed) {
    actions.push(row.managed?.pinned === true ? "unpin" : "pin");
  }
  if (pluginMcpNeedsApproval(row)) {
    actions.push("approve-mcp");
  }
  if (servicesNeedApproval(row)) {
    actions.push("approve-services");
  }
  if (managed) {
    actions.push("remove");
  }
  if (managed || row.tier === "local" || row.tier === "legacy-user") {
    actions.push("reveal");
  }
  return actions;
}

/** Rollback button label names the version it would return to. */
export function rollbackLabel(row: PluginRowView): string {
  const previous = pluginPreviousVersion(row);
  return previous !== undefined ? `Rollback to ${previous}` : "Rollback";
}

// ── index header ──

export type IndexHeaderTone = "ok" | "warn" | "muted";

/** Index status row text + tone (design §6 header). */
export function pluginIndexStatusText(status: PluginsIndexStatus): { text: string; tone: IndexHeaderTone } {
  switch (status) {
    case "ok":
      return { text: "Index up to date", tone: "ok" };
    case "offline":
      return { text: "Index offline — using the last verified copy", tone: "warn" };
    case "expired":
      return { text: "Index expired — no new installs or updates until it refreshes", tone: "warn" };
    case "signature-failed":
      return { text: "Index signature failed — refusing it", tone: "warn" };
    case "not configured":
      return { text: "Official index not configured in this build", tone: "muted" };
    case "unchecked":
      return { text: "Index not checked yet", tone: "muted" };
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
  source: PluginInstallSource;
  /** True when the option is not yet available in stage 1. */
  disabled: boolean;
};

/**
 * The "Install…" menu (design §6): file (.tgz) / URL / folder / git. `file`
 * and `folder` carry NO path — main opens its own picker (path custody). Git
 * is refused by main until Stage 2 ("git sources arrive in Stage 2"), so the
 * option renders disabled.
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
export function installSourceForOption(index: number): PluginInstallSource | undefined {
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
  if (entry.incompatibleReason !== undefined) {
    return { label: "Install", disabled: true, reason: entry.incompatibleReason };
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

/** One MCP server row's command line, pre-joined for the red sheet row. */
export function mcpServerCommandLine(server: PluginInstallPreview["mcpServers"][number]): string {
  return [server.command, ...server.args].join(" ");
}

/** Whether the sheet shows background services and offers the services consent (Taskana 4750a). */
export function sheetHasServices(preview: PluginInstallPreview): boolean {
  return (preview.services?.length ?? 0) > 0;
}

/** One service row's command line on the sheet (no env values — only the key names are shown). */
export function serviceCommandLine(service: NonNullable<PluginInstallPreview["services"]>[number]): string {
  return [service.command, ...service.args].join(" ");
}

/**
 * Primary button label. The default (both consents withheld) keeps services
 * OFF, so the label says so; "allow … and services" only when every offered
 * consent is ticked.
 */
export function sheetPrimaryLabel(preview: PluginInstallPreview, allowMcp: boolean, allowServices = false): string {
  const hasMcp = sheetHasMcpServers(preview);
  const hasServices = sheetHasServices(preview);
  if (hasMcp && hasServices) {
    if (allowMcp && allowServices) return "Install and allow MCP servers and services";
    if (!allowMcp && !allowServices) return "Install (MCP servers and services stay off)";
    return allowMcp ? "Install (services stay off)" : "Install (MCP servers stay off)";
  }
  if (hasMcp) {
    return allowMcp ? "Install and allow MCP servers" : "Install (MCP servers stay off)";
  }
  if (hasServices) {
    return allowServices ? "Install and allow services" : "Install (services stay off)";
  }
  return "Install";
}

/**
 * The install button's own refusal copy (design §4 sheet is about consent;
 * a failed prepare never opens the sheet — these strings render inline in
 * the pane while the sheet is closed, or as the sheet's error row when a
 * commit fails).
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
    [row.name, row.displayName ?? "", row.description ?? ""].some((field) => field.toLowerCase().includes(needle)),
  );
}

/** Whether a snapshot shows ANY third-party-or-lower tier (drives the consent reminder line). */
export function hasNonOfficialPlugins(snapshot: PluginsSnapshot): boolean {
  return snapshot.plugins.some(
    (row) => row.tier === "third-party" || row.tier === "local" || row.tier === "project" || row.tier === "legacy-user",
  );
}

/**
 * Plugins management control-plane contract (design 4732 §6/§7, Taskana 4732
 * S1-C). Thirteen additive invoke channels between main and the renderer for
 * the Settings "Plugins" pane — the list snapshot (installed rows + official
 * index entries + index status + settings mirror), update check, two-phase
 * install (prepare stages/validates MAIN-side and returns a single-use token +
 * preview; commit applies it, optionally allowing MCP servers), update /
 * rollback / pin / enable / remove / approve-MCP / reveal per installed
 * plugin, and the auto-update toggle — plus one push channel
 * (`plugins-changed`) main fires whenever the plugin set changes under a
 * running app.
 *
 * VALUE-ONLY module with ZERO imports, exact ethic of shared/skills-config.ts:
 * it is imported by preload (sandboxed CJS), the renderer web bundle, AND
 * main, so it must never drag zod or the @anycode/core barrel into a bundle
 * that cannot afford it. Request validation lives in main/plugins-ipc.ts
 * (main is the trust boundary), not here.
 *
 * Host↔ui wire delta: ZERO — these are independent invoke-channel
 * registrations, not a HostToUiMessage/AgentEvent variant, so there is no
 * exhaustive-`never` hazard and no protocol-fixture fallout.
 *
 * PATH CUSTODY INVARIANT (design §4): the renderer NEVER supplies a filesystem
 * path in any request below. An install source is expressed as a KIND plus at
 * most a URL or a plugin NAME/version (`file`/`folder` sources take NO
 * argument — main opens its own native picker); a plugin is always identified
 * by `name` (update/rollback/remove/approve/reveal); `reveal` opens main's own
 * file manager on a path main re-resolves from its own scan, never from a
 * renderer-supplied string. Display-only provenance (source URL/path text)
 * DOES cross back inside `PluginRowView` — the user's own trusted config
 * (same custody class as the MCP pane's `cwd`), never accepted as a request
 * field.
 *
 * S1-C COEXISTENCE RULE (this file is authored by the renderer/docs brief and
 * adopted as-is by S1-B main): the pane must degrade HONESTLY when the main
 * handlers are absent (an app where S1-B is not built) — every bridge call
 * throws across `contextBridge` for an unregistered channel, which the pane
 * catches and renders as a "Plugins service unavailable" state, never a crash.
 */

// ── invoke channels (13, additive — independent registrations) + 1 push ──

/** invoke channel: read the joined installed/available PluginsSnapshot. */
export const PLUGINS_LIST_CHANNEL = "anycode:plugins-list";

/** invoke channel: check the official index for updates now (out-of-schedule). */
export const PLUGINS_CHECK_UPDATES_CHANNEL = "anycode:plugins-check-updates";

/** invoke channel: phase 1 of install — main stages + validates, returns `{token, preview}`. */
export const PLUGINS_INSTALL_PREPARE_CHANNEL = "anycode:plugins-install-prepare";

/** invoke channel: phase 2 of install — apply the prepared token, optionally allowing MCP. */
export const PLUGINS_INSTALL_COMMIT_CHANNEL = "anycode:plugins-install-commit";

/** invoke channel: update one installed plugin to the newest compatible index version. */
export const PLUGINS_UPDATE_CHANNEL = "anycode:plugins-update";

/** invoke channel: swap active/previous and pin (rollback). */
export const PLUGINS_ROLLBACK_CHANNEL = "anycode:plugins-rollback";

/** invoke channel: set the pinned flag on one installed plugin. */
export const PLUGINS_SET_PINNED_CHANNEL = "anycode:plugins-set-pinned";

/** invoke channel: enable/disable one plugin by name (user-global, all tiers). */
export const PLUGINS_SET_ENABLED_CHANNEL = "anycode:plugins-set-enabled";

/** invoke channel: remove one managed install (records a tombstone for defaults). */
export const PLUGINS_REMOVE_CHANNEL = "anycode:plugins-remove";

/** invoke channel: record MCP-server consent for one plugin (current serversHash). */
export const PLUGINS_APPROVE_MCP_CHANNEL = "anycode:plugins-approve-mcp";

/** invoke channel: reveal a managed/local plugin's directory in the OS file manager. */
export const PLUGINS_REVEAL_CHANNEL = "anycode:plugins-reveal";

/** invoke channel: toggle the "Auto-update official plugins" setting. */
export const PLUGINS_SET_AUTO_UPDATE_CHANNEL = "anycode:plugins-set-auto-update";

/** push channel: main → renderer broadcast after any plugin-set change (reason only). */
export const PLUGINS_CHANGED_CHANNEL = "anycode:plugins-changed";

// ── shared vocabulary ──

/**
 * Install tier (design §3): `official` = installed from a verified signed
 * index entry; `third-party` = url/file/git install; `local` = dev-linked
 * directory; `project` = hand-placed `<ws>/.anycode/plugins/<dir>`; `legacy` =
 * hand-placed `~/.anycode/plugins/<dir>` (unmanaged — same renderer grammar,
 * fewer actions).
 */
export type PluginTier = "official" | "third-party" | "local" | "project" | "legacy";

/** Install source provenance for a `PluginRowView` — display-only. */
export type PluginSourceView =
  | { kind: "official" }
  | { kind: "url"; url: string }
  | { kind: "file"; fileName: string }
  | { kind: "git"; url: string; ref?: string; commit?: string }
  | { kind: "local"; path: string }
  | { kind: "project" }
  | { kind: "legacy" };

/** Official index health (design §5/§6): what the header status row renders. */
export type PluginIndexStatus =
  | "ok"
  | "offline"
  | "expired"
  | "signature_failed"
  | "not_configured";

/** Refusal reason vocabulary shared by every mutating channel (main's zod decides which apply). */
export type PluginsRefusalReason =
  | "invalid"
  | "not_found"
  | "read_only_source"
  | "incompatible"
  | "signature"
  | "integrity"
  | "too_large"
  | "network"
  | "io_error";

/**
 * Derived capabilities (design §2: "capabilities are DERIVED from content,
 * never self-declared") — the same capability tokens the official index
 * carries per version.
 */
export type PluginCapability = "skills" | "agents" | "workflows" | "mcp";

/** One MCP server a plugin contributes: display name + consent state. */
export interface PluginMcpServerView {
  /** Runtime server name (`plugin_<plugin>_<server>`). */
  name: string;
  /** `command + args` (stdio) or `url` (http), pre-joined main-side — trusted config, no env values. */
  commandLine: string;
  /** True when the plugin's CURRENT mcpServers hash has explicit consent (settings.json). */
  consented: boolean;
}

/**
 * One installed plugin row (design §6 "Installed list cards"). `status` is the
 * display-normalized lifecycle state the pane's chips derive from;
 * `problems` are fail-soft discovery problems for this plugin only.
 */
export interface PluginRowView {
  name: string;
  displayName: string;
  description: string;
  version: string;
  tier: PluginTier;
  source: PluginSourceView;
  enabled: boolean;
  /** Inactive = installed but not contributing (incompatible / disabled-by-error). */
  active: boolean;
  pinned: boolean;
  /** Newest compatible index version above `version`, when one exists. */
  updateVersion?: string;
  /** Set when active is false because the engines range excludes this app. */
  incompatibleRange?: string;
  capabilities: PluginCapability[];
  mcpServers: PluginMcpServerView[];
  /** True when any MCP server lacks consent (chip "Needs approval"). */
  mcpNeedsApproval: boolean;
  /** Rollback target, when the previous version is retained. */
  previousVersion?: string;
  problems: string[];
}

/** One not-installed official index entry (design §6 "Available from AnyCode"). */
export interface IndexEntryView {
  name: string;
  displayName: string;
  description: string;
  /** Newest version compatible with this app, when one exists. */
  version?: string;
  /** Set when NO version of the entry is compatible (Install greyed with reason). */
  incompatibleRange?: string;
  capabilities: PluginCapability[];
  /** `default: true` entries auto-install — surfaced so the row can say so. */
  defaultInstall: boolean;
}

/** Index health block of the snapshot (header row: status + last check + serial). */
export interface PluginsIndexView {
  status: PluginIndexStatus;
  /** ISO timestamp of the last successful check, if any. */
  checkedAt?: string;
  serial?: number;
}

/** Settings mirror the pane renders without a second settings round-trip. */
export interface PluginsSettingsView {
  /** `settings.plugins.autoUpdateOfficial` — absent reads as true (owner default). */
  autoUpdateOfficial: boolean;
}

export interface PluginsSnapshot {
  plugins: PluginRowView[];
  available: IndexEntryView[];
  index: PluginsIndexView;
  settings: PluginsSettingsView;
}

export interface PluginsListRequest {
  /** Active tab whose workspace resolves project-tier plugins; omit for user-only. */
  tabId?: string;
}

/** Result shape shared by every snapshot-returning channel (list/mutations). */
export type PluginsMutationResult =
  | { ok: true; snapshot: PluginsSnapshot }
  | { ok: false; reason: PluginsRefusalReason };

// ── check-updates ──

export interface PluginsCheckUpdatesRequest {
  tabId?: string;
}

/**
 * Returns a fresh snapshot (the check itself is main-side network work); on
 * network failure the snapshot's index.status is `offline` and ok stays true —
 * `reason` is reserved for request-level refusals.
 */
export type PluginsCheckUpdatesResult =
  | { ok: true; snapshot: PluginsSnapshot }
  | { ok: false; reason: PluginsRefusalReason };

// ── install prepare / commit (two-phase, single-use token) ──

/**
 * Install source REQUEST (path custody: `file`/`folder` carry NO path — main
 * opens its own picker and returns the staged preview; `git` is stage 2 and
 * accepted but refused `invalid` until then).
 */
export type PluginInstallSourceRequest =
  | { kind: "official"; name: string; version?: string }
  | { kind: "url"; url: string }
  | { kind: "file" }
  | { kind: "folder" }
  | { kind: "git"; url: string; ref?: string };

export interface PluginsInstallPrepareRequest {
  tabId?: string;
  source: PluginInstallSourceRequest;
}

/** The staged preview the confirmation sheet renders (design §4's sheet contents). */
export interface PluginInstallPreview {
  name: string;
  displayName: string;
  description: string;
  version: string;
  tier: PluginTier;
  source: PluginSourceView;
  /** First 12 hex chars of the archive sha256, when the source is an archive. */
  sha256Prefix?: string;
  capabilities: PluginCapability[];
  /** One row per MCP server (command + args) — the red rows of the consent sheet. */
  mcpServers: PluginMcpServerView[];
  /** The engines range as written in the manifest, when present. */
  enginesRange?: string;
  /** True when the manifest declares no version at all (legacy-style). */
  unversioned?: boolean;
}

export type PluginsInstallPrepareResult =
  | { ok: true; token: string; preview: PluginInstallPreview }
  | { ok: false; reason: PluginsRefusalReason };

export interface PluginsInstallCommitRequest {
  /** The single-use token a successful prepare returned (10-minute expiry, main-enforced). */
  token: string;
  /** Explicit MCP-server consent — "Install and allow MCP servers" sets this true. */
  allowMcp: boolean;
}

export type PluginsInstallCommitResult = PluginsMutationResult;

// ── per-plugin actions (identity = name, NEVER a path) ──

export interface PluginsUpdateRequest {
  tabId?: string;
  name: string;
}

export interface PluginsRollbackRequest {
  tabId?: string;
  name: string;
}

export interface PluginsSetPinnedRequest {
  tabId?: string;
  name: string;
  pinned: boolean;
}

export interface PluginsSetEnabledRequest {
  tabId?: string;
  name: string;
  enabled: boolean;
}

export interface PluginsRemoveRequest {
  tabId?: string;
  name: string;
}

export interface PluginsApproveMcpRequest {
  tabId?: string;
  name: string;
}

export interface PluginsRevealRequest {
  tabId?: string;
  name: string;
}

/** Reveal has no catalog effect on success — just an ok/refusal. */
export type PluginsRevealResult = { ok: true } | { ok: false; reason: PluginsRefusalReason };

// ── auto-update toggle ──

export interface PluginsSetAutoUpdateRequest {
  enabled: boolean;
}

// ── push payload ──

/** `plugins-changed` payload: why the set changed — the tab banner renders it. */
export interface PluginsChangedPayload {
  reason: string;
}

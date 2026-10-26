/**
 * Plugins control-plane channel names + wire view types (Taskana 4732 S1-B,
 * design §7). VALUE-ONLY, zero imports — the S1-C renderer pane compiles
 * against exactly these names; main/plugins-ipc.ts registers them; preload
 * bridges them. Any rename here is a three-file contract change by design.
 *
 * Channels (additive `ipcRenderer.invoke`, `anycode:plugins-*`):
 * list / check-updates / install-prepare / install-commit / update /
 * rollback / set-pinned / set-enabled / remove / approve-mcp / reveal /
 * set-auto-update — plus the `anycode:plugins-changed` PUSH (reason only).
 */

// ── channels ──

export const PLUGINS_LIST_CHANNEL = "anycode:plugins-list";
export const PLUGINS_CHECK_UPDATES_CHANNEL = "anycode:plugins-check-updates";
export const PLUGINS_INSTALL_PREPARE_CHANNEL = "anycode:plugins-install-prepare";
export const PLUGINS_INSTALL_COMMIT_CHANNEL = "anycode:plugins-install-commit";
export const PLUGINS_UPDATE_CHANNEL = "anycode:plugins-update";
export const PLUGINS_ROLLBACK_CHANNEL = "anycode:plugins-rollback";
export const PLUGINS_SET_PINNED_CHANNEL = "anycode:plugins-set-pinned";
export const PLUGINS_SET_ENABLED_CHANNEL = "anycode:plugins-set-enabled";
export const PLUGINS_REMOVE_CHANNEL = "anycode:plugins-remove";
export const PLUGINS_APPROVE_MCP_CHANNEL = "anycode:plugins-approve-mcp";
/** Taskana 4750a: grant consent for the plugin's CURRENT services definition (name-only payload). */
export const PLUGINS_APPROVE_SERVICES_CHANNEL = "anycode:plugins-approve-services";
/** Taskana 4750a: supervised service states (no argv, env, or paths). */
export const PLUGINS_SERVICES_CHANNEL = "anycode:plugins-services";
/** Taskana 4750a: bounded plain-text log of one service ({plugin,name}). */
export const PLUGINS_SERVICE_LOGS_CHANNEL = "anycode:plugins-service-logs";
/** Taskana 4750a: manual restart of one service ({plugin,name}); clears backoff and crash loop. */
export const PLUGINS_SERVICE_RESTART_CHANNEL = "anycode:plugins-service-restart";
export const PLUGINS_REVEAL_CHANNEL = "anycode:plugins-reveal";
export const PLUGINS_SET_AUTO_UPDATE_CHANNEL = "anycode:plugins-set-auto-update";

/** Push channel: broadcast after any change to installed plugins (reason only). */
export const PLUGINS_CHANGED_CHANNEL = "anycode:plugins-changed";

/** Why the plugins changed (push payload — one word, renderer localizes). */
export type PluginsChangedReason =
  | "install"
  | "update"
  | "rollback"
  | "remove"
  | "enable"
  | "pin"
  | "consent"
  | "auto-update";

// ── refusal reasons (design §7) ──

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

export type PluginsMutationResult = { ok: true } | { ok: false; reason: PluginsRefusalReason; detail?: string };

// ── index views ──

export type PluginsIndexStatus =
  | "ok"
  | "offline"
  | "expired"
  | "signature-failed"
  | "not configured"
  | "unchecked";

export interface PluginsIndexInfo {
  status: PluginsIndexStatus;
  /** ISO timestamp of the last completed check (cached or network). */
  checkedAt?: string;
  serial?: number;
}

// ── installed rows (mirrors core's PluginAdminRow, trimmed to the wire) ──

export type PluginTierView = "project" | "official" | "third-party" | "local" | "legacy-user";

export type PluginStatusView = "active" | "inactive" | "disabled";

export interface PluginRowView {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  tier: PluginTierView;
  status: PluginStatusView;
  /** User-global disabled state (also applies to non-managed plugins). */
  disabled: boolean;
  problems: string[];
  source: { kind: string; url?: string; fileName?: string; path?: string; ref?: string; commit?: string };
  capabilities?: {
    skills: number;
    agents: number;
    workflows: number;
    mcp: string[];
    commands: number;
    hooks: boolean;
    docs: boolean;
    engineSupport: string[];
    promptOverlays: number;
    services: string[];
  };
  mcpServersHash?: string;
  mcpConsentGranted?: boolean;
  mcpServerNames: string[];
  /** Background services the plugin declares (Taskana 4750a). env KEY names only, never values. */
  serviceNames: string[];
  servicesHash?: string;
  servicesConsentGranted?: boolean;
  services?: { name: string; command: string; args: string[]; envKeys: string[]; secretNames?: string[] }[];
  managed?: {
    enabled: boolean;
    pinned: boolean;
    active: string;
    previous?: string;
    installedAt?: string;
    sha256?: string;
  };
  /** Update availability (official, compat-gated, > active, not pinned). */
  updateAvailable?: { version: string; needsApproval: boolean };
}

/** One `default: true` official index entry not installed (installable list). */
export interface IndexEntryView {
  name: string;
  displayName?: string;
  description?: string;
  default: boolean;
  /** Newest version compatible with this app, when one exists. */
  version?: string;
  /** Why no version is compatible (incompatible entries grey out). */
  incompatibleReason?: string;
  capabilities: string[];
}

export interface PluginsSnapshot {
  plugins: PluginRowView[];
  available: IndexEntryView[];
  index: PluginsIndexInfo;
  settings: {
    autoUpdateOfficial: boolean;
    indexConfigured: boolean;
  };
}

// ── two-phase install (design §6/§7) ──

export type PluginInstallSource =
  | { kind: "official"; name: string; version?: string }
  | { kind: "url"; url: string }
  | { kind: "file" } // main opens the picker itself (path custody)
  | { kind: "folder" } // ditto
  | { kind: "git"; url: string; ref?: string }; // s2 — schema present, refused for now

/** Confirmation-sheet payload returned by prepare; no filesystem paths (§4 custody). */
export interface PluginInstallPreview {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  source: PluginInstallSource;
  /** 8-hex prefix of the archive sha256 (index-pinned or computed). */
  sha256Prefix?: string;
  capabilities: string[];
  /** One row per MCP server: red rows on the sheet (command + args). */
  mcpServers: { name: string; command: string; args: string[] }[];
  /** Taskana 4750a: red rows for each background service (command + args + env KEY names). */
  services?: { name: string; command: string; args: string[]; envKeys: string[]; secretNames?: string[] }[];
  hasHooks: boolean;
  engines?: string;
  /** True when the manifest is incompatible with this app (grey out). */
  incompatible?: boolean;
}

export type PluginInstallPrepareResult =
  | { ok: true; token: string; preview: PluginInstallPreview }
  | { ok: false; reason: PluginsRefusalReason; detail?: string };

export type PluginInstallCommitResult =
  | { ok: true; snapshot: PluginsSnapshot }
  | { ok: false; reason: PluginsRefusalReason; detail?: string };

// ═══════════════════════════════════════════════════════════════════
// S1-C renderer additions (merged from the renderer brief's version,
// ADDITIVE ONLY — wire semantics above are S1-B main's, unchanged).
// Aliases carry no wire meaning: they exist so the renderer keeps one
// spelling per concept (PluginInstallSourceRequest = what a request
// carries; PluginsCheckUpdatesResult = what check-updates resolves with).
// ═══════════════════════════════════════════════════════════════════

/** Alias of `PluginInstallSource` — S1-C renderer spelling for request payloads. */
export type PluginInstallSourceRequest = PluginInstallSource;

/** Alias of `PluginsIndexInfo` — S1-C renderer spelling. */
export type PluginsIndexView = PluginsIndexInfo;

/** `plugins-changed` push payload shape (`{reason}`) — S1-C renderer spelling. */
export interface PluginsChangedPayload {
  reason: PluginsChangedReason;
}

/** Alias of `PluginInstallPrepareResult` — S1-C renderer spelling. */
export type PluginsInstallPrepareResult = PluginInstallPrepareResult;

/** Alias of `PluginInstallCommitResult` — S1-C renderer spelling. */
export type PluginsInstallCommitResult = PluginInstallCommitResult;

/** check-updates resolves with a fresh snapshot (main's S1-B semantics: a
 *  network failure is reported through `index.status:"offline"`, so the
 *  ok-branch carries the snapshot and the refusal union is reserved for
 *  request-level errors). */
export type PluginsCheckUpdatesResult = PluginsSnapshot;

/** Reveal has no catalog effect on success — ok/refusal only (S1-C spelling). */
export type PluginsRevealResult = PluginsMutationResult;

// ── Taskana 4750a: plugin background services (supervised by main) ──

/** Supervisor state of one service, as the pane shows it. */
export type PluginServiceStateView =
  | "stopped"
  | "starting"
  | "running"
  | "backoff"
  | "crash_loop"
  | "blocked";

/** Why a service is blocked from starting (the pane localizes the label). */
export type PluginServiceBlockedReason = "no_consent" | "untrusted" | "disabled" | "bad_command" | "missing_secret";

/** One row of the services view: no argv, env, or paths. */
export interface PluginServiceView {
  plugin: string;
  name: string;
  state: PluginServiceStateView;
  reason?: PluginServiceBlockedReason;
  /** Secret NAMES the service needs and that are not set (`missing_secret` only; never values). */
  missingSecrets?: string[];
  pid?: number;
  /** Restarts since the last manual start/restart. */
  restarts: number;
  /** Seconds until the next automatic restart (backoff only). */
  restartInSec?: number;
  /** Exit summary of the last run (code or signal). */
  lastExit?: string;
}

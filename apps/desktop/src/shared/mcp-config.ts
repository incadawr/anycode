/**
 * MCP config management control-plane contract (design slice-P7.19-cut.md §3/§4
 * W2, W3-FIX). Six additive invoke channels between main and the renderer for
 * the MCP Servers settings pane: read the joined project/user/compat config
 * view, upsert/delete/set-enabled a server entry, and scan/apply an
 * explicit-trust import from other coding-harness configs (Claude, Codex,
 * zcode, `.mcp.json`). `setEnabled` (W3-FIX) is a lossless PATCH of just the
 * `enabled` field — the toggle path no longer full-replaces the entry via
 * `upsert`, which would silently drop `cwd`/secret env values a display-only
 * view never carries.
 *
 * VALUE-ONLY module with ZERO imports, exact ethic of shared/settings.ts: it is
 * imported by preload (sandboxed CJS), the renderer web bundle, AND main, so it
 * must never drag zod or the @anycode/core barrel into a bundle that cannot
 * afford it. Request validation lives in main/mcp-config-ipc.ts (main is the
 * trust boundary), not here.
 *
 * Host↔ui wire delta: ZERO — these are independent invoke-channel registrations,
 * not a HostToUiMessage/AgentEvent variant, so there is no exhaustive-`never`
 * hazard and no protocol-fixture fallout.
 *

 * never crosses to the renderer in EITHER direction of display. Every view type
 * below (`McpConfigEntryView`, `McpImportCandidateView`) carries `envKeys` (key
 * NAMES only) — never `env`/`headers` values. A value only ever travels
 * renderer -> main, inside an upsert/edit `entry` payload (write-only, like
 * `secret-set`) or an import-apply consent flag (values copied main-side,
 * foreign-file -> our-file, never routed back through the renderer).
 */

// ── invoke channels (6, additive — independent registrations, no union exhaustiveness) ──

/** invoke channel: read the joined project/user/compat McpConfigSnapshot. */
export const MCP_CONFIG_GET_CHANNEL = "anycode:mcp-config-get";

/** invoke channel: add or replace one server entry in a scope's config file. */
export const MCP_CONFIG_UPSERT_CHANNEL = "anycode:mcp-config-upsert";

/** invoke channel: remove one server entry from a scope's config file. */
export const MCP_CONFIG_DELETE_CHANNEL = "anycode:mcp-config-delete";

/** invoke channel: patch ONLY `mcpServers[name].enabled` — lossless toggle (W3-FIX). */
export const MCP_CONFIG_SET_ENABLED_CHANNEL = "anycode:mcp-config-set-enabled";

/**
 * invoke channel: promote a compat `<ws>/.mcp.json` server into the PROJECT
 * config (W5-FIX, finding 3). Done main-side against the REAL `.mcp.json` entry
 * (verbatim args/cwd/env/headers, forced `enabled:false`) — the renderer never
 * reconstructs the entry from a display-only view (which would drop cwd/env and
 * corrupt quoted args), and never handles the values (custody preserved).
 */
export const MCP_CONFIG_PROMOTE_COMPAT_CHANNEL = "anycode:mcp-config-promote-compat";

/** invoke channel: scan the fixed foreign-harness allowlist for import candidates. */
export const MCP_IMPORT_SCAN_CHANNEL = "anycode:mcp-import-scan";

/** invoke channel: apply a consented subset of scanned candidates into a scope. */
export const MCP_IMPORT_APPLY_CHANNEL = "anycode:mcp-import-apply";

// ── shared vocabulary ──

/** Transport shape of an MCP server entry (structural: command => stdio, url => http). */
export type McpTransport = "stdio" | "http";

/** Where a config-view row's defining entry lives. `compat` is `<ws>/.mcp.json` (read-only). */
export type McpConfigSource = "project" | "user" | "compat";

/**
 * Scope a mutation targets. `compat` is a valid REQUEST value (so a compat row's
 * "Import to project" affordance can still type its target as this union) but
 * every mutating handler refuses it outright (`read_only_source`) — we never
 * write a foreign harness's file.
 */
export type McpConfigScope = "project" | "user" | "compat";

/**
 * Write-side server entry payload — structurally identical to core's
 * `McpServerEntry` (mcpServerEntrySchema), redeclared locally so this
 * value-only module keeps its zero-import rule (exact precedent:
 * shared/settings.ts's `AlwaysAllowRule`). Main re-validates every field with
 * the real zod schema before it ever reaches disk (trust boundary).
 */
export interface McpServerEntryInput {
  // stdio form
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  // http form
  url?: string;
  headers?: Record<string, string>;
  // shared
  enabled?: boolean;
}

// ── config-view (get) ──

/**
 * One row of the joined config view (design §4 W2). `commandLine` is PRE-JOINED
 * main-side (`command + args` or `url`) — args are trusted config that DO cross
 * (config.ts §comment), only env/header VALUES never cross. `envKeys` carries
 * KEY NAMES only (custody). `shadowed` marks a row whose name is claimed by a

 * (so the page can surface/edit it) but is visually deprioritized.
 */
export interface McpConfigEntryView {
  name: string;
  source: McpConfigSource;
  enabled: boolean;
  transport: McpTransport;
  commandLine: string;
  envKeys: string[];
  /**
   * Stdio working directory (W3-FIX). A filesystem path is trusted config —
   * same custody class as `command`/`args`, NOT an env/header value — so it
   * safely crosses to the renderer; only env/header VALUES never do.
   */
  cwd?: string;
  shadowed?: boolean;
}

export interface McpConfigSnapshot {
  entries: McpConfigEntryView[];
  /** Fail-soft parse/read problems across all three sources (never throws). */
  problems: string[];
}

export interface McpConfigGetRequest {
  /** Active tab whose workspace resolves the project/compat sources; omit for user-only. */
  tabId?: string;
}

// ── mutation (upsert / delete) ──

export type McpConfigRefusalReason =
  | "invalid"
  | "no_workspace"
  | "read_only_source"
  | "io_error"
  /** setEnabled only: the named server no longer exists in the target scope's config file. */
  | "not_found";

export interface McpConfigUpsertRequest {
  tabId?: string;
  scope: McpConfigScope;
  name: string;
  entry: McpServerEntryInput;
}

export interface McpConfigDeleteRequest {
  tabId?: string;
  scope: McpConfigScope;
  name: string;
}

/**
 * Promote-compat request (W5-FIX, finding 3): the renderer sends ONLY the compat
 * row's name + tab; main reads the real `<ws>/.mcp.json` entry and writes it into
 * the project config with `enabled:false` forced, args/cwd/env/headers verbatim.
 */
export interface McpConfigPromoteCompatRequest {
  tabId?: string;
  name: string;
}

/**
 * setEnabled request (W3-FIX): patches ONLY `enabled` via core's
 * `setMcpServerEnabled`, preserving every other field of the entry
 * (cwd/env/headers/args/etc) byte-semantically — unlike upsert, the renderer
 * never has to reconstruct the full entry from a display-only view.
 */
export interface McpConfigSetEnabledRequest {
  tabId?: string;
  scope: McpConfigScope;
  name: string;
  enabled: boolean;
}

/** Response of upsert/delete: a fresh joined snapshot on success, or a typed refusal. */
export type McpConfigMutationResult =
  | { ok: true; snapshot: McpConfigSnapshot }
  | { ok: false; reason: McpConfigRefusalReason };

// ── import scan ──

/** Origin harness of a discovered candidate — mirrors core's `HarnessKind`. */
export type McpHarnessKind = "claude" | "claude-project" | "mcp-json" | "codex" | "zcode";

/**
 * One discovered foreign-harness server, projected for the renderer (custody
 * §3: same rule as `McpConfigEntryView` — `envKeys` names only, never values).
 * `hasSecrets` is a display convenience (`envKeys.length > 0`); the masked
 * `KEY=••••` chips are composed renderer-side from `envKeys` alone.
 */
export interface McpImportCandidateView {
  /**
   * Stable candidate IDENTITY (W5-FIX, finding 2): `${harness} ${sourcePath}
   * ${name}`, built main-side. Import selection keys and the apply request match
   * on THIS, not on `name` alone — two harnesses defining a server with the same
   * name are distinct candidates, so selecting one never copies the other's
   * (possibly secret-bearing) definition.
   */
  id: string;
  harness: McpHarnessKind;
  sourcePath: string;
  name: string;
  transport: McpTransport;
  commandLine: string;
  envKeys: string[];
  hasSecrets: boolean;
  /** True when `name` already exists in the target project/user config. */
  alreadyConfigured: boolean;
  /** True for a `<ws>/.mcp.json` candidate — already active via the compat loader. */
  alreadyActiveViaCompat?: boolean;
}

export interface McpImportScanRequest {
  tabId?: string;
}

/** Always succeeds (fail-soft internally); per-source read problems surface here. */
export interface McpImportScanResult {
  candidates: McpImportCandidateView[];
  problems: string[];
}

// ── import apply ──

export interface McpImportApplyRequest {
  tabId?: string;
  /** Target scope for the write — `compat` is refused (`read_only_source`). */
  scope: McpConfigScope;
  /**
   * Candidate IDENTITIES (`McpImportCandidateView.id`) to apply (W5-FIX, finding
   * 2) — the renderer's primary, cross-source-safe selector. When present the
   * handler filters on identity; two same-named candidates from different
   * harnesses are disambiguated.
   */
  ids?: string[];
  /**
   * Candidate names to apply — the automation-driver / back-compat fallback used
   * ONLY when `ids` is absent. Distinct-named candidates only (the identity path
   * is the secure one). Optional now that `ids` is the primary selector.
   */
  names?: string[];
  /**
   * Explicit consent to copy secret env/header VALUES from the source config
   * (design §3 trust gate). Default UNCHECKED on the renderer form; every
   * written entry is forced `enabled:false` regardless of this flag.
   */
  includeEnvValues: boolean;
}

export interface McpImportApplyResultItem {
  name: string;
  harness: McpHarnessKind;
  applied: boolean;
  /**
   * Set when NOT written: `exists` (target already defines the name) or
   * `unsafe_name` (a reserved prototype key — W5-FIX, finding 7).
   */
  skipped?: "exists" | "unsafe_name";
}

export type McpImportApplyResult =
  | { ok: true; results: McpImportApplyResultItem[]; snapshot: McpConfigSnapshot }
  | { ok: false; reason: McpConfigRefusalReason };

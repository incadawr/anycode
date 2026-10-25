/**
 * Language-server management control-plane contract (Taskana 4743). Four
 * additive invoke channels between main and the renderer for the Settings →
 * Language servers pane: a joined catalog+config+trust status view, one-click
 * enable of a catalog preset, disable (remove) of a configured entry, and a
 * custom-entry upsert. Mirrors shared/mcp-config.ts's structure exactly.
 *
 * VALUE-ONLY module with ZERO imports, exact ethic of shared/mcp-config.ts: it
 * is imported by preload (sandboxed CJS), the renderer web bundle, AND main,
 * so it must never drag zod or the @anycode/core barrel into a bundle that
 * cannot afford it. Request validation lives in main/lsp-config-ipc.ts (main
 * is the trust boundary), not here.
 *
 * Host↔ui wire delta: ZERO — independent invoke-channel registrations, not a
 * HostToUiMessage/AgentEvent variant, so there is no exhaustive-`never`
 * hazard and no protocol-fixture fallout. `lsp_status` /
 * `lsp_restart_request` on the host plane are UNTOUCHED (brief §2.7).
 *
 * PATH CUSTODY (mirror of the MCP rule): the renderer NEVER supplies a
 * filesystem path in any request — only `tabId` + `presetId`/`name`/`entry`.
 * Main resolves the project workspace from its own tab meta
 * (`workspaceForTab(tabId)`), never from a renderer string. In the RESPONSE
 * direction, detection returns only `found` + a coarse `foundSource`
 * ("path" | "project" | null) — the resolved absolute path of a binary never
 * crosses to the renderer. `initializationOptions` values never cross either:
 * `LspEntryView` carries only a boolean `hasInitOptions`.
 */

// ── invoke channels (4, additive) ──

/** invoke channel: read the joined LspConfigStatus (catalog + configured entries + trust). */
export const LSP_CATALOG_STATUS_CHANNEL = "anycode:lsp-catalog-status";

/** invoke channel: write a catalog preset into a scope's `lspServers`. */
export const LSP_ENABLE_CHANNEL = "anycode:lsp-enable";

/** invoke channel: remove one entry from a scope's `lspServers`. */
export const LSP_DISABLE_CHANNEL = "anycode:lsp-disable";

/** invoke channel: add or replace a custom (non-catalog) entry in a scope's `lspServers`. */
export const LSP_CUSTOM_UPSERT_CHANNEL = "anycode:lsp-custom-upsert";

// ── shared vocabulary ──

/** Scope a mutation targets; both are `.anycode/config.json` files (project = `<workspace>/`, user = `~`). */
export type LspConfigScope = "project" | "user";

/** Where a detected binary was found — coarse on purpose (never an absolute path). */
export type LspFoundSource = "path" | "project";

/** One catalog row in the status view: the preset plus its detection result. */
export interface LspCatalogStatusEntry {
  /** Catalog id — also the name written to `lspServers` on enable. */
  id: string;
  label: string;
  /** Display string naming the languages served. */
  languages: string;
  /** The executable the pane looked for (display; same value the enable would write). */
  command: string;
  args: string[];
  extensions: string[];
  /** Copyable install command — rendered as plain text, never executed. */
  installHint: string;
  /** Existence-only detection result (main/lsp-detect.ts; nothing is spawned). */
  found: boolean;
  foundSource: LspFoundSource | null;
}

/** One configured `lspServers` entry, projected for the pane (no `initializationOptions` values). */
export interface LspEntryView {
  name: string;
  command: string;
  args: string[];
  extensions: string[];
  /** The catalog id this entry's name matches, else null (custom/hand-written). */
  presetId: string | null;
  /** True when the raw entry carries `initializationOptions` (values never cross). */
  hasInitOptions: boolean;
}

/** Joined status view returned by `lsp-catalog-status` (always succeeds — fail-soft internally). */
export interface LspConfigStatus {
  catalog: LspCatalogStatusEntry[];
  /** Configured entries per scope; `project` is null when no workspace resolved. */
  entries: { project: LspEntryView[] | null; user: LspEntryView[] };
  /** Fail-soft loader-shaped problems (invalid JSON, bad entry, …) for the notices area. */
  issues: string[];
  /** Whether the request's tab workspace resolved (main-side truth). */
  projectScopeAvailable: boolean;
  /**
   * Whether the tab's workspace is trusted for project LSP entries: true
   * (trusted / nothing to gate), false (not trusted — project entries are
   * saved but inactive), or null (main could not determine it cheaply — the
   * pane shows the generic notice).
   */
  projectTrusted: boolean | null;
}

export interface LspCatalogStatusRequest {
  /** Active tab whose workspace resolves the project scope; omit for user-only. */
  tabId?: string;
}

// ── mutations ──

export type LspConfigRefusalReason =
  | "invalid"
  | "unknown_preset"
  | "no_workspace"
  | "io_error"
  /** A non-array `lspServers` value the writer refuses to clobber (or a bad entry). */
  | "invalid_shape";

export interface LspEnableRequest {
  tabId?: string;
  presetId: string;
  scope: LspConfigScope;
}

export interface LspDisableRequest {
  tabId?: string;
  /** The entry's `name` in the target scope's config file. */
  name: string;
  scope: LspConfigScope;
}

/**
 * Custom entry payload — `lspServerEntrySchema` minus `initializationOptions`
 * (the pane deliberately offers no init-options editing, brief §2.7). Main
 * normalizes extensions to lowercase with a leading dot before writing.
 */
export interface LspCustomEntryInput {
  name: string;
  command: string;
  args?: string[];
  extensions: string[];
}

export interface LspCustomUpsertRequest {
  tabId?: string;
  scope: LspConfigScope;
  entry: LspCustomEntryInput;
}

/** Response of enable/disable/custom-upsert: a fresh status on success, or a typed refusal. */
export type LspMutationResult =
  | { ok: true; status: LspConfigStatus }
  | { ok: false; reason: LspConfigRefusalReason };

/**
 * Reserved names the writer refuses (`__proto__`/`constructor`/`prototype`):
 * duplicated here so the catalog test can pin "no catalog id is dangerous"
 * without importing core into this value-only module's test graph twice.
 */
export const DANGEROUS_LSP_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Skills management control-plane contract (design slice-P7.20-cut.md §5 W2).
 * Seven additive invoke channels between main and the renderer for the Skills
 * settings pane: list the joined project/user/plugin catalog view, toggle a
 * skill's enabled state, delete/create/reveal an own-catalog skill, and
 * scan/apply an explicit-selection import from other coding-harness skill
 * catalogs (Claude, Codex, zcode, installed CC plugins).
 *
 * VALUE-ONLY module with ZERO imports, exact ethic of shared/mcp-config.ts: it
 * is imported by preload (sandboxed CJS), the renderer web bundle, AND main, so
 * it must never drag zod or the @anycode/core barrel into a bundle that cannot
 * afford it. Request validation lives in main/skills-ipc.ts (main is the trust
 * boundary), not here.
 *
 * Host↔ui wire delta: ZERO — these are independent invoke-channel registrations,
 * not a HostToUiMessage/AgentEvent variant, so there is no exhaustive-`never`
 * hazard and no protocol-fixture fallout.
 *
 * PATH CUSTODY INVARIANT (design §4 — the load-bearing invariant of this slice,
 * mirror of the MCP env/header-value custody rule but for FILESYSTEM PATHS): the
 * renderer NEVER supplies a filesystem path in any request below. A skill is
 * always identified by `name` (list/setEnabled/delete/reveal) or by an import
 * candidate's `id` (scan/apply); main re-resolves the real path from its OWN
 * fresh scan and verifies it sits under an own-catalog root before any
 * destructive or filesystem-revealing operation. `SkillRowView.path` DOES cross
 * to the renderer (display-only, same trusted-config custody class as the MCP
 * pane's `cwd` — the user's own file path, needed for a tooltip/reveal
 * affordance) but is never accepted back as a request field.
 */

// ── invoke channels (7, additive — independent registrations, no union exhaustiveness) ──

/** invoke channel: read the joined project/user/plugin SkillsSnapshot. */
export const SKILLS_LIST_CHANNEL = "anycode:skills-list";

/** invoke channel: toggle one skill's enabled state (scope = the row's sourceKind). */
export const SKILLS_SET_ENABLED_CHANNEL = "anycode:skills-set-enabled";

/** invoke channel: delete one own-catalog skill directory. */
export const SKILLS_DELETE_CHANNEL = "anycode:skills-delete";

/** invoke channel: scaffold a new `<scope>/.anycode/skills/<name>/SKILL.md`. */
export const SKILLS_CREATE_CHANNEL = "anycode:skills-create";

/** invoke channel: reveal an own-catalog skill's directory in the OS file manager. */
export const SKILLS_REVEAL_CHANNEL = "anycode:skills-reveal";

/** invoke channel: scan the fixed foreign-harness allowlist for import candidates. */
export const SKILLS_IMPORT_SCAN_CHANNEL = "anycode:skills-import-scan";

/** invoke channel: apply a consented subset of scanned candidates into a scope. */
export const SKILLS_IMPORT_APPLY_CHANNEL = "anycode:skills-import-apply";

// ── shared vocabulary ──

/** Where a row's defining catalog lives. `plugin` rows are read-only (§2 D1 scope OUT). */
export type SkillSourceKind = "project" | "user" | "plugin";

/** Scope a mutation targets — `plugin` is never a valid request value (no writer). */
export type SkillScope = "project" | "user";

export type SkillsRefusalReason =
  | "invalid"
  | "no_workspace"
  | "read_only_source"
  | "not_found"
  | "io_error";

// ── list ──

/**
 * One row of the joined catalog view (design §5 W2). `source` is the raw
 * discovery tag (`"project" | "user" | "plugin:<name>"`, core's `SkillMeta`
 * shape); `sourceKind` is the display-normalized 3-way split the pane groups
 * on, with `pluginName` carried separately for the plugin-group badge/note.
 * `path` is the skill directory's SKILL.md absolute path — trusted config, not
 * a secret (custody note above) — safe to cross for the Reveal affordance.
 */
export interface SkillRowView {
  name: string;
  description: string;
  source: string;
  sourceKind: SkillSourceKind;
  pluginName?: string;
  enabled: boolean;
  path: string;
}

export interface SkillsSnapshot {
  rows: SkillRowView[];
  /** Fail-soft discovery/plugin-discovery problems (never throws). */
  problems: string[];
}

export interface SkillsListRequest {
  /** Active tab whose workspace resolves the project roots; omit for user-only. */
  tabId?: string;
}

/** Response of a mutation that changes the catalog: a fresh snapshot, or a typed refusal. */
export type SkillsMutationResult =
  | { ok: true; snapshot: SkillsSnapshot }
  | { ok: false; reason: SkillsRefusalReason };

// ── set-enabled / delete / reveal (identity = name, NEVER a path) ──

export interface SkillsSetEnabledRequest {
  tabId?: string;
  name: string;
  enabled: boolean;
}

export interface SkillsDeleteRequest {
  tabId?: string;
  name: string;
}

export interface SkillsRevealRequest {
  tabId?: string;
  name: string;
}

/** Reveal has no catalog effect on success — no snapshot to return, just an ok/refusal. */
export type SkillsRevealResult = { ok: true } | { ok: false; reason: SkillsRefusalReason };

// ── create (scaffold) ──

export interface SkillsCreateRequest {
  tabId?: string;
  scope: SkillScope;
  name: string;
  description: string;
}

// ── import scan ──

/** Origin harness of a discovered candidate — mirrors core's `SkillHarnessKind`. */
export type SkillHarnessKind = "claude" | "claude-project" | "codex" | "zcode" | "claude-plugin";

/**
 * One discovered foreign-harness skill, projected for the renderer. `id` is the
 * stable candidate IDENTITY (`${harness} ${sourceDir} ${name}`, built main-side,
 * same W5-FIX-2 discipline as the MCP import) — apply selects on this, never on
 * `name` alone, so two harnesses defining the same name stay distinct.
 */
export interface SkillImportCandidateView {
  id: string;
  harness: SkillHarnessKind;
  sourceDir: string;
  name: string;
  description: string;
  /** false ⇒ name/description unextractable — rendered disabled, NEVER imported. */
  compatible: boolean;
  /** true ⇒ frontmatter will be rewritten by the D3 normalizer on import. */
  needsConversion: boolean;
  conversionNotes: string[];
  /** true ⇒ `name` already exists in our post-dedup catalog (will suffix on import). */
  alreadyPresent: boolean;
}

export interface SkillsImportScanRequest {
  tabId?: string;
}

/** Always succeeds (fail-soft internally); per-source read problems surface here. */
export interface SkillsImportScanResult {
  candidates: SkillImportCandidateView[];
  problems: string[];
}

// ── import apply ──

export interface SkillsImportApplyRequest {
  tabId?: string;
  /** Target scope for the write — `<scope>/.anycode/skills`. */
  scope: SkillScope;
  /** Candidate IDENTITIES (`SkillImportCandidateView.id`) to apply. */
  ids: string[];
}

export interface SkillsImportApplyResultItem {
  id: string;
  /** Final name written (may carry a `-N` conflict suffix). */
  name: string;
  applied: boolean;
  suffixed: boolean;
  converted: boolean;
  /** Set when NOT applied. */
  skipped?: "incompatible" | "unsafe_name" | "io_error";
  notes: string[];
}

export type SkillsImportApplyResult =
  | { ok: true; results: SkillsImportApplyResultItem[]; snapshot: SkillsSnapshot }
  | { ok: false; reason: SkillsRefusalReason };

/**
 * Subagents editor control-plane contract (design slice-P7.21-cut.md §2-D6 +
 * §4 W2). Seven additive invoke channels between main and the renderer for the
 * Settings "Subagents" pane: list the joined built-in/project/user/plugin
 * catalog view, read one profile's editable draft, save/create/delete an
 * own-catalog profile, reveal its file in the OS file manager, and preview the
 * REAL final child system prompt a draft would spawn with.
 *
 * VALUE-ONLY module with ZERO imports, exact ethic of shared/skills-config.ts:
 * it is imported by preload (sandboxed CJS), the renderer web bundle, AND
 * main, so it must never drag zod or the @anycode/core barrel into a bundle
 * that cannot afford it. Request validation lives in main/subagents-ipc.ts
 * (main is the trust boundary), not here.
 *
 * Host<->ui wire delta: ZERO — these are independent invoke-channel
 * registrations, not a HostToUiMessage/AgentEvent variant, so there is no
 * exhaustive-`never` hazard and no protocol-fixture fallout.
 *
 * PATH CUSTODY INVARIANT (design §2-D7 — the load-bearing invariant of this
 * slice, exact mirror of the skills-config.ts path-custody rule but for agent
 * profiles): the renderer NEVER supplies a filesystem path in any request
 * below. A profile is always identified by `(name, sourceKind)` — main
 * re-resolves the real path from its OWN fresh admin scan and verifies it
 * sits under an own-catalog root (`<ws>/.anycode/agents` or
 * `~/.anycode/agents`) before any read/save/delete/reveal. `SubagentRowView.path`
 * DOES cross to the renderer (display-only, same trusted-config custody class
 * as the skills pane's row path — the user's own file path, needed for a
 * tooltip/reveal affordance) but is never accepted back as a request field.
 */

// ── invoke channels (7, additive — independent registrations, no union exhaustiveness) ──

/** invoke channel: read the joined built-in/project/user/plugin SubagentsSnapshot. */
export const SUBAGENTS_LIST_CHANNEL = "anycode:subagents-list";

/** invoke channel: read one profile's editable draft + raw md. */
export const SUBAGENTS_READ_CHANNEL = "anycode:subagents-read";

/** invoke channel: save (and optionally rename) an existing own-catalog profile. */
export const SUBAGENTS_SAVE_CHANNEL = "anycode:subagents-save";

/** invoke channel: create a NEW own-catalog profile. */
export const SUBAGENTS_CREATE_CHANNEL = "anycode:subagents-create";

/** invoke channel: delete one own-catalog profile. */
export const SUBAGENTS_DELETE_CHANNEL = "anycode:subagents-delete";

/** invoke channel: reveal an own-catalog profile's file in the OS file manager. */
export const SUBAGENTS_REVEAL_CHANNEL = "anycode:subagents-reveal";

/** invoke channel: compute the REAL final child system prompt a draft would spawn with. */
export const SUBAGENTS_PREVIEW_CHANNEL = "anycode:subagents-preview";

// ── shared vocabulary ──

/** Where a row's defining catalog lives. `builtin` and `plugin` rows are read-only. */
export type SubagentSourceKind = "builtin" | "project" | "user" | "plugin";

/** Scope a create targets — `builtin`/`plugin` are never valid request values (no writer). */
export type SubagentScope = "project" | "user";

export type SubagentsRefusalReason =
  | "invalid"
  | "no_workspace"
  | "read_only_source"
  | "not_found"
  | "io_error"
  | "reserved_name"
  | "validation_failed";

// ── list ──

/**
 * One row of the joined catalog view (design §4 W2). `source` is the raw
 * provenance tag (`"builtin" | "project" | "user" | "plugin:<name>"`);
 * `sourceKind` is the display-normalized 4-way split the pane groups on, with
 * `pluginName` carried separately for the plugin-group badge/note. `toolsBadge`
 * is the human label ("All tools" / "N tools") the row/card renders;
 * `toolCount` is the same number the badge derives from, exposed separately
 * for tests/searches that want the raw count. `path` is the profile `*.md`'s
 * absolute path — trusted config, not a secret (custody note above) — safe to
 * cross for a tooltip/reveal affordance; absent for `builtin` rows (no file).
 */
export interface SubagentRowView {
  name: string;
  description: string;
  toolsBadge: string;
  toolCount: number;
  source: string;
  sourceKind: SubagentSourceKind;
  pluginName?: string;
  path?: string;
  /** false for `builtin` and `plugin` rows — no mutation affordance rendered. */
  editable: boolean;
}

export interface SubagentsSnapshot {
  rows: SubagentRowView[];
  /** Fail-soft discovery/plugin-discovery problems (never throws). */
  problems: string[];
}

export interface SubagentsListRequest {
  /** Active tab whose workspace resolves the project root; omit for user-only. */
  tabId?: string;
}

/** Response of a mutation that changes the catalog: a fresh snapshot, or a typed refusal. */
export type SubagentsMutationResult =
  | { ok: true; snapshot: SubagentsSnapshot }
  | { ok: false; reason: SubagentsRefusalReason; issues?: string[] };

// ── draft (editor content) ──

/**
 * A draft profile the editor edits/previews/saves. Mirrors core's
 * `SubagentProfileDraft` (packages/core/src/subagents/preview.ts) field-for-
 * field — this is the renderer-grain value-only twin (no core import allowed
 * here), kept structurally identical by a shared-shape unit test.
 */
export interface SubagentProfileDraft {
  name: string;
  description: string;
  /** Absent ⇒ inherit the general-purpose baseline (nine non-spawn tools). */
  tools?: string[];
  body: string;
}

// ── read (identity = name + sourceKind, NEVER a path) ──

export interface SubagentsReadRequest {
  tabId?: string;
  name: string;
  sourceKind: SubagentSourceKind;
}

export type SubagentReadResult =
  | { ok: true; draft: SubagentProfileDraft; raw: string }
  | { ok: false; reason: SubagentsRefusalReason };

// ── save (existing profile; a name change in the draft is a rename) ──

export interface SubagentsSaveRequest {
  tabId?: string;
  /** The EXISTING row's identity (before any rename in `draft.name`). */
  name: string;
  sourceKind: SubagentSourceKind;
  draft: SubagentProfileDraft;
}

// ── create ──

export interface SubagentsCreateRequest {
  tabId?: string;
  scope: SubagentScope;
  draft: SubagentProfileDraft;
}

// ── delete / reveal (identity = name + sourceKind, NEVER a path) ──

export interface SubagentsDeleteRequest {
  tabId?: string;
  name: string;
  sourceKind: SubagentSourceKind;
}

export interface SubagentsRevealRequest {
  tabId?: string;
  name: string;
  sourceKind: SubagentSourceKind;
}

/** Reveal has no catalog effect on success — no snapshot to return, just an ok/refusal. */
export type SubagentsRevealResult = { ok: true } | { ok: false; reason: SubagentsRefusalReason };

// ── preview (no identity — previews whatever draft the editor currently holds) ──

export interface SubagentsPreviewRequest {
  draft: SubagentProfileDraft;
}

export type SubagentsPreviewResult =
  | { ok: true; systemPrompt: string; effectiveTools: string[] }
  | { ok: false; reason: "invalid" };

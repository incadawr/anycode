/**
 * Taskana 4704 §3.9 (part B) — pure preset derivation for the first-run
 * RolePickerDialog and the Settings Roles pane. Same discipline as
 * slash-menu.ts/vision-pane-model.ts: this package's vitest runs
 * `environment: "node"` (no jsdom), so every decision the dialog needs is a
 * plain exported function here and the JSX only renders what these return.
 *
 * Three presets (§3.9, LAW — names, applicability, and per-role chains):
 *
 *  P1 "Claude leads, Codex builds" — requires claude ready AND codex ready:
 *     orchestrator/planner/reviewer `{engine:"claude"}`, executor
 *     `{engine:"codex"}` with fallback `[{connection: activeConnectionId}]`,
 *     explore `{connection: activeConnectionId}`.
 *  P2 "All Claude" — requires claude ready: all roles `{engine:"claude"}`;
 *     explore fallback `[{connection: activeConnectionId}]`.
 *  P3 "This connection" — always available: every role
 *     `{connection: <active>}`.
 *
 * Auto-selection order is P1 > P2 > P3 (the first applicable wins); the user
 * can edit anything before Save.
 */
import type { RoleConfig, RoleRouteEntry } from "../../shared/settings.js";

/** The five roles the picker edits (orchestrator + the four delegate roles). */
export const ROLE_PRESET_ROLES = ["orchestrator", "planner", "executor", "reviewer", "explore"] as const;

export type PresetRole = (typeof ROLE_PRESET_ROLES)[number];

/** Minimal engine-readiness input: which external engines are ready. */
export interface PresetEngineInput {
  claudeReady: boolean;
  codexReady: boolean;
}

/** A preset's identity plus the role chains it would write. */
export interface RolePreset {
  id: "claude-leads-codex-builds" | "all-claude" | "this-connection";
  label: string;
  /** Human one-liner shown under the chip. */
  description: string;
  roles: Record<PresetRole, RoleConfig>;
}

/** `claude` everywhere helper. */
function claudeEntry(): RoleRouteEntry {
  return { engine: "claude" };
}

/** P1 — "Claude leads, Codex builds" (§3.9 verbatim chain). */
function preset1(activeConnectionId: string): RolePreset["roles"] {
  return {
    orchestrator: { primary: claudeEntry() },
    planner: { primary: claudeEntry() },
    executor: { primary: { engine: "codex" }, fallbacks: [{ connection: activeConnectionId }] },
    reviewer: { primary: claudeEntry() },
    explore: { primary: { connection: activeConnectionId } },
  };
}

/** P2 — "All Claude" (§3.9 verbatim chain). */
function preset2(activeConnectionId: string): RolePreset["roles"] {
  return {
    orchestrator: { primary: claudeEntry() },
    planner: { primary: claudeEntry() },
    executor: { primary: claudeEntry() },
    reviewer: { primary: claudeEntry() },
    explore: { primary: claudeEntry(), fallbacks: [{ connection: activeConnectionId }] },
  };
}

/** P3 — "This connection" (§3.9 verbatim chain). */
function preset3(activeConnectionId: string): RolePreset["roles"] {
  const entry: RoleRouteEntry = { connection: activeConnectionId };
  return {
    orchestrator: { primary: entry },
    planner: { primary: entry },
    executor: { primary: entry },
    reviewer: { primary: entry },
    explore: { primary: entry },
  };
}

/**
 * All three presets, in auto-select priority order (P1, P2, P3), each with
 * its applicability predicate. Pure over the inputs; a preset whose engines
 * are not ready is still listed (the dialog may show it disabled) but never
 * auto-selected by {@link autoSelectPreset}.
 */
export function deriveRolePresets(engines: PresetEngineInput, activeConnectionId: string): RolePreset[] {
  return [
    {
      id: "claude-leads-codex-builds",
      label: "Claude leads, Codex builds",
      description: "Claude plans and reviews, Codex implements; explore runs on this connection.",
      roles: preset1(activeConnectionId),
    },
    {
      id: "all-claude",
      label: "All Claude",
      description: "Every role runs on Claude; explore falls back to this connection.",
      roles: preset2(activeConnectionId),
    },
    {
      id: "this-connection",
      label: "This connection",
      description: "Every role runs on the active connection's model.",
      roles: preset3(activeConnectionId),
    },
  ];
}

/** A preset's applicability (§3.9): P1 needs BOTH engines, P2 needs claude, P3 always. */
export function presetApplicable(preset: RolePreset, engines: PresetEngineInput): boolean {
  switch (preset.id) {
    case "claude-leads-codex-builds":
      return engines.claudeReady && engines.codexReady;
    case "all-claude":
      return engines.claudeReady;
    case "this-connection":
      return true;
  }
}

/** The first applicable preset in P1 > P2 > P3 order — never null (P3 always applies). */
export function autoSelectPreset(engines: PresetEngineInput, activeConnectionId: string): RolePreset {
  const presets = deriveRolePresets(engines, activeConnectionId);
  return presets.find((preset) => presetApplicable(preset, engines)) ?? presets[presets.length - 1]!;
}

/**
 * Default model prefill for one role's primary entry (§3.9): the connection's
 * own `model`, else its first `models[]` entry, else "" (free text). Only a
 * CONNECTION-routed (or routing-less) entry consults the connection facts —
 * an engine entry names no connection, so its model is free text (§3.9's
 * "model text input prefilled from connection.model ?? connection.models[0]"
 * is about the connection option). Pure — the dialog calls it per role when
 * seeding the editable draft.
 */
export function entryModelPrefill(entry: RoleRouteEntry, connectionModel: string | undefined, connectionModels: readonly string[] | undefined): string {
  if (entry.engine !== undefined) {
    return entry.model ?? "";
  }
  if (entry.model !== undefined) {
    return entry.model;
  }
  if (connectionModel !== undefined && connectionModel.length > 0) {
    return connectionModel;
  }
  return connectionModels?.[0] ?? "";
}

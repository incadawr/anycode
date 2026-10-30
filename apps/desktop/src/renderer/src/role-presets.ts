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
 *  P3 "Current connection" — always available: every role pins
 *     `{connection: activeConnectionId}`.
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

/** P3 — "Current connection" (§3.9 verbatim chain). */
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
      label: "Current connection",
      description: "Every role is pinned to the connection active now.",
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

/** Key-order-independent serialization: the editor builds the same chains in a different insertion order than a persisted file. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * True when a roles payload is exactly this preset's chain. The chip that is
 * highlighted must follow the VALUES the editor shows, not the last chip that
 * happened to be clicked or auto-selected: an edited or persisted chain that no
 * preset describes highlights nothing.
 */
export function presetMatchesRoles(preset: RolePreset, roles: Partial<Record<PresetRole, RoleConfig>>): boolean {
  return stableJson(roles) === stableJson(preset.roles);
}

/**
 * The one preset a roles payload equals, or null when no chip can honestly
 * claim it. With `engines`, a preset that is not applicable on this machine
 * is excluded too: highlighting a disabled chip ("Current connection" over a
 * Claude/Codex chain, or an engine preset nothing is signed in for) is exactly
 * the contradiction this exists to prevent.
 */
export function activePresetId(
  presets: readonly RolePreset[],
  roles: Partial<Record<PresetRole, RoleConfig>>,
  engines?: PresetEngineInput,
): RolePreset["id"] | null {
  return presets.find(
    (preset) => (engines === undefined || presetApplicable(preset, engines)) && presetMatchesRoles(preset, roles),
  )?.id ?? null;
}

/**
 * Why a preset chip is disabled, in words — a hover `title` alone leaves
 * touch/keyboard users with no explanation. `null` for an applicable preset.
 */
export function presetUnavailableReason(preset: RolePreset, engines: PresetEngineInput): string | null {
  if (presetApplicable(preset, engines)) return null;
  switch (preset.id) {
    case "claude-leads-codex-builds": {
      const missing = [
        engines.claudeReady ? null : "Claude",
        engines.codexReady ? null : "Codex",
      ].filter((name): name is string => name !== null).join(" and ");
      return `Requires ${missing} to be set up and signed in.`;
    }
    case "all-claude":
      return "Requires Claude to be set up and signed in.";
    case "this-connection":
      return null;
  }
}

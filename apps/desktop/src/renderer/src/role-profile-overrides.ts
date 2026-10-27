/**
 * a hand-authored md agent profile named
 * after a role (`<workspace>/.anycode/agents/reviewer.md`, `~/.anycode/agents/
 * planner.md`, a plugin's copy) WINS over the Settings route — md-profile >
 * settings-derived > built-in (host/index.ts's `resolveRoleRouteImpl` answers
 * `null` for a claimed role, so the profile's own routing applies). Before this
 * module the user could save a role route that never took effect and see
 * nothing about it in Settings → Roles.
 *
 * This is the renderer-grain projection of the host's own claim rule: a role is
 * CLAIMED when a discovered profile row with that exact name exists and it is
 * not one of the built-in personas themselves. Value-only (no core import) so
 * the Settings bundle stays light.
 */
import type { SubagentRowView } from "../../shared/subagents-config.js";
import type { PresetRole } from "./role-presets.js";

/**
 * The roles a route chain is resolved for (core's `isRoleRouteName`): a profile
 * named `orchestrator` claims nothing, so listing it would be a false warning.
 */
export const ROLE_ROUTE_CLAIM_NAMES = ["planner", "executor", "reviewer", "explore"] as const;
export type RoleRouteClaimName = (typeof ROLE_ROUTE_CLAIM_NAMES)[number];

export interface RoleProfileOverride {
  role: RoleRouteClaimName;
  /** The profile's catalog name (identical to the role name by definition). */
  profileName: string;
  /** The profile file's absolute path when discovery resolved one. */
  path?: string;
}

/**
 * One override per claimed role, or `{}` when nothing claims a role. Rows are
 * already in discovery precedence order (project > user > plugin), so the FIRST
 * match for a name is the one the host will resolve too.
 */
export function claimedRoleOverrides(
  rows: readonly SubagentRowView[],
  claims?: readonly { name: string; path: string }[],
): Partial<Record<PresetRole, RoleProfileOverride>> {
  const overrides: Partial<Record<PresetRole, RoleProfileOverride>> = {};
  for (const row of rows) {
    // Built-in personas carry the role names by construction — they are the
    // fallback the profile would override, never a claim themselves.
    if (row.sourceKind === "builtin") continue;
    if (!(ROLE_ROUTE_CLAIM_NAMES as readonly string[]).includes(row.name)) continue;
    const role = row.name as RoleRouteClaimName;
    if (overrides[role] !== undefined) continue;
    overrides[role] = { role, profileName: row.name, ...(row.path !== undefined ? { path: row.path } : {}) };
  }
  if (claims !== undefined) {
    for (const role of ROLE_ROUTE_CLAIM_NAMES) {
      const claim = claims.find((entry) => entry.name === role);
      if (!claim) delete overrides[role];
      else overrides[role] = { role, profileName: role, path: claim.path };
    }
  }
  return overrides;
}

/**
 * The notice text for one claimed role: the file the user has to edit or remove
 * for their Settings route to apply again. Falls back to the conventional
 * project-relative path when a row carried no path (built-in/plugin edge).
 */
export function roleOverrideNotice(override: RoleProfileOverride): string {
  const file = override.path ?? `.anycode/agents/${override.profileName}.md`;
  return `Overridden by the agent profile ${file} — this role's Settings route is not used while that profile exists.`;
}

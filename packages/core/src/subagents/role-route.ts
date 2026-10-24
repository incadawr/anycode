/**
 * Shared role-route types (Taskana 4704 §3.2/§3.6). The chain shape is the
 * contract between the HOST-side resolver (settings roles section + health
 * cache) and core's consumers (the inline runner chain walk and the Agent
 * tool's session-tier route stamping). Core deliberately carries NO catalog,
 * clock, or settings knowledge: it only walks entries and reports skips.
 *
 * Import-free of runner.ts/agent.ts on purpose — this is a leaf type module
 * both sides can depend on without a cycle.
 */

import type { AgentProfileEffort, PersonaDefinition, PersonaName } from "./personas.js";
import type { AgentProfileEngine } from "./profiles.js";

/** One hop of a role's model route (mirrors the settings RoleRouteEntry). */
export interface RoleRouteEntry {
  engine?: AgentProfileEngine;
  /** Exact connection id; mutually exclusive with engine (settings schema enforces). */
  connection?: string;
  /** Catalog provider id; mutually exclusive with engine and connection. */
  provider?: string;
  model?: string;
  effort?: AgentProfileEffort;
}

/**
 * The roles a route chain can be resolved for: the three orchestration role
 * personas plus explore (the 4131 cheap-default folds into the same chain
 * walk as a one-entry chain).
 */
export type RoleRouteName = Extract<PersonaName, "planner" | "executor" | "reviewer" | "explore">;

/** True when an agent_type participates in role-route resolution at all. */
export function isRoleRouteName(agentType: string): agentType is RoleRouteName {
  return agentType === "planner" || agentType === "executor" || agentType === "reviewer" || agentType === "explore";
}

/** A skipped entry and why (resolver rejection text, or "needs session tier"). */
export interface RoleRouteSkip {
  entry: RoleRouteEntry;
  reason: string;
}

/**
 * A host-resolved chain: ordered entries already filtered to inline-runnable
 * provider/model hops by the caller when appropriate, plus the per-skip
 * reasons for visibility. The parent model remains the implicit last resort —
 * represented by simply stamping no route fields when every entry is skipped.
 */
export interface RoleRouteResolution {
  entries: readonly RoleRouteEntry[];
  skipped: readonly RoleRouteSkip[];
  /** Role turn budget (ROLE_TURN_BUDGETS) stamped onto session-tier requests. */
  turnBudget?: number;
}

/**
 * Model-visible notice for a role whose ENTIRE route chain is cooling down: the
 * spawn runs on the parent's model (the documented last resort). Shared by the
 * inline runner (N3) and the session tier (Taskana 4729) — the text is pinned.
 */
export function formatRoleDegradeNotice(agentType: string, skipped: readonly RoleRouteSkip[]): string {
  const reasons = skipped.map((s) => s.reason).join("; ");
  return `Agent: role "${agentType}" ran on the parent's model (every route entry is unhealthy${reasons ? `: ${reasons}` : ""})`;
}

/**
 * Model-visible notice for a role whose PRIMARY entry was skipped but a later
 * entry is healthy and runs instead (Taskana 4729).
 */
export function formatRoleFallbackNotice(agentType: string, skipped: readonly RoleRouteSkip[]): string {
  const reasons = skipped.map((s) => s.reason).join("; ");
  return `Agent: role "${agentType}" skipped its primary route entry${reasons ? ` (${reasons})` : ""}; running on the next healthy entry`;
}

/**
 * The request fields a role route stamps onto a FRESH session-tier spawn
 * (Taskana 4704 §3.3 / R7, Taskana 4729, Taskana 4735). Every key is optional
 * and omitted rather than undefined, so the spread keeps the request
 * byte-identical when nothing stamps.
 */
export interface RoleRouteRequestFields {
  provider?: string;
  connectionId?: string;
  engine?: AgentProfileEngine;
  model?: string;
  effort?: AgentProfileEffort;
  maxTurns?: number;
  routeStamped?: boolean;
}

/**
 * The route -> request stamping, shared by the Agent tool's session tier
 * (tools/agent.ts runSessionTier) and the workflow engine's engine-role steps
 * (workflow/engine.ts) so the two cannot drift.
 *
 * `caller` carries what the caller chose itself: an explicit provider or model
 * outranks the route's own fields (R7/F9 precedence), `engineTurnBudget` is the
 * engine profile's own turn budget (it outranks the role's budget), and
 * `degraded` marks a spawn whose route chain is fully exhausted — only then
 * does the role's turn budget ride an entry-less route.
 *
 * Pure: the caller spreads the result onto the request at its own position.
 */
export function buildRoleRouteRequestFields(
  roleRoute: RoleRouteResolution | undefined,
  caller: { provider?: string; model?: string; engineTurnBudget?: number; degraded: boolean },
): RoleRouteRequestFields {
  if (roleRoute === undefined) {
    return {};
  }
  if (roleRoute.entries.length === 0) {
    // Taskana 4729: an exhausted chain has no entry to stamp, but the role's
    // turn budget still rides the spawn (the last resort keeps the role's cap).
    return caller.degraded && roleRoute.turnBudget !== undefined ? { maxTurns: roleRoute.turnBudget } : {};
  }
  const first = roleRoute.entries[0]!;
  const noProvider = caller.provider === undefined;
  const noModel = caller.model === undefined;
  return {
    ...(noProvider && noModel && first.provider !== undefined ? { provider: first.provider } : {}),
    ...(noProvider && first.connection !== undefined ? { connectionId: first.connection } : {}),
    // F5(a): an engine entry stamps `engine` so a respawn reads the entry the
    // child actually runs on.
    ...(noProvider && noModel && first.engine !== undefined ? { engine: first.engine } : {}),
    ...(noModel && first.model !== undefined ? { model: first.model } : {}),
    // F9: an explicit model also drops the entry's effort tier.
    ...(noModel && first.effort !== undefined ? { effort: first.effort } : {}),
    ...(roleRoute.turnBudget !== undefined && caller.engineTurnBudget === undefined
      ? { maxTurns: roleRoute.turnBudget }
      : {}),
    // R7: marks a spawn whose routing fields came from the ROUTE, not the caller.
    ...(noProvider && noModel ? { routeStamped: true } : {}),
  };
}

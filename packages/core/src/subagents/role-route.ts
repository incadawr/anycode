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

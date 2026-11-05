/** Engine-neutral projection of personas into the Agent bridge catalog. */

import { PERSONAS, isReservedPersonaName, sessionRestrictionsForPersona, type AgentBridgeCatalogEntry, type PersonaDefinition } from "@anycode/core";
import type { AnycodeSettings } from "../shared/settings.js";
import { readRoleSettings } from "./role-settings.js";

export function catalogFromProfiles(profiles: readonly PersonaDefinition[]): AgentBridgeCatalogEntry[] {
  return profiles
    .filter((profile) => !isReservedPersonaName(profile.name))
    .map(projectPersona);
}

function projectPersona(profile: PersonaDefinition): AgentBridgeCatalogEntry {
  return ({
      name: profile.name,
      description: profile.description,
      systemPrompt: profile.systemPrompt,
      ...(sessionRestrictionsForPersona(profile, true) !== null ? { restrictions: sessionRestrictionsForPersona(profile, true)! } : {}),
      ...(profile.engine !== undefined ? { engine: profile.engine } : {}),
      ...(profile.model !== undefined ? { model: profile.model } : {}),
      ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
      // the profile's turn budget rides the creating spawn's
      // session-tier request (catalog maxTurns); omitted when absent.
      ...(profile.turnBudget !== undefined ? { maxTurns: profile.turnBudget } : {}),
      // the profile's own connection selection rides the catalog
      // (and thus the creating spawn) verbatim. An engine profile can never
      // carry these (parser-fatal), so the two spreads below never co-exist
      // with `engine` above.
      ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
      ...(profile.connection !== undefined ? { connection: profile.connection } : {}),
    });
}

/**
 * Catalog a bridge CALL may use: entries re-read from disk now,
 * filtered to names the boot snapshot declared (the CLI's tools/list cache and
 * the codex thread's declarations are both per-session — names never hot-add).
 * Parity with the codex door's own filter (dynamic-tool-bridge.ts handle()).
 */
export function bridgeCallableCatalog(
  boot: readonly AgentBridgeCatalogEntry[],
  current: readonly AgentBridgeCatalogEntry[],
): readonly AgentBridgeCatalogEntry[] {
  return current.filter((entry) => boot.some((declared) => declared.name === entry.name));
}

/** Build the orchestration catalog; discovered profiles take precedence over role settings. */
export function roleCatalog(
  profiles: readonly PersonaDefinition[],
  roles: AnycodeSettings["roles"],
): AgentBridgeCatalogEntry[] {
  const discovered = profiles.filter((profile) => !isReservedPersonaName(profile.name));
  const builtins = (["planner", "executor", "reviewer", "explore"] as const).map((name) => {
    const profile = discovered.find((entry) => entry.name === name);
    if (profile) return profile;
    const primary = roles?.[name]?.primary;
    return { ...PERSONAS[name], ...(primary ?? {}), turnBudget: undefined };
  });
  const names = new Set(builtins.map((entry) => entry.name));
  // Explore is reserved against discovery, so project it explicitly.
  return [...builtins.map(projectPersona), ...catalogFromProfiles(discovered.filter((entry) => !names.has(entry.name)))];
}

/** Read role profiles on every call, allowing profile switches within a session. */
export function readRoleCatalog(profiles: readonly PersonaDefinition[], settingsPath: string, projectRoot: string): AgentBridgeCatalogEntry[] {
  return roleCatalog(profiles, readRoleSettings(settingsPath, projectRoot));
}

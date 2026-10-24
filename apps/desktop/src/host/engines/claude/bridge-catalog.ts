/**
 * Projects `discoverAgentProfiles`'s output (`PersonaDefinition[]`, core's own
 * shared profile scanner — TASK.226 план §3.1/F13, this srez is FORBIDDEN from
 * writing a new scanner) onto the MCP bridge's model-visible catalog
 * (`AgentBridgeCatalogEntry[]`, срез S1's `buildAgentBridgeToolDecl`/
 * `runAgentBridgeCall`).
 *
 * Deliberately excludes hard-reserved personas (`general-purpose`/`explore`)
 * even if one ever appeared in the input list: `discoverAgentProfiles` itself
 * never returns one (it only scans `.anycode/agents/*.md`, never `PERSONAS`),
 * but `isReservedPersonaName` is checked here too so the exclusion holds by
 * construction rather than by the caller only ever passing the right array
 * (plan §3.1: "встроенные персоны … НЕ включаются в v1"). Taskana 4704 made
 * planner/executor/reviewer overridable personas (an md-profile or a
 * settings-derived role persona may legitimately own those names), so the
 * filter must be the reserved-name check, not `isKnownPersona` — otherwise
 * user role personas vanish from the Claude bridge catalog.
 */

import { isReservedPersonaName, type AgentBridgeCatalogEntry, type PersonaDefinition } from "@anycode/core";

export function catalogFromProfiles(profiles: readonly PersonaDefinition[]): AgentBridgeCatalogEntry[] {
  return profiles
    .filter((profile) => !isReservedPersonaName(profile.name))
    .map((profile) => ({
      name: profile.name,
      description: profile.description,
      systemPrompt: profile.systemPrompt,
      ...(profile.engine !== undefined ? { engine: profile.engine } : {}),
      ...(profile.model !== undefined ? { model: profile.model } : {}),
      ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
      // TASK.180: the profile's turn budget rides the creating spawn's
      // session-tier request (catalog maxTurns); omitted when absent.
      ...(profile.turnBudget !== undefined ? { maxTurns: profile.turnBudget } : {}),
      // Taskana 4269: the profile's own connection selection rides the catalog
      // (and thus the creating spawn) verbatim. An engine profile can never
      // carry these (parser-fatal), so the two spreads below never co-exist
      // with `engine` above.
      ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
      ...(profile.connection !== undefined ? { connection: profile.connection } : {}),
    }));
}

/**
 * Catalog a bridge CALL may use (Taskana 4101): entries re-read from disk now,
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

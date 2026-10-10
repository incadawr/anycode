/**
 * Projects `discoverAgentProfiles`'s output (`PersonaDefinition[]`, core's own
 * shared profile scanner — TASK.226 план §3.1/F13, this srez is FORBIDDEN from
 * writing a new scanner) onto the MCP bridge's model-visible catalog
 * (`AgentBridgeCatalogEntry[]`, срез S1's `buildAgentBridgeToolDecl`/
 * `runAgentBridgeCall`).
 *
 * Deliberately excludes built-in personas (`general-purpose`/`explore`) even
 * if one ever appeared in the input list: `discoverAgentProfiles` itself never
 * returns one (it only scans `.anycode/agents/*.md`, never `PERSONAS`), but
 * `isKnownPersona` is checked here too so the exclusion holds by construction
 * rather than by the caller only ever passing the right array (plan §3.1: "
 * встроенные персоны … НЕ включаются в v1").
 */

import { isKnownPersona, type AgentBridgeCatalogEntry, type PersonaDefinition } from "@anycode/core";

export function catalogFromProfiles(profiles: readonly PersonaDefinition[]): AgentBridgeCatalogEntry[] {
  return profiles
    .filter((profile) => !isKnownPersona(profile.name))
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
    }));
}

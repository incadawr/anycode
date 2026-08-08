export {
  SPAWN_TOOLS,
  buildChildConfig,
  createSubagentRunner,
  withSubagents,
} from "./runner.js";
export type { SubagentRunnerOptions } from "./runner.js";
export {
  PERSONAS,
  getPersona,
  isKnownPersona,
  listPersonaNames,
} from "./personas.js";
export type { PersonaDefinition, PersonaName } from "./personas.js";
export { discoverAgentProfiles } from "./profiles.js";
export type { AgentProfileRoot, AgentProfilesResult } from "./profiles.js";
export {
  createSubagentCardAccumulator,
  finalizeSubagentCard,
  reduceSubagentCardEvent,
} from "./card-snapshot.js";
export type { SubagentCardAccumulator, SubagentCardEvent } from "./card-snapshot.js";
// Re-exported so the renderer's S1 parity test (subagent-card.test.ts) can
// value-import the real cap alongside the five SUBAGENT_CARD_* constants
// (TASK.102 slice S1 review finding #1): summarize-tool.ts is not a types/
// file, so it rides the root barrel via this module's existing wildcard
// export (index.ts: `export * from "./subagents/index.js"`) rather than
// types/index.ts's curated config.js re-export list.
export { SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS } from "./summarize-tool.js";

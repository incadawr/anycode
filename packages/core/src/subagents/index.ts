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
export {
  appendFinalText,
  createFinalTextAccumulator,
  finalizeFinalText,
  fixateFinalText,
  resetFinalText,
} from "./final-text.js";
export type { FinalTextAccumulator } from "./final-text.js";
// Re-exported so the renderer's S1 parity test (subagent-card.test.ts) can
// value-import the real cap alongside the five SUBAGENT_CARD_* constants
// (TASK.102 slice S1 review finding #1): summarize-tool.ts is not a types/
// file, so it rides the root barrel via this module's existing wildcard
// export (index.ts: `export * from "./subagents/index.js"`) rather than
// types/index.ts's curated config.js re-export list.
export { SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS } from "./summarize-tool.js";
// Re-exported so the desktop host's child-mode Session (apps/desktop/src/
// host/session.ts, TASK.102 CUT-S2 §2.6.3/§10.7) can build its activity-feed
// summaries with the EXACT SAME sanitizer the in-process inline runner uses
// (runner.ts:524) — the host imports only @anycode/core's root, never a
// subpath, so this additive reexport is the only way it can reach a
// summarize-tool.ts function (§10.7 п.7 explicitly authorizes this).
export { summarizeChildToolCall } from "./summarize-tool.js";

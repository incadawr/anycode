/**
 * Main-safe subagents admin barrel (subpath `@anycode/core/subagents-admin`,
 * P7.21 W1, design §2-D8). The Electron main process imports the agent-profile
 * admin surface ONLY through this subpath so it never drags the full
 * `@anycode/core` barrel — or `subagents/runner.ts` → `loop/agent-loop.ts` → the
 * dispatch/tools tree, and the ai-SDK with it — into main.
 *
 * ⚠ Import-audited (§4-W1): every module re-exported here transitively touches
 * only ports + node stdlib + the profiles/personas/plugins readers. NO `loop/`,
 * NO `subagents/runner.ts`, NO `"ai"`/`@ai-sdk`. `personas.ts` is data; the
 * preview builder calls the ai-SDK-free `prompts/subagent.ts`; the effective-tool
 * list is a `DEFAULT_TOOL_NAMES` data constant, not a registry import.
 */

export {
  buildAgentProfileRoots,
  ownAgentRoots,
  scanAgentProfilesAdmin,
} from "./admin-scan.js";
export type {
  AgentProfileAdminRow,
  AgentProfileAdminScanResult,
  AgentProfileSourceKind,
} from "./admin-scan.js";

export {
  validateAgentProfileDraft,
  serializeAgentProfile,
  createAgentProfile,
  saveAgentProfile,
  deleteAgentProfile,
} from "./admin-write.js";
export type {
  ValidateAgentProfileResult,
  WriteAgentProfileResult,
  WriteRefusal,
  DeleteAgentProfileResult,
} from "./admin-write.js";

export {
  DEFAULT_TOOL_NAMES,
  effectiveProfileTools,
  buildProfilePreview,
} from "./preview.js";
export type { SubagentProfileDraft, ProfilePreview } from "./preview.js";

export { parseAgentProfileMd, AGENT_PROFILE_NAME_RE } from "./profiles.js";
export type {
  ParsedAgentProfile,
  ParseAgentProfileResult,
  AgentProfileParseError,
  AgentProfileRoot,
} from "./profiles.js";

export { PERSONAS, isKnownPersona, listPersonaNames } from "./personas.js";
export type { PersonaDefinition, PersonaName } from "./personas.js";

export { isUnderOwnRootsResolved } from "../util/path-containment.js";

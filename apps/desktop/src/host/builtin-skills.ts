/**
 * Host registration of the in-memory built-in skills (Taskana 4707 review).
 * host/index.ts hands the combined list to discoverExtensions as ONE
 * `builtinSkills` key, so every skill set the host ships is named here, in one
 * place, and the unit test pins the composition.
 */

import {
  PREVIEW_BUILTIN_SKILLS,
  SUBAGENT_BUILTIN_SKILLS,
  WORKTREE_BUILTIN_SKILLS,
  anycodeSetupBuiltinSkills,
  type AnycodeSetupDocsLocation,
  type BuiltinSkillDefinition,
} from "@anycode/core";

export interface HostBuiltinSkillGates {
  /** EnterWorktree/ExitWorktree are registered for this boot. */
  readonly worktreeAvailable: boolean;
  /** BrowserOpen/BrowserRead are registered for this boot. */
  readonly previewAvailable: boolean;
  /** Where the anycode-setup skill reads the docs from (host/anycode-setup-docs.ts). */
  readonly anycodeSetupDocs: AnycodeSetupDocsLocation;
}

/**
 * Builds the builtin skill list for one host boot. Capability-gated sets follow
 * their booleans; the subagent-authoring and anycode-setup skills are
 * unconditional (no capability to gate on — see builtin.ts).
 */
export function buildHostBuiltinSkills(gates: HostBuiltinSkillGates): readonly BuiltinSkillDefinition[] {
  return [
    ...(gates.worktreeAvailable ? WORKTREE_BUILTIN_SKILLS : []),
    ...(gates.previewAvailable ? PREVIEW_BUILTIN_SKILLS : []),
    ...SUBAGENT_BUILTIN_SKILLS,
    ...anycodeSetupBuiltinSkills(gates.anycodeSetupDocs),
  ];
}

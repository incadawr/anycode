/**
 * Skills module barrel (Phase 3 slice 3.3). Frontmatter is a full util
 * (task 3.3.1); discovery + prompt-section are filled by task 3.3.2. The
 * SkillMeta/SkillPort/LoadedSkill types live on ports/ and flow through the
 * ports barrel — they are intentionally NOT re-exported here.
 */

export { parseFrontmatter, splitList } from "./frontmatter.js";
export type { FrontmatterError, FrontmatterParsed, FrontmatterResult } from "./frontmatter.js";
export { createSkillPort, discoverSkills } from "./discovery.js";
export type { SkillDiscoveryResult, SkillRoot } from "./discovery.js";
export { buildSkillsPromptSection } from "./prompt-section.js";
export { SKILL_NAME_RE } from "./discovery.js";
export {
  BUILTIN_SKILL_SOURCE,
  USING_GIT_WORKTREES_SKILL,
  WORKTREE_BUILTIN_SKILLS,
  builtinSkillMeta,
  builtinSkillPath,
} from "./builtin.js";
export type { BuiltinSkillDefinition } from "./builtin.js";

// Admin / settings surface (P7.20 W1) — also exposed main-side via the
// `@anycode/core/skills-admin` subpath; re-exported here for in-core consumers.
export {
  loadDisabledSkills,
  setSkillEnabled,
  removeDisabledEntry,
  anycodeConfigPath,
} from "./settings.js";
export {
  buildSkillRoots,
  ownSkillRoots,
  scanSkillsAdmin,
  isUnderOwnRoots,
  isUnderOwnRootsResolved,
  deleteSkillDir,
} from "./admin-scan.js";
export type { SkillAdminRow, SkillAdminScanResult, DeleteSkillResult } from "./admin-scan.js";
export { scanHarnessSkills, applySkillImport } from "./harness-skill-import.js";
export type {
  HarnessSkillCandidate,
  SkillHarnessKind,
  ApplySkillImportResult,
} from "./harness-skill-import.js";

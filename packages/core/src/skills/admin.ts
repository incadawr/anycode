/**
 * Main-safe skills admin barrel (subpath `@anycode/core/skills-admin`, design
 * slice-P7.20-cut.md §5 W1). Re-exports the admin scan, the disabled-list
 * settings patchers, the own-catalog deleter, and the foreign-harness import
 * reader/writer.
 *
 * ⚠ NO ai-SDK imports: the Electron main process imports skills admin ONLY
 * through this subpath so it never drags the full `@anycode/core` barrel (and
 * the ai-SDK with it). Every module re-exported here transitively touches only
 * ports + zod + the skills/plugins readers — verified clean of ai-SDK.
 */

export {
  buildSkillRoots,
  ownSkillRoots,
  scanSkillsAdmin,
  isUnderOwnRoots,
  isUnderOwnRootsResolved,
  deleteSkillDir,
  anycodeConfigPath,
  removeDisabledEntry,
} from "./admin-scan.js";
export type { SkillAdminRow, SkillAdminScanResult, DeleteSkillResult } from "./admin-scan.js";
export { loadDisabledSkills, setSkillEnabled } from "./settings.js";
export { scanHarnessSkills, applySkillImport } from "./harness-skill-import.js";
export type {
  HarnessSkillCandidate,
  SkillHarnessKind,
  ApplySkillImportResult,
} from "./harness-skill-import.js";

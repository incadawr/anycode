/**
 * Dev/automation-ONLY override for the host's extensions-discovery `home`
 * (design/slice-P7.21-cut.md, dispatch-parity fix): `discoverExtensions` reads
 * agent profiles + skills/workflows/memory from `<home>/.anycode/...`, and the
 * host previously called it with `os.homedir()` unconditionally — invisible to
 * a subagent profile written under main's `ANYCODE_SUBAGENTS_HOME` override, so
 * `agent_type` never resolved in automation.
 *
 * A packaged production build NEVER honors this: main's fork-env scrub
 * (`applySubagentsHomeOverride`, main/host-env.ts) guarantees
 * `ANYCODE_SUBAGENTS_HOME` is absent from a packaged host's env structurally,
 * so this predicate is defense-in-depth, not the only gate. Mirrors main's
 * `resolveSubagentsHome` (main/index.ts:112) — duplicated on purpose, same rule
 * as `resolveSkillsImportHome`/`resolveSubagentsHome` there (main/index.ts:104).
 */

import { isAbsolute } from "node:path";

export function resolveExtensionsHomeOverride(env: NodeJS.ProcessEnv): string | null {
  if (env.ANYCODE_AUTOMATION !== "1") {
    return null;
  }
  const raw = env.ANYCODE_SUBAGENTS_HOME;
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Skills admin scan + own-catalog deleter (design slice-P7.20-cut.md §5 W1).
 *
 * `buildSkillRoots` is the SINGLE source of the roots recipe — both the
 * extensions bootstrap (boot/session discovery) and this admin scan consume it,
 * so the two lists can never drift. `scanSkillsAdmin` produces the UNFILTERED
 * (disabled skills still listed, flagged) deduped catalog view the Skills pane
 * renders, plus the fail-soft problems the pane's amber strip surfaces.
 *
 * ⚠ Main-safe: this module (and everything it imports) touches only ports + the
 * skills/plugins readers — NO ai-SDK. It is re-exported through the
 * `@anycode/core/skills-admin` subpath for the Electron main process.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { SkillMeta } from "../ports/skills.js";
import { discoverSkills, type SkillRoot } from "./discovery.js";
import { loadDisabledSkills, removeDisabledEntry, anycodeConfigPath } from "./settings.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { isUnderOwnRootsResolved } from "../util/path-containment.js";

/** `<baseDir>/<relative>`, tolerating a trailing separator on baseDir (mirrors bootstrap.subdir). */
function subdir(baseDir: string, rel: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/${rel}`;
}

/**
 * The FOUR own-catalog roots (project `.anycode`/`.agents`, user
 * `.anycode`/`.agents`). workspace === home collapses the project/user pair to
 * two. These are the ONLY directories our delete/import ever writes into —
 * plugin roots are explicitly excluded (read-only, §2 Scope OUT).
 */
export function ownSkillRoots(workspace: string, home: string): string[] {
  const projectRoots = [subdir(workspace, ".anycode/skills"), subdir(workspace, ".agents/skills")];
  if (workspace === home) {
    return projectRoots;
  }
  return [...projectRoots, subdir(home, ".anycode/skills"), subdir(home, ".agents/skills")];
}

/**
 * Builds the precedence-ordered skill roots (project `.anycode` > project
 * `.agents` > user `.anycode` > user `.agents` > plugin roots). EXTRACTED from
 * the extensions bootstrap so both boot discovery and the admin scan share one
 * recipe. workspace === home drops the user pair (they are byte-identical paths
 * — the shared "load once" dedup).
 */
export function buildSkillRoots(
  workspace: string,
  home: string,
  pluginSkillRoots: readonly SkillRoot[],
): SkillRoot[] {
  const sameWorkspaceHome = workspace === home;
  return [
    { dir: subdir(workspace, ".anycode/skills"), source: "project" },
    { dir: subdir(workspace, ".agents/skills"), source: "project" },
    ...(sameWorkspaceHome
      ? []
      : [
          { dir: subdir(home, ".anycode/skills"), source: "user" },
          { dir: subdir(home, ".agents/skills"), source: "user" },
        ]),
    ...pluginSkillRoots,
  ];
}

/** One admin-scan row: a discovered skill's metadata + whether it is disabled. */
export interface SkillAdminRow extends SkillMeta {
  /** True when this name appears in `skills.disabled` (project or user scope). */
  disabled: boolean;
}

export interface SkillAdminScanResult {
  rows: SkillAdminRow[];
  problems: string[];
}

/**
 * Scans the full skill catalog for the admin pane: discovers plugins (for their
 * read-only roots), builds the roots recipe, runs an UNFILTERED discovery
 * (disabled skills stay in the list, tagged), and joins the disabled-list state.
 * Never throws — plugin discovery and skill discovery are each fail-soft and
 * their problems are aggregated.
 */
export async function scanSkillsAdmin(
  fs: FileSystemPort,
  opts: { workspace: string; home: string },
): Promise<SkillAdminScanResult> {
  const { workspace, home } = opts;
  const problems: string[] = [];

  let pluginSkillRoots: SkillRoot[] = [];
  try {
    const plugins = await discoverPlugins(fs, { workspace, home, claimedMcpNames: new Set() });
    pluginSkillRoots = plugins.skillRoots;
    problems.push(...plugins.problems);
  } catch (error) {
    problems.push(`plugin discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const roots = buildSkillRoots(workspace, home, pluginSkillRoots);

  const discovery = await discoverSkills(fs, roots);
  problems.push(...discovery.problems);

  const disabled = await loadDisabledSkills(fs, { workspace, home });

  const rows: SkillAdminRow[] = discovery.metas.map((meta) => ({
    ...meta,
    disabled: disabled.has(meta.name),
  }));

  return { rows, problems };
}

/**
 * True when `candidatePath` sits strictly INSIDE one of `ownRoots` (a
 * `<root>/<child>...` path, never a root itself and never an escape). Uses
 * node:path containment (same discipline as plugins/discovery.resolveContained).
 * This is the load-bearing guard: the renderer never sends a path, but a
 * main-side scan-resolved path must still be proven to live under our catalog
 * before any destructive op.
 */
export function isUnderOwnRoots(candidatePath: string, ownRoots: readonly string[]): boolean {
  const target = resolve(candidatePath);
  for (const root of ownRoots) {
    const rootAbs = resolve(root);
    const rel = relative(rootAbs, target);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

// Symlink-RESOLVED containment (realpathExistingAncestor / resolveTrustedRoot /
// isUnderOwnRootsResolved) now lives in `util/path-containment.ts` (P7.21 W1,
// design §2-D8) so the subagents admin surface shares one implementation.
// Re-exported here byte-compatibly for existing importers (skills/index.ts,
// skills/admin.ts, harness-skill-import.ts).
export { isUnderOwnRootsResolved };

export type DeleteSkillResult =
  | { ok: true }
  | { ok: false; reason: "outside_own_roots" | "io_error" };

/**
 * Deletes a skill directory AFTER proving it lives under one of the own-catalog
 * roots. Refuses (`outside_own_roots`) any path that is a plugin/foreign path or
 * a root itself. Requires the port's optional `rm`; absent ⇒ io_error (fail
 * closed rather than a partial delete). Never throws.
 */
export async function deleteSkillDir(
  fs: FileSystemPort,
  skillDirPath: string,
  ownRoots: readonly string[],
): Promise<DeleteSkillResult> {
  // Symlink-RESOLVED containment (P7.20 W5-FIX P1-c): a lexical prefix check lets
  // a symlinked catalog root (`.anycode/skills -> /tmp/outside`) or a symlinked
  // skill dir escape and delete an arbitrary tree. Resolve real paths and reject
  // a symlinked root outright before the destructive rm.
  if (!(await isUnderOwnRootsResolved(fs, skillDirPath, ownRoots))) {
    return { ok: false, reason: "outside_own_roots" };
  }
  if (typeof fs.rm !== "function") {
    return { ok: false, reason: "io_error" };
  }
  try {
    await fs.rm(skillDirPath);
    return { ok: true };
  } catch {
    return { ok: false, reason: "io_error" };
  }
}

export { anycodeConfigPath, removeDisabledEntry };

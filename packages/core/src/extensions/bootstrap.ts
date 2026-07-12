/**
 * Extensions bootstrap aggregator (Phase 3 slices 3.3/3.4/3.6/3.7). ONE entry
 * point that CLI and host wiring both call, so the two obvious paths never
 * drift: it discovers plugins first, feeds their roots into skills + profiles
 * discovery, discovers workflows (a fourth, independent subsystem — no plugin

 * independent subsystem, design slice-3.6-cut.md §2.5), builds the capped
 * prompt sections — including profilesPromptSection (slice-3.7-cut.md §2.4),
 * which makes the already-discovered profiles[] visible to the model rather
 * than adding a new discovery pass — and returns a single fail-soft bundle.
 * NEVER throws — each subsystem (plugins, skills, agent profiles, workflows,
 * memory) is independently wrapped, so one subsystem's failure never takes
 * the others down; a session with no extensions at all is byte-identical to
 * today's boot (empty port, "" sections, no profiles/servers/workflows, zero
 * problems).
 */

import type { FileSystemPort } from "../ports/file-system.js";
import type { McpServerSpec } from "../ports/mcp.js";
import type { SkillMeta, SkillPort } from "../ports/skills.js";
import type { WorkflowDefinition, WorkflowMeta } from "../ports/workflow.js";
import type { PersonaDefinition } from "../subagents/personas.js";
import { createSkillPort, discoverSkills, type SkillRoot } from "../skills/discovery.js";
import { buildSkillRoots } from "../skills/admin-scan.js";
import { loadDisabledSkills } from "../skills/settings.js";
import { buildSkillsPromptSection } from "../skills/prompt-section.js";
import { discoverAgentProfiles, type AgentProfileRoot } from "../subagents/profiles.js";
import { buildAgentProfileRoots } from "../subagents/admin-scan.js";
import { buildProfilesPromptSection } from "../subagents/profiles-prompt-section.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { discoverWorkflows, type WorkflowRoot } from "../workflow/discovery.js";
import { buildWorkflowsPromptSection } from "../workflow/prompt-section.js";
import { capUtf8Bytes } from "../util/bytes.js";
import {
  MEMORY_FILE_MAX_BYTES,
  REPO_MAP_ENRICH_TOP_N,
  REPO_MAP_IGNORED_DIR_NAMES,
  REPO_MAP_MAX_DEPTH,
  REPO_MAP_MAX_FILES,
} from "../types/config.js";
import {
  prioritizeAndEnrich,
  walkRepo,
  type RepoFile,
  type RepoMapConfig,
} from "../repoMap/index.js";

export interface ExtensionsBootstrap {
  /** SkillPort over the discovered skills (empty port when there are none). */
  skills: SkillPort;
  /** Prompt section for the discovered skills ("" when there are none). */
  skillsPromptSection: string;
  /** Md-profile personas, ready for SubagentRunnerOptions.profiles. */
  profiles: PersonaDefinition[];
  /**
   * Prompt section for the discovered agent profiles ("" when there are none
   * — systemPrompt byte-invariant, Phase 3 slice 3.7 design §2.4). Makes
   * custom `agent_type` values discoverable to the model, mirroring
   * skillsPromptSection/workflowsPromptSection.
   */
  profilesPromptSection: string;
  /** Plugin-declared MCP server specs to add to manager.start(...). */
  pluginMcpServerSpecs: McpServerSpec[];
  /** Validated workflow definitions (empty when there are none, design §2.9). */
  workflows: WorkflowDefinition[];
  /** Prompt section for the discovered workflows ("" when there are none — systemPrompt byte-invariant). */
  workflowsPromptSection: string;
  /**
   * Memory section built from AGENTS.md files (fifth fail-soft subsystem,
   * slice 3.6, design §2.5): `~/.anycode/AGENTS.md` (user) then
   * `<ws>/AGENTS.md` (project), each capped at MEMORY_FILE_MAX_BYTES. "" when
   * neither file exists — the systemPrompt byte-invariant is preserved.
   */
  memorySection: string;
  /** Boot-frozen, prioritized repository metadata; rendered by the caller for the active model window. */
  repoMapFiles: RepoFile[];
  /** Aggregated fail-soft problems across all subsystems. */
  problems: string[];
}

export interface DiscoverExtensionsOptions {
  workspace: string;
  home: string;
  /** Server names already claimed by explicit config (so it always wins over plugins). */
  claimedMcpNames?: Set<string>;
  /** null/undefined keeps repository discovery fully disabled (default). */
  repoMapConfig?: RepoMapConfig | null;
  repoMapMaxFiles?: number;
  repoMapMaxDepth?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<baseDir>/<relative>`, tolerating a trailing separator on baseDir (mirrors hook-config.ts's configPath). */
function subdir(baseDir: string, relative: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/${relative}`;
}

/**
 * One AGENTS.md candidate location tagged with the provenance label its
 * section header carries (design §2.5). Read order is FIXED: user, then
 * project — project sits closer to the tail of the assembled section, so it
 * is the more specific, workspace-local memory a model reads last.
 */
interface MemoryFileCandidate {
  path: string;
  provenance: "user" | "project";
}

/**
 * Reads and caps a single AGENTS.md file. A missing file is a silent no-op
 * (undefined) — most workspaces have none, and that is not an error. An
 * actual readFile FAILURE (permission denied, a race with deletion, ...) is
 * fail-soft: recorded as a `problems[]` entry and the file contributes
 * nothing, mirroring the readFile-failure precedent in
 * skills/discovery.ts's scanRoot (only the read call itself is guarded —
 * `fs.exists` is trusted not to throw, same as every sibling subsystem
 * above). Overflow past MEMORY_FILE_MAX_BYTES is capped by capUtf8Bytes
 * (never mid-multibyte-char) and ALSO reported as a problem, since silent
 * truncation would otherwise be invisible data loss.
 */
async function readMemoryFile(
  fs: FileSystemPort,
  candidate: MemoryFileCandidate,
  problems: string[],
): Promise<string | undefined> {
  if (!(await fs.exists(candidate.path))) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await fs.readFile(candidate.path);
  } catch (error) {
    problems.push(`Memory discovery: could not read ${candidate.path}: ${describeError(error)}`);
    return undefined;
  }

  const capped = capUtf8Bytes(raw, MEMORY_FILE_MAX_BYTES);
  if (capped.truncated) {
    problems.push(
      `Memory discovery: ${candidate.path} exceeded ${MEMORY_FILE_MAX_BYTES} bytes and was truncated.`,
    );
  }
  return `AGENTS.md (${candidate.provenance}):\n${capped.text}`;
}

/**
 * Discovers the memory section (fifth fail-soft subsystem, design
 * slice-3.6-cut.md §2.5): `~/.anycode/AGENTS.md` (user) then `<ws>/AGENTS.md`
 * (project), through FileSystemPort only (zero node:fs). workspace === home
 * (e.g. running from the home directory itself) collapses the pair to the
 * single shared path — read ONCE and labeled "project" (the
 * higher-precedence label), same "load once" dedup precedent as the
 * skill/agent-profile/workflow roots above. Both absent (or both fail to

 */
async function discoverMemory(
  fs: FileSystemPort,
  opts: { workspace: string; home: string },
  problems: string[],
): Promise<string> {
  const { workspace, home } = opts;
  const candidates: MemoryFileCandidate[] =
    workspace === home
      ? [{ path: subdir(workspace, "AGENTS.md"), provenance: "project" }]
      : [
          { path: subdir(home, "AGENTS.md"), provenance: "user" },
          { path: subdir(workspace, "AGENTS.md"), provenance: "project" },
        ];

  const sections: string[] = [];
  for (const candidate of candidates) {
    const section = await readMemoryFile(fs, candidate, problems);
    if (section) {
      sections.push(section);
    }
  }
  return sections.join("\n\n");
}

/**
 * Discovers all local extensions (skills + agent profiles + plugins +
 * workflows + AGENTS.md memory). Never throws — each subsystem is fail-soft (a
 * thrown subsystem contributes nothing + a `problems[]` entry; the others
 * still run). Internal order: plugins first (their skillRoots/agentRoots are
 * the lowest-precedence source fed into the two discovery passes below), then
 * skills + profiles discovery, then workflow discovery (project > user roots

 * memory discovery (fifth subsystem, design slice-3.6-cut.md §2.5), then the
 * prompt sections are built from the resulting metas.
 */
export async function discoverExtensions(
  fs: FileSystemPort,
  opts: DiscoverExtensionsOptions,
): Promise<ExtensionsBootstrap> {
  const { workspace, home } = opts;
  const claimed = opts.claimedMcpNames ?? new Set<string>();
  const problems: string[] = [];

  let pluginSkillRoots: SkillRoot[] = [];
  let pluginAgentRoots: AgentProfileRoot[] = [];
  let pluginMcpServerSpecs: McpServerSpec[] = [];
  try {
    const result = await discoverPlugins(fs, { workspace, home, claimedMcpNames: claimed });
    pluginSkillRoots = result.skillRoots;
    pluginAgentRoots = result.agentRoots;
    pluginMcpServerSpecs = result.mcpServerSpecs;
    problems.push(...result.problems);
  } catch (error) {
    problems.push(`plugin discovery failed: ${describeError(error)}`);
  }

  // workspace === home (e.g. running from the home directory itself): the user
  // roots below would be byte-identical paths to the project roots — load the
  // shared pair once rather than scanning the same directory twice (mirrors
  // dispatch/hook-config.ts's loadHookConfigs dedupe).
  const sameWorkspaceHome = workspace === home;

  // Roots recipe is shared with the admin scan (buildSkillRoots) so the two
  // discovery paths never drift.
  const skillRoots: SkillRoot[] = buildSkillRoots(workspace, home, pluginSkillRoots);

  // Disabled skills are read fail-soft from the shared config and filtered at
  // discovery claim-time (before the cap). An empty set (the overwhelmingly
  // common case, and every pre-slice config) leaves discovery byte-identical.
  let disabledSkills = new Set<string>();
  try {
    disabledSkills = await loadDisabledSkills(fs, { workspace, home });
  } catch (error) {
    problems.push(`skills disabled-list load failed: ${describeError(error)}`);
  }

  let skillMetas: SkillMeta[] = [];
  try {
    const result = await discoverSkills(fs, skillRoots, { disabled: disabledSkills });
    skillMetas = result.metas;
    problems.push(...result.problems);
  } catch (error) {
    problems.push(`skills discovery failed: ${describeError(error)}`);
  }
  const skills = createSkillPort(fs, skillMetas);
  const skillsPromptSection = buildSkillsPromptSection(skillMetas);

  // Roots recipe shared with the admin scan (buildAgentProfileRoots) so the two
  // discovery paths never drift (mirrors the skills buildSkillRoots pattern).
  const agentRoots: AgentProfileRoot[] = buildAgentProfileRoots(workspace, home, pluginAgentRoots);

  let profiles: PersonaDefinition[] = [];
  try {
    const result = await discoverAgentProfiles(fs, agentRoots);
    profiles = result.profiles;
    problems.push(...result.problems);
  } catch (error) {
    problems.push(`agent profile discovery failed: ${describeError(error)}`);
  }
  const profilesPromptSection = buildProfilesPromptSection(profiles);

  // Workflow discovery is the fourth subsystem (design §2.9): independent
  // fail-soft block, symmetric with the three above. Roots are project > user

  // so pluginSkillRoots/pluginAgentRoots do NOT feed this one.
  const workflowRoots: WorkflowRoot[] = [
    { dir: subdir(workspace, ".anycode/workflows"), source: "project" },
    ...(sameWorkspaceHome ? [] : [{ dir: subdir(home, ".anycode/workflows"), source: "user" }]),
  ];

  let workflows: WorkflowDefinition[] = [];
  try {
    const result = await discoverWorkflows(fs, workflowRoots);
    workflows = result.workflows;
    problems.push(...result.problems);
  } catch (error) {
    problems.push(`workflow discovery failed: ${describeError(error)}`);
  }
  const workflowMetas: WorkflowMeta[] = workflows.map((workflow) => ({
    name: workflow.name,
    description: workflow.description,
    stepCount: workflow.steps.length,
    source: workflow.source,
  }));
  const workflowsPromptSection = buildWorkflowsPromptSection(workflowMetas);

  // Memory discovery is the fifth subsystem (design slice-3.6-cut.md §2.5):
  // independent fail-soft block, symmetric with the four above. Wrapped
  // defensively even though discoverMemory's own reads are already fail-soft
  // internally (readMemoryFile never throws) — kept symmetric with its
  // neighbors' defense-in-depth posture.
  let memorySection = "";
  try {
    memorySection = await discoverMemory(fs, { workspace, home }, problems);
  } catch (error) {
    problems.push(`memory discovery failed: ${describeError(error)}`);
  }

  // Repository map is the sixth independent, opt-in subsystem. It performs a
  // single bounded stat-only walk and enriches only the priority prefix.
  let repoMapFiles: RepoFile[] = [];
  if (opts.repoMapConfig?.enabled) {
    try {
      const files = await walkRepo(fs, workspace, {
        ignoredDirs: REPO_MAP_IGNORED_DIR_NAMES,
        maxFiles: opts.repoMapMaxFiles ?? REPO_MAP_MAX_FILES,
        maxDepth: opts.repoMapMaxDepth ?? REPO_MAP_MAX_DEPTH,
        onProblem: (problem) => problems.push(problem),
      });
      repoMapFiles = await prioritizeAndEnrich(fs, files, REPO_MAP_ENRICH_TOP_N, workspace);
    } catch (error) {
      problems.push(`repo-map discovery failed: ${describeError(error)}`);
    }
  }

  return {
    skills,
    skillsPromptSection,
    profiles,
    profilesPromptSection,
    pluginMcpServerSpecs,
    workflows,
    workflowsPromptSection,
    memorySection,
    repoMapFiles,
    problems,
  };
}

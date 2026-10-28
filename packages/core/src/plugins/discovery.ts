/**
 * Plugin discovery (Taskana 4732 S1-A, design §2–§4; originally slice-3.3-cut
 * §3.6). Discovers plugins from tiered sources, applies the v1 rules (compat
 * gating, reserved builtin names, official-only contributions, MCP consent),
 * and contributes skill/agent/workflow roots + MCP specs — fail-soft
 * throughout: ONE offending plugin (or one offending directory inside it) is
 * skipped with a `problems[]` entry, discovery never throws and never drops
 * an unrelated plugin.
 *
 * Tiered sources, highest → lowest precedence (design §3):
 *  1. `project` — `<ws>/.anycode/plugins/<dir>` (hand-placed, never managed);
 *  2. the MANAGED store from `state.json` (design §3): `official` >
 *     `third-party` > `local`, each at `~/.anycode/plugins/.store/<name>/<active>`
 *     for store sources (ONLY the active version is discovered; `previous`
 *     exists for rollback) or at the recorded absolute path for `local` dev
 *     links;
 *  3. `legacy-user` — the pre-4732 hand-dropped `~/.anycode/plugins/<dir>`
 *     scan, kept working byte-for-byte: dot-dirs (`.store`/`.staging`/
 *     `.cache`, plus `state.json` which is a FILE, not a dir) are skipped
 *     before the manifest probe, exactly as before.
 *
 * Same manifest name in two tiers: the higher tier wins, the lower copy gets
 * a problem. Contributions are emitted in (tier, name) order for
 * deterministic downstream precedence.
 *
 * v1 gating (design §2/§4), applied per plugin AFTER manifest load:
 *  - name in state.json `disabled` (user-global by name) → skip with a
 *    `skipped[]` entry but NO problem: it is the user's own OFF switch, not a
 *    load failure, so panes must not warn about it. This is checked FIRST —
 *    a disabled plugin's newer manifest or engine mismatch is not a problem
 *    either, it simply does not load;
 *  - `manifestVersion > MANIFEST_VERSION` → skip, problem "requires newer
 *    AnyCode" (the schema accepts the int; a future manifest never crashes
 *    an older app);
 *  - `engines.anycode` unsatisfied by `appVersion` (when provided) → plugin
 *    stays installed but INACTIVE: skip, problem "incompatible with AnyCode
 *    X (needs R)";
 *  - non-official tier + official-only contribution (`docs`,
 *    `engineSupport`, `promptOverlays`) → plugin loads, contribution ignored
 *    with a problem (s1 contributes these for no one — s2 fields);
 *  - non-official tier + a skill/agent name in the caller's RESERVED builtin
 *    sets (`reservedSkillNames`, e.g. `anycode-setup`; `reservedAgentNames`)
 *    → plugin loads, that ONE shadowing file is dropped with a problem
 *    (official plugins may shadow builtins, design §9.5);
 *  - MCP consent (design §4/§9.6): with `mcpConsent` provided and no current
 *    grant for the plugin's `serversHash`, ALL its servers are withheld with
 *    one problem. `mcpConsent` undefined (CLI, legacy callers) keeps today's
 *    behaviour exactly.
 *
 * Accepted plugins contribute (in tier-then-name order):
 *  - `skillRoots`/`agentRoots`/`workflowRoots`: each declared directory
 *    resolved RELATIVE to the plugin root, containment-checked (absolute or
 *    `..`-escape → that ONE directory dropped + problem);
 *  - `mcpServerSpecs`: each server renamed `<srv>` → `plugin_<name>_<srv>`
 *    (cwd defaulted to the plugin root / resolved from it when relative),
 *    through the SAME `resolveMcpServerEntries` the explicit config uses,
 *    over the SHARED `claimedMcpNames` set the caller pre-populates from
 *    explicit config (explicit config always wins a name collision).
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { ZodError } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpServerSpec } from "../ports/mcp.js";
import {
  isProjectGated,
  resolveMcpServerEntries,
  type McpResolveOptions,
  type McpServerEntry,
  type ProjectTrustOptions,
} from "../mcp/config.js";
import type { SkillRoot } from "../skills/discovery.js";
import { parseFrontmatter } from "../skills/frontmatter.js";
import type { AgentProfileRoot } from "../subagents/profiles.js";
import type { WorkflowRoot } from "../workflow/discovery.js";
import { MAX_PLUGINS } from "../types/config.js";
import { normalizeSemverRange, rangeMatches } from "../util/semver-range.js";
import {
  MANIFEST_VERSION,
  declaresOfficialOnly,
  pluginManifestSchema,
  pluginWorkflowsDirs,
  type PluginManifest,
} from "./manifest.js";
import {
  hasMcpConsent,
  readPluginState,
  serversHash,
  type McpConsentEntry,
} from "./state.js";

/** Discovery tier — where a plugin came from (design §3 precedence). */
export type PluginTier = "project" | "official" | "third-party" | "local" | "legacy-user";

/** tier → precedence rank (lower = wins). */
const TIER_RANK: Record<PluginTier, number> = {
  project: 0,
  official: 1,
  "third-party": 2,
  local: 3,
  "legacy-user": 4,
};

export interface DiscoverPluginsOptions extends ProjectTrustOptions, McpResolveOptions {
  workspace: string;
  home: string;
  /** Server names already claimed by explicit config; plugins never override them. */
  claimedMcpNames: Set<string>;
  /**
   * Taskana 4732 (design §7 host wiring): absolute path of the managed state
   * file. Optional — absent keeps the pure legacy scan (no managed store),
   * so current callers compile and behave unchanged.
   */
  pluginStatePath?: string;
  /** App version for `engines.anycode` compat gating; absent = no gating. */
  appVersion?: string;
  /**
   * Reserved (builtin) skill names non-official plugins may not shadow
   * (design §4). Official plugins may (§9.5). Absent = no drops (legacy
   * callers keep today's shadowing behaviour).
   */
  reservedSkillNames?: ReadonlySet<string>;
  /** Reserved (builtin) agent-profile names; same rules as reservedSkillNames. */
  reservedAgentNames?: ReadonlySet<string>;
  /**
   * MCP consent list from settings.json (design §4). UNDEFINED keeps today's
   * behaviour (all plugin servers contribute); an array (even empty) enables
   * the consent gate.
   */
  mcpConsent?: readonly McpConsentEntry[];
}

export interface PluginDiscoveryResult {
  /** Plugin-contributed skill roots (source: "plugin:<name>"), lowest precedence. */
  skillRoots: SkillRoot[];
  /** Plugin-contributed agent-profile roots (source: "plugin:<name>"). */
  agentRoots: AgentProfileRoot[];
  /** NEW s1: plugin-contributed workflow roots (source: "plugin:<name>"), between user and bundled. */
  workflowRoots: WorkflowRoot[];
  /** Plugin-declared, renamed + resolved MCP server specs (consent-filtered). */
  mcpServerSpecs: McpServerSpec[];
  /**
   * Per-accepted-plugin metadata (name → tier + manifest version + root) for
   * admin surfaces (Taskana 4732 S1-A): the Skills/Subagents panes badge
   * plugin rows with tier + version. Informational only — boot wiring
   * ignores it.
   */
  pluginInfo: Map<string, { tier: PluginTier; version?: string; root: string }>;
  /**
   * Candidate plugins that were seen but NOT accepted (disabled,
   * incompatible, manifestVersion>1, name conflict, cap overflow), with the
   * problem reason. Consumed by the Plugins pane (admin.ts) so skipped
   * plugins still row (design §6 chips "Inactive"/"Incompatible").
   */
  skipped: SkippedPlugin[];
  problems: string[];
}

/** A candidate plugin that failed a gate — kept for the Plugins pane rows. */
export interface SkippedPlugin {
  name?: string;
  /** The candidate directory (install root). */
  dir: string;
  tier: PluginTier;
  /** Short machine reason ("disabled" | "incompatible" | "newer-manifest" | "conflict" | "cap"). */
  reason: string;
  /**
   * The full problem string (also present in problems[]). ABSENT for
   * `reason: "disabled"`: a user-chosen OFF state is not a problem.
   */
  problem?: string;
}

interface AcceptedPlugin {
  manifest: PluginManifest;
  /** Absolute plugin root directory (the directory carrying .anycode-plugin/). */
  root: string;
  tier: PluginTier;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** `<baseDir>/.anycode/plugins`, tolerating a trailing separator on baseDir. */
function pluginsRootPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/plugins`;
}

/**
 * Resolves `rel` against `pluginRoot`, requiring the result to stay inside it.
 * An absolute `rel` is rejected outright (never resolved) — plugin content
 * directories must be expressed relative to the plugin, unlike a server `cwd`.
 */
function resolveContained(
  pluginRoot: string,
  rel: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (isAbsolute(rel)) {
    return { ok: false, reason: `absolute path "${rel}" is not allowed` };
  }
  const resolved = resolve(pluginRoot, rel);
  const fromRoot = relative(pluginRoot, resolved);
  if (fromRoot !== "" && (fromRoot.startsWith("..") || isAbsolute(fromRoot))) {
    return { ok: false, reason: `"${rel}" escapes the plugin root` };
  }
  return { ok: true, path: resolved };
}

/** Loads + validates one plugin's manifest. undefined -> not a plugin OR fail-soft skip (problem already recorded). */
async function loadManifest(
  fs: FileSystemPort,
  pluginDir: string,
  problems: string[],
): Promise<PluginManifest | undefined> {
  const manifestPath = `${pluginDir}/.anycode-plugin/plugin.json`;
  if (!(await fs.exists(manifestPath))) {
    return undefined; // no manifest => silently not a plugin.
  }

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath);
  } catch (error) {
    problems.push(`Could not read plugin manifest ${manifestPath}: ${describeError(error)}`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(`Invalid JSON in plugin manifest ${manifestPath}: ${describeError(error)}`);
    return undefined;
  }

  const result = pluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    problems.push(`Invalid plugin manifest ${manifestPath}: ${formatZodError(result.error)}`);
    return undefined;
  }

  return result.data;
}

/** Sorted non-dot directory entry names under `root`; [] (fail-soft) if absent/unreadable. */
async function listPluginDirs(fs: FileSystemPort, root: string, problems: string[]): Promise<string[]> {
  if (!(await fs.exists(root))) {
    return [];
  }
  try {
    const entries = await fs.readdir(root);
    // Store plumbing (.store/.staging/.cache dot-DIRS) is not the legacy
    // tier's business; state.json is a file and never enumerated here.
    return entries.filter((entry) => !entry.startsWith(".")).sort();
  } catch (error) {
    problems.push(`Could not list plugins directory ${root}: ${describeError(error)}`);
    return [];
  }
}

/** Maps a state trust tier onto its managed discovery tier. */
function tierOfTrust(trust: string): PluginTier {
  switch (trust) {
    case "official":
      return "official";
    case "local":
      return "local";
    default:
      return "third-party";
  }
}

interface ManagedCandidate {
  dir: string;
  tier: PluginTier;
}

/** One managed-store listing: candidates + the user-global disabled set (design §3). */
interface ManagedListing {
  candidates: ManagedCandidate[];
  disabled: ReadonlySet<string>;
}

/**
 * Resolves the managed store from state.json (design §3): store sources at
 * `~/.anycode/plugins/.store/<name>/<active>` (active version ONLY —
 * `previous` is rollback material), `local` sources read in place at their
 * recorded absolute path. Ordered official > third-party > local, then name.
 */
async function listManagedPlugins(
  fs: FileSystemPort,
  opts: DiscoverPluginsOptions,
  problems: string[],
): Promise<ManagedListing> {
  if (!opts.pluginStatePath) {
    return { candidates: [], disabled: new Set<string>() };
  }
  const read = await readPluginState(fs, opts.pluginStatePath);
  problems.push(...read.problems);
  const userPluginsRoot = pluginsRootPath(opts.home);
  const candidates: ManagedCandidate[] = [];
  for (const [name, entry] of Object.entries(read.state.plugins)) {
    if (entry.source.kind === "local") {
      candidates.push({ dir: entry.source.path, tier: tierOfTrust(entry.trust) });
      continue;
    }
    candidates.push({
      dir: `${userPluginsRoot}/.store/${name}/${entry.active}`,
      tier: tierOfTrust(entry.trust),
    });
  }
  candidates.sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.dir.localeCompare(b.dir),
  );
  return { candidates, disabled: new Set(read.state.disabled) };
}

/** Resolves one contribution list (skills/agents/workflows) into containment-checked roots. */
function resolveContentRoots(
  plugin: AcceptedPlugin,
  dirs: readonly string[],
  kind: "skills" | "agents" | "workflows",
  problems: string[],
): { dir: string; source: string }[] {
  const source = `plugin:${plugin.manifest.name}`;
  const roots: { dir: string; source: string }[] = [];
  for (const dir of dirs) {
    const resolved = resolveContained(plugin.root, dir);
    if (!resolved.ok) {
      problems.push(
        `Plugin "${plugin.manifest.name}" ${kind} entry ${JSON.stringify(dir)}: ${resolved.reason} — dropped`,
      );
      continue;
    }
    roots.push({ dir: resolved.path, source });
  }
  return roots;
}

/**
 * Reserved-name scan for ONE plugin (design §4). Third-party/local/project/
 * legacy plugins may not shadow builtin skill/agent names: we peek at each
 * declared root and DROP the whole root when it carries a reserved name.
 * Fail-soft: an unreadable root is kept (the downstream discovery reports its
 * own problems) — only a PROVEN reserved-name collision drops the root.
 */
async function dropReservedRoots(
  fs: FileSystemPort,
  plugin: AcceptedPlugin,
  roots: { dir: string; source: string }[],
  kind: "skills" | "agents",
  reserved: ReadonlySet<string> | undefined,
  problems: string[],
): Promise<{ dir: string; source: string }[]> {
  if (!reserved || reserved.size === 0 || plugin.tier === "official") {
    return roots;
  }
  const kept: { dir: string; source: string }[] = [];
  for (const root of roots) {
    let reservedHit: string | undefined;
    try {
      const entries = (await fs.readdir(root.dir)).sort();
      if (kind === "skills") {
        // A skill's name is the SKILL.md frontmatter `name`, else the dir name.
        for (const entry of entries) {
          const skillMd = `${root.dir}/${entry}/SKILL.md`;
          if (!(await fs.exists(skillMd))) {
            continue;
          }
          const raw = await fs.readFile(skillMd);
          const name = skillNameOf(raw, entry);
          if (name !== undefined && reserved.has(name)) {
            reservedHit = name;
            break;
          }
        }
      } else {
        // An agent profile's name is the frontmatter `name`, else the file stem.
        for (const entry of entries) {
          if (!entry.endsWith(".md")) {
            continue;
          }
          const raw = await fs.readFile(`${root.dir}/${entry}`);
          const parsed = parseFrontmatter(raw);
          if ("error" in parsed) {
            continue;
          }
          const name = (parsed.fields.name ?? "").trim() || entry.slice(0, -".md".length);
          if (reserved.has(name)) {
            reservedHit = name;
            break;
          }
        }
      }
    } catch {
      // Unreadable root: keep it — downstream discovery owns read failures.
      kept.push(root);
      continue;
    }
    if (reservedHit === undefined) {
      kept.push(root);
    } else {
      problems.push(
        `Plugin "${plugin.manifest.name}" ${kind} root ${root.dir} dropped: name "${reservedHit}" is reserved by a built-in and this plugin is not official`,
      );
    }
  }
  return kept;
}

/** SKILL.md frontmatter `name` (trimmed), else the directory name. undefined when frontmatter is unparseable. */
function skillNameOf(raw: string, dirName: string): string | undefined {
  const parsed = parseFrontmatter(raw);
  if ("error" in parsed) {
    return undefined;
  }
  return (parsed.fields.name ?? "").trim() || dirName;
}

/**
 * Renames + resolves one plugin's mcpServers contribution through the shared
 * entry-resolver. Consent (design §4): with the gate enabled and no current
 * grant, ALL of the plugin's servers are withheld (one problem); the gate
 * off (mcpConsent undefined) keeps today's behaviour.
 */
function resolvePluginMcpServers(
  plugin: AcceptedPlugin,
  claimedMcpNames: Set<string>,
  consent: { allowed: boolean; hash: string },
  secrets: McpResolveOptions["secrets"],
  loginPath: McpResolveOptions["loginPath"],
): { specs: McpServerSpec[]; problems: string[] } {
  const entries = plugin.manifest.mcpServers;
  if (!entries || Object.keys(entries).length === 0) {
    return { specs: [], problems: [] };
  }
  if (!consent.allowed) {
    return {
      specs: [],
      problems: [
        `Plugin "${plugin.manifest.name}" MCP servers not started: needs approval (servers hash ${consent.hash.slice(0, 8)})`,
      ],
    };
  }

  const renamed: Record<string, McpServerEntry> = {};
  for (const [srv, entry] of Object.entries(entries)) {
    const name = `plugin_${plugin.manifest.name}_${srv}`;
    const cwd =
      entry.cwd === undefined
        ? plugin.root
        : isAbsolute(entry.cwd)
          ? entry.cwd
          : resolve(plugin.root, entry.cwd);
    renamed[name] = { ...entry, cwd };
  }

  return resolveMcpServerEntries(renamed, {
    sourceLabel: `plugin:${plugin.manifest.name}`,
    claimed: claimedMcpNames,
    secrets,
    loginPath,
  });
}

/**
 * Discovers plugins across the tiered sources (design §3): project dirs →
 * managed store (official > third-party > local, from state.json) → legacy
 * user dirs. Never throws: every failure mode is fail-soft, collected in
 * `problems[]`. A world with no plugins and no state file costs one
 * `exists()` per root and yields an all-empty result byte-identical to the
 * legacy scanner's.
 */
export async function discoverPlugins(
  fs: FileSystemPort,
  opts: DiscoverPluginsOptions,
): Promise<PluginDiscoveryResult> {
  const problems: string[] = [];
  const claimedPluginNames = new Map<string, AcceptedPlugin>();
  const accepted: AcceptedPlugin[] = [];
  const skipped: SkippedPlugin[] = [];

  /** One candidate root → load manifest → gate → dedupe/cap. Records every skip as a problem. */
  const consider = async (pluginDir: string, tier: PluginTier, disabled: ReadonlySet<string>): Promise<void> => {
    const manifest = await loadManifest(fs, pluginDir, problems);
    if (!manifest) {
      return;
    }

    // The user's OFF switch is decided FIRST, once the name is known: a plugin
    // the user turned off is a STATE, not a load failure, so nothing about it
    // (newer manifest, incompatible engine) may surface as a problem in the
    // Plugins pane or leak into MCP/Skills/Subagents. Only an ENABLED plugin
    // reaches the gates below.
    if (disabled.has(manifest.name)) {
      skipped.push({ name: manifest.name, dir: pluginDir, tier, reason: "disabled" });
      return;
    }

    if (manifest.manifestVersion !== undefined && manifest.manifestVersion > MANIFEST_VERSION) {
      const problem = `Plugin "${manifest.name}" at ${pluginDir} skipped: manifest version ${manifest.manifestVersion} requires a newer AnyCode (this app understands ${MANIFEST_VERSION})`;
      problems.push(problem);
      skipped.push({ name: manifest.name, dir: pluginDir, tier, reason: "newer-manifest", problem });
      return;
    }

    if (opts.appVersion !== undefined && manifest.engines?.anycode !== undefined) {
      const range = manifest.engines.anycode;
      if (!rangeMatches(range, opts.appVersion)) {
        const problem = `Plugin "${manifest.name}" at ${pluginDir} is installed but inactive: incompatible with AnyCode ${opts.appVersion} (needs ${normalizeSemverRange(range)})`;
        problems.push(problem);
        skipped.push({ name: manifest.name, dir: pluginDir, tier, reason: "incompatible", problem });
        return;
      }
    }

    const existing = claimedPluginNames.get(manifest.name);
    if (existing) {
      if (TIER_RANK[tier] < TIER_RANK[existing.tier]) {
        // The NEW plugin is the higher tier: swap it in, demote the old copy.
        const idx = accepted.indexOf(existing);
        if (idx >= 0) {
          accepted.splice(idx, 1);
        }
        const winner = { manifest, root: pluginDir, tier };
        claimedPluginNames.set(manifest.name, winner);
        accepted.push(winner);
        problems.push(
          `Plugin "${manifest.name}" at ${existing.root} ignored: name already claimed by a higher-precedence plugin (${pluginDir})`,
        );
      } else {
        const problem = `Plugin "${manifest.name}" at ${pluginDir} ignored: name already claimed by a higher-precedence plugin`;
        problems.push(problem);
        skipped.push({ name: manifest.name, dir: pluginDir, tier, reason: "conflict", problem });
      }
      return;
    }

    if (accepted.length >= MAX_PLUGINS) {
      const problem = `Plugin "${manifest.name}" at ${pluginDir} skipped: MAX_PLUGINS (${MAX_PLUGINS}) reached`;
      problems.push(problem);
      skipped.push({ name: manifest.name, dir: pluginDir, tier, reason: "cap", problem });
      return;
    }

    claimedPluginNames.set(manifest.name, { manifest, root: pluginDir, tier });
    accepted.push({ manifest, root: pluginDir, tier });
  };

  // The managed store is read ONCE: candidates + the user-global disabled set.
  const managed = await listManagedPlugins(fs, opts, problems);

  // ── Tier 1: project plugins (hand-placed under the workspace). ──
  const projectRoot = pluginsRootPath(opts.workspace);
  for (const entry of await listPluginDirs(fs, projectRoot, problems)) {
    await consider(`${projectRoot}/${entry}`, "project", managed.disabled);
  }

  // ── Tier 2: managed store (official > third-party > local, from state.json). ──
  for (const candidate of managed.candidates) {
    await consider(candidate.dir, candidate.tier, managed.disabled);
  }

  // ── Tier 3: legacy user plugins (hand-dropped, never managed). ──
  const userRoot = pluginsRootPath(opts.home);
  if (userRoot !== projectRoot) {
    for (const entry of await listPluginDirs(fs, userRoot, problems)) {
      await consider(`${userRoot}/${entry}`, "legacy-user", managed.disabled);
    }
  }

  // Deterministic downstream precedence among plugins: tier, then name.
  accepted.sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.manifest.name.localeCompare(b.manifest.name),
  );

  const skillRoots: SkillRoot[] = [];
  const agentRoots: AgentProfileRoot[] = [];
  const workflowRoots: WorkflowRoot[] = [];
  const mcpServerSpecs: McpServerSpec[] = [];

  const gated = isProjectGated(opts.workspace, opts.home, opts);
  for (const plugin of accepted) {
    const official = plugin.tier === "official";

    // Official-only contributions (design §2/§4): ignored with a problem on
    // non-official plugins. s1 contributes them for no one (s2 fields).
    if (declaresOfficialOnly(plugin.manifest) && !official) {
      problems.push(
        `Plugin "${plugin.manifest.name}": docs/engineSupport/promptOverlays are official-only contributions — ignored`,
      );
    }

    const skillRootList = await dropReservedRoots(
      fs,
      plugin,
      resolveContentRoots(plugin, plugin.manifest.skills, "skills", problems),
      "skills",
      opts.reservedSkillNames,
      problems,
    );
    skillRoots.push(...skillRootList);

    const agentRootList = await dropReservedRoots(
      fs,
      plugin,
      resolveContentRoots(plugin, plugin.manifest.agents, "agents", problems),
      "agents",
      opts.reservedAgentNames,
      problems,
    );
    agentRoots.push(...agentRootList);

    workflowRoots.push(
      ...resolveContentRoots(plugin, pluginWorkflowsDirs(plugin.manifest), "workflows", problems),
    );

    // Project-tier plugin MCP is covered by workspace trust (Taskana 4736):
    // untrusted => never spawns. When the host supplied a trust decision, a
    // trusted project needs no separate per-plugin consent (one prompt, not two).
    if (gated && plugin.tier === "project") {
      if (plugin.manifest.mcpServers) {
        problems.push(`Plugin "${plugin.manifest.name}" MCP servers skipped: folder not trusted`);
      }
      continue;
    }

    // MCP consent (design §4): undefined mcpConsent keeps today's behaviour.
    const hash = serversHash(plugin.manifest.mcpServers ?? {});
    const consentAllowed =
      opts.mcpConsent === undefined ||
      (plugin.tier === "project" && opts.projectTrusted === true) ||
      hasMcpConsent(opts.mcpConsent, plugin.manifest.name, hash);
    const resolvedServers = resolvePluginMcpServers(
      plugin,
      opts.claimedMcpNames,
      { allowed: consentAllowed, hash },
      opts.secrets,
      opts.loginPath,
    );
    mcpServerSpecs.push(...resolvedServers.specs);
    problems.push(...resolvedServers.problems);
  }

  return {
    skillRoots,
    agentRoots,
    workflowRoots,
    mcpServerSpecs,
    pluginInfo: new Map(
      accepted.map((plugin) => [
        plugin.manifest.name,
        {
          tier: plugin.tier,
          ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
          root: plugin.root,
        },
      ]),
    ),
    skipped,
    problems,
  };
}

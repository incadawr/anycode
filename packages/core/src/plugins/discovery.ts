/**
 * Plugin discovery (design slice-3.3-cut.md §3.6). Scans
 * `<ws>/.anycode/plugins/<dir>` then `<home>/.anycode/plugins/<dir>` for a
 * directory carrying `<dir>/.anycode-plugin/plugin.json`; a directory with no
 * manifest is silently not a plugin (no problem reported). Dedupe is by
 * manifest `name` (project wins — project root is scanned first), capped at
 * `MAX_PLUGINS` after dedupe. Every failure (unreadable dir, bad JSON, bad
 * schema) is fail-soft: the ONE offending plugin is skipped with a `problems[]`
 * entry, discovery never throws and never drops an unrelated plugin.
 *
 * Accepted plugins contribute (in manifest-name order, for deterministic
 * downstream precedence — design §3.3/§3.5 "plugins are lowest precedence, in
 * name order"):
 *  - `skillRoots`/`agentRoots`: each declared directory resolved RELATIVE to
 *    the plugin root, containment-checked (absolute or `..`-escape -> that ONE
 *    directory dropped + problem, the rest of the plugin is unaffected).
 *  - `mcpServerSpecs`: each server renamed `<srv>` -> `plugin_<name>_<srv>`
 *    (both segments already passed the manifest's name regex, so the mcp
 *    bridge needs no re-sanitization), `cwd` defaulted to the plugin root (or
 *    resolved from it when relative; an absolute `cwd` is left as-is — server

 *    through the SAME `resolveMcpServerEntries` the explicit config uses, over
 *    the SHARED `claimedMcpNames` set the caller pre-populates from explicit
 *    config (so explicit config always wins a name collision).
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { ZodError } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpServerSpec } from "../ports/mcp.js";
import { resolveMcpServerEntries, type McpServerEntry } from "../mcp/config.js";
import type { SkillRoot } from "../skills/discovery.js";
import type { AgentProfileRoot } from "../subagents/profiles.js";
import { MAX_PLUGINS } from "../types/config.js";
import { pluginManifestSchema, type PluginManifest } from "./manifest.js";

export interface DiscoverPluginsOptions {
  workspace: string;
  home: string;
  /** Server names already claimed by explicit config; plugins never override them. */
  claimedMcpNames: Set<string>;
}

export interface PluginDiscoveryResult {
  /** Plugin-contributed skill roots (source: "plugin:<name>"), lowest precedence. */
  skillRoots: SkillRoot[];
  /** Plugin-contributed agent-profile roots (source: "plugin:<name>"). */
  agentRoots: AgentProfileRoot[];
  /** Plugin-declared, renamed + resolved MCP server specs. */
  mcpServerSpecs: McpServerSpec[];
  problems: string[];
}

interface AcceptedPlugin {
  manifest: PluginManifest;
  /** Absolute plugin root directory (the directory carrying .anycode-plugin/). */
  root: string;
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

/** Sorted directory entry names under `root`; [] (fail-soft) if the root is absent/unreadable. */
async function listPluginDirs(fs: FileSystemPort, root: string, problems: string[]): Promise<string[]> {
  if (!(await fs.exists(root))) {
    return [];
  }
  try {
    return [...(await fs.readdir(root))].sort();
  } catch (error) {
    problems.push(`Could not list plugins directory ${root}: ${describeError(error)}`);
    return [];
  }
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

/** Resolves one contribution list (skills or agents) into containment-checked roots. */
function resolveContentRoots(
  plugin: AcceptedPlugin,
  dirs: readonly string[],
  kind: "skills" | "agents",
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

/** Renames + resolves one plugin's mcpServers contribution through the shared entry-resolver. */
function resolvePluginMcpServers(
  plugin: AcceptedPlugin,
  claimedMcpNames: Set<string>,
): { specs: McpServerSpec[]; problems: string[] } {
  const entries = plugin.manifest.mcpServers;
  if (!entries) {
    return { specs: [], problems: [] };
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
  });
}

/**
 * Discovers local plugins under the project then user plugins root (design
 * §3.6). Never throws: every failure mode is fail-soft, collected in
 * `problems[]`. An absent/empty plugins world costs one `exists()` check per
 * root and yields an all-empty result.
 */
export async function discoverPlugins(
  fs: FileSystemPort,
  opts: DiscoverPluginsOptions,
): Promise<PluginDiscoveryResult> {
  const problems: string[] = [];
  const claimedPluginNames = new Set<string>();
  const accepted: AcceptedPlugin[] = [];

  const roots = [
    { dir: pluginsRootPath(opts.workspace) },
    { dir: pluginsRootPath(opts.home) },
  ];

  const seenRootDirs = new Set<string>();
  for (const root of roots) {
    // Dedup identical paths (workspace === home) so the same root is never scanned twice.
    if (seenRootDirs.has(root.dir)) {
      continue;
    }
    seenRootDirs.add(root.dir);

    const entries = await listPluginDirs(fs, root.dir, problems);
    for (const entry of entries) {
      const pluginDir = `${root.dir}/${entry}`;
      const manifest = await loadManifest(fs, pluginDir, problems);
      if (!manifest) {
        continue;
      }

      if (claimedPluginNames.has(manifest.name)) {
        problems.push(
          `Plugin "${manifest.name}" at ${pluginDir} ignored: name already claimed by a higher-precedence plugin`,
        );
        continue;
      }
      if (accepted.length >= MAX_PLUGINS) {
        problems.push(`Plugin "${manifest.name}" at ${pluginDir} skipped: MAX_PLUGINS (${MAX_PLUGINS}) reached`);
        continue;
      }

      claimedPluginNames.add(manifest.name);
      accepted.push({ manifest, root: pluginDir });
    }
  }

  // Deterministic downstream precedence among plugins: manifest-name order (design §3.3/§3.5).
  accepted.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

  const skillRoots: SkillRoot[] = [];
  const agentRoots: AgentProfileRoot[] = [];
  const mcpServerSpecs: McpServerSpec[] = [];

  for (const plugin of accepted) {
    skillRoots.push(...resolveContentRoots(plugin, plugin.manifest.skills, "skills", problems));
    agentRoots.push(...resolveContentRoots(plugin, plugin.manifest.agents, "agents", problems));

    const resolvedServers = resolvePluginMcpServers(plugin, opts.claimedMcpNames);
    mcpServerSpecs.push(...resolvedServers.specs);
    problems.push(...resolvedServers.problems);
  }

  return { skillRoots, agentRoots, mcpServerSpecs, problems };
}

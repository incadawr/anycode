/**
 * Project spawn-config collection (Taskana 4736, design 2.1/2.2). Enumerates
 * exactly the project-level declarations that can START a process from a
 * cloned repository, and hashes them canonically:
 *   - enabled `mcpServers` of `<ws>/.anycode/config.json` and `<ws>/.mcp.json`
 *   - every `hooks` declaration of `<ws>/.anycode/config.json`
 *   - every `lspServers` entry of `<ws>/.anycode/config.json`
 *   - the enabled `mcpServers` of each project-tier plugin manifest
 *     (`<ws>/.anycode/plugins/<dir>/.anycode-plugin/plugin.json`)
 * Skills, agents and workflows are NOT part of the set: they spawn nothing.
 *
 * The hash covers command/args/cwd/env (and http url/headers) VALUES so a
 * changed secret or argument re-prompts, but the values are never returned in
 * `items` — the displayable view carries the command line and env KEY names
 * only. `workspace === home` is the user file itself: nothing is collected.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { mcpServerEntrySchema, type McpServerEntry } from "../mcp/config.js";
import { commandHookEntrySchema } from "../dispatch/hook-config.js";
import { lspServerEntrySchema } from "../lsp/config.js";
import { pluginManifestSchema } from "../plugins/manifest.js";

export type ProjectSpawnKind = "mcp" | "hook" | "lsp" | "plugin-mcp";

/** Displayable view of one project spawn declaration (no env/header values). */
export interface ProjectSpawnItem {
  kind: ProjectSpawnKind;
  name: string;
  /** Command line (stdio/hook/lsp) or URL (http MCP). */
  commandLine: string;
  /** The file that declares it (absolute path). */
  source: string;
  /** Env / header KEY names only — values are never shown. */
  envKeys: string[];
}

export interface ProjectSpawnConfig {
  items: ProjectSpawnItem[];
  /** sha256 hex over the canonical form of the full set; "" when there are no items. */
  hash: string;
}

interface CollectedItem {
  display: ProjectSpawnItem;
  /** Everything that affects what runs, values included; hashed, never returned. */
  canonical: Record<string, unknown>;
}

const PLUGINS_DIR_SUFFIX = ".anycode/plugins";

function configPathOf(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

function compatPathOf(workspace: string): string {
  return `${workspace.replace(/[/\\]+$/, "")}/.mcp.json`;
}

/** Recursively sorted-key JSON so the hash is independent of JSON key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Reads and parses a JSON file; missing, unreadable or malformed => undefined (fail-soft). */
async function readJsonIfPresent(fs: FileSystemPort, path: string): Promise<unknown> {
  try {
    if (!(await fs.exists(path))) return undefined;
    return JSON.parse(await fs.readFile(path));
  } catch {
    return undefined;
  }
}

function mcpItems(
  servers: unknown,
  source: string,
  kind: "mcp" | "plugin-mcp",
  namePrefix: string,
  extra: Record<string, unknown>,
): CollectedItem[] {
  if (!servers || typeof servers !== "object") return [];
  const out: CollectedItem[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const parsed = mcpServerEntrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const entry: McpServerEntry = parsed.data;
    if ((entry.enabled ?? true) === false) continue;
    const spec: Record<string, unknown> = { ...entry };
    delete spec.enabled;
    const displayName = `${namePrefix}${name}`;
    if (entry.command !== undefined) {
      out.push({
        display: {
          kind,
          name: displayName,
          commandLine: [entry.command, ...(entry.args ?? [])].join(" "),
          source,
          envKeys: Object.keys(entry.env ?? {}).sort(),
        },
        canonical: { kind, name: displayName, source, ...extra, ...spec },
      });
    } else if (entry.url !== undefined) {
      out.push({
        display: {
          kind,
          name: displayName,
          commandLine: entry.url,
          source,
          envKeys: Object.keys(entry.headers ?? {}).sort(),
        },
        canonical: { kind, name: displayName, source, ...extra, ...spec },
      });
    }
  }
  return out;
}

function hookItems(hooks: unknown, source: string): CollectedItem[] {
  if (!hooks || typeof hooks !== "object") return [];
  const out: CollectedItem[] = [];
  for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const parsed = commandHookEntrySchema.safeParse(raw);
      if (!parsed.success) continue;
      out.push({
        display: { kind: "hook", name: event, commandLine: parsed.data.command, source, envKeys: [] },
        canonical: { kind: "hook", name: event, source, ...parsed.data },
      });
    }
  }
  return out;
}

function lspItems(lspServers: unknown, source: string): CollectedItem[] {
  if (!Array.isArray(lspServers)) return [];
  const out: CollectedItem[] = [];
  for (const raw of lspServers) {
    const parsed = lspServerEntrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const entry = parsed.data;
    out.push({
      display: {
        kind: "lsp",
        name: entry.name,
        commandLine: [entry.command, ...(entry.args ?? [])].join(" "),
        source,
        envKeys: [],
      },
      canonical: { ...entry, kind: "lsp", source },
    });
  }
  return out;
}

async function projectPluginItems(fs: FileSystemPort, workspace: string): Promise<CollectedItem[]> {
  const root = `${workspace.replace(/[/\\]+$/, "")}/${PLUGINS_DIR_SUFFIX}`;
  if (!(await fs.exists(root))) return [];
  let dirs: string[];
  try {
    dirs = [...(await fs.readdir(root))].sort();
  } catch {
    return [];
  }
  const out: CollectedItem[] = [];
  for (const dir of dirs) {
    const pluginRoot = `${root}/${dir}`;
    const manifestPath = `${pluginRoot}/.anycode-plugin/plugin.json`;
    const json = await readJsonIfPresent(fs, manifestPath);
    if (json === undefined) continue;
    const manifest = pluginManifestSchema.safeParse(json);
    if (!manifest.success) continue;
    out.push(
      ...mcpItems(manifest.data.mcpServers, manifestPath, "plugin-mcp", `plugin:${manifest.data.name}/`, {
        plugin: manifest.data.name,
        pluginRoot,
      }),
    );
  }
  return out;
}

/**
 * Collects the project-level spawn declarations of `workspace` and their
 * canonical hash. Never throws; malformed or absent sources contribute nothing.
 */
export async function collectProjectSpawnConfig(
  fs: FileSystemPort,
  workspace: string,
  home: string,
): Promise<ProjectSpawnConfig> {
  if (resolve(workspace) === resolve(home)) {
    return { items: [], hash: "" };
  }

  const projectConfigPath = configPathOf(workspace);
  const compatPath = compatPathOf(workspace);
  const projectConfig = await readJsonIfPresent(fs, projectConfigPath);
  const compat = await readJsonIfPresent(fs, compatPath);

  const collected: CollectedItem[] = [];
  if (projectConfig && typeof projectConfig === "object") {
    const section = projectConfig as Record<string, unknown>;
    collected.push(...mcpItems(section.mcpServers, projectConfigPath, "mcp", "", {}));
    collected.push(...hookItems(section.hooks, projectConfigPath));
    collected.push(...lspItems(section.lspServers, projectConfigPath));
  }
  if (compat && typeof compat === "object") {
    collected.push(
      ...mcpItems((compat as Record<string, unknown>).mcpServers, compatPath, "mcp", "", {}),
    );
  }
  collected.push(...(await projectPluginItems(fs, workspace)));

  if (collected.length === 0) {
    return { items: [], hash: "" };
  }

  const sorted = [...collected].sort((a, b) =>
    canonicalJson(a.canonical).localeCompare(canonicalJson(b.canonical)),
  );
  const hash = createHash("sha256")
    .update(canonicalJson({ version: 1, items: sorted.map((c) => c.canonical) }))
    .digest("hex");

  return { items: sorted.map((c) => c.display), hash };
}

/**
 * Main-safe plugins admin barrel + the Plugins-pane scan (Taskana 4732 S1-A,
 * design §7/§8). `scanPluginsAdmin` enumerates EVERY plugin — managed store
 * entries (with their state: enabled/pinned/versions/source), project and
 * legacy hand-dropped dirs — running the SAME tiered discovery the boot path
 * runs, and emits one row per plugin with tier, status, capabilities, consent
 * state, and problems. It is the single source behind Settings → Plugins.
 *
 * ⚠ NO ai-SDK imports: the Electron main process imports plugins admin ONLY
 * through the `@anycode/core/plugins-admin` subpath so it never drags the
 * full `@anycode/core` barrel (and the ai-SDK with it). Every module
 * re-exported here transitively touches only ports + zod + node:crypto —
 * verified clean of ai-SDK (same audit posture as skills-admin).
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { discoverPlugins, type PluginTier } from "./discovery.js";
import {
  capabilities,
  pluginManifestSchema,
  pluginWorkflowsDirs,
  serviceSecretRefs,
  type PluginCapabilities,
} from "./manifest.js";
import {
  hasMcpConsent,
  hasServiceConsent,
  readPluginState,
  serversHash,
  servicesHash,
  PLUGIN_STATE_FILE,
  type McpConsentEntry,
  type PluginStateEntry,
  type ServiceConsentEntry,
} from "./state.js";

/** How the plugin's installation is surfaced (design §6 source column). */
export interface PluginSourceView {
  kind: PluginStateEntry["source"]["kind"] | "dir";
  /** Human-readable origin: URL, file name, or omitted for dir/official. */
  url?: string;
  fileName?: string;
  path?: string;
  ref?: string;
  commit?: string;
}

/** Coarse lifecycle status of one plugin row (design §6 chips). */
export type PluginStatus =
  | "active"
  | "inactive" // incompatible or missing install dir
  | "disabled";

/** One Plugins-pane row: everything the UI needs about one plugin. */
export interface PluginAdminRow {
  name: string;
  /** Manifest version (managed installs always have one; dirs may not). */
  version?: string;
  displayName?: string;
  description?: string;
  tier: PluginTier;
  status: PluginStatus;
  /** Reason(s) behind inactive/disabled/problems chip (free-form strings). */
  problems: string[];
  source: PluginSourceView;
  /** DERIVED capability summary (never self-declared, design §2). */
  capabilities?: PluginCapabilities;
  /** sha256 hex of the plugin's mcpServers map — the consent key (design §4). */
  mcpServersHash?: string;
  /** True when mcpConsent holds a CURRENT grant for this plugin's servers. */
  mcpConsentGranted?: boolean;
  /** MCP server names the plugin declares (pre-rename). */
  mcpServerNames: string[];
  /** Background service names the plugin declares (Taskana 4750a, sorted). */
  serviceNames: string[];
  /** sha256 of the services definition (name/command/args/env KEYS); absent when no services. */
  servicesHash?: string;
  /** True when serviceConsent holds a CURRENT grant for this plugin's services. */
  servicesConsentGranted?: boolean;
  /** Service definitions for the install/consent sheet — env KEY and secret NAMES only, NEVER values. */
  services?: { name: string; command: string; args: string[]; envKeys: string[]; secretNames?: string[] }[];
  /** Managed-install bookkeeping (absent for project/legacy dir plugins). */
  managed?: {
    enabled: boolean;
    pinned: boolean;
    active: string;
    previous?: string;
    installedAt?: string;
    sha256?: string;
  };
  /** Absolute install/plugin root (main-side Reveal in Finder; never sent by the renderer). */
  root?: string;
}

export interface ScanPluginsAdminOptions {
  workspace: string;
  home: string;
  /** Absolute state.json path; defaults to `<home>/.anycode/plugins/state.json`. */
  pluginStatePath?: string;
  appVersion?: string;
  reservedSkillNames?: ReadonlySet<string>;
  reservedAgentNames?: ReadonlySet<string>;
  mcpConsent?: readonly McpConsentEntry[];
  serviceConsent?: readonly ServiceConsentEntry[];
}

export interface PluginsAdminScanResult {
  rows: PluginAdminRow[];
  problems: string[];
}

/** The default state file location (design §3). */
export function defaultPluginStatePath(home: string): string {
  return `${home.replace(/[/\\]+$/, "")}/.anycode/plugins/${PLUGIN_STATE_FILE}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Containment helper for dir roots (same discipline as discovery.resolveContained). */
function containedRoot(root: string, rel: string): boolean {
  if (isAbsolute(rel)) {
    return false;
  }
  const resolved = resolve(root, rel);
  const fromRoot = relative(root, resolved);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

/**
 * Scans the WHOLE plugin world for the Plugins pane. Never throws: discovery
 * and the state reader are each fail-soft; their problems are aggregated both
 * into `problems[]` and (where attributable) the owning row's own list.
 *
 * Row construction mirrors discovery tiers: managed entries from state.json
 * (official > third-party > local), then project dirs, then legacy user dirs —
 * a name claimed by a higher tier keeps that tier's row, exactly like boot.
 */
export async function scanPluginsAdmin(
  fs: FileSystemPort,
  opts: ScanPluginsAdminOptions,
): Promise<PluginsAdminScanResult> {
  const { workspace, home } = opts;
  const statePath = opts.pluginStatePath ?? defaultPluginStatePath(home);
  const problems: string[] = [];

  // ONE discovery pass: same tiers, same gating, same problems as boot. Its
  // pluginInfo map is the skeleton for the accepted-plugin rows.
  const discovery = await discoverPlugins(fs, {
    workspace,
    home,
    claimedMcpNames: new Set(),
    pluginStatePath: statePath,
    ...(opts.appVersion !== undefined ? { appVersion: opts.appVersion } : {}),
    ...(opts.reservedSkillNames !== undefined ? { reservedSkillNames: opts.reservedSkillNames } : {}),
    ...(opts.reservedAgentNames !== undefined ? { reservedAgentNames: opts.reservedAgentNames } : {}),
    ...(opts.mcpConsent !== undefined ? { mcpConsent: opts.mcpConsent } : {}),
  });
  problems.push(...discovery.problems);

  const stateRead = await readPluginState(fs, statePath);
  problems.push(...stateRead.problems);
  const disabled = new Set(stateRead.state.disabled);

  const rows = new Map<string, PluginAdminRow>();

  // ── Managed entries (state.json): one row each, with bookkeeping. ──
  for (const [name, entry] of Object.entries(stateRead.state.plugins)) {
    const discovered = discovery.pluginInfo.get(name);
    const row: PluginAdminRow = {
      name,
      tier: entry.trust === "official" ? "official" : entry.trust === "local" ? "local" : "third-party",
      status: disabled.has(name) ? "disabled" : discovered ? "active" : "inactive",
      problems: [],
      source: sourceViewOf(entry),
      managed: {
        enabled: entry.enabled,
        pinned: entry.pinned,
        active: entry.active,
        ...(entry.previous !== undefined ? { previous: entry.previous } : {}),
        ...(entry.installedAt !== undefined ? { installedAt: entry.installedAt } : {}),
        ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
      },
      ...(discovered?.version !== undefined ? { version: discovered.version } : { version: entry.active }),
      ...(discovered?.root !== undefined ? { root: discovered.root } : {}),
      mcpServerNames: [],
      serviceNames: [],
    };
    rows.set(name, row);
  }

  // ── Accepted plugins not already rowed (project + legacy-user dirs). ──
  for (const [name, info] of discovery.pluginInfo) {
    if (rows.has(name)) {
      continue;
    }
    rows.set(name, {
      name,
      tier: info.tier,
      status: disabled.has(name) ? "disabled" : "active",
      problems: [],
      source: { kind: "dir" },
      ...(info.version !== undefined ? { version: info.version } : {}),
      ...(info.root !== undefined ? { root: info.root } : {}),
      mcpServerNames: [],
      serviceNames: [],
    });
  }

  // ── Skipped candidates not already rowed (disabled/incompatible dir
  // plugins): they still row — inactive/disabled, with the reason. ──
  for (const candidate of discovery.skipped) {
    if (candidate.name === undefined || rows.has(candidate.name)) {
      continue;
    }
    rows.set(candidate.name, {
      name: candidate.name,
      tier: candidate.tier,
      status: candidate.reason === "disabled" ? "disabled" : "inactive",
      problems: [candidate.problem],
      source: { kind: "dir" },
      ...(candidate.dir !== undefined ? { root: candidate.dir } : {}),
      mcpServerNames: [],
      serviceNames: [],
    });
  }

  // ── Per-row detail: re-read each plugin's manifest (accepted AND skipped,
  // both carry a root) for the derived capabilities + MCP consent state
  // (fail-soft per row). ──
  const detailTargets: [string, string | undefined][] = [
    ...[...discovery.pluginInfo.entries()].map(([name, info]) => [name, info.root] as [string, string | undefined]),
    ...discovery.skipped
      .filter((c) => c.name !== undefined && !discovery.pluginInfo.has(c.name))
      .map((c) => [c.name!, c.dir] as [string, string | undefined]),
  ];
  for (const [name, root] of detailTargets) {
    const info = { root };
    const row = rows.get(name);
    if (!row || info.root === undefined) {
      continue;
    }
    const manifestPath = `${info.root}/.anycode-plugin/plugin.json`;
    try {
      if (await fs.exists(manifestPath)) {
        const raw = await fs.readFile(manifestPath);
        const parsed = pluginManifestSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          const caps = capabilities(parsed.data);
          row.capabilities = caps;
          row.mcpServerNames = caps.mcp;
          row.serviceNames = caps.services;
          const services = parsed.data.services ?? [];
          if (services.length > 0) {
            const sHash = servicesHash(services);
            row.servicesHash = sHash;
            row.servicesConsentGranted =
              opts.serviceConsent !== undefined && hasServiceConsent(opts.serviceConsent, name, sHash);
            row.services = services.map((svc) => ({
              name: svc.name,
              command: svc.command,
              args: [...(svc.args ?? [])],
              envKeys: Object.keys(svc.env ?? {}).sort(),
              ...(serviceSecretRefs(svc).length > 0 ? { secretNames: serviceSecretRefs(svc) } : {}),
            }));
          }
          const hash = serversHash(parsed.data.mcpServers ?? {});
          row.mcpServersHash = hash;
          row.mcpConsentGranted =
            opts.mcpConsent !== undefined && hasMcpConsent(opts.mcpConsent, name, hash);
          // displayName/description for the card header.
          if (parsed.data.displayName !== undefined) {
            row.displayName = parsed.data.displayName;
          }
          if (parsed.data.description !== undefined) {
            row.description = parsed.data.description;
          }
          // Containment sanity problems for declared dirs (informational).
          for (const [dirs, label] of [
            [parsed.data.skills, "skills"],
            [parsed.data.agents, "agents"],
            [pluginWorkflowsDirs(parsed.data), "workflows"],
          ] as const) {
            for (const dir of dirs) {
              if (!containedRoot(info.root, dir)) {
                row.problems.push(`${label} entry ${JSON.stringify(dir)} escapes the plugin root`);
              }
            }
          }
        }
      }
    } catch (error) {
      row.problems.push(`Could not read manifest: ${describeError(error)}`);
    }
  }

  // ── Attribution: discovery problems that name a plugin land on its row. ──
  for (const problem of discovery.problems) {
    for (const name of rows.keys()) {
      if (problem.includes(`"${name}"`)) {
        rows.get(name)!.problems.push(problem);
        break;
      }
    }
  }

  // Deterministic order: tier rank, then name (mirrors discovery order).
  const TIER_RANK: Record<PluginTier, number> = {
    project: 0,
    official: 1,
    "third-party": 2,
    local: 3,
    "legacy-user": 4,
  };
  const ordered = [...rows.values()].sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.name.localeCompare(b.name),
  );

  return { rows: ordered, problems };
}

function sourceViewOf(entry: PluginStateEntry): PluginSourceView {
  switch (entry.source.kind) {
    case "official":
      return { kind: "official" };
    case "url":
      return { kind: "url", url: entry.source.url };
    case "file":
      return { kind: "file", fileName: entry.source.fileName };
    case "git":
      return {
        kind: "git",
        url: entry.source.url,
        ...(entry.source.ref !== undefined ? { ref: entry.source.ref } : {}),
        ...(entry.source.commit !== undefined ? { commit: entry.source.commit } : {}),
      };
    case "local":
      return { kind: "local", path: entry.source.path };
  }
}

// Main-safe barrel re-exports (design §7): the subpath pulls plugins admin
// WITHOUT the ai-SDK-tainted core barrel.
export { discoverPlugins } from "./discovery.js";
export type { DiscoverPluginsOptions, PluginTier, PluginDiscoveryResult } from "./discovery.js";
export {
  PLUGIN_STATE_FILE,
  PLUGIN_STATE_VERSION,
  canonicalJson,
  emptyPluginState,
  hasMcpConsent,
  pluginsStateSchema,
  pluginTrustSchema,
  readPluginState,
  serversHash,
  servicesHash,
  hasServiceConsent,
  writePluginState,
} from "./state.js";
export type {
  McpConsentEntry,
  ServiceConsentEntry,
  ServiceHashInput,
  PluginStateEntry,
  PluginTrust,
  PluginStateReadResult,
  PluginsState,
} from "./state.js";
export {
  capabilities,
  declaresOfficialOnly,
  pluginManifestSchema,
  pluginServiceSchema,
  pluginWorkflowsDirs,
  MANIFEST_VERSION,
  OFFICIAL_ONLY_CONTRIBUTIONS,
  PLUGIN_NAME_RE,
  serviceSecretRefs,
  expandServiceSecrets,
} from "./manifest.js";
export type { PluginManifest, PluginCapabilities, PluginServiceSpec } from "./manifest.js";
// Taskana 4732 S1-B: the desktop main store reuses the same semver helpers
// discovery's engines gating uses (one implementation of the grammar).
export { isValidSemver, parseSemver, rangeMatches, normalizeSemverRange } from "../util/semver-range.js";

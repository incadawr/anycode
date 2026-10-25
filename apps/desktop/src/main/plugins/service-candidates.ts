/**
 * Candidate source for the service supervisor (Taskana 4750a). Builds the
 * desired service set from the SAME admin scan the Plugins pane uses:
 *  - home scan (managed + legacy-user plugins), `enabled = row.status === "active"`;
 *  - one scan per distinct LIVE root-tab workspace, keeping only `project`-tier
 *    rows, each gated by that workspace's trust decision.
 * The service command/args/env VALUES are read here from the manifest and
 * handed only to the supervisor; no renderer-facing type ever carries them.
 * `${secret:NAME}` references (Taskana 4751 part 0) are resolved here too, for
 * services that are enabled, consented and eligible for a folder; an unset name
 * is reported as missing and blocks the spawn.
 */

import {
  pluginManifestSchema,
  scanPluginsAdmin,
  serviceSecretRefs,
  type PluginAdminRow,
  type ServiceConsentEntry,
} from "@anycode/core/plugins-admin";
import { defaultTrustStorePath, resolveWorkspaceTrust } from "@anycode/core/workspace-trust";
import type { FileSystemPort } from "@anycode/core";
import { statePath } from "./store.js";
import type { ServiceCandidate } from "./service-supervisor.js";

export interface ServiceCandidatesDeps {
  fs: FileSystemPort;
  home: string;
  appVersion: string;
  /** Distinct workspaces of the live root tabs (childless). */
  liveWorkspaces(): readonly string[];
  serviceConsent(): Promise<readonly ServiceConsentEntry[]>;
  /** Project-folder trust (once-approval included); false when undecided or unreadable. */
  isWorkspaceTrusted(workspace: string): Promise<boolean>;
  /** Values of the named secrets that are set (names absent from the store are omitted). */
  resolveSecrets?(names: readonly string[]): Promise<Record<string, string>>;
}

/** Reads the service definition (values included) of one row from its manifest. */
async function candidatesOf(
  fs: FileSystemPort,
  row: PluginAdminRow,
  trusted: boolean,
  resolveSecrets?: ServiceCandidatesDeps["resolveSecrets"],
): Promise<ServiceCandidate[]> {
  if (row.root === undefined || row.serviceNames.length === 0) return [];
  let parsed: ReturnType<typeof pluginManifestSchema.safeParse>;
  try {
    parsed = pluginManifestSchema.safeParse(JSON.parse(await fs.readFile(`${row.root}/.anycode-plugin/plugin.json`)));
  } catch {
    return [];
  }
  if (!parsed.success) return [];
  const root = row.root;
  const enabled = row.status === "active";
  const consented = row.servicesConsentGranted === true;
  const out: ServiceCandidate[] = [];
  for (const svc of parsed.data.services ?? []) {
    // Secrets are read only for a service that could actually start (saves vault reads for the rest).
    const refs = enabled && consented && trusted ? serviceSecretRefs(svc) : [];
    let secretValues: Record<string, string> = {};
    if (refs.length > 0 && resolveSecrets !== undefined) {
      try {
        const resolved = await resolveSecrets(refs);
        secretValues = Object.fromEntries(refs.filter((name) => typeof resolved[name] === "string").map((name) => [name, resolved[name]!]));
      } catch {
        secretValues = {};
      }
    }
    const missingSecrets = refs.filter((name) => secretValues[name] === undefined);
    out.push({
      plugin: row.name,
      tier: row.tier,
      root,
      service: {
        name: svc.name,
        command: svc.command,
        args: [...(svc.args ?? [])],
        env: { ...(svc.env ?? {}) },
      },
      enabled,
      consented,
      trusted,
      secretValues,
      missingSecrets,
    });
  }
  return out;
}

export async function listServiceCandidates(deps: ServiceCandidatesDeps): Promise<ServiceCandidate[]> {
  const consent = [...(await deps.serviceConsent())];
  const out: ServiceCandidate[] = [];
  const seen = new Set<string>();
  const push = (list: ServiceCandidate[]) => {
    for (const candidate of list) {
      const key = `${candidate.plugin}/${candidate.service.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  };

  const homeScan = await scanPluginsAdmin(deps.fs, {
    workspace: deps.home,
    home: deps.home,
    pluginStatePath: statePath(deps.home),
    appVersion: deps.appVersion,
    serviceConsent: consent,
  }).catch(() => ({ rows: [] as PluginAdminRow[], problems: [] as string[] }));
  for (const row of homeScan.rows) {
    if (row.tier === "project") continue;
    push(await candidatesOf(deps.fs, row, true, deps.resolveSecrets));
  }

  for (const workspace of new Set(deps.liveWorkspaces())) {
    const scan = await scanPluginsAdmin(deps.fs, {
      workspace,
      home: deps.home,
      pluginStatePath: statePath(deps.home),
      appVersion: deps.appVersion,
      serviceConsent: consent,
    }).catch(() => ({ rows: [] as PluginAdminRow[], problems: [] as string[] }));
    const projectRows = scan.rows.filter((row) => row.tier === "project");
    if (projectRows.length === 0) continue;
    const trusted = await deps.isWorkspaceTrusted(workspace);
    for (const row of projectRows) {
      push(await candidatesOf(deps.fs, row, trusted, deps.resolveSecrets));
    }
  }
  return out;
}

/** Workspace trust for the project tier: the SAME core resolver the LSP pane and host boot use. */
export async function isWorkspaceTrustedFor(
  fs: FileSystemPort,
  home: string,
  workspace: string,
  onceHash: string | undefined,
): Promise<boolean> {
  try {
    const result = await resolveWorkspaceTrust(fs, {
      workspace,
      home,
      storePath: defaultTrustStorePath(home),
      onceHash,
    });
    return result.projectTrusted === true;
  } catch {
    return false;
  }
}

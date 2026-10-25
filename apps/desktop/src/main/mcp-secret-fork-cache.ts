/**
 * Main-side preparation of `ANYCODE_MCP_SECRETS` (Taskana 4752, part C).
 *
 * The host forks with no vault access, so main hands it the secret VALUES its
 * tab's MCP configs reference, as ONE JSON object in the fork env. This cache
 * computes that object per workspace. `spawnTabHost` is synchronous, so it reads
 * the cache; the cache is primed before a tab is created and refreshed after a
 * secret changes (a respawn reads the latest cache).
 *
 * Only names that are BOTH referenced by a config file of the workspace (project,
 * user, compat) AND set in the vault are included. Plugin-declared servers are not
 * scanned here: their `${secret:}` references fail closed in this release.
 * Nothing is logged except a fixed failure line.
 */

import { collectSecretRefs, mcpConfigFileSchema, type McpServerEntry } from "@anycode/core/mcp-admin";

/** The file-read surface (structural; NodeMcpConfigFs satisfies it). */
export interface McpSecretForkCacheFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

export interface McpSecretForkCacheVault {
  listMcpSecretNames(): Promise<string[]>;
  getMcpSecretValues(names: readonly string[]): Promise<Record<string, string>>;
}

export interface McpSecretForkCacheDeps {
  vault: McpSecretForkCacheVault;
  fs: McpSecretForkCacheFs;
  /** The home directory whose user-level MCP config is read. */
  home(): string;
  /** Diagnostics sink. Receives fixed lines only, never a value. */
  logger?: (line: string) => void;
}

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

/** Reads and schema-checks one config file's servers; a missing or invalid file yields no servers. */
async function readServers(fs: McpSecretForkCacheFs, path: string): Promise<Record<string, McpServerEntry>> {
  try {
    if (!(await fs.exists(path))) return {};
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(await fs.readFile(path)));
    return parsed.success ? (parsed.data.mcpServers ?? {}) : {};
  } catch {
    return {};
  }
}

export class McpSecretForkCache {
  private readonly values = new Map<string, string>();
  private readonly workspaces = new Set<string>();

  constructor(private readonly deps: McpSecretForkCacheDeps) {}

  /** The JSON `{NAME: value}` for a workspace's tabs, or undefined when there is nothing to hand off. */
  get(workspace: string): string | undefined {
    return this.values.get(workspace);
  }

  /** Recomputes one workspace's hand-off from its configs and the vault. Never throws. */
  async prime(workspace: string): Promise<void> {
    this.workspaces.add(workspace);
    try {
      const home = this.deps.home();
      const sources = [
        await readServers(this.deps.fs, `${stripTrailingSep(workspace)}/.anycode/config.json`),
        await readServers(this.deps.fs, `${stripTrailingSep(home)}/.anycode/config.json`),
        await readServers(this.deps.fs, `${stripTrailingSep(workspace)}/.mcp.json`),
      ];
      const referenced = new Set<string>();
      for (const source of sources) {
        for (const name of collectSecretRefs(source)) referenced.add(name);
      }
      if (referenced.size === 0) {
        this.values.delete(workspace);
        return;
      }
      const stored = new Set(await this.deps.vault.listMcpSecretNames());
      const wanted = [...referenced].filter((name) => stored.has(name)).sort();
      const resolved = wanted.length === 0 ? {} : await this.deps.vault.getMcpSecretValues(wanted);
      if (Object.keys(resolved).length === 0) {
        this.values.delete(workspace);
        return;
      }
      this.values.set(workspace, JSON.stringify(resolved));
    } catch {
      this.values.delete(workspace);
      this.deps.logger?.("[mcp-secrets] could not prepare fork secrets for a workspace; its MCP secrets will be unset");
    }
  }

  /** Re-primes every workspace primed so far (after a secret mutation). */
  async refreshAll(): Promise<void> {
    for (const workspace of [...this.workspaces]) {
      await this.prime(workspace);
    }
  }
}

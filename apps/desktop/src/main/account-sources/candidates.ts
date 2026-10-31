import { accountSourceHash, pluginManifestSchema, scanPluginsAdmin, type AccountSource } from "@anycode/core/plugins-admin";
import type { FileSystemPort } from "@anycode/core";

export interface AccountSourceCandidate { plugin: string; descriptor: AccountSource; descriptorHash: string }
/** Scan only the user home registry. Never scan a tab's project directory. */
export async function listAccountSourceCandidates(fs: FileSystemPort, home: string, appVersion: string, allowLoopback = false): Promise<AccountSourceCandidate[]> {
  const scan = await scanPluginsAdmin(fs, { home, workspace: home, appVersion });
  const result: AccountSourceCandidate[] = [];
  for (const row of scan.rows) {
    if (row.status !== "active" || !row.root || !row.capabilities?.accountSources?.length) continue;
    try {
      const parsed = pluginManifestSchema.safeParse(JSON.parse(await fs.readFile(`${row.root}/.anycode-plugin/plugin.json`)));
      if (!parsed.success || parsed.data.name !== row.name) continue;
      for (const descriptor of parsed.data.accountSources ?? []) {
        if (!allowLoopback && new URL(descriptor.apiBaseUrl).protocol !== "https:") continue;
        result.push({ plugin: row.name, descriptor, descriptorHash: accountSourceHash(descriptor) });
      }
    } catch { /* A removed or malformed plugin cannot contribute a source. */ }
  }
  return result;
}

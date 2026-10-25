/**
 * settings.json `plugins.mcpConsent` writers for the main process (Taskana
 * 4732 xfix H1(c)).
 *
 * Two writers, two semantics:
 *  - `setPluginsMcpConsent` is the USER-facing writer (install-time "allow",
 *    Approve MCP, re-approval after a changed serversHash). It replaces the
 *    whole array with the composed list and ALWAYS lands — the caller already
 *    read-modify-wrote the list, so a "keep the winner" guard here silently
 *    dropped every grant after the first one.
 *  - `grandfatherPluginsMcpConsent` is the one-shot legacy migration. It keeps
 *    the "lost a race: keep the winner" guard: an existing array (written by
 *    the user or an earlier boot) is never overwritten by the migration.
 *
 * Both run under the settings-file lock.
 */

import type { McpConsentEntry } from "@anycode/core/plugins-admin";
import { loadSettings, saveSettings, withSettingsFileLock } from "../../settings/files.js";

type SettingsLogger = Parameters<typeof loadSettings>[1];

export async function setPluginsMcpConsent(
  settingsPath: string,
  entries: readonly McpConsentEntry[],
  logger: SettingsLogger,
): Promise<void> {
  await withSettingsFileLock(settingsPath, async () => {
    const current = await loadSettings(settingsPath, logger);
    await saveSettings(settingsPath, {
      ...current.settings,
      plugins: { ...(current.settings.plugins ?? {}), mcpConsent: [...entries] },
    });
  });
}

export async function grandfatherPluginsMcpConsent(
  settingsPath: string,
  entries: readonly McpConsentEntry[],
  logger: SettingsLogger,
): Promise<void> {
  await withSettingsFileLock(settingsPath, async () => {
    const current = await loadSettings(settingsPath, logger);
    if (current.settings.plugins?.mcpConsent !== undefined) return; // lost a race: keep the winner
    await saveSettings(settingsPath, {
      ...current.settings,
      plugins: { ...(current.settings.plugins ?? {}), mcpConsent: [...entries] },
    });
  });
}

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
 *
 * `upsertPluginServiceConsent` (Taskana 4750a) is the service-consent writer:
 * the same read-modify-write under the lock, but it replaces the grant for
 * ONE plugin (keyed by its servicesHash) and leaves every other plugin's grant
 * alone. There is no legacy migration for services — absent = nobody granted.
 */

import type { McpConsentEntry, ServiceConsentEntry } from "@anycode/core/plugins-admin";
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

export async function upsertPluginServiceConsent(
  settingsPath: string,
  entry: ServiceConsentEntry,
  logger: SettingsLogger,
): Promise<void> {
  await withSettingsFileLock(settingsPath, async () => {
    const current = await loadSettings(settingsPath, logger);
    const others = (current.settings.plugins?.serviceConsent ?? []).filter((e) => e.plugin !== entry.plugin);
    await saveSettings(settingsPath, {
      ...current.settings,
      plugins: { ...(current.settings.plugins ?? {}), serviceConsent: [...others, { ...entry }] },
    });
  });
}

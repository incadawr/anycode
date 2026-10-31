import type { z } from "zod";
import type { accountCatalogSchema } from "@anycode/core/plugins-admin";
import { loadSettings, saveSettings, withSettingsFileLock } from "../../settings/files.js";
import type { AnycodeSettings } from "../../shared/settings.js";
import { reconcileCatalog } from "./sync.js";

type Catalog = z.output<typeof accountCatalogSchema>;
function sameUrl(a: string, b: string): boolean {
  try { return new URL(a).href === new URL(b).href; } catch { return false; }
}

/** Apply only to the exact, still-current binding. No network work takes the settings lock. */
export async function persistCatalog(
  path: string,
  expected: { plugin: string; source: string; descriptorHash: string; connectionId: string; accountId: string; gatewayBaseUrl: string; gatewayKind: "openai-compatible" | "openai" | "anthropic" },
  catalog: Catalog,
  isCurrent: () => boolean,
  onMutation?: (settings: AnycodeSettings) => void | Promise<void>,
): Promise<"changed" | "unchanged" | "stale" | "read_only"> {
  let changedSettings: AnycodeSettings | undefined;
  const result = await withSettingsFileLock(path, async () => {
    const loaded = await loadSettings(path);
    if (loaded.readOnly) return "read_only";
    const settings = loaded.settings;
    const bindings = settings.plugins?.accountSources ?? [];
    const binding = bindings.find((entry) => entry.plugin === expected.plugin && entry.source === expected.source);
    if (!isCurrent() || !binding || binding.descriptorHash !== expected.descriptorHash || binding.connectionId !== expected.connectionId || binding.accountId !== expected.accountId || catalog.accountId !== binding.accountId) return "stale";
    const connection = settings.provider.connections.find((entry) => entry.id === binding.connectionId);
    if (!connection) return "stale";
    const custom = settings.provider.custom?.find((entry) => entry.id === connection.providerId);
    if (!custom || custom.kind !== expected.gatewayKind || !sameUrl(custom.baseUrl, expected.gatewayBaseUrl) || (connection.baseUrl !== undefined && !sameUrl(connection.baseUrl, expected.gatewayBaseUrl)) || settings.provider.connections.filter((entry) => entry.providerId === custom.id).length !== 1 || bindings.filter((entry) => entry.connectionId === connection.id).length !== 1) return "stale";
    const next = reconcileCatalog(custom, connection, binding.ownership, catalog);
    if (JSON.stringify([custom, connection, binding.ownership]) === JSON.stringify([next.custom, next.connection, next.ownership])) return "unchanged";
    const updated: AnycodeSettings = {
      ...settings,
      plugins: { ...settings.plugins, accountSources: bindings.map((entry) => entry === binding ? { ...entry, ownership: next.ownership } : entry) },
      provider: { ...settings.provider, custom: settings.provider.custom?.map((entry) => entry.id === custom.id ? next.custom : entry), connections: settings.provider.connections.map((entry) => entry.id === connection.id ? next.connection : entry) },
    };
    if (!isCurrent()) return "stale";
    await saveSettings(path, updated);
    changedSettings = updated;
    return "changed" as const;
  });
  if (changedSettings) await onMutation?.(changedSettings);
  return result;
}

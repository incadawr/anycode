import { findCatalogEntry } from "@anycode/core/catalog";
import { openCodeGoModelIds } from "@anycode/core/opencode-go";
import { loadSettings, saveSettings, withSettingsFileLock, type FileIoLogger } from "../settings/files.js";
import { modelReasoningReplay, patchModelOverride } from "../shared/model-overrides.js";
import { REASONING_REPLAY_REJECTED, type ReasoningReplayRejection } from "../shared/reasoning-replay.js";
import { automaticGoRoute } from "./go-route.js";

function parseObservation(raw: unknown): ReasoningReplayRejection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["type", "reason", "baseUrl", "model"].includes(key))) return undefined;
  if (value.type !== REASONING_REPLAY_REJECTED || value.reason !== "provider-rejected" || typeof value.model !== "string" || !value.model.trim() || value.model !== value.model.trim() || typeof value.baseUrl !== "string") return undefined;
  try { if (!["https:", "http:"].includes(new URL(value.baseUrl).protocol)) return undefined; } catch { return undefined; }
  return value as unknown as ReasoningReplayRejection;
}

/** Only main supplies deps and the emitting tab's pinned connection id. */
export async function recordReasoningReplayRejection(
  deps: { settingsPath: string; logger?: FileIoLogger }, connectionId: string, raw: unknown,
): Promise<boolean> {
  const event = parseObservation(raw);
  if (!event) return false;
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) return false;
    const settings = loaded.settings;
    const connection = settings.provider.connections.find(item => item.id === connectionId);
    if (!connection || modelReasoningReplay(connection, event.model) !== undefined) return false;
    const custom = connection.providerId.startsWith("custom:")
      ? settings.provider.custom?.find(item => item.id === connection.providerId) : undefined;
    const catalog = findCatalogEntry(connection.providerId);
    const route = automaticGoRoute(connection, { ANYCODE_MODEL: event.model });
    if (route?.kind === "refusal") return false;
    const models = route ? openCodeGoModelIds(connection.providerId, connection.modelRoutes)
      : [connection.model, ...(connection.models ?? []), ...(custom?.models ?? []), ...(catalog?.models.map(item => item.id) ?? [])];
    if (!models.includes(event.model)) return false;
    const baseUrl = route?.route.baseUrl ?? (connection.providerId.startsWith("custom:")
      ? custom?.baseUrl : connection.baseUrl?.trim() || catalog?.baseUrl);
    if (!baseUrl || baseUrl !== event.baseUrl) return false;
    patchModelOverride(connection, event.model, { reasoningReplayRejection: { reason: event.reason, baseUrl } });
    await saveSettings(deps.settingsPath, settings);
    return true;
  });
}

/**
 * TEST-ONLY. Builds a settings v2 `provider` block (TASK.45) from a legacy
 * singleton description, so a fixture can keep expressing intent as
 * `{id, model, ...}` while the persisted shape is the v2
 * `{activeConnectionId, connections[]}`. The single active connection it emits
 * uses a deterministic fixture id and `providerId === ""` for the bare/custom
 * bucket, so `activeProviderView` reads it back byte-for-byte as the former v1
 * singleton.
 *
 * Zero runtime imports (only types) — usable from main/, renderer/, settings/
 * and host/ test bundles alike.
 */

import type {
  ProviderConnection,
  ProviderSettingsV2,
  ProviderTransportId,
  ReasoningEffort,
} from "./settings.js";

/** A legacy-singleton description (the folded model/effort, not the raw `defaults` map). */
export interface SingletonFixture {
  id?: string;
  label?: string;
  model?: string;
  baseUrl?: string;
  transport?: ProviderTransportId;
  reasoningEffort?: ReasoningEffort;
}

/** Deterministic fixture connection id (bare/custom -> `conn-legacy`, else `conn-<providerId>`); kept inline so this fixture stays zero-dep. */
export function fixtureConnectionId(providerId: string | undefined): string {
  return providerId === undefined || providerId === "" || providerId === "custom" ? "conn-legacy" : `conn-${providerId}`;
}

/** One connection object from a singleton description (id defaults to the deterministic fixture id). */
export function connectionFixture(singleton: SingletonFixture & { connectionId?: string }): ProviderConnection {
  const { id, connectionId, label, model, baseUrl, transport, reasoningEffort } = singleton;
  return {
    id: connectionId ?? fixtureConnectionId(id),
    providerId: id ?? "",
    ...(label !== undefined ? { label } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

/**
 * A v2 `provider` block. An empty singleton yields `{connections: []}` (a fresh
 * install — no active connection); otherwise ONE active migrated connection.
 */
export function providerV2(singleton: SingletonFixture = {}): ProviderSettingsV2 {
  const hasConfig =
    singleton.id !== undefined ||
    singleton.label !== undefined ||
    singleton.model !== undefined ||
    singleton.baseUrl !== undefined ||
    singleton.transport !== undefined ||
    singleton.reasoningEffort !== undefined;
  if (!hasConfig) {
    return { connections: [] };
  }
  const connection = connectionFixture(singleton);
  return { activeConnectionId: connection.id, connections: [connection] };
}

/** A v2 `provider` block from explicit connections + an active id (multi-connection fixtures). */
export function providerV2Multi(activeConnectionId: string | undefined, connections: ProviderConnection[]): ProviderSettingsV2 {
  return { ...(activeConnectionId !== undefined ? { activeConnectionId } : {}), connections };
}

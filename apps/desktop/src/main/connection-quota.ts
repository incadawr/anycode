/**
 * Provider-reported quota persistence (Taskana 4090 / TASK.71 follow-up).
 *
 * The host emits `provider_quota` agent events and the renderer paints them
 * into its in-memory settings snapshot live (renderer store, Taskana 4090),
 * but nothing wrote `lastQuota` to disk — the connect card's quota line was
 * lost on reload and on every settings snapshot refresh. This module is the
 * missing main-side half: it receives a quota observation for a TAB, resolves
 * the tab's PINNED connection (main/tabs.ts already binds parentPort messages
 * to `tab.connectionId` — the same targeting rule the renderer fix applied:
 * the quota belongs to THIS tab's key, never to a sibling connection on the
 * same host), and sparse-merges `lastQuota` into that one connection under
 * the settings-file lock.
 *
 * Wiring mirrors the health signal's exact chain (TASK.45 W11): host session
 * → `PROVIDER_QUOTA_EVENT_TYPE` on parentPort → `handleHostMessage`
 * (main/tabs.ts) → `onProviderQuotaEvent(connectionId, event)` dep →
 * `recordConnectionQuota` here. Main is the sole writer of settings.json.
 *
 * Cadence (brief Q3): at most one write per connection per
 * `QUOTA_WRITE_INTERVAL_MS` (30 s), trailing-edge flushed — events inside the
 * window are coalesced and the LATEST value is persisted when the window
 * closes. The renderer keeps its own live in-memory paint (no flicker); this
 * write exists so a fresh app start / snapshot refresh still shows the line.
 *
 * Like `applyConnectionHealthEvent`, this NEVER fires `onMutation` — quota is
 * advisory display data and must not trigger the readiness/host-env/auto-tab
 * cascade a real settings mutation does. Main pushes a lightweight
 * `PROVIDER_QUOTA_CHANGED_CHANNEL` ping after a write lands instead (the
 * `PROVIDER_HEALTH_CHANGED_CHANNEL` precedent), so an already-loaded renderer
 * refreshes its snapshot without waiting for an unrelated mutation.
 */

import type { FileIoLogger } from "../settings/files.js";
import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import type { AnycodeSettings, ProviderConnection } from "../shared/settings.js";
import { PROVIDER_QUOTA_EVENT_TYPE, type ProviderQuotaEvent, type ProviderQuotaWindowWire } from "../shared/provider-quota.js";

/**
 * Minimum spacing between two `lastQuota` writes for the SAME connection
 * (Taskana 4090 brief Q3 cadence ruling). One constant, one line to change.
 */
export const QUOTA_WRITE_INTERVAL_MS = 30_000;

/** Exposed for tests; production callers default to `Date.now`. */
export type NowMs = () => number;

export interface ConnectionQuotaDeps {
  settingsPath: string;
  logger?: FileIoLogger;
  /** Injectable clock (throttle windows + `observedAt`), tests default to `Date.now`. */
  now?: NowMs;
  /**
   * Injectable window length (tests shrink the 30 s to milliseconds so the
   * REAL event loop can fire the trailing flush); production omits it and
   * gets `QUOTA_WRITE_INTERVAL_MS`.
   */
  writeIntervalMs?: number;
}

/**
 * Runtime validation at the untrusted main↔host process boundary (the
 * `normalizeProviderHealthEvent` precedent): `handleHostMessage` casts the
 * parentPort message to `ProviderQuotaEvent` with no shape check, so every
 * number here is re-validated before it can reach settings.json. Anything
 * malformed is dropped whole (returning `undefined`), never coerced — a
 * half-valid quota line is worse than no line.
 */
export function parseProviderQuotaEvent(raw: unknown): ProviderQuotaEvent | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const message = raw as { type?: unknown; quota?: unknown; source?: unknown };
  if (message.type !== PROVIDER_QUOTA_EVENT_TYPE) {
    return undefined;
  }
  const quota = message.quota;
  if (quota === null || typeof quota !== "object") {
    return undefined;
  }
  const { usedPercent, windowDurationMins, resetsAt } = quota as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    return undefined;
  }
  const window: ProviderQuotaWindowWire = { usedPercent };
  if (windowDurationMins !== undefined) {
    if (typeof windowDurationMins !== "number" || !Number.isFinite(windowDurationMins) || windowDurationMins < 0) {
      return undefined;
    }
    window.windowDurationMins = windowDurationMins;
  }
  if (resetsAt !== undefined) {
    // Epoch seconds; anything before 2001-09 is not a real reset time.
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt < 1_000_000_000) {
      return undefined;
    }
    window.resetsAt = resetsAt;
  }
  if (typeof message.source !== "string" || message.source === "") {
    return undefined;
  }
  return { type: PROVIDER_QUOTA_EVENT_TYPE, quota: window, source: message.source };
}

/** The persisted `lastQuota` shape (shared/settings.ts `ProviderConnection`). */
export type LastQuota = NonNullable<ProviderConnection["lastQuota"]>;

/**
 * Sparse merge onto one connection; `undefined` when the connection no longer
 * exists (race-safe no-op — deleted mid-flight). Only `lastQuota` is touched:
 * every sibling field (`model`, `lastHealth`, `models`, …) is carried
 * verbatim. A new observation with absent optional fields never inherits
 * another family's values: the merge is scoped to the SAME header `source`
 * (the renderer fix's rule — a different family must not keep the old
 * family's `resetsAt`/`windowDurationMins`).
 */
export function withConnectionQuota(
  settings: AnycodeSettings,
  connectionId: string,
  quota: ProviderQuotaWindowWire,
  source: string,
  observedAt: string,
): AnycodeSettings | undefined {
  let found = false;
  const connections = settings.provider.connections.map((connection) => {
    if (connection.id !== connectionId) {
      return connection;
    }
    found = true;
    const previous = connection.lastQuota;
    const lastQuota: LastQuota = {
      // Same-source observations merge sparsely (absent fields keep their
      // known values); a different source starts from a clean window.
      ...(previous?.source === source ? previous : {}),
      ...quota,
      observedAt,
      source,
    };
    return { ...connection, lastQuota };
  });
  return found ? { ...settings, provider: { ...settings.provider, connections } } : undefined;
}

interface ThrottleState {
  lastWriteMs: number;
  /** Latest coalesced observation waiting for the trailing window to close. */
  pending?: { quota: ProviderQuotaWindowWire; source: string };
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: boolean;
}

const throttles = new Map<string, ThrottleState>();

/** Test seam: clears all throttle windows (vitest resets modules, but be explicit). */
export function resetConnectionQuotaThrottles(): void {
  for (const state of throttles.values()) {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
    }
  }
  throttles.clear();
}

/**
 * Validates + throttle-gates one raw parentPort payload for `connectionId`.
 * Fire-and-forget by design (called from a message handler that must not
 * await); errors are swallowed into the logger — a quota write must never
 * take anything down with it.
 */
export function handleProviderQuotaMessage(
  deps: ConnectionQuotaDeps,
  connectionId: string,
  raw: unknown,
  onPersisted?: () => void,
): void {
  const event = parseProviderQuotaEvent(raw);
  if (event === undefined) {
    return;
  }
  void recordConnectionQuota(deps, connectionId, event.quota, event.source, onPersisted).catch((error) => {
    deps.logger?.warn?.(`[main] failed to persist connection quota`, error);
  });
}

/**
 * Persists one observation for one connection, at most once per write
 * interval (`QUOTA_WRITE_INTERVAL_MS`, 30 s in production): an event inside
 * the window replaces the pending value (latest wins) and schedules a single
 * trailing flush; the connection's next event after the flush goes straight
 * through. Read-only settings, a since-deleted connection, or a shutdown
 * race resolves `false` (nothing pushed — there is nothing new to reflect).
 */
export async function recordConnectionQuota(
  deps: ConnectionQuotaDeps,
  connectionId: string,
  quota: ProviderQuotaWindowWire,
  source: string,
  onPersisted?: () => void,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const interval = deps.writeIntervalMs ?? QUOTA_WRITE_INTERVAL_MS;
  const state = throttles.get(connectionId) ?? { lastWriteMs: -Infinity };
  throttles.set(connectionId, state);
  const elapsed = now() - state.lastWriteMs;
  if (elapsed < interval) {
    state.pending = { quota, source };
    if (state.timer === undefined) {
      const remaining = interval - elapsed;
      state.timer = setTimeout(() => {
        state.timer = undefined;
        const pending = state.pending;
        state.pending = undefined;
        if (pending === undefined) {
          return;
        }
        void recordConnectionQuota(deps, connectionId, pending.quota, pending.source, onPersisted).catch((error) => {
          deps.logger?.warn?.(`[main] failed to persist connection quota`, error);
        });
      }, remaining);
      state.timer.unref?.();
    }
    return false;
  }
  // A write is already in flight for this connection: coalesce into its
  // trailing edge instead of stacking a second locked write behind it.
  if (state.inFlight) {
    state.pending = { quota, source };
    return false;
  }
  state.inFlight = true;
  try {
    const persisted = await writeQuotaUnderLock(deps, connectionId, quota, source, now);
    if (persisted) {
      onPersisted?.();
    }
    return persisted;
  } finally {
    // Stamped on failure too: a write that keeps throwing (disk full, EACCES)
    // must stay throttled, not retry a locked load+save on every response.
    state.lastWriteMs = now();
    state.inFlight = false;
    const pending = state.pending;
    state.pending = undefined;
    if (pending !== undefined) {
      void recordConnectionQuota(deps, connectionId, pending.quota, pending.source, onPersisted).catch((error) => {
        deps.logger?.warn?.(`[main] failed to persist connection quota`, error);
      });
    }
  }
}

async function writeQuotaUnderLock(
  deps: ConnectionQuotaDeps,
  connectionId: string,
  quota: ProviderQuotaWindowWire,
  source: string,
  now: NowMs,
): Promise<boolean> {
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) {
      return false;
    }
    const updated = withConnectionQuota(
      loaded.settings,
      connectionId,
      quota,
      source,
      new Date(now()).toISOString(),
    );
    if (updated === undefined) {
      return false;
    }
    await saveSettings(deps.settingsPath, updated);
    return true;
  });
}

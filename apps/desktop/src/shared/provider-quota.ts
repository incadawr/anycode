/**
 * Control-plane contract for the host→main provider-quota signal (Taskana
 * 4090 / TASK.71 follow-up). The exact `shared/provider-health.ts` precedent
 * (TASK.45 W11): posted on `process.parentPort` by a CORE-engine host session
 * when the model port yields a `provider_quota` ModelStreamEvent, and matched
 * by `type` in `TabHostManager.handleHostMessage` (main/tabs.ts), which
 * already knows the per-tab pinned connectionId this proc belongs to — the
 * host itself stays connection-agnostic, exactly like the credential broker
 * and the health signal. Main is the only writer of settings.json, so the
 * durable `lastQuota` write (throttled, sparse, under the settings lock —
 * main/connection-quota.ts) lives there; the host never touches disk.
 *
 * VALUE-ONLY module with ZERO imports (same rule as
 * shared/credentials.ts / shared/provider-health.ts), so it is safe for the
 * sandboxed preload, the renderer web bundle, main, AND the host
 * utilityProcess to import. The quota payload is plain JSON (it crossed the
 * structured-clone boundary once already as an AgentEvent member); the numbers
 * are validated at the receiving boundary in main/connection-quota.ts, never
 * trusted by shape alone.
 */

/** parentPort message type: a core host reports a provider quota observation for its live turn. */
export const PROVIDER_QUOTA_EVENT_TYPE = "anycode:provider-quota";

/**
 * The `primary` window of a `ProviderQuotaUpdate` (core provider/quota.ts),
 * inlined as plain JSON — the shared layer must not import the core package.
 * `usedPercent` is 0–100 inclusive and is the only required field; every
 * other member is ABSENT when the provider did not report it (never zero).
 */
export interface ProviderQuotaWindowWire {
  usedPercent: number;
  windowDurationMins?: number;
  /** Epoch SECONDS (the wire convention of CodexRateLimitsWire). */
  resetsAt?: number;
}

/** host → main. `source` is the literal header name that produced the window. */
export interface ProviderQuotaEvent {
  type: typeof PROVIDER_QUOTA_EVENT_TYPE;
  quota: ProviderQuotaWindowWire;
  source: string;
}

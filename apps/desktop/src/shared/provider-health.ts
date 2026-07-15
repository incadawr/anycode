/**
 * Control-plane contract for the host<->main provider-health signal (TASK.45
 * W11). Mirrors the CREDENTIAL_REQUEST_TYPE precedent (shared/credentials.ts):
 * posted on `process.parentPort` by a CORE-engine host session after a model
 * stream event settles (`error` or `finish`); matched by `type` in
 * `TabHostManager.handleHostMessage` (main/tabs.ts), which already knows the
 * per-tab pinned connectionId this proc belongs to — the host itself stays
 * connection-agnostic, exactly like the credential broker.
 *
 * VALUE-ONLY module with ZERO imports, by the exact precedent of
 * shared/credentials.ts, so it is safe for the sandboxed preload, the renderer
 * web bundle, main, AND the host utilityProcess to import.
 */

/** parentPort message type: a core host reports a real request outcome for its live turn. */
export const PROVIDER_HEALTH_EVENT_TYPE = "anycode:provider-health";

/**
 * host -> main. `code` mirrors core's `ProviderFailureCode` (provider/failure.ts)
 * as a plain string — the host relays the classification the core loop's
 * `classifyProviderFailure` already computed (`ModelStreamEvent.safe.code`)
 * VERBATIM; it is never reclassified on the host side (same "plain string, not
 * the provider-layer union" precedent as `WireAgentEvent`'s own `retry.code`).
 * Present only for `kind:"failure"`; main maps it to a `ProviderHealthStatus`.
 */
export interface ProviderHealthEvent {
  type: typeof PROVIDER_HEALTH_EVENT_TYPE;
  kind: "success" | "failure";
  code?: string;
}

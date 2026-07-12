/**
 * Control-plane contract for the host<->main credential broker (design
 * slice-2.5-cut.md §3.3), frozen by task 2.5.1. When a host runs in OAuth mode
 * it asks main for a fresh access token at the start of each model attempt; main
 * answers over the same parentPort channel that already carries the host's other
 * control-plane messages (§3.5 phase-2 is NOT amended — this is slice 2.5's own
 * additive delta). Host is tab-agnostic: main replies to whichever process asked.
 *
 * VALUE-ONLY module with ZERO imports, by the exact precedent of shared/tabs.ts,

 * host (utilityProcess) AND main, so it must never drag zod or the @anycode/core

 * main -> host on the RESPONSE; the request carries no secret.
 */

// ── parentPort message types (host <-> main) ──

/** parentPort message type: host asks main for a fresh credential. */
export const CREDENTIAL_REQUEST_TYPE = "anycode:credential-request";

/** parentPort message type: main answers a credential request. */
export const CREDENTIAL_RESPONSE_TYPE = "anycode:credential-response";

/**
 * host -> main: request a fresh credential. `requestId` correlates the answer;
 * the host does NOT name a provider — main knows the selected provider for the
 * process it spawned (env-at-fork topology, §3.3). Carries no secret.
 */
export interface CredentialRequest {
  type: typeof CREDENTIAL_REQUEST_TYPE;
  requestId: string;
}

/**
 * main -> host: the answer. `apiKey` is the freshly resolved access token / key
 * (present on success); absent when main could not resolve one, so the host
 * falls back to the static env key of its fork (`MainCredentialProvider`, 2.5.3).
 */
export interface CredentialResponse {
  type: typeof CREDENTIAL_RESPONSE_TYPE;
  requestId: string;
  apiKey?: string;
}

// ── non-secret env flag (§3.3) ──

/**
 * Non-secret env var handed to a host fork: `"oauth"` enables host-side
 * credential brokering (the host wires `AiSdkModelPort.resolveApiKey` to ask main
 * per attempt); unset/anything-else keeps the byte-for-byte 2.2 static-key path.
 */
export const ENV_AUTH_MODE = "ANYCODE_AUTH_MODE";

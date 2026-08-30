/**
 * Control-plane contract for the vision-fallback recognizer's live config push
 * (TASK.198 E1, plan §1.2/§6/§7): main recomputes the resolved recognizer
 * endpoint on every settings/provider mutation and pushes a fresh value to
 * every live root core tab's host over the SAME parentPort channel credentials
 * already ride (shared/credentials.ts's CREDENTIAL_RESPONSE_TYPE precedent) —
 * but PUSH-only (main -> host), never a request/response pair: unlike a fresh
 * OAuth token, there is no host-side moment analogous to "the start of a model
 * attempt" to hang a request off — the config can change at any point in a
 * session's lifetime, including while the host is mid-turn (host/session.ts
 * queues the applied config for the next `busy=false`, a later slice).
 *
 * VALUE-ONLY module by the same discipline as shared/credentials.ts/proxy.ts/
 * engines.ts: no zod, no electron, no @anycode/core, so preload/renderer/main/
 * host can all import it. `./settings.js` is the one value import this module
 * takes (same precedent as shared/proxy.ts's and shared/engines.ts's own
 * headers) — it is itself value-import-free.
 */

import type { AnycodeSettings, ProviderTransportId } from "./settings.js";
import { connectionById } from "./settings.js";

// ── parentPort message type (main -> host, PUSH only) ──

/** parentPort message type: main pushes a fresh (or cleared) recognizer endpoint. */
export const RECOGNIZER_CONFIG_CHANGED_TYPE = "anycode:recognizer-config-changed";

/**
 * The resolved recognizer endpoint a host needs to build `ask()` calls
 * (packages/core/src/vision, срез A). Mirrors the five `ANYCODE_RECOGNIZER_*`
 * env vars main's boot-time snapshot carries (main/host-env.ts) — same shape,
 * two delivery paths (fork env vs. live push), so a host's live-update handler
 * (срез C) builds the SAME core `RecognizerEndpoint` from either. `transport`/
 * `baseUrl`/`apiKey`/`providerName` are all optional because a connection may
 * leave any of them unset (a bare/custom connection has no `providerName`, a
 * keyless local server has no `apiKey`); `model` is the user's explicit choice
 * (`settings.recognizer.modelId`) and is always present when `endpoint` itself
 * is non-null.
 */
export interface RecognizerWireConfig {
  transport?: ProviderTransportId;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  providerName?: string;
}

/**
 * main -> host: the live config push. `endpoint: null` means the fallback is
 * disabled (no `settings.recognizer`, a dangling `connectionId`, or an OAuth
 * connection — none resolve in slice 1) — the host must deregister
 * `InspectImage` and go back to rejecting a blind model's image turns, exactly
 * today's behaviour.
 */
export interface RecognizerConfigChanged {
  type: typeof RECOGNIZER_CONFIG_CHANGED_TYPE;
  endpoint: RecognizerWireConfig | null;
}

// ── fingerprint (finding #7 — a resolved secret must never ride an unrelated
// mutation's wire) ──

/**
 * The identity a live push compares against the last one sent (plan §1.2/§7):
 * `connectionId`+`modelId` are the user's OWN `settings.recognizer` selection;
 * `baseUrl`+`transport` are what that selection CURRENTLY resolves to (a
 * connection's baseUrl/transport can change out from under a stable
 * connectionId, e.g. the user edits the connection's endpoint). Comparing all
 * four — not just the settings pair — is what stops a live push firing on an
 * UNRELATED mutation that happens to touch a different field of an unrelated
 * connection, while still catching the ones that matter. Never carries the
 * decrypted API key: computing this fingerprint costs no vault read, which is
 * what lets "did anything change" be answered before any secret is resolved.
 */
export interface RecognizerFingerprint {
  connectionId: string;
  modelId: string;
  baseUrl?: string;
  transport?: ProviderTransportId;
}

/** The fingerprint of `settings.recognizer` right now, or undefined when the fallback names no connection / a dangling one. */
export function recognizerFingerprint(settings: AnycodeSettings): RecognizerFingerprint | undefined {
  const setting = settings.recognizer;
  if (setting === undefined) {
    return undefined;
  }
  const connection = connectionById(settings, setting.connectionId);
  if (connection === undefined) {
    return undefined;
  }
  return {
    connectionId: setting.connectionId,
    modelId: setting.modelId,
    baseUrl: connection.baseUrl,
    transport: connection.transport,
  };
}

/** Structural equality of two fingerprints (undefined counts as its own value — "off" never equals "on"). */
export function recognizerFingerprintsEqual(
  a: RecognizerFingerprint | undefined,
  b: RecognizerFingerprint | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === undefined && b === undefined;
  }
  return (
    a.connectionId === b.connectionId &&
    a.modelId === b.modelId &&
    a.baseUrl === b.baseUrl &&
    a.transport === b.transport
  );
}

// ── the Vision panel's "Probe" button (TASK.198 E2) ──

/** Renderer -> main invoke channel for the recognizer probe. */
export const RECOGNIZER_PROBE_CHANNEL = "anycode:recognizer-probe";

/**
 * The candidate a user is trying out on the Vision panel BEFORE it is
 * necessarily saved to `settings.recognizer` — the probe resolves this pair
 * through the exact same production ladder (`resolveRecognizerConfig`)
 * `settings.recognizer` itself would go through, on a shallow settings copy
 * with `recognizer` overridden to this value, so "does this connection/model
 * pair actually work" can be answered before the user commits to it.
 */
export interface RecognizerProbeRequest {
  connectionId: string;
  modelId: string;
}

/**
 * Machine-readable cause of a failed probe (main/recognizer-probe.ts owns the
 * classification). Each maps to one of the honesty rules the probe exists to
 * enforce: `not_configured` covers every way `resolveRecognizerConfig` itself
 * refuses (no `settings.recognizer`, a dangling connectionId, an oauth
 * connection, or a still-blank resolved address) — the probe never spawns a
 * child for any of these. The rest classify the CHILD's own outcome.
 */
export type RecognizerProbeFailureReason =
  | "not_configured"
  | "spawn_failed"
  | "timeout"
  | "bad_output"
  | "provider_error"
  | "empty_response";

/**
 * The probe's one result, always resolved and never thrown across the invoke
 * boundary (design rule: an IPC handler must never reject with the model
 * provider's own error string, which can carry the API key). `message` is
 * always safe to render verbatim — every secret is scrubbed before this
 * shape is built.
 */
export type RecognizerProbeResult = { ok: true; text: string } | { ok: false; reason: RecognizerProbeFailureReason; message: string };

// ── the Vision panel's "off" switch (TASK.198) ──

/**
 * Renderer -> main invoke channel that sets or clears `settings.recognizer`.
 * A SEPARATE channel from `settings-set` on purpose: `settings/schema.ts`'s
 * `mergeSettings` deep-merges a patch via `deepMerge`, whose loop reads
 * `if (value === undefined) continue;` — an `undefined` patch value is
 * SKIPPED, never used to delete a base key. `setPatch({ recognizer: undefined })`
 * through the generic path is therefore a silent no-op: it can turn the
 * fallback ON but can never turn it OFF. `recognizer: null` on THIS channel is
 * the explicit "delete `settings.recognizer`" instruction the generic merge
 * has no way to express — the same shape `ProxyRefPicker.tsx`'s
 * `proxyRefSetPayload` already uses for "clear this scope's ref back to
 * inherit" (`{ scope, ref: null }`).
 */
export const RECOGNIZER_SET_CHANNEL = "anycode:recognizer-set";

/**
 * The recognizer-set request. `recognizer: null` deletes `settings.recognizer`
 * (the fallback is off); a `{connectionId, modelId}` pair sets it —
 * main/settings-ipc.ts's `handleRecognizerSet` validates `connectionId`
 * against the live `provider.connections` list and refuses a blank/whitespace
 * `modelId` before persisting either.
 */
export interface RecognizerSetRequest {
  recognizer: { connectionId: string; modelId: string } | null;
}

/**
 * priming the pin of a NEW session opened on a non-active
 * connection (Sessions API `create_session` with `model`). The tab's fork env
 * comes from a per-connection cache that is fail-closed on a miss (tabs.ts
 * refuses to spawn -> crash_looped), so a non-active pin MUST be primed (and
 * reserved against a concurrent delete) before `createTab`. The resume path does
 * the same through `resolveResumePin`; this wraps it for the new-session path.
 */

import { classifyEngineFailure } from "../host/safe-failure.js";

export type ResumePinResult =
  | { ok: true; connectionId?: string; release: () => void }
  | { ok: false; connectionId: string };

export type NewSessionPin =
  | { ok: true; release: () => void }
  | { ok: false; reason: "not_ready" | "connection_missing"; connectionId?: string; detail?: string };

/**
 * A safe, actionable reason for a priming failure. The raw error may be a vault
 * read failure or a provider/network probe — `classifyEngineFailure` reduces it
 * to a fixed-vocabulary sentence that never echoes credentials, URLs or raw
 * provider bodies. Prefixed with the connection so the Sessions API refusal can
 * tell the caller this is a connection-preparation problem, not a sign-in or
 * tab-limit problem.
 */
function primingFailureDetail(connectionId: string, error: unknown): string {
  return `could not prepare connection ${connectionId}: ${classifyEngineFailure(error).message}`;
}

export async function primeNewSessionPin(
  connectionId: string | undefined,
  activeConnectionId: string | undefined,
  resolveResumePin: (meta: { connectionId?: string }) => Promise<ResumePinResult>,
): Promise<NewSessionPin> {
  // Every selected connection needs a reservation and a cached environment.
  void activeConnectionId;
  if (connectionId === undefined) {
    return { ok: true, release: () => {} };
  }
  try {
    const pinned = await resolveResumePin({ connectionId });
    if (!pinned.ok) return { ok: false, reason: "connection_missing", connectionId: pinned.connectionId };
    return { ok: true, release: pinned.release };
  } catch (error) {
    return { ok: false, reason: "not_ready", connectionId, detail: primingFailureDetail(connectionId, error) };
  }
}

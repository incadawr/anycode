
/** Main-authored boot capability, consumed before host subprocesses start. */
export const NATIVE_SESSIONS_ENV = "ANYCODE_NATIVE_SESSIONS_ENABLED";

export function takeNativeSessionsCarrier(env: Record<string, string | undefined>): boolean {
  const enabled = env[NATIVE_SESSIONS_ENV] === "1";
  delete env[NATIVE_SESSIONS_ENV];
  return enabled;
}

export { parseSessionPeerRequest, parseSessionPeerResponse } from "@anycode/core";
export type { SessionPeerRequest, SessionPeerCall, SessionPeerResponse } from "@anycode/core";

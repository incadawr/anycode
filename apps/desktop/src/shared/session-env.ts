/**
 * Environment that a session's tools (Bash, hooks, the terminal, engine
 * processes) see so they can identify the session they run for. Value-only,
 * zero imports: main stamps these into the host fork env, the host falls back
 * to them for a bare boot, and the engine allowlists pass them through.
 *
 * `ANYCODE_SESSION_ID` is the same string the communication API reports as
 * `sessionId` (`list_sessions`). The workspace key is deliberately NOT
 * `ANYCODE_WORKSPACE`: that name is the Electron launch directive that opens a
 * workspace, and a nested `anycode` started from a tool's Bash must not open it.
 */

export const ENV_SESSION_ID = "ANYCODE_SESSION_ID";
export const ENV_SESSION_WORKSPACE = "ANYCODE_SESSION_WORKSPACE";
/** The pair an engine child allowlist forwards when present (and nothing else from ANYCODE_*). */
export const SESSION_TOOL_ENV_KEYS = [ENV_SESSION_ID, ENV_SESSION_WORKSPACE] as const;

/** The two keys for one session; an empty value is omitted, never stamped as "". */
export function sessionToolEnv(sessionId: string, workspace: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (sessionId !== "") out[ENV_SESSION_ID] = sessionId;
  if (workspace !== "") out[ENV_SESSION_WORKSPACE] = workspace;
  return out;
}

/** Fills the two keys only where absent (`??=`); never overrides an existing value. */
export function applySessionToolEnv(
  env: Record<string, string | undefined>,
  sessionId: string,
  workspace: string,
): void {
  const stamp = sessionToolEnv(sessionId, workspace);
  for (const [key, value] of Object.entries(stamp)) {
    env[key] ??= value;
  }
}

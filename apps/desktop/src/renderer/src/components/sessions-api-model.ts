/**
 * Pure view-model for the Settings → Sessions API pane and the per-tab switch
 * (Taskana 4747). Labels, the status chip, button enablement, port parsing and
 * the mutation-refusal wording live here so they are unit-testable without a DOM.
 * Everything rendered is PLAIN TEXT; nothing here carries a token or a path that
 * the renderer did not already receive from main.
 */
import type { CommunicationHandleResult, CommunicationMutationReason, CommunicationStatus } from "../../../shared/communication-config.js";

export const SESSIONS_API_PANE_ID = "sessions-api" as const;
export const SESSIONS_API_LABEL = "Sessions API";
/** The Settings header subtitle (printed once; the pane body does not repeat it). */
export const SESSIONS_API_DESCRIPTION = "Let external agents (Claude Code, Codex, scripts) read and message the sessions you choose. Local only.";
export const SESSIONS_API_ENABLE_LABEL = "Allow external agents";
export const SESSIONS_API_ENV_NOTE = "Controlled by ANYCODE_COMMUNICATION_CONFIG";
export const SESSIONS_API_REGENERATE_CONFIRM =
  "Existing clients keep working only until they next read the discovery file; connected clients are dropped. " +
  "After regenerating, restart the external client's MCP connection (a running adapter keeps the old token).";
export const SESSIONS_API_REGENERATE_HINT = "Disconnects running clients; copy the config again afterwards.";
export const SESSIONS_API_PORT_HINT = "Empty = random free port.";
export const SESSIONS_API_NODE_HINT = "Needs Node 22+ where the agent runs.";
/** The one-line footer under the pane. */
export const SESSIONS_API_FOOTER =
  "The token is stored only in a private file on this computer and is never shown here. Anyone who can read that file can message shared sessions.";
/** The one-line folder hint; the full exact-folder rule is kept as the field's tooltip. */
export const SESSIONS_API_FOLDER_HINT = "Empty = any folder; only sessions you switch on are shared.";
export const SESSIONS_API_FOLDER_NOTE =
  "Optional. When empty, only the sessions you switch on are shared. When set, a session must also be inside one of these exact folders (subfolders are not included; symlinks are resolved).";
/** The mark on a listed folder that is not on disk right now (a danger chip). */
export const SESSIONS_API_FOLDER_MISSING_LABEL = "Missing on disk";
/** One plain-text sentence under the chip: what the mark means for the user. */
export const SESSIONS_API_FOLDER_MISSING_NOTE = "This folder grants nothing until the folder is back; agents calling with it get folder_not_found. It is allowed again automatically once it exists — no restart needed.";

/** The Advanced row that lists projects where agents may open tasks (view, plus a Turn off action; turning one on is the sidebar project menu). */
export const SESSIONS_API_AGENT_PROJECTS_LABEL = "Agents may open tasks here";
/** The row's STATE label: every listed project is ON (main lists only allowed ones). */
export const SESSIONS_API_AGENT_PROJECT_ON = "On";
/** The row's ACTION label: the listed project is on, so the button turns it off (never a bare "Off", which reads as state). */
export const SESSIONS_API_AGENT_PROJECT_TURN_OFF = "Turn off";
export const SESSIONS_API_AGENT_PROJECTS_EMPTY = "No project allows agents to open tasks yet. Use the project ⋯ menu in the sidebar.";
export const SESSIONS_API_AGENT_PROJECTS_HINT = "Off by default. Turn one on in the sidebar project ⋯ menu; trusted folders only.";
/**
 * The step-1 hint (audit D9): says WHERE a session is switched on (the
 * session's own ⋯ environment menu) before the live count, so the pane
 * explains per-session sharing instead of only listing "Currently shared: 4".
 */
export const SESSIONS_API_SHARE_HINT =
  "Open a session's ⋯ environment menu and turn on Sessions API; only sessions you switch on are shared. Currently shared: {count}.";

export type SessionsApiTone = "ok" | "danger" | "muted";

/**
 * Renders the status chip text: `Listening · 127.0.0.1:PORT · N shared` / `Off` /
 * `Error: …` / `Controlled by environment`.
 */
export function sessionsApiStatusLine(status: CommunicationStatus, envControlled: boolean): string {
  if (envControlled || status.state === "env") return "Controlled by environment";
  if (status.state === "listening") return `Listening · 127.0.0.1:${status.port ?? ""} · ${status.sessions} shared`;
  if (status.state === "error") return `Error: ${errorDetailText(status.detail)}`;
  return "Off";
}

/** The chip tone: green when listening, danger on error, muted otherwise. */
export function sessionsApiStatusTone(status: CommunicationStatus, envControlled: boolean): SessionsApiTone {
  if (envControlled || status.state === "env" || status.state === "off") return "muted";
  if (status.state === "listening") return "ok";
  return "danger";
}

function errorDetailText(detail: CommunicationStatus["detail"]): string {
  switch (detail) {
    case "port in use": return "the port is already in use; choose another port.";
    case "folder not found": return "a folder in the list is no longer available; remove it or re-add it.";
    case "host not ready": return "the app is still starting; try again in a moment.";
    default: return "the server could not start. Check the app log.";
  }
}

/** Copy buttons are enabled only when the server is actually listening (and not env-controlled). */
export function copyConfigEnabled(status: CommunicationStatus, envControlled: boolean): boolean {
  return !envControlled && status.state === "listening";
}

/** Regenerate needs a running settings-mode server. */
export function regenerateEnabled(status: CommunicationStatus, envControlled: boolean): boolean {
  return !envControlled && status.state === "listening";
}

/** Toggles, folder edits and the port field are read-only under the env override. */
export function settingsEditable(envControlled: boolean): boolean {
  return !envControlled;
}

/** Parses the port field: blank = random (null); otherwise an integer 0..65535. Returns undefined when invalid. */
export function parsePortInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 0 && value <= 65535 ? value : undefined;
}

export function portFieldValue(port: number | null): string {
  return port === null ? "" : String(port);
}

/** Maps a refused mutation to the sentence the pane shows. */
export function mutationRefusalText(reason: CommunicationMutationReason): string {
  switch (reason) {
    case "read_only": return "Settings are read-only (saved by a newer AnyCode).";
    case "invalid": return "That value is not valid.";
    case "io_error": return "The settings could not be saved or the folder could not be read.";
    case "env_controlled": return SESSIONS_API_ENV_NOTE + ".";
    case "cancelled": return "";
    case "not_a_directory": return "That path is not a folder.";
    case "duplicate": return "That folder is already in the list.";
    case "too_many": return "You can add at most 20 folders.";
    case "not_found": return "That session is no longer open.";
    case "not_running": return "The Sessions API is not listening.";
    default: return "The change could not be made.";
  }
}

/** Per-tab switch wording: a short row title plus the state on its secondary line. */
export const SESSION_SWITCH_TITLE = "Sessions API";

export function sessionSwitchDetail(enabled: boolean): string {
  return enabled ? "Shared with external agents" : "Not shared";
}

export function sessionSwitchDisabledReason(envControlled: boolean, hasTab: boolean): string | null {
  if (envControlled) return SESSIONS_API_ENV_NOTE;
  if (!hasTab) return "Open a session to share it.";
  return null;
}

/** Taskana 4763: per-session External approvals switch (shown only while the session is shared). */
export const SESSION_APPROVALS_ARIA_LABEL = "Allow approving this session's tool requests from outside";
export const SESSION_APPROVALS_NOTE = "Whoever holds the Sessions API token can allow or deny this session's tool requests.";

export function sessionApprovalsLabel(enabled: boolean): string {
  return enabled ? "External approvals on" : "External approvals off";
}

export const SESSION_HANDLE_LABEL = "Handle (optional)";
export const SESSION_HANDLE_PLACEHOLDER = "Name for agents (optional)";
/** The row's secondary line; the full explanation stays on the field's tooltip. */
export const SESSION_HANDLE_DETAIL = "Name external agents see in list_sessions";
/** Tooltip on the handle field: what the name is for. */
export const SESSION_HANDLE_HINT = "A short name external agents see in list_sessions to find this session, e.g. build-bot. Leave empty to show only the session id.";

/** The inline error under the handle field (plain text). `null` = nothing to show. */
export function handleErrorText(reason: Extract<CommunicationHandleResult, { ok: false }>["reason"] | undefined): string | null {
  switch (reason) {
    case "invalid": return "Use lowercase letters, digits and - _ . @, up to 64.";
    case "duplicate": return "Another live session already uses this handle.";
    case "unknown_tab": return "That session is no longer open.";
    case "io_error": return "The handle could not be saved.";
    default: return null;
  }
}

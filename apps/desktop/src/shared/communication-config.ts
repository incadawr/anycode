/**
 * Sessions API (Taskana 4747) control-plane contract: the channels and the
 * value-only types shared by main (main/communication-ipc.ts) and the renderer
 * (SettingsScreen → Sessions API pane). Renderer-safe by construction: no type
 * here carries the bearer token, the discovery-file path, or any filesystem path
 * the renderer did not already choose. Folders enter only through the native
 * dialog owned by main.
 */

export const COMMUNICATION_GET_CHANNEL = "anycode:communication-get";
export const COMMUNICATION_SET_ENABLED_CHANNEL = "anycode:communication-set-enabled";
export const COMMUNICATION_SET_PORT_CHANNEL = "anycode:communication-set-port";
export const COMMUNICATION_ADD_WORKSPACE_CHANNEL = "anycode:communication-add-workspace";
export const COMMUNICATION_REMOVE_WORKSPACE_CHANNEL = "anycode:communication-remove-workspace";
export const COMMUNICATION_REGENERATE_TOKEN_CHANNEL = "anycode:communication-regenerate-token";
export const COMMUNICATION_COPY_CONFIG_CHANNEL = "anycode:communication-copy-config";
export const COMMUNICATION_SET_DEFAULT_ACCESS_CHANNEL = "anycode:communication-set-default-access";
export const COMMUNICATION_SET_SESSION_ACCESS_CHANNEL = "anycode:communication-set-session-access";
export const COMMUNICATION_SET_SESSION_HANDLE_CHANNEL = "anycode:communication-set-session-handle";
/** Taskana 4763: the per-session External approvals switch. Writable ONLY from this channel (the renderer's trusted UI). */
export const COMMUNICATION_SET_SESSION_APPROVALS_CHANNEL = "anycode:communication-set-session-approvals";
/**
 * Taskana 4768: the per-project "Allow agents to open tasks here" switch. The
 * sidebar sends its workspace identity (like deleteSessionsOlder); main
 * canonicalises. Settings lists main-owned exact keys and can only turn them Off.
 */
export const COMMUNICATION_AGENT_PROJECTS_LIST_CHANNEL = "anycode:communication-agent-projects-list";
export const COMMUNICATION_AGENT_PROJECTS_GET_CHANNEL = "anycode:communication-agent-projects-get";
export const COMMUNICATION_AGENT_PROJECTS_SET_CHANNEL = "anycode:communication-agent-projects-set";
export const COMMUNICATION_AGENT_PROJECTS_OFF_CHANNEL = "anycode:communication-agent-projects-off";

/** Hard cap on the optional outer folder boundary. */
export const COMMUNICATION_MAX_WORKSPACES = 20;

/** Renderer-safe status of the running (or refused) server. Never the token, never the discovery path. */
export interface CommunicationStatus {
  state: "off" | "listening" | "env" | "error";
  url?: string;
  port?: number;
  /** Count of optional outer folder boundaries (0 = no folder restriction). */
  workspaces: number;
  /** Count of sessions currently switched on. */
  sessions: number;
  reason?: "start_failed";
  detail?: "port in use" | "folder not found" | "could not start" | "host not ready";
}

/** The Settings → Sessions API view. `tabs` lists root tabs by tabId only (no session ids, no paths); `handle` appears only when one is set. */
export interface CommunicationView {
  enabled: boolean;
  workspaces: string[];
  /**
   * Listed folders that are not on disk right now (deleted, renamed, an unmounted
   * drive, a removed git worktree). The Sessions API keeps running without them,
   * but each one grants nothing until the folder is back — the pane marks them so
   * the user sees why a folder refuses with folder_not_found. Recomputed on every
   * view: an empty array once every folder resolves again.
   */
  missingWorkspaces: string[];
  port: number | null;
  defaultSessionAccess: "off" | "on";
  status: CommunicationStatus;
  /** `approvals` is the per-session External approvals switch (Taskana 4763); always false while `enabled` is false. */
  tabs: Array<{ tabId: string; enabled: boolean; approvals: boolean; handle?: string }>;
  /** Taskana 4768: projects where agents may open tasks. `key` is the exact stored canonical key (a lookup key for Off, never a new path). */
  agentProjects: Array<{ key: string; name: string; displayPath: string }>;
}

export type AgentProjectsGetResult = { ok: true; enabled: boolean } | { ok: false; reason: "invalid" };
export type AgentProjectsListResult = { ok: true; projects: CommunicationView["agentProjects"] } | { ok: false; reason: "invalid" };

export type CommunicationMutationReason =
  | "read_only"
  | "invalid"
  | "io_error"
  | "env_controlled"
  | "cancelled"
  | "not_a_directory"
  | "duplicate"
  | "too_many"
  | "not_found"
  | "not_running";

export type CommunicationGetResult = { ok: true; view: CommunicationView; envControlled: boolean } | { ok: false; reason: "invalid" };
export type CommunicationMutationResult = { ok: true; view: CommunicationView } | { ok: false; reason: CommunicationMutationReason };
export type CommunicationRegenerateResult = { ok: true; view: CommunicationView } | { ok: false; reason: CommunicationMutationReason };
/** Session handle write (EnvironmentMenu). `unknown_tab` = no live tab with that id. */
export type CommunicationHandleResult = { ok: true; view: CommunicationView } | { ok: false; reason: "invalid" | "duplicate" | "unknown_tab" | "io_error" };

/** The copy-config clients. `generic` is the bare mcpServers JSON. */
export type CommunicationCopyClient = "claude-code" | "codex" | "generic";
export type CommunicationCopyConfigResult = { ok: true; json: string; note: string } | { ok: false; reason: CommunicationMutationReason | "no_adapter" };

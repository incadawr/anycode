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

/** The Settings → Sessions API view. `tabs` lists root tabs by tabId only (no session ids, no paths). */
export interface CommunicationView {
  enabled: boolean;
  workspaces: string[];
  port: number | null;
  defaultSessionAccess: "off" | "on";
  status: CommunicationStatus;
  tabs: Array<{ tabId: string; enabled: boolean }>;
}

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

/** The copy-config clients. `generic` is the bare mcpServers JSON. */
export type CommunicationCopyClient = "claude-code" | "codex" | "generic";
export type CommunicationCopyConfigResult = { ok: true; json: string; note: string } | { ok: false; reason: CommunicationMutationReason | "no_adapter" };

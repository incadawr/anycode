/**

 * concerns:
 *
 * 1. Port/host-exited forwarding (unchanged MVP mechanism): contextBridge cannot
 *    carry a MessagePort, so the documented Electron pattern is to receive it on
 *    the classic ipcRenderer channel and re-post it via window.postMessage with
 *    the transferred ports; the renderer picks it up from MessageEvent.ports.
 *    Both envelopes now carry a { tabId } routing key (§3.1); the port envelope
 *    also carries { workspace }. Preload re-stamps the `type` and re-posts.
 *
 * 2. Tab control-plane invoke-API (Phase-2 §3.2, NEW): the FIRST contextBridge
 *    surface — `window.anycode` with three thin ipcRenderer.invoke wrappers over

 *    no secrets, no arbitrary channels cross the bridge — only these three.
 *
 * Sandboxed CJS build — nothing else belongs here.
 */
import { contextBridge, ipcRenderer } from "electron";
import { HOST_EXITED_ENVELOPE_TYPE, PORT_ENVELOPE_TYPE } from "../shared/envelopes.js";
import {
  MCP_CONFIG_DELETE_CHANNEL,
  MCP_CONFIG_GET_CHANNEL,
  MCP_CONFIG_PROMOTE_COMPAT_CHANNEL,
  MCP_CONFIG_SET_ENABLED_CHANNEL,
  MCP_CONFIG_UPSERT_CHANNEL,
  MCP_IMPORT_APPLY_CHANNEL,
  MCP_IMPORT_SCAN_CHANNEL,
} from "../shared/mcp-config.js";
import {
  SKILLS_CREATE_CHANNEL,
  SKILLS_DELETE_CHANNEL,
  SKILLS_IMPORT_APPLY_CHANNEL,
  SKILLS_IMPORT_SCAN_CHANNEL,
  SKILLS_LIST_CHANNEL,
  SKILLS_REVEAL_CHANNEL,
  SKILLS_SET_ENABLED_CHANNEL,
} from "../shared/skills-config.js";
import {
  SUBAGENTS_CREATE_CHANNEL,
  SUBAGENTS_DELETE_CHANNEL,
  SUBAGENTS_LIST_CHANNEL,
  SUBAGENTS_PREVIEW_CHANNEL,
  SUBAGENTS_READ_CHANNEL,
  SUBAGENTS_REVEAL_CHANNEL,
  SUBAGENTS_SAVE_CHANNEL,
} from "../shared/subagents-config.js";
import type {
  McpConfigDeleteRequest,
  McpConfigGetRequest,
  McpConfigMutationResult,
  McpConfigPromoteCompatRequest,
  McpConfigSetEnabledRequest,
  McpConfigSnapshot,
  McpConfigUpsertRequest,
  McpImportApplyRequest,
  McpImportApplyResult,
  McpImportScanRequest,
  McpImportScanResult,
} from "../shared/mcp-config.js";
import { ENGINES_LIST_CHANNEL, type AvailableEngines } from "../shared/tabs.js";
import type {
  SkillsCreateRequest,
  SkillsDeleteRequest,
  SkillsImportApplyRequest,
  SkillsImportApplyResult,
  SkillsImportScanRequest,
  SkillsImportScanResult,
  SkillsListRequest,
  SkillsMutationResult,
  SkillsRevealRequest,
  SkillsRevealResult,
  SkillsSetEnabledRequest,
  SkillsSnapshot,
} from "../shared/skills-config.js";
import type {
  SubagentReadResult,
  SubagentsCreateRequest,
  SubagentsDeleteRequest,
  SubagentsListRequest,
  SubagentsMutationResult,
  SubagentsPreviewRequest,
  SubagentsPreviewResult,
  SubagentsReadRequest,
  SubagentsRevealRequest,
  SubagentsRevealResult,
  SubagentsSaveRequest,
  SubagentsSnapshot,
} from "../shared/subagents-config.js";
import {
  PROFILE_REVEAL_DIR_CHANNEL,
  PROFILE_STATS_GET_CHANNEL,
  PROFILE_TELEMETRY_SET_CHANNEL,
} from "../shared/profile-config.js";
import type {
  ProfileRevealDirResult,
  ProfileStatsResult,
  ProfileTelemetrySetRequest,
  ProfileTelemetrySetResult,
} from "../shared/profile-config.js";
import { TERMINAL_PORT_ENVELOPE_TYPE, type TerminalPortEnvelope } from "../shared/terminal.js";
import {
  OAUTH_CANCEL_CHANNEL,
  OAUTH_START_CHANNEL,
  PERMISSION_RULE_ADD_CHANNEL,
  SECRET_CLEAR_CHANNEL,
  SECRET_SET_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
} from "../shared/settings.js";
import type {
  OAuthStartResult,
  PermissionRuleAddRequest,
  SecretKey,
  SettingsMutationResult,
  SettingsPatch,
  SettingsSnapshot,
} from "../shared/settings.js";
import {
  SESSIONS_LIST_CHANNEL,
  TAB_CLOSE_CHANNEL,
  TAB_CREATE_CHANNEL,
  WORKSPACE_PICK_CHANNEL,
} from "../shared/tabs.js";
import type {
  CloseTabResult,
  CreateTabRequest,
  CreateTabResult,
  SessionSummary,
  WorkspacePickResult,
} from "../shared/tabs.js";
import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
} from "../shared/updates.js";
import type { UpdateActionResult, UpdateStatus } from "../shared/updates.js";
import {
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_STATE_CHANNEL,
  WINDOW_STATE_GET_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
} from "../shared/window.js";
import type { DesktopPlatform, WindowState } from "../shared/window.js";

// §3.1: forward the main-side payload as-is. The port envelope carries
// { tabId, workspace }, the host-exited envelope carries { tabId }; preload just
// re-stamps the `type` and re-posts (still window.postMessage, since

ipcRenderer.on(PORT_ENVELOPE_TYPE, (event, payload: { tabId: string; workspace: string }) => {
  window.postMessage(
    { type: PORT_ENVELOPE_TYPE, tabId: payload.tabId, workspace: payload.workspace },
    "*",
    event.ports,
  );
});

ipcRenderer.on(HOST_EXITED_ENVELOPE_TYPE, (_event, payload: { tabId: string }) => {
  window.postMessage({ type: HOST_EXITED_ENVELOPE_TYPE, tabId: payload.tabId }, "*");
});

// Slice 2.4.2 (design §3.4): the term-port envelope, exact copy of the
// PORT_ENVELOPE_TYPE pattern above — contextBridge cannot transfer a
// MessagePort, so forward the { tabId }-keyed payload via window.postMessage
// carrying the transferred term-port. Renderer routing is task 2.4.4.
ipcRenderer.on(TERMINAL_PORT_ENVELOPE_TYPE, (event, payload: { tabId: string }) => {
  window.postMessage(
    { type: TERMINAL_PORT_ENVELOPE_TYPE, tabId: payload.tabId } satisfies TerminalPortEnvelope,
    "*",
    event.ports,
  );
});

// §3.2: the tab invoke-API. Each method is a thin invoke wrapper — main owns the
// zod validation and all lifecycle logic (main/tab-ipc.ts).
//
// Slice 2.2 (design §3, ruling §4.5): `settings.*` — five more thin invoke
// wrappers over the frozen settings channels (main owns validation + all vault

// no ports, no arbitrary channels, no decrypted secret ever crosses back — a
// value only travels in via setSecret.
contextBridge.exposeInMainWorld("anycode", {
  createTab: (req: CreateTabRequest): Promise<CreateTabResult> =>
    ipcRenderer.invoke(TAB_CREATE_CHANNEL, req) as Promise<CreateTabResult>,
  closeTab: (tabId: string): Promise<CloseTabResult> =>
    ipcRenderer.invoke(TAB_CLOSE_CHANNEL, { tabId }) as Promise<CloseTabResult>,
  listSessions: (): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(SESSIONS_LIST_CHANNEL) as Promise<SessionSummary[]>,
  pickWorkspace: (): Promise<WorkspacePickResult> =>
    ipcRenderer.invoke(WORKSPACE_PICK_CHANNEL) as Promise<WorkspacePickResult>,
  listAvailableEngines: (): Promise<AvailableEngines> =>
    ipcRenderer.invoke(ENGINES_LIST_CHANNEL) as Promise<AvailableEngines>,
  settings: {
    get: (): Promise<SettingsSnapshot> =>
      ipcRenderer.invoke(SETTINGS_GET_CHANNEL) as Promise<SettingsSnapshot>,
    set: (patch: SettingsPatch): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(SETTINGS_SET_CHANNEL, patch) as Promise<SettingsMutationResult>,
    setSecret: (key: SecretKey, value: string): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(SECRET_SET_CHANNEL, { key, value }) as Promise<SettingsMutationResult>,
    clearSecret: (key: SecretKey): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(SECRET_CLEAR_CHANNEL, { key }) as Promise<SettingsMutationResult>,
    addRule: (rule: PermissionRuleAddRequest): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(PERMISSION_RULE_ADD_CHANNEL, rule) as Promise<SettingsMutationResult>,
    // Slice 2.5 (design §4.5): OAuth sign-in/cancel — two more thin invoke

    // token ever crosses back (oauthStart resolves with a snapshot whose
    // SecretStatus flips to set:true, never the token itself).
    oauthStart: (providerId: string): Promise<OAuthStartResult> =>
      ipcRenderer.invoke(OAUTH_START_CHANNEL, { providerId }) as Promise<OAuthStartResult>,
    oauthCancel: (providerId: string): Promise<void> =>
      ipcRenderer.invoke(OAUTH_CANCEL_CHANNEL, { providerId }) as Promise<void>,
  },
  // P7.19/F22 W2 (design/slice-P7.19-cut.md §3/§4): `mcpConfig.*` — five more
  // thin invoke wrappers over the MCP config-management channels (main owns


  // crosses the bridge (only tabId + scope + name/entry), and — custody §3 —
  // an env/header VALUE never crosses back in a get/scan response; a value
  // only travels in via upsert/edit `entry` payloads (write-only) or the
  // import-apply consent flag (values copied main-side, foreign file -> ours).
  mcpConfig: {
    get: (req: McpConfigGetRequest = {}): Promise<McpConfigSnapshot> =>
      ipcRenderer.invoke(MCP_CONFIG_GET_CHANNEL, req) as Promise<McpConfigSnapshot>,
    upsert: (req: McpConfigUpsertRequest): Promise<McpConfigMutationResult> =>
      ipcRenderer.invoke(MCP_CONFIG_UPSERT_CHANNEL, req) as Promise<McpConfigMutationResult>,
    delete: (req: McpConfigDeleteRequest): Promise<McpConfigMutationResult> =>
      ipcRenderer.invoke(MCP_CONFIG_DELETE_CHANNEL, req) as Promise<McpConfigMutationResult>,
    setEnabled: (req: McpConfigSetEnabledRequest): Promise<McpConfigMutationResult> =>
      ipcRenderer.invoke(MCP_CONFIG_SET_ENABLED_CHANNEL, req) as Promise<McpConfigMutationResult>,
    promoteCompat: (req: McpConfigPromoteCompatRequest): Promise<McpConfigMutationResult> =>
      ipcRenderer.invoke(MCP_CONFIG_PROMOTE_COMPAT_CHANNEL, req) as Promise<McpConfigMutationResult>,
    importScan: (req: McpImportScanRequest = {}): Promise<McpImportScanResult> =>
      ipcRenderer.invoke(MCP_IMPORT_SCAN_CHANNEL, req) as Promise<McpImportScanResult>,
    importApply: (req: McpImportApplyRequest): Promise<McpImportApplyResult> =>
      ipcRenderer.invoke(MCP_IMPORT_APPLY_CHANNEL, req) as Promise<McpImportApplyResult>,
  },
  // P7.20/F23 W2 (design/slice-P7.20-cut.md §5): `skills.*` — seven thin invoke
  // wrappers over the skills management channels (main owns zod validation +
  // path custody + scope resolution in main/skills-ipc.ts). Same narrow rule

  // tabId + scope + candidate ids for import) — every mutator/reveal resolves
  // the real path main-side from its own fresh scan.
  skills: {
    list: (req: SkillsListRequest = {}): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(SKILLS_LIST_CHANNEL, req) as Promise<SkillsSnapshot>,
    setEnabled: (req: SkillsSetEnabledRequest): Promise<SkillsMutationResult> =>
      ipcRenderer.invoke(SKILLS_SET_ENABLED_CHANNEL, req) as Promise<SkillsMutationResult>,
    delete: (req: SkillsDeleteRequest): Promise<SkillsMutationResult> =>
      ipcRenderer.invoke(SKILLS_DELETE_CHANNEL, req) as Promise<SkillsMutationResult>,
    create: (req: SkillsCreateRequest): Promise<SkillsMutationResult> =>
      ipcRenderer.invoke(SKILLS_CREATE_CHANNEL, req) as Promise<SkillsMutationResult>,
    reveal: (req: SkillsRevealRequest): Promise<SkillsRevealResult> =>
      ipcRenderer.invoke(SKILLS_REVEAL_CHANNEL, req) as Promise<SkillsRevealResult>,
    importScan: (req: SkillsImportScanRequest = {}): Promise<SkillsImportScanResult> =>
      ipcRenderer.invoke(SKILLS_IMPORT_SCAN_CHANNEL, req) as Promise<SkillsImportScanResult>,
    importApply: (req: SkillsImportApplyRequest): Promise<SkillsImportApplyResult> =>
      ipcRenderer.invoke(SKILLS_IMPORT_APPLY_CHANNEL, req) as Promise<SkillsImportApplyResult>,
  },
  // P7.21/F21 W2 (design/slice-P7.21-cut.md §4): `subagents.*` — seven thin
  // invoke wrappers over the subagents editor channels (main owns zod
  // validation + path custody in main/subagents-ipc.ts). Same narrow rule

  // sourceKind (read/save/delete/reveal identity) or tabId + scope + draft
  // (create); preview carries only the draft being edited (no identity).
  subagents: {
    list: (req: SubagentsListRequest = {}): Promise<SubagentsSnapshot> =>
      ipcRenderer.invoke(SUBAGENTS_LIST_CHANNEL, req) as Promise<SubagentsSnapshot>,
    read: (req: SubagentsReadRequest): Promise<SubagentReadResult> =>
      ipcRenderer.invoke(SUBAGENTS_READ_CHANNEL, req) as Promise<SubagentReadResult>,
    save: (req: SubagentsSaveRequest): Promise<SubagentsMutationResult> =>
      ipcRenderer.invoke(SUBAGENTS_SAVE_CHANNEL, req) as Promise<SubagentsMutationResult>,
    create: (req: SubagentsCreateRequest): Promise<SubagentsMutationResult> =>
      ipcRenderer.invoke(SUBAGENTS_CREATE_CHANNEL, req) as Promise<SubagentsMutationResult>,
    delete: (req: SubagentsDeleteRequest): Promise<SubagentsMutationResult> =>
      ipcRenderer.invoke(SUBAGENTS_DELETE_CHANNEL, req) as Promise<SubagentsMutationResult>,
    reveal: (req: SubagentsRevealRequest): Promise<SubagentsRevealResult> =>
      ipcRenderer.invoke(SUBAGENTS_REVEAL_CHANNEL, req) as Promise<SubagentsRevealResult>,
    preview: (req: SubagentsPreviewRequest): Promise<SubagentsPreviewResult> =>
      ipcRenderer.invoke(SUBAGENTS_PREVIEW_CHANNEL, req) as Promise<SubagentsPreviewResult>,
  },
  // P7.22/F19 W2 (design/slice-P7.22-cut.md §2-D5): `profile.*` — three thin
  // invoke wrappers over the Profile-stats channels (main owns zod validation
  // + the user-scope dir resolution in main/profile-ipc.ts). Same narrow rule

  // no argument at all — main resolves the dir itself from its own home +
  // config read; setTelemetry carries only a boolean).
  profile: {
    getStats: (): Promise<ProfileStatsResult> =>
      ipcRenderer.invoke(PROFILE_STATS_GET_CHANNEL) as Promise<ProfileStatsResult>,
    setTelemetry: (enabled: boolean): Promise<ProfileTelemetrySetResult> =>
      ipcRenderer.invoke(PROFILE_TELEMETRY_SET_CHANNEL, { enabled } satisfies ProfileTelemetrySetRequest) as Promise<ProfileTelemetrySetResult>,
    revealDir: (): Promise<ProfileRevealDirResult> =>
      ipcRenderer.invoke(PROFILE_REVEAL_DIR_CHANNEL) as Promise<ProfileRevealDirResult>,
  },
  // Slice 2.6 (design §6): auto-updater — three FIXED invoke wrappers (no

  // status subscription. `onUpdateStatus` is the one callback-shaped surface
  // here: contextBridge proxies the callback itself (not a MessagePort, so
  // this does NOT need the window.postMessage port-forwarding dance above),
  // and returns an unsubscribe that removes the underlying ipcRenderer
  // listener — the standard secure pattern for a push channel across the
  // bridge (never expose raw `ipcRenderer.on` to the renderer).
  updates: {
    check: (): Promise<UpdateActionResult> =>
      ipcRenderer.invoke(UPDATE_CHECK_CHANNEL) as Promise<UpdateActionResult>,
    download: (): Promise<UpdateActionResult> =>
      ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL) as Promise<UpdateActionResult>,
    install: (): Promise<UpdateActionResult> =>
      ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL) as Promise<UpdateActionResult>,
    onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
      function listener(_event: unknown, status: UpdateStatus): void {
        callback(status);
      }
      ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener);
    },
  },
  // Custom titlebar (design/ui-track custom-titlebar §4): the platform the
  // renderer branches its chrome on (clamped to the 3 desktop platforms), plus
  // the caption-button invoke-API. First three take NO argument (main reads only

  // `updates.onUpdateStatus` above — subscribe to the push channel, return an
  // unsubscribe that removes the underlying listener (never expose raw
  // `ipcRenderer.on` to the renderer).
  platform: (["darwin", "win32", "linux"].includes(process.platform)
    ? process.platform
    : "linux") as DesktopPlatform,
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(WINDOW_MINIMIZE_CHANNEL) as Promise<void>,
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke(WINDOW_TOGGLE_MAXIMIZE_CHANNEL) as Promise<void>,
    close: (): Promise<void> => ipcRenderer.invoke(WINDOW_CLOSE_CHANNEL) as Promise<void>,
    getState: (): Promise<WindowState> => ipcRenderer.invoke(WINDOW_STATE_GET_CHANNEL) as Promise<WindowState>,
    onWindowState: (callback: (state: WindowState) => void): (() => void) => {
      function listener(_event: unknown, state: WindowState): void {
        callback(state);
      }
      ipcRenderer.on(WINDOW_STATE_CHANNEL, listener);
      return () => ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, listener);
    },
  },
});

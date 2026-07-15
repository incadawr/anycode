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
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
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
  CONNECTION_CHECK_CHANNEL,
  CONNECTION_CREATE_CHANNEL,
  CONNECTION_DELETE_CHANNEL,
  CONNECTION_SET_ACTIVE_CHANNEL,
  CONNECTION_UPDATE_CHANNEL,
  OAUTH_CANCEL_CHANNEL,
  OAUTH_START_CHANNEL,
  PERMISSION_RULE_ADD_CHANNEL,
  SECRET_CLEAR_CHANNEL,
  SECRET_SET_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
} from "../shared/settings.js";
import type {
  ConnectionCheckRequest,
  ConnectionCreateRequest,
  ConnectionDeleteRequest,
  ConnectionSetActiveRequest,
  ConnectionUpdateRequest,
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

// TASK.41 (design/slice-codex-fixes-cut.md §2(g)/§3.8): Codex onboarding
// invoke/push channels. Duplicated literals, not `shared/**` exports — every
// lane in this track froze `shared/**` as read-only after block C0 (design
// cut §4 disjointness rules); main/codex-ipc.ts holds the byte-identical
// source of truth, kept in sync by contract (same "duplicated on purpose"
// precedent as `buildCodexChildEnv` in main/codex-doctor.ts). The result
// shapes below mirror main/codex-ipc.ts's `CodexOnboardingSnapshot` /
// `CodexPickBinaryResult` / `CodexLoginStartResult` — `CodexDoctorReport`
// itself IS a frozen `shared/**` type, imported (never edited) above.
const CODEX_RECHECK_CHANNEL = "anycode:codex-recheck";
const CODEX_PICK_BINARY_CHANNEL = "anycode:codex-pick-binary";
const CODEX_LOGIN_START_CHANNEL = "anycode:codex-login-start";
const CODEX_LOGIN_CANCEL_CHANNEL = "anycode:codex-login-cancel";
const ENGINES_CHANGED_CHANNEL = "anycode:engines-changed";

export interface CodexOnboardingSnapshot {
  report: CodexDoctorReport;
  binaryPath: string | null;
  source: "env" | "settings" | "path" | "common" | "picker" | "none";
  checkedAt: string;
}

export type CodexPickBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

export type CodexLoginStartResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

// §3.1: forward the main-side payload as-is. The port envelope carries
// { tabId, workspace }, the host-exited envelope carries { tabId }; preload just
// re-stamps the `type` and re-posts (still window.postMessage, since

ipcRenderer.on(
  PORT_ENVELOPE_TYPE,
  (event, payload: { tabId: string; workspace: string; connectionId?: string; providerId?: string }) => {
    // TASK.45 W10-FIX F2: forward the additive pin metadata (connectionId/providerId)
    // when present — additive control-plane, no session-stream change. Both fields
    // ride together (main only sets them together) or are absent for an unpinned tab.
    window.postMessage(
      {
        type: PORT_ENVELOPE_TYPE,
        tabId: payload.tabId,
        workspace: payload.workspace,
        ...(payload.connectionId !== undefined && payload.providerId !== undefined
          ? { connectionId: payload.connectionId, providerId: payload.providerId }
          : {}),
      },
      "*",
      event.ports,
    );
  },
);

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
  // TASK.41 (design/slice-codex-fixes-cut.md §5.5): push fired after any
  // change that could flip `listAvailableEngines()`'s result (today: every
  // Codex onboarding step). No payload — listeners re-invoke
  // `listAvailableEngines`/`codex.recheck`, same "thin unsubscribe-returning
  // wrapper" shape as `updates.onUpdateStatus`/`window.onWindowState` below.
  onEnginesChanged: (callback: () => void): (() => void) => {
    function listener(): void {
      callback();
    }
    ipcRenderer.on(ENGINES_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(ENGINES_CHANGED_CHANNEL, listener);
  },
  // TASK.41 (design/slice-codex-fixes-cut.md §2(g)/§5.5): Codex onboarding
  // invoke-API — main owns the discovery ladder, the bounded doctor, and the
  // native login flow (main/codex-ipc.ts). `recheck` re-runs discovery+
  // diagnosis now (used both by a "Recheck" button and by the Settings pane
  // on mount); `pickBinary` opens a native file dialog for the explicit
  // ladder rung; `loginStart`/`loginCancel` drive the native ChatGPT sign-in.
  // No token/credential value ever crosses this bridge in either direction
  // (custody, cut §2(g)) — every result carries only status/version/account
  // type+plan, never a raw auth value.
  codex: {
    recheck: (): Promise<CodexOnboardingSnapshot> =>
      ipcRenderer.invoke(CODEX_RECHECK_CHANNEL) as Promise<CodexOnboardingSnapshot>,
    pickBinary: (): Promise<CodexPickBinaryResult> =>
      ipcRenderer.invoke(CODEX_PICK_BINARY_CHANNEL) as Promise<CodexPickBinaryResult>,
    loginStart: (): Promise<CodexLoginStartResult> =>
      ipcRenderer.invoke(CODEX_LOGIN_START_CHANNEL) as Promise<CodexLoginStartResult>,
    loginCancel: (): Promise<void> =>
      ipcRenderer.invoke(CODEX_LOGIN_CANCEL_CHANNEL) as Promise<void>,
  },
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
    // TASK.45 W10: ModelPill's model/effort write, main-authoritative by connection
    // id (off the v1-patch shim). Returns a fresh snapshot; never carries a secret.
    connectionUpdate: (req: ConnectionUpdateRequest): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(CONNECTION_UPDATE_CHANNEL, req) as Promise<SettingsMutationResult>,
    // TASK.45 W12: the connections grid/drawer's CRUD surface — main-authoritative,
    // additive. No credential ever crosses these (create/update payloads are
    // `.strict()`-refused if they carry one); a value only ever travels via
    // `setSecret`.
    connectionCreate: (req: ConnectionCreateRequest): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(CONNECTION_CREATE_CHANNEL, req) as Promise<SettingsMutationResult>,
    connectionSetActive: (req: ConnectionSetActiveRequest): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(CONNECTION_SET_ACTIVE_CHANNEL, req) as Promise<SettingsMutationResult>,
    connectionDelete: (req: ConnectionDeleteRequest): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(CONNECTION_DELETE_CHANNEL, req) as Promise<SettingsMutationResult>,
    connectionCheck: (req: ConnectionCheckRequest): Promise<SettingsMutationResult> =>
      ipcRenderer.invoke(CONNECTION_CHECK_CHANNEL, req) as Promise<SettingsMutationResult>,
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

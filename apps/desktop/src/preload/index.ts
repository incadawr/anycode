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
  CodexProfileRecord,
  ConnectionCheckRequest,
  ConnectionCreateRequest,
  ConnectionDeleteRequest,
  ConnectionSetActiveRequest,
  ConnectionUpdateRequest,
  CustomProviderRecord,
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
  UPDATE_OPEN_RELEASES_CHANNEL,
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
// TASK.50 (codex-profiles cut §2/§4, amended §A1): the profile control-plane
// channels — main/codex-ipc.ts holds the byte-identical source of truth, same
// duplicated-literal convention as the four channels above.
const CODEX_PROFILE_LIST_CHANNEL = "anycode:codex-profile-list";
const CODEX_PROFILE_CREATE_CHANNEL = "anycode:codex-profile-create";
const CODEX_PROFILE_DELETE_CHANNEL = "anycode:codex-profile-delete";
const CODEX_PROFILE_SET_ACTIVE_CHANNEL = "anycode:codex-profile-set-active";
const CODEX_PROFILE_REPAIR_LINK_CHANNEL = "anycode:codex-profile-repair-link";
// TASK.53 (codex-profiles cut §7, amended §A4): the binary/manifest control
// plane — main/codex-install.ts holds the byte-identical source of truth.
const CODEX_INSTALL_CHANNEL = "anycode:codex-install";
const CODEX_RISK_ACCEPT_CHANNEL = "anycode:codex-risk-accept";
const CODEX_SUPPORT_STATUS_CHANNEL = "anycode:codex-support-status";
const CODEX_MANIFEST_REFRESH_CHANNEL = "anycode:codex-manifest-refresh";
// TASK.45 W11-FIX (W13 live-dogfood finding): `applyConnectionHealthEvent`
// (main/settings-ipc.ts) persists a real request outcome's advisory health
// deliberately WITHOUT firing the normal `onMutation` broadcast (health must
// never trigger the readiness/host-env/auto-tab side effects a real settings
// mutation does) — but with zero push at all, an already-loaded renderer's
// settings-store snapshot never reflected it live; only an UNRELATED settings
// mutation happening to refresh the snapshot ever repainted a tile. Same
// "duplicated on purpose" precedent as `ENGINES_CHANGED_CHANNEL` above
// (main/index.ts holds the byte-identical source of truth).
const PROVIDER_HEALTH_CHANGED_CHANNEL = "anycode:provider-health-changed";
// TASK.54 (cut §9.2/§13.1): the custom OpenAI-compatible model-provider CRUD
// + guarded models-fetch channels — main/provider-ipc.ts holds the
// byte-identical source of truth, same "duplicated on purpose" convention as
// every other channel literal in this file.
const CUSTOM_PROVIDER_CREATE_CHANNEL = "anycode:custom-provider-create";
const CUSTOM_PROVIDER_UPDATE_CHANNEL = "anycode:custom-provider-update";
const CUSTOM_PROVIDER_DELETE_CHANNEL = "anycode:custom-provider-delete";
const CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL = "anycode:custom-provider-fetch-models";

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

// TASK.50 (codex-profiles cut §2/§4, amended §A1): duplicated from
// main/codex-ipc.ts's own `CodexProfilesSnapshot`/`CodexProfileCreateResult`/
// `CodexProfileGuardResult` — same "shared/** froze read-only after C0"
// reasoning as the onboarding shapes above. `CodexProfileRecord` itself IS a
// frozen shared/** type, imported (never edited) above.
export interface CodexProfilesSnapshot {
  profiles: Array<{ profile: CodexProfileRecord; report?: CodexDoctorReport }>;
  activeProfileId: string;
}

export interface CodexProfileCreateRequest {
  label: string;
  authLink?: string;
  linkedHome?: string;
}

export type CodexProfileCreateResult =
  | { ok: true; profile: CodexProfileRecord }
  | { ok: false; reason: "invalid" | "limit" | "failed"; message?: string };

export type CodexProfileGuardResult = { ok: true } | { ok: false; reason: string };

// TASK.53 (codex-profiles cut §7, amended §A4): duplicated from
// main/codex-install.ts's own `CodexInstallControllerResult`/`supportStatus`/
// `refreshManifest` return shapes.
export type CodexInstallResult =
  | { ok: true; version: string; binaryPath: string; report: CodexDoctorReport }
  | { ok: false; error: string };

export interface CodexSupportStatusResult {
  supportedRange: string;
  recommended: string;
  riskAcceptedVersions: string[];
}

export interface CodexManifestRefreshResult {
  source: "network" | "cache" | "bundled";
  supportedRange: string;
}

// TASK.54 (cut §9.2/§13.1): duplicated from main/provider-ipc.ts's own
// `CustomProviderMutationResult`/`FetchModelsOutcome`/handle*-request shapes
// (same "shared/** froze read-only after C0" reasoning as the Codex shapes
// above). `CustomProviderRecord` itself IS a frozen shared/** type, imported
// above.
export type CustomProviderMutationReason = "invalid" | "read_only" | "not_found" | "weak_storage_needs_consent";
export type CustomProviderMutationResult =
  | { ok: true; providers: CustomProviderRecord[] }
  | { ok: false; reason: CustomProviderMutationReason };

export type FetchModelsFailureReason =
  | "invalid_request"
  | "invalid_url"
  | "redirect_blocked"
  | "http_error"
  | "response_too_large"
  | "timeout"
  | "network_error"
  | "invalid_response";

export type FetchModelsOutcome = { ok: true; models: { id: string }[] } | { ok: false; reason: FetchModelsFailureReason };

export interface CustomProviderCreateRequest {
  name: string;
  baseUrl: string;
  kind: CustomProviderRecord["kind"];
  apiKey: string;
  models?: string[];
}

export interface CustomProviderUpdateRequest {
  id: string;
  name?: string;
  baseUrl?: string;
  kind?: CustomProviderRecord["kind"];
  apiKey?: string;
  models?: string[];
}

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
    // `profileId` (TASK.50, cut §4.2): omitted diagnoses/signs into the
    // ACTIVE profile — main's own default, unchanged for every pre-existing
    // caller of these two methods.
    recheck: (profileId?: string): Promise<CodexOnboardingSnapshot> =>
      ipcRenderer.invoke(CODEX_RECHECK_CHANNEL, profileId ? { profileId } : undefined) as Promise<CodexOnboardingSnapshot>,
    pickBinary: (): Promise<CodexPickBinaryResult> =>
      ipcRenderer.invoke(CODEX_PICK_BINARY_CHANNEL) as Promise<CodexPickBinaryResult>,
    loginStart: (profileId?: string): Promise<CodexLoginStartResult> =>
      ipcRenderer.invoke(CODEX_LOGIN_START_CHANNEL, profileId ? { profileId } : undefined) as Promise<CodexLoginStartResult>,
    loginCancel: (): Promise<void> =>
      ipcRenderer.invoke(CODEX_LOGIN_CANCEL_CHANNEL) as Promise<void>,
    // TASK.50 (cut §2/§4): the profile control-plane — settings/fs mutations
    // only, no spawns. No credential value ever crosses this bridge in either
    // direction (custody, cut §4.4) — `listProfiles` carries only the
    // persisted record (id/label/createdAt/linkedHome/authLink/lastCheck)
    // plus the in-memory doctor report (status/version/account/rateLimits),
    // never a token.
    listProfiles: (): Promise<CodexProfilesSnapshot> =>
      ipcRenderer.invoke(CODEX_PROFILE_LIST_CHANNEL) as Promise<CodexProfilesSnapshot>,
    createProfile: (request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult> =>
      ipcRenderer.invoke(CODEX_PROFILE_CREATE_CHANNEL, request) as Promise<CodexProfileCreateResult>,
    deleteProfile: (id: string): Promise<CodexProfileGuardResult> =>
      ipcRenderer.invoke(CODEX_PROFILE_DELETE_CHANNEL, { id }) as Promise<CodexProfileGuardResult>,
    setActiveProfile: (id: string): Promise<CodexProfileGuardResult> =>
      ipcRenderer.invoke(CODEX_PROFILE_SET_ACTIVE_CHANNEL, { id }) as Promise<CodexProfileGuardResult>,
    repairProfileLink: (id: string): Promise<CodexProfileGuardResult> =>
      ipcRenderer.invoke(CODEX_PROFILE_REPAIR_LINK_CHANNEL, { id }) as Promise<CodexProfileGuardResult>,
    // TASK.53 (cut §7, amended §A4): the binary/manifest control plane.
    install: (version?: string): Promise<CodexInstallResult> =>
      ipcRenderer.invoke(CODEX_INSTALL_CHANNEL, version ? { version } : undefined) as Promise<CodexInstallResult>,
    acceptRisk: (version: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(CODEX_RISK_ACCEPT_CHANNEL, { version }) as Promise<{ ok: boolean; error?: string }>,
    supportStatus: (): Promise<CodexSupportStatusResult> =>
      ipcRenderer.invoke(CODEX_SUPPORT_STATUS_CHANNEL) as Promise<CodexSupportStatusResult>,
    manifestRefresh: (): Promise<CodexManifestRefreshResult> =>
      ipcRenderer.invoke(CODEX_MANIFEST_REFRESH_CHANNEL) as Promise<CodexManifestRefreshResult>,
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
    // `connectionId` (TASK.45 W12-FIX §1, additive/optional): scopes the
    // sign-in to one connection; omitted preserves the legacy provider-scoped
    // findOrCreate behavior byte-for-byte.
    oauthStart: (providerId: string, connectionId?: string): Promise<OAuthStartResult> =>
      ipcRenderer.invoke(OAUTH_START_CHANNEL, {
        providerId,
        ...(connectionId ? { connectionId } : {}),
      }) as Promise<OAuthStartResult>,
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
    // TASK.45 W11-FIX (W13 live-dogfood finding): push fired after a real
    // request outcome updates a connection's advisory health (main's
    // `onProviderHealthEvent`). No payload — same "thin unsubscribe-returning
    // wrapper" shape as `onEnginesChanged` above; the listener re-invokes
    // `settings.get()` (settings-store.ts's `subscribeProviderHealth`).
    onProviderHealthChanged: (callback: () => void): (() => void) => {
      function listener(): void {
        callback();
      }
      ipcRenderer.on(PROVIDER_HEALTH_CHANGED_CHANNEL, listener);
      return () => ipcRenderer.removeListener(PROVIDER_HEALTH_CHANGED_CHANNEL, listener);
    },
  },
  // TASK.54 (cut §9.2/§13.1): `customProvider.*` — four thin invoke wrappers
  // over the custom OpenAI-compatible model-provider CRUD + guarded
  // `/v1/models` preview fetch (main owns the URL/redirect/body-cap threat
  // model + vault custody in main/provider-ipc.ts). No credential ever
  // crosses back — every result carries only the persisted record (never a
  // key); `create`/`update` are the only two directions a plaintext key ever
  // travels, main-bound, exactly once per call.
  customProvider: {
    create: (req: CustomProviderCreateRequest): Promise<CustomProviderMutationResult> =>
      ipcRenderer.invoke(CUSTOM_PROVIDER_CREATE_CHANNEL, req) as Promise<CustomProviderMutationResult>,
    update: (req: CustomProviderUpdateRequest): Promise<CustomProviderMutationResult> =>
      ipcRenderer.invoke(CUSTOM_PROVIDER_UPDATE_CHANNEL, req) as Promise<CustomProviderMutationResult>,
    delete: (req: { id: string }): Promise<CustomProviderMutationResult> =>
      ipcRenderer.invoke(CUSTOM_PROVIDER_DELETE_CHANNEL, req) as Promise<CustomProviderMutationResult>,
    fetchModels: (
      req: { id: string } | { baseUrl: string; apiKey?: string; kind?: CustomProviderRecord["kind"] },
    ): Promise<FetchModelsOutcome> =>
      ipcRenderer.invoke(CUSTOM_PROVIDER_FETCH_MODELS_CHANNEL, req) as Promise<FetchModelsOutcome>,
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
    // TASK.47 defect 2: darwin honest-manual-path action — opens the fixed
    // GitHub Releases URL (main-side constant, no argument crosses here).
    openReleasesPage: (): Promise<UpdateActionResult> =>
      ipcRenderer.invoke(UPDATE_OPEN_RELEASES_CHANNEL) as Promise<UpdateActionResult>,
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

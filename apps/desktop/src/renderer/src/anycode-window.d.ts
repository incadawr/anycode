/**
 * Canonical ambient type for preload's contextBridge surface (design
 * phase-2.md §3.2). Task 2.1.4 (App.tsx) and task 2.1.5 (SessionPicker.tsx)
 * each declared their own local `declare global` for `window.anycode` while
 * building in parallel against the same frozen shared/tabs.ts contract —
 * task 2.1.6 dedupes both into this single ambient module, typed directly
 * against the real preload implementation (preload/index.ts).
 *
 * A `.d.ts` with a top-level `import type` is itself a module, so the
 * augmentation must be wrapped in `declare global` + a top-level `export {}`
 * to actually merge into the global `Window` interface.
 */
import type {
  AvailableEngines,
  CloseTabResult,
  CreateTabRequest,
  CreateTabResult,
  SessionSummary,
  WorkspacePickResult,
} from "../../shared/tabs";
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
} from "../../shared/settings";
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
} from "../../shared/mcp-config";
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
} from "../../shared/skills-config";
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
} from "../../shared/subagents-config";
import type {
  ProfileRevealDirResult,
  ProfileStatsResult,
  ProfileTelemetrySetResult,
} from "../../shared/profile-config";
import type { UpdateActionResult, UpdateStatus } from "../../shared/updates";
import type { DesktopPlatform, WindowState } from "../../shared/window";
import type { CodexDoctorReport } from "../../shared/codex-doctor";

// TASK.41 (design/slice-codex-fixes-cut.md §2(g)/§3.8): mirrors the SAME
// duplicated shapes declared in preload/index.ts (that file's own header
// explains why — `shared/**` froze read-only after block C0, so these small
// wire interfaces are kept in sync by contract, the same "duplicated on
// purpose" precedent as every channel-name literal in this codebase that
// crosses a layering boundary shared/** can no longer mediate).
export interface CodexOnboardingSnapshot {
  report: CodexDoctorReport;
  binaryPath: string | null;
  source: "env" | "settings" | "path" | "common" | "installed" | "picker" | "none";
  checkedAt: string;
}

export type CodexPickBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

export type CodexLoginStartResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

// TASK.50 (codex-profiles cut §2/§4, amended §A1): mirrors the SAME
// duplicated shapes declared in preload/index.ts and main/codex-ipc.ts.
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

// TASK.53 (codex-profiles cut §7, amended §A4): mirrors main/codex-install.ts.
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

// TASK.52 (codex-profiles cut §8.8): mirrors the SAME duplicated shapes
// declared in preload/index.ts (that file's own header explains why
// `CodexRolloutImportReportView` deliberately narrows main's own
// `RolloutImportReport` — it omits `items`, an `@anycode/core` type this
// bundle never imports; the renderer only ever needs the preview's
// stats/warnings/meta).
export interface CodexRolloutEntry {
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  cwd?: string;
  firstUserMessage?: string;
}

export type CodexRolloutListResult =
  | { ok: true; rollouts: CodexRolloutEntry[] }
  | { ok: false; reason: "profile_not_found" | "not_readable" };

export interface CodexRolloutImportStats {
  messages: number;
  toolPairs: number;
  reasoningDropped: number;
  developerDropped: number;
  imagesDropped: number;
  orphansSynthesized: number;
  collapsedToText: number;
  malformedLines: number;
  unknownRecordsSkipped: number;
  unknownItemsSkipped: number;
  unknownPartsSkipped: number;
}

export interface CodexRolloutImportReportView {
  stats: CodexRolloutImportStats;
  meta: { cwd?: string; cliVersion?: string; model?: string; startedAt?: string };
  warnings: string[];
}

export type CodexRolloutPreviewResult =
  | { ok: true; report: CodexRolloutImportReportView }
  | { ok: false; reason: "profile_not_found" | "invalid_file_name" | "not_readable" | "too_large" | "invalid_model" };

export type CodexRolloutImportResult =
  | { ok: true; sessionId: string; workspace: string; report: CodexRolloutImportReportView }
  | { ok: false; reason: "profile_not_found" | "invalid_file_name" | "not_readable" | "too_large" | "invalid_model" };

// TASK.54 (cut §9.2/§13.1): mirrors the SAME duplicated shapes declared in
// preload/index.ts and main/provider-ipc.ts. `CustomProviderRecord` itself
// IS a frozen shared/** type, imported above.
export type CustomProviderMutationReason = "invalid" | "read_only" | "not_found" | "needs_api_key" | "weak_storage_needs_consent";
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

declare global {
  interface Window {
    anycode: {
      createTab(request: CreateTabRequest): Promise<CreateTabResult>;
      closeTab(tabId: string): Promise<CloseTabResult>;
      listSessions(): Promise<SessionSummary[]>;
      pickWorkspace(): Promise<WorkspacePickResult>;
      listAvailableEngines(): Promise<AvailableEngines>;
      // TASK.41 (design/slice-codex-fixes-cut.md §5.5): push fired after any
      // step that could flip `listAvailableEngines()`'s result. No payload —
      // returns an unsubscribe, same shape as `updates.onUpdateStatus`/
      // `window.onWindowState` below.
      onEnginesChanged(callback: () => void): () => void;
      // TASK.41 (design/slice-codex-fixes-cut.md §2(g)): Codex onboarding
      // invoke-API. No token/credential value ever crosses this bridge in
      // either direction — every result carries only status/version/account
      // type+plan (custody).
      codex: {
        // `profileId` (TASK.50, cut §4.2): omitted diagnoses/signs into the
        // ACTIVE profile.
        recheck(profileId?: string): Promise<CodexOnboardingSnapshot>;
        pickBinary(): Promise<CodexPickBinaryResult>;
        loginStart(profileId?: string): Promise<CodexLoginStartResult>;
        loginCancel(): Promise<void>;
        // TASK.50 (cut §2/§4): the profile control-plane — settings/fs
        // mutations only, no spawns. No credential value ever crosses this
        // bridge (custody, cut §4.4).
        listProfiles(): Promise<CodexProfilesSnapshot>;
        createProfile(request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult>;
        deleteProfile(id: string): Promise<CodexProfileGuardResult>;
        setActiveProfile(id: string): Promise<CodexProfileGuardResult>;
        repairProfileLink(id: string): Promise<CodexProfileGuardResult>;
        // TASK.53 (cut §7, amended §A4): the binary/manifest control plane.
        install(version?: string): Promise<CodexInstallResult>;
        acceptRisk(version: string): Promise<{ ok: boolean; error?: string }>;
        supportStatus(): Promise<CodexSupportStatusResult>;
        manifestRefresh(): Promise<CodexManifestRefreshResult>;
        // TASK.52 (cut §8.8): the rollout-import control plane — a profile's
        // sessions dir is resolved main-side from `profileId` alone, never a
        // renderer-supplied path. `rolloutImport`'s `model` is the one piece
        // of new-session identity the renderer supplies (continuing an
        // imported conversation on a different model is the whole point).
        rolloutList(profileId: string): Promise<CodexRolloutListResult>;
        rolloutPreview(profileId: string, fileName: string): Promise<CodexRolloutPreviewResult>;
        rolloutImport(profileId: string, fileName: string, model: string): Promise<CodexRolloutImportResult>;
      };
      // Slice 2.2 (design §3): settings + secret-vault invoke-API. A decrypted
      // secret is never returned — setSecret is the only value-carrying call.
      settings: {
        get(): Promise<SettingsSnapshot>;
        set(patch: SettingsPatch): Promise<SettingsMutationResult>;
        setSecret(key: SecretKey, value: string): Promise<SettingsMutationResult>;
        clearSecret(key: SecretKey): Promise<SettingsMutationResult>;
        addRule(rule: PermissionRuleAddRequest): Promise<SettingsMutationResult>;
        // Slice 2.5 (design §4.5): interactive OAuth sign-in / cancel. No token
        // ever returns — oauthStart resolves with a fresh snapshot on success.
        // `connectionId` (TASK.45 W12-FIX §1, additive/optional): scopes the
        // sign-in to one connection; omitted preserves the legacy provider-scoped
        // findOrCreate behavior byte-for-byte.
        oauthStart(providerId: string, connectionId?: string): Promise<OAuthStartResult>;
        oauthCancel(providerId: string): Promise<void>;
        // TASK.45 W10: main-authoritative connection metadata update (ModelPill's
        // model/effort write path, off the v1-patch shim). Never carries a secret.
        connectionUpdate(req: ConnectionUpdateRequest): Promise<SettingsMutationResult>;
        // TASK.45 W12: the connections grid/drawer's remaining CRUD surface.
        // Never carries a secret; resolves with a fresh snapshot.
        connectionCreate(req: ConnectionCreateRequest): Promise<SettingsMutationResult>;
        connectionSetActive(req: ConnectionSetActiveRequest): Promise<SettingsMutationResult>;
        connectionDelete(req: ConnectionDeleteRequest): Promise<SettingsMutationResult>;
        connectionCheck(req: ConnectionCheckRequest): Promise<SettingsMutationResult>;
        // TASK.45 W11-FIX (W13 live-dogfood finding): push fired after a real
        // request outcome updates a connection's advisory health — no payload,
        // same shape as `onEnginesChanged` above.
        onProviderHealthChanged(callback: () => void): () => void;
      };
      // TASK.54 (cut §9.2/§13.1): custom OpenAI-compatible model-provider
      // CRUD + guarded `/v1/models` preview fetch (main/provider-ipc.ts owns
      // the URL/redirect/body-cap threat model + vault custody). No
      // credential ever crosses back — every result carries only the
      // persisted record (never a key); `create`/`update` are the only two
      // directions a plaintext key ever travels, main-bound, once per call.
      customProvider: {
        create(req: CustomProviderCreateRequest): Promise<CustomProviderMutationResult>;
        update(req: CustomProviderUpdateRequest): Promise<CustomProviderMutationResult>;
        delete(req: { id: string }): Promise<CustomProviderMutationResult>;
        fetchModels(
          req: { id: string } | { baseUrl: string; apiKey?: string; kind?: CustomProviderRecord["kind"] },
        ): Promise<FetchModelsOutcome>;
      };
      // P7.19/F22 (design/slice-P7.19-cut.md §3/§4 W2-W3, W3-FIX): MCP config
      // management invoke-API. `get` returns the joined project/user/compat
      // view (env/header VALUES never cross — envKeys names only, custody
      // §3); upsert/delete mutate one scope's config file; setEnabled (W3-FIX)
      // patches ONLY the `enabled` field — lossless even for a server with a
      // cwd/secret env values, unlike upsert's full-replace; importScan/
      // importApply drive the explicit-trust import from foreign harness
      // configs. Every mutator resolves a fresh snapshot on success.
      mcpConfig: {
        get(req?: McpConfigGetRequest): Promise<McpConfigSnapshot>;
        upsert(req: McpConfigUpsertRequest): Promise<McpConfigMutationResult>;
        delete(req: McpConfigDeleteRequest): Promise<McpConfigMutationResult>;
        setEnabled(req: McpConfigSetEnabledRequest): Promise<McpConfigMutationResult>;
        promoteCompat(req: McpConfigPromoteCompatRequest): Promise<McpConfigMutationResult>;
        importScan(req?: McpImportScanRequest): Promise<McpImportScanResult>;
        importApply(req: McpImportApplyRequest): Promise<McpImportApplyResult>;
      };
      // P7.20/F23 (design/slice-P7.20-cut.md §5 W2-W3): skills management
      // invoke-API. `list` returns the joined project/user/plugin view (a
      // filesystem PATH never crosses back in a request — every mutator/
      // reveal identifies a skill by name alone, design §4 path custody);
      // setEnabled/delete/create mutate one scope's catalog; importScan/
      // importApply drive the explicit-selection import from foreign harness
      // skill catalogs. Every mutator resolves a fresh snapshot on success.
      skills: {
        list(req?: SkillsListRequest): Promise<SkillsSnapshot>;
        setEnabled(req: SkillsSetEnabledRequest): Promise<SkillsMutationResult>;
        delete(req: SkillsDeleteRequest): Promise<SkillsMutationResult>;
        create(req: SkillsCreateRequest): Promise<SkillsMutationResult>;
        reveal(req: SkillsRevealRequest): Promise<SkillsRevealResult>;
        importScan(req?: SkillsImportScanRequest): Promise<SkillsImportScanResult>;
        importApply(req: SkillsImportApplyRequest): Promise<SkillsImportApplyResult>;
      };
      // P7.21/F21 (design/slice-P7.21-cut.md §4 W2-W3): subagents editor
      // invoke-API. `list` returns the joined built-in/project/user/plugin
      // view (a filesystem PATH never crosses back in a request — every
      // read/save/delete/reveal identifies a profile by name+sourceKind alone,
      // design §2-D7 path custody); save/create/delete mutate one own-catalog
      // profile; preview computes the REAL final child system prompt a draft
      // would spawn with. Every mutator resolves a fresh snapshot on success.
      subagents: {
        list(req?: SubagentsListRequest): Promise<SubagentsSnapshot>;
        read(req: SubagentsReadRequest): Promise<SubagentReadResult>;
        save(req: SubagentsSaveRequest): Promise<SubagentsMutationResult>;
        create(req: SubagentsCreateRequest): Promise<SubagentsMutationResult>;
        delete(req: SubagentsDeleteRequest): Promise<SubagentsMutationResult>;
        reveal(req: SubagentsRevealRequest): Promise<SubagentsRevealResult>;
        preview(req: SubagentsPreviewRequest): Promise<SubagentsPreviewResult>;
      };
      // P7.22/F19 (design/slice-P7.22-cut.md §2-D5 W2-W3): Profile-stats
      // invoke-API. `getStats`/`revealDir` take no argument at all — main
      // resolves the user-scope dir itself (never a renderer-supplied path);
      // `setTelemetry` patches ONLY the user-scope `telemetry.enabled` flag
      // and resolves with a fresh stats view on success.
      profile: {
        getStats(): Promise<ProfileStatsResult>;
        setTelemetry(enabled: boolean): Promise<ProfileTelemetrySetResult>;
        revealDir(): Promise<ProfileRevealDirResult>;
      };
      // Slice 2.6 (design §6): auto-updater. Three fixed no-argument invoke
      // wrappers (no renderer-supplied URL/channel ever crosses the bridge)
      // plus a status subscription; `onUpdateStatus` returns an unsubscribe.
      updates: {
        check(): Promise<UpdateActionResult>;
        download(): Promise<UpdateActionResult>;
        install(): Promise<UpdateActionResult>;
        // TASK.47 defect 2: darwin honest-manual-path action.
        openReleasesPage(): Promise<UpdateActionResult>;
        onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
      };
      // Custom titlebar (design/ui-track custom-titlebar §4): the platform the
      // renderer branches chrome on + the caption-button invoke-API. First three
      // take no argument; `onWindowState` returns an unsubscribe.
      platform: DesktopPlatform;
      window: {
        minimize(): Promise<void>;
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        getState(): Promise<WindowState>;
        onWindowState(callback: (state: WindowState) => void): () => void;
      };
    };
  }
}

export {};

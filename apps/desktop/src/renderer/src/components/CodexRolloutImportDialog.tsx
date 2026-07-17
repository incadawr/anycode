/**
 * "Import a Codex session" dialog (TASK.52, codex-profiles cut §8.8, lane
 * W3-H): Settings → Codex → pick a profile → pick one of its rollout files →
 * see an honest loss report → pick a model for the brand-new session → Import
 * & open. Main's half (`main/codex-rollout-ipc.ts`, lane D) already does the
 * real work — list/preview/import — and import already persists a NEW core
 * session + its converted history (cut §8.1: never a link back to the source
 * codex session). Opening the resulting session reuses the EXISTING
 * `kind:"resume"` tab path (`handleCreateTabResult`, `SessionPicker.js`) byte
 * for byte — this dialog is not a second way to spawn a tab.
 *
 * Types below duplicate preload/index.ts's own duplicates of
 * main/codex-rollout-ipc.ts's wire shapes (same "shared/** froze read-only
 * after C0" convention every Codex type in this codebase follows —
 * CodexEnginePane.tsx's own header explains it). `CodexRolloutImportReportView`
 * is deliberately narrower than main's `RolloutImportReport`: it omits
 * `items` (an `@anycode/core` type this bundle never imports) since the
 * dialog only ever displays the preview's stats/warnings/meta — the imported
 * history reaches its tab the normal `session_history` wire way, once resumed.
 *
 * Model catalog (cut §8.8: "модель новой сессии выбирается пользователем...
 * продолжить на другой модели"): the imported session is always engine
 * `"core"` (main's `createSession` call, codex-rollout-ipc.ts), so the model
 * list is the ACTIVE connection's own provider catalog — the same
 * `snapshot.catalog` + `modelMenuItems` ModelPill.tsx/StartScreen.tsx already
 * use for a core session's model chip, reused here rather than re-derived.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { CodexProfileRecord } from "../../../shared/settings.js";
import { activeProviderView } from "../../../shared/settings.js";
import type { CreateTabRequest, CreateTabResult } from "../../../shared/tabs.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { useTabsStore, type TabsState } from "../tabs-store.js";
import { createAsyncEpochGate, issueGuarded } from "./async-epoch-gate.js";
import { modelMenuItems, providerModelsFor } from "./ModelPill.js";
import { handleCreateTabResult } from "./SessionPicker.js";

// ── duplicated wire types (see file header) ──

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

export type RolloutStageFailureReason = "profile_not_found" | "invalid_file_name" | "not_readable" | "too_large" | "invalid_model";

export type CodexRolloutPreviewResult =
  | { ok: true; report: CodexRolloutImportReportView }
  | { ok: false; reason: RolloutStageFailureReason };

export type CodexRolloutImportResult =
  | { ok: true; sessionId: string; workspace: string; report: CodexRolloutImportReportView }
  | { ok: false; reason: RolloutStageFailureReason };

// ── constants duplicated across the main/renderer boundary ──

/** Mirrors `SYSTEM_PROFILE_ID` (CodexEnginePane.tsx / main/codex-profiles.ts) — the pseudo-profile that always exists and has its own sessions dir. */
const SYSTEM_PROFILE_ID = "system";
const SYSTEM_PROFILE_LABEL = "System (current environment)";
/** §8.7: mirrors main's own file-size cap, for the honest "too large" message. */
const MAX_ROLLOUT_FILE_MIB = 32;
/** List-row first-user-message preview cap — a rollout's first message can run long; the list view only needs enough to recognize the session. */
const FIRST_MESSAGE_PREVIEW_CAP = 96;

// ── pure helpers (unit-tested directly — see CodexRolloutImportDialog.test.ts) ──

export function buildRolloutProfileOptions(profiles: readonly CodexProfileRecord[]): { id: string; label: string }[] {
  return [{ id: SYSTEM_PROFILE_ID, label: SYSTEM_PROFILE_LABEL }, ...profiles.map((profile) => ({ id: profile.id, label: profile.label }))];
}

/** `mtimeMs` -> a fixed UTC "YYYY-MM-DD HH:mm" label — deterministic regardless of the host's local timezone (unlike `toLocaleString`). */
export function formatRolloutTimestamp(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatRolloutSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Collapses whitespace (a rollout's first user message is often multi-line) and caps length for the list row. `undefined` in, `undefined` out. */
export function truncateRolloutPreview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= FIRST_MESSAGE_PREVIEW_CAP) return collapsed;
  return `${collapsed.slice(0, FIRST_MESSAGE_PREVIEW_CAP)}…`;
}

// ── provenance stamps (W4-F0c finding B) ──

/**
 * Async results stamped with the id they answer (W4-F0c finding B): the
 * stamp is attached in the SAME guarded callback that resolves the bridge
 * call, so it rides WITH the reply — a stale reply that lands late still
 * carries its own (old) stamp, and the DOM below signs whose content it
 * actually shows (`data-rollouts-for`/`data-preview-for`). Render-only
 * self-description; the epoch gates above stay the sole clobber guard.
 */
export interface StampedRolloutList {
  forProfileId: string;
  result: CodexRolloutListResult;
}

export interface StampedRolloutPreview {
  forFileName: string;
  result: CodexRolloutPreviewResult;
}

/**
 * `data-rollouts-for` value for `.codex-rollout-list`: always the committed
 * RESULT's own provenance stamp, never the currently-selected profile —
 * while a stale result still occupies the state (the passive-effect window
 * after a profile switch), the DOM honestly signs it with its ORIGIN
 * profile; while loading (no committed result) there is no stamp at all.
 * Deliberately receives the current profileId too, so the dishonest
 * from-select derivation is expressible — and red-proofed — under this
 * file's pure-test discipline (node env, no rendered DOM).
 */
export function rolloutListProvenance(state: { profileId: string | null; listResult: StampedRolloutList | null }): string | undefined {
  return state.listResult?.forProfileId;
}

/** Preview twin of `rolloutListProvenance`: `data-preview-for` is the RESULT's own file stamp, never the currently-selected row. */
export function rolloutPreviewProvenance(state: { selectedFileName: string | null; previewResult: StampedRolloutPreview | null }): string | undefined {
  return state.previewResult?.forFileName;
}

export type RolloutListViewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; reason: "profile_not_found" | "not_readable" }
  | { kind: "loaded"; rollouts: CodexRolloutEntry[] };

/** `null` (no request issued/pending yet) -> loading; every other branch is an honest, exhaustive projection of the wire result. */
export function rolloutListViewState(result: CodexRolloutListResult | null): RolloutListViewState {
  if (result === null) return { kind: "loading" };
  if (!result.ok) return { kind: "error", reason: result.reason };
  if (result.rollouts.length === 0) return { kind: "empty" };
  return { kind: "loaded", rollouts: result.rollouts };
}

export type RolloutPreviewViewState =
  | { kind: "loading" }
  | { kind: "error"; reason: RolloutStageFailureReason }
  | { kind: "loaded"; report: CodexRolloutImportReportView };

export function rolloutPreviewViewState(result: CodexRolloutPreviewResult | null): RolloutPreviewViewState {
  if (result === null) return { kind: "loading" };
  if (!result.ok) return { kind: "error", reason: result.reason };
  return { kind: "loaded", report: result.report };
}

export function describeRolloutListFailure(reason: "profile_not_found" | "not_readable"): string {
  switch (reason) {
    case "profile_not_found":
      return "That profile no longer exists.";
    case "not_readable":
      return "Could not read that profile's Codex sessions folder.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function describeRolloutStageFailure(reason: RolloutStageFailureReason): string {
  switch (reason) {
    case "profile_not_found":
      return "That profile no longer exists.";
    case "invalid_file_name":
      return "That session file couldn't be identified — try refreshing the list.";
    case "not_readable":
      return "Could not read that session file.";
    case "too_large":
      return `That session file is too large to import (${MAX_ROLLOUT_FILE_MIB} MiB limit).`;
    case "invalid_model":
      return "Pick a model for the new session first.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * The honest loss lines cut §8.8 requires ("N reasoning dropped, M tools
 * collapsed to text, K images omitted") — only non-zero counts render, so a
 * lossless import shows no lines here at all (the component renders its own
 * "Nothing was lost" text for that case, not this helper).
 */
export function formatRolloutStatsLines(stats: CodexRolloutImportStats): string[] {
  const lines: string[] = [];
  if (stats.reasoningDropped > 0) lines.push(`${stats.reasoningDropped} reasoning dropped`);
  if (stats.collapsedToText > 0) lines.push(`${stats.collapsedToText} tools collapsed to text`);
  if (stats.imagesDropped > 0) lines.push(`${stats.imagesDropped} images omitted`);
  const unrecognized = stats.malformedLines + stats.unknownRecordsSkipped + stats.unknownItemsSkipped + stats.unknownPartsSkipped;
  if (unrecognized > 0) lines.push(`${unrecognized} unrecognized lines skipped`);
  return lines;
}

/** The active connection's own model when it's a member of its own catalog, else the catalog's first entry, else the raw active model (or "" for no provider configured at all) — same "explicit-if-valid, else first" shape as `resolveCodexDraftModel`/`resolveProviderDefaultModel` (StartScreen.tsx), applied to the CORE catalog. */
export function resolveDefaultImportModel(activeModel: string | undefined, catalogModels: readonly { id: string; name?: string }[] | undefined): string {
  if (activeModel !== undefined && (catalogModels ?? []).some((entry) => entry.id === activeModel)) {
    return activeModel;
  }
  return catalogModels?.[0]?.id ?? activeModel ?? "";
}

/**
 * Honest Import-button gate (F2, codex-profiles cut lane FXH review):
 * the pre-existing `previewState.kind !== "loaded" || importing` check never
 * looked at `model`, so a custom-provider connection whose catalog resolves
 * to no models at all (`resolveDefaultImportModel` bottoming out at `""`)
 * left Import clickable on an empty pick — main then refused with a
 * misleading `profile_not_found` (see the `invalid_model` reason split
 * below). Mirrors `modelPickDisabled`'s precedent of an extracted,
 * independently-testable predicate. Exported for unit testing.
 */
export function importDisabled(previewKind: RolloutPreviewViewState["kind"], importing: boolean, model: string): boolean {
  return previewKind !== "loaded" || importing || model === "";
}

// ── import + open (the resume-path reuse cut §8.8 mandates) ──

export interface CodexRolloutBridge {
  rolloutList(profileId: string): Promise<CodexRolloutListResult>;
  rolloutPreview(profileId: string, fileName: string): Promise<CodexRolloutPreviewResult>;
  rolloutImport(profileId: string, fileName: string, model: string): Promise<CodexRolloutImportResult>;
}

export interface RolloutTabOpenDeps {
  /** Default: `window.anycode.createTab`. */
  createTab(req: CreateTabRequest): Promise<CreateTabResult>;
  /** Default: the app's singleton `useTabsStore`. Narrowed to exactly the two setters this dialog calls, so a test fake never needs to fabricate the whole `TabsState`. */
  tabsStore: { getState(): Pick<TabsState, "addTab" | "setActiveTab"> };
}

function defaultTabOpenDeps(): RolloutTabOpenDeps {
  return { createTab: (req) => window.anycode.createTab(req), tabsStore: useTabsStore };
}

/**
 * Opens the just-imported session via the EXISTING resume path — byte for
 * byte `Sidebar.tsx`'s `resumeSession`/`App.tsx`'s `runResumeSession`: a
 * `kind:"resume"` createTab call, then `handleCreateTabResult` (already_open
 * -> focus that tab instead of opening a second writer). Returns the notice
 * text on a resume-stage failure (session IS persisted either way — only the
 * live tab failed to open), or `null` on success. Exported for unit testing.
 */
export async function openImportedSession(sessionId: string, deps: RolloutTabOpenDeps): Promise<string | null> {
  const result = await deps.createTab({ kind: "resume", sessionId });
  return handleCreateTabResult(result, {
    onTabCreated: ({ tabId, workspace }) => {
      deps.tabsStore.getState().addTab({ tabId, workspace });
      deps.tabsStore.getState().setActiveTab(tabId);
    },
    onFocusTab: (tabId) => {
      deps.tabsStore.getState().setActiveTab(tabId);
    },
  });
}

export interface PerformImportParams {
  profileId: string;
  fileName: string;
  model: string;
}

export type PerformImportOutcome = { ok: true; openMessage: string | null } | { ok: false; reason: RolloutStageFailureReason };

/**
 * "Import & open" in full: import (persists a new session + history, never
 * touching a tab) then open it via the resume path above. A refused import
 * never calls `createTab` at all — there is nothing to resume. Exported for
 * unit testing (the red-proof surface for "sends the picked model" / "opens
 * exactly the returned sessionId, never a blank new tab").
 */
export async function performImportAndOpen(
  bridge: Pick<CodexRolloutBridge, "rolloutImport">,
  tabOpenDeps: RolloutTabOpenDeps,
  params: PerformImportParams,
): Promise<PerformImportOutcome> {
  const result = await bridge.rolloutImport(params.profileId, params.fileName, params.model);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  const openMessage = await openImportedSession(result.sessionId, tabOpenDeps);
  return { ok: true, openMessage };
}

// ── component ──

export interface CodexRolloutImportDialogProps {
  open: boolean;
  onClose(): void;
  /** The registered (non-system) profiles — `CodexEnginePane`'s own `profiles` state, the system pseudo-profile is prepended internally. */
  profiles: readonly CodexProfileRecord[];
  /** Injectable for tests; defaults to the real `window.anycode.codex`. */
  bridge?: CodexRolloutBridge;
  /** Injectable for tests; defaults to `window.anycode.createTab` + the app's singleton tabs-store. */
  tabOpenDeps?: RolloutTabOpenDeps;
  /** Injectable for tests / isolation; defaults to the app's singleton settings-store. */
  settingsStore?: SettingsStoreApi;
}

export function CodexRolloutImportDialog({
  open,
  onClose,
  profiles,
  bridge = window.anycode.codex,
  tabOpenDeps = defaultTabOpenDeps(),
  settingsStore = useSettingsStore,
}: CodexRolloutImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // F1 (review lane FXH): epoch-gates the two async chains below so a fast
  // profile/file switch can never have its state clobbered by a slower,
  // now-stale reply landing after the newer one already resolved.
  const listGateRef = useRef(createAsyncEpochGate());
  const previewGateRef = useRef(createAsyncEpochGate());
  const [profileId, setProfileId] = useState<string | null>(null);
  const [listResult, setListResult] = useState<StampedRolloutList | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<StampedRolloutPreview | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const snapshot = useStore(settingsStore, (state) => state.snapshot);

  // Native <dialog> open/close mirrors McpImportDialog's own convention; the
  // reset-on-close clears every downstream step so reopening the picker never
  // shows a stale profile/list/preview from the previous run.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open) {
      if (dialog && !dialog.open) dialog.showModal();
    } else {
      dialog?.close();
      setProfileId(null);
      setListResult(null);
      setSelectedFileName(null);
      setPreviewResult(null);
      setSelectedModel(null);
      setImporting(false);
      setImportError(null);
      listGateRef.current.invalidate();
      previewGateRef.current.invalidate();
    }
  }, [open]);

  useEffect(() => {
    if (profileId === null) return;
    setListResult(null);
    setSelectedFileName(null);
    setPreviewResult(null);
    setImportError(null);
    // A profile switch retires any in-flight preview too — otherwise a stale
    // preview reply from the PREVIOUS profile could still land and resurrect
    // `previewState:"loaded"` while `selectedFileName` is null, enabling
    // Import on a no-op.
    previewGateRef.current.invalidate();
    // The provenance stamp is attached in the same guarded chain (finding B):
    // the reply and the id it answers commit as one value.
    issueGuarded(
      listGateRef.current,
      bridge.rolloutList(profileId).then((result) => ({ forProfileId: profileId, result })),
      setListResult,
    );
  }, [profileId, bridge]);

  function selectRollout(fileName: string): void {
    setSelectedFileName(fileName);
    setPreviewResult(null);
    setSelectedModel(null);
    setImportError(null);
    if (profileId !== null) {
      issueGuarded(
        previewGateRef.current,
        bridge.rolloutPreview(profileId, fileName).then((result) => ({ forFileName: fileName, result })),
        setPreviewResult,
      );
    }
  }

  const activeProvider = snapshot ? activeProviderView(snapshot.settings) : undefined;
  const catalogModels = providerModelsFor(activeProvider?.id, snapshot?.catalog, snapshot?.settings.provider.custom);
  const defaultModel = resolveDefaultImportModel(activeProvider?.model, catalogModels);
  const model = selectedModel ?? defaultModel;
  const modelItems = modelMenuItems(model, catalogModels);

  async function importAndOpen(): Promise<void> {
    if (profileId === null || selectedFileName === null) return;
    setImporting(true);
    setImportError(null);
    try {
      const outcome = await performImportAndOpen(bridge, tabOpenDeps, { profileId, fileName: selectedFileName, model });
      if (!outcome.ok) {
        setImportError(describeRolloutStageFailure(outcome.reason));
        return;
      }
      if (outcome.openMessage !== null) {
        setImportError(outcome.openMessage);
        return;
      }
      onClose();
    } finally {
      setImporting(false);
    }
  }

  const listState = rolloutListViewState(listResult?.result ?? null);
  const previewState = rolloutPreviewViewState(previewResult?.result ?? null);
  const profileOptions = buildRolloutProfileOptions(profiles);

  return (
    <dialog
      ref={dialogRef}
      className="mcp-form-dialog codex-rollout-dialog"
      aria-label="Import a Codex session"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="mcp-dialog-header">
        <span className="mcp-dialog-title">Import a Codex session</span>
      </div>
      <div className="mcp-dialog-body">
        <div className="settings-field-row">
          <span className="settings-field-label">Profile</span>
          <select className="settings-field-select" value={profileId ?? ""} onChange={(event) => setProfileId(event.target.value || null)}>
            <option value="" disabled>
              Choose a profile…
            </option>
            {profileOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {profileId !== null && (
          <div className="codex-rollout-list" data-rollouts-for={rolloutListProvenance({ profileId, listResult })}>
            {listState.kind === "loading" && <div className="settings-mcp-empty">Loading sessions…</div>}
            {listState.kind === "error" && (
              <div className="settings-notice" role="alert">
                {describeRolloutListFailure(listState.reason)}
              </div>
            )}
            {listState.kind === "empty" && <div className="settings-mcp-empty">No Codex sessions found for this profile.</div>}
            {listState.kind === "loaded" && (
              <ul className="settings-mcp-list">
                {listState.rollouts.map((entry) => (
                  <li key={entry.fileName} className="settings-mcp-row codex-rollout-row" data-file-name={entry.fileName}>
                    <label className="codex-rollout-row-label">
                      <input type="radio" name="codex-rollout-pick" checked={selectedFileName === entry.fileName} onChange={() => selectRollout(entry.fileName)} />
                      <span className="settings-mcp-name">{formatRolloutTimestamp(entry.mtimeMs)}</span>
                      <span className="codex-rollout-size">{formatRolloutSize(entry.sizeBytes)}</span>
                    </label>
                    {entry.cwd && <div className="settings-mcp-detail">{entry.cwd}</div>}
                    {entry.firstUserMessage && <div className="codex-rollout-preview-line">{truncateRolloutPreview(entry.firstUserMessage)}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {selectedFileName !== null && (
          <div className="codex-rollout-preview" data-preview-for={rolloutPreviewProvenance({ selectedFileName, previewResult })}>
            {previewState.kind === "loading" && <div className="settings-mcp-empty">Loading preview…</div>}
            {previewState.kind === "error" && (
              <div className="settings-notice" role="alert">
                {describeRolloutStageFailure(previewState.reason)}
              </div>
            )}
            {previewState.kind === "loaded" && (
              <>
                <div className="settings-section-title">What will be imported</div>
                {formatRolloutStatsLines(previewState.report.stats).length === 0 ? (
                  <div className="codex-rollout-stat-line">Nothing was lost — every message and tool call carries over.</div>
                ) : (
                  formatRolloutStatsLines(previewState.report.stats).map((line) => (
                    <div key={line} className="codex-rollout-stat-line">
                      {line}
                    </div>
                  ))
                )}
                {previewState.report.warnings.map((warning) => (
                  <div key={warning} className="settings-notice" role="alert">
                    {warning}
                  </div>
                ))}
                <div className="settings-field-row">
                  <span className="settings-field-label">Model for the new session</span>
                  <select className="settings-field-select" value={model} onChange={(event) => setSelectedModel(event.target.value)}>
                    {modelItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            {importError && (
              <div className="settings-notice" role="alert">
                {importError}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mcp-dialog-actions">
        <button type="button" className="settings-button" onClick={onClose}>
          Close
        </button>
        <button type="button" className="settings-button settings-button-primary" disabled={importDisabled(previewState.kind, importing, model)} onClick={() => void importAndOpen()}>
          {importing ? "Importing…" : "Import & open"}
        </button>
      </div>
    </dialog>
  );
}

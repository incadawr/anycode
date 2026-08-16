/**
 * "New Task" start screen (slice P7.12 §4.5 / intake F5#1a, extended by F5#1b
 * §2-D2/D3, restyled in slice-start-composer-cut): a composer-styled new-task
 * state — the SAME composer grammar the live-session composer uses
 * (`.composer` elevated card + borderless `.composer-textarea` +
 * `.composer-footer`), just without mounting `Composer.tsx` itself (that one
 * is bound to a live session via `TabContext`/`useTabSend`). A row of
 * environment chips (project popover) sits ABOVE the card (zcode/claude
 * desktop grammar). Renders in App.tsx's main-pane whenever `draftActive` is
 * true (App owns the precedence over the normal tab UI, §4.6) — this
 * component owns none of that gating itself, mirroring WelcomeScreen.tsx's
 * split of concerns.
 *
 * The project control (D2) merges the old standalone folder button + loose
 * recents strip into ONE popover: click opens a list of recent workspaces
 * (`deriveRecentWorkspaces`, limit 8) followed by a divider and a "Browse…"
 * row that fires the native dialog (`pickFolderForDraft`, reused verbatim).
 * The model chip (D3) is the footer-left control: a flat popover (grammar of
 * `model-list-claude-code.png`) built from ModelPill's own exported helpers
 * (`modelMenuItems`/`modelDisplayName`/`resolvePid`, imported — not
 * re-derived). Both popovers copy `ModeMenu.tsx`'s mechanics (roving focus
 * via its exported `nextRovingIndex`, outside-mousedown close, Esc close);
 * the start composer has no `overflow:hidden` ancestor, so plain absolute
 * positioning is used (the `ModelPill`/`Sidebar` fixed-position anchor dance
 * is only needed to escape such an ancestor).
 *
 * The textarea is store-controlled (`value={draft.prompt}`, write-through
 * `setDraftPrompt`) rather than local React state, so the automation facade
 * (W3) can drive/read the exact same state path a human types into — no
 * second source of truth to keep in sync.
 *
 * Submission always goes through `submitStartDraft()` (start-session.ts) with
 * its defaults (no second path, §4.3) — this component's only job is to
 * gate the Send button per §3-D3 and surface a `{ok:false}` refusal as a
 * toast via the injected `onToast`.
 *
 * The decision logic below (`computeSendDisabledReason`/`isSendKeydown`/
 * `deriveRecentWorkspaces`/`pickFolderForDraft`/`computeProjectLabel`/
 * `resolveProviderDefaultModel`/`computeModelChipDisplay`/`pickModelForDraft`)
 * is factored out as plain exported functions — this package's vitest config
 * runs `environment: "node"` (no jsdom, App.test.ts's precedent), so
 * StartScreen.test.ts exercises these directly rather than rendering the
 * component.
 *
 * TASK.81 (composer parity): the draft now carries image attachments
 * (`draft.images`) and a non-core reasoning-effort pick (`draft.engineEffort`,
 * tabs-store.ts) alongside the pre-existing model/mode/preset/profile picks.
 * Images are attach/paste only (no drag-and-drop — out of this task's DoD)
 * and reuse Composer.tsx's exact decode/resize pipeline
 * (`readComposerImageFile`) and pill grammar — no second image path. Effort
 * reuses `EngineModelMenu`'s existing `effort` prop (EngineControls.tsx),
 * the SAME control the live Codex/Claude composer already renders, gated on
 * the SAME "does this model even declare a vocabulary" predicate
 * (`draftModelEfforts`/`resolveDraftEngineEffort`) — the CORE engine has no
 * draft-time effort data at all (see `SessionDraft.engineEffort`'s doc
 * comment in tabs-store.ts) so it never gets a row. Both values are
 * delivered by `queueInitialPrompt` (tab-registry.ts) strictly before the
 * first `user_message` — effort via its own `set_engine_effort` wire
 * message, images inline on the `user_message` itself, honestly dropped
 * (with a notice, text still sent) if the boot model turns out not to
 * accept them.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { useTabsStore, type SessionDraft, type TabsStoreApi } from "../tabs-store.js";
import type { QueuedPromptImage } from "../store.js";
import { useSettingsStore } from "../settings-store.js";
import { submitStartDraft, type StartSubmitResult } from "../start-session.js";
import { Folder, ArrowUp, BrandMark, Check, Chevron, Clipboard, ImageIcon, Search, Terminal, Warning, X } from "./icons.js";
import { modelDisplayName, modelMenuItems, pillLabel, providerModelsFor, resolvePid } from "./ModelPill.js";
import { connectionDisplayName } from "./ConnectionTile.js";
import { ModeMenu, nextRovingIndex } from "./ModeMenu.js";
import { EngineModelMenu, EnginePresetMenu } from "./EngineControls.js";
import {
  COMPOSER_IMAGE_MAX_PER_MESSAGE,
  IMAGE_ACCEPT,
  formatImageSize,
  hasSendableDraft,
  readComposerImageFile,
} from "./Composer.js";
import type { SessionSummary, WorkspacePickResult } from "../../../shared/tabs.js";
import { activeProviderView, connectionById } from "../../../shared/settings.js";
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../../shared/settings.js";
import type { EngineId } from "../../../shared/engines.js";
import type { EngineModelChoice, EnginePermissionPreset } from "../../../shared/protocol.js";
import type { ToastKind } from "../toasts.js";
import { RUN_ACTION_EVENT, SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";
import { createAsyncEpochGate, issueGuarded } from "./async-epoch-gate.js";

export interface StartScreenProps {
  onToast(kind: ToastKind, text: string): void;
}

/** §2-D2: bumped from F5#1a's 5 now that recents live inside a popover rather than an always-visible strip. */
const RECENT_LIMIT = 8;
const PROJECT_HINT_DURATION_MS = 4_000;

/** A compact first-message starting point. Clicking one never starts a task; it only fills the draft. */
const STARTER_PRESETS = [
  { title: "Explore the codebase", prompt: "Explore this codebase and explain how it is structured.", icon: Search },
  { title: "Build a new feature", prompt: "Help me plan and implement a new feature: ", icon: Terminal },
  { title: "Review current changes", prompt: "Review the current changes and suggest improvements.", icon: Clipboard },
  { title: "Fix an issue", prompt: "Investigate and fix this issue: ", icon: Warning },
] as const;

/** Basename of a workspace path, tolerant of trailing slashes and both separators — same rule as Sidebar.tsx's private helper. */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/**
 * §3-D4: dedupe `SessionSummary.workspace` by its max `updatedAt`, exclude
 * hidden workspaces, take the top `limit` by recency.
 */
export function deriveRecentWorkspaces(
  sessions: readonly SessionSummary[],
  hiddenWorkspaces: readonly string[],
  limit: number = RECENT_LIMIT,
): string[] {
  const latestByWorkspace = new Map<string, number>();
  for (const session of sessions) {
    if (hiddenWorkspaces.includes(session.workspace)) {
      continue;
    }
    const seen = latestByWorkspace.get(session.workspace);
    if (seen === undefined || session.updatedAt > seen) {
      latestByWorkspace.set(session.workspace, session.updatedAt);
    }
  }
  return [...latestByWorkspace.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([workspace]) => workspace);
}

/** §2-D2: the project control's label — the workspace's basename once one is chosen, else the prompt to pick one. Exported for unit testing. */
export function computeProjectLabel(workspace: string | null): string {
  return workspace !== null ? basename(workspace) : "Choose a project";
}

/**
 * §3-D3: Send stays disabled until a project is chosen and the draft has
 * something to send — mirrors Composer's `sendDisabledReason`, reusing the
 * SAME `hasSendableDraft` predicate (TASK.81: an attached image alone, with
 * no typed text, is sendable there and must be here too — no second
 * "is this draft empty" rule). `imageCount` defaults to 0 so every pre-
 * existing call site (none of which knew about images) keeps its exact
 * original behavior.
 */
export function computeSendDisabledReason(draft: SessionDraft, imageCount: number = 0): string | undefined {
  if (draft.workspace === null) {
    return "Choose a project first";
  }
  if (!hasSendableDraft(draft.prompt, imageCount)) {
    return "Type a message to send";
  }
  return undefined;
}

/** Enter=send, Shift+Enter=newline — Composer.tsx parity (Composer.tsx:488-493). */
export function isSendKeydown(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey;
}

/**
 * SLICE-CC A4 (cut §1.2 DoD-3): the Claude engine button's visibility
 * predicate, extracted to a pure function so the unit half of DoD-3 ("the
 * button renders iff availableEngines contains claude") doesn't need to
 * render this component — this package's vitest config runs
 * `environment: "node"` (no jsdom), the same rationale every other derived
 * value in this file is already exported for.
 */
export function shouldShowClaudeEngineButton(availableEngines: readonly EngineId[]): boolean {
  return availableEngines.includes("claude");
}

/** Starter cards preserve typed work by appending after it instead of replacing it. */
export function applyStarterPreset(current: string, preset: string): string {
  return current.length === 0 ? preset : current.endsWith("\n") ? current + preset : `${current}\n${preset}`;
}

export interface GuardedSubmitDeps {
  /** Whether §3-D3's folder/prompt gate currently allows a submit. */
  canSend: boolean;
  /**
   * A plain mutable latch (a `useRef`, not `useState`): two clicks/Enters
   * dispatched in the same tick both close over the same pre-update render,
   * so a `useState` flag alone can't stop the second one from slipping
   * through before React commits the re-render — the ref is checked and set
   * synchronously, before the first `await`.
   */
  guard: { current: boolean };
  /** Drives the Send button's `disabled` (React state, for the visible UI). */
  setSubmitting(value: boolean): void;
  submit(): Promise<StartSubmitResult>;
  onToast(kind: ToastKind, text: string): void;
}

/** Double-submit guard (codex review, P7.12 fix): a rapid double-click/double-Enter must create at most one session from a draft. */
export async function guardedSubmit(deps: GuardedSubmitDeps): Promise<void> {
  if (!deps.canSend || deps.guard.current) {
    return;
  }
  deps.guard.current = true;
  deps.setSubmitting(true);
  try {
    const result = await deps.submit();
    if (!result.ok) {
      deps.onToast("shell_error", result.message);
    }
  } finally {
    deps.guard.current = false;
    deps.setSubmitting(false);
  }
}

export interface FolderPickDeps {
  pickWorkspace(): Promise<WorkspacePickResult>;
  tabsStore: TabsStoreApi;
}

function defaultFolderPickDeps(): FolderPickDeps {
  return { pickWorkspace: () => window.anycode.pickWorkspace(), tabsStore: useTabsStore };
}

/** The project control's "Browse…" row (§2-D2): fires the native dialog, writes a non-cancelled pick onto the draft. */
export async function pickFolderForDraft(deps: FolderPickDeps = defaultFolderPickDeps()): Promise<void> {
  const result = await deps.pickWorkspace();
  if (result.workspace !== null) {
    deps.tabsStore.getState().setDraftWorkspace(result.workspace);
  }
}

/**
 * §3-D3: the resolved provider default the model chip falls back to when the
 * draft has no explicit pick — `defaults[pid]?.model ?? provider.model`,
 * the same resolution `main/host-env.ts`'s `buildHostEnv` and `ModelPill`'s
 * own ack-persist use. Exported for unit testing.
 */
export function resolveProviderDefaultModel(
  providerModel: string | undefined,
  providerDefaults: Record<string, { model?: string } | undefined> | undefined,
  pid: string,
): string {
  return providerDefaults?.[pid]?.model ?? providerModel ?? "";
}

export interface ModelChipDisplay {
  /** The model id the chip currently represents — the draft's explicit pick, else the resolved provider default. */
  modelId: string;
  /** Display label (`modelDisplayName`, reused from ModelPill). */
  label: string;
  /** True when showing the resolved default rather than an explicit draft pick (chip renders muted/"default" styled, §3-D3). */
  isDefault: boolean;
}

/** §3-D3: the model chip's display data. Exported for unit testing. */
export function computeModelChipDisplay(
  draftModel: string | null,
  resolvedDefault: string,
  catalogModels: readonly { id: string; name?: string }[] | undefined,
): ModelChipDisplay {
  const isDefault = draftModel === null;
  const modelId = draftModel ?? resolvedDefault;
  return { modelId, label: modelDisplayName(modelId, catalogModels), isDefault };
}

export interface ModelPickDeps {
  tabsStore: TabsStoreApi;
}

function defaultModelPickDeps(): ModelPickDeps {
  return { tabsStore: useTabsStore };
}

/**
 * A model-chip row's click handler (§3-D3): stores the explicit id the user
 * clicked. There is no dedicated "Default" affordance in v1's flat list (no
 * effort row, no manage row — just `modelMenuItems`), so every pick is
 * explicit; `null` (= "use the provider default") is reachable only via
 * `openDraft`/`discardDraft`'s initial state, never from a click. Exported
 * for unit testing.
 */
export function pickModelForDraft(modelId: string, deps: ModelPickDeps = defaultModelPickDeps()): void {
  deps.tabsStore.getState().setDraftModel(modelId);
}

/** One selectable row inside a `StartModelMenuGroup` (TASK.106 cut-1 stage B). */
export interface StartModelMenuItem {
  id: string;
  name: string;
  /**
   * True exactly for the item matching BOTH axes of the current pair
   * (connection id + model id). The same model id can appear in two
   * different connections' groups (e.g. a Kimi subscription connection and a
   * Kimi API-key connection) — only the item belonging to the actually
   * current/pinned connection is ever marked current.
   */
  current: boolean;
}

/** One connection's group in the New Session model popover (TASK.106 cut-1 stage B). */
export interface StartModelMenuGroup {
  /** The connection's real id — always defined, even for the active connection's group (the click handler decides whether to submit this id as-is or normalize it to `undefined`, §3 item 3). */
  connectionId: string;
  /** Group header text — `connectionDisplayName`'s auto-naming, the SAME label Settings/Welcome already show for this connection. */
  label: string;
  items: StartModelMenuItem[];
}

/**
 * TASK.106 cut-1 stage B: groups the New Session model popover by EVERY
 * connected connection, not just the active one. For each connection,
 * `providerModelsFor` resolves its offered models exactly like the
 * pre-existing single-connection call did — an empty/absent live fetch falls
 * back to the provider's static catalog, `providerModelsFor`'s own behavior,
 * not duplicated here. `current.connectionId` is the CALLER-resolved
 * effective current connection (the draft's explicit pin, else the active
 * connection — `SessionDraft.connectionId`'s "unset ⇒ active" convention,
 * resolved once by the caller rather than re-derived per group here): the
 * matching group appends `current.modelId` via `modelMenuItems` when the
 * catalog doesn't already carry it (mirrors the single-connection chip's own
 * fallback); every OTHER group shows exactly its resolved catalog, with no
 * such synthetic entry — there is no "current model" to preserve for a
 * connection that isn't the current pair. Exported for unit testing.
 */
export function buildStartModelMenuGroups(
  connections: readonly ProviderConnection[],
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
  current: { connectionId: string | undefined; modelId: string },
): StartModelMenuGroup[] {
  return connections.map((connection) => {
    const catalogEntry = catalog?.find((entry) => entry.id === connection.providerId);
    const label = connectionDisplayName(connection, catalogEntry?.name ?? "Custom", connections);
    const catalogModels = providerModelsFor(connection.providerId, catalog, custom, connection.models);
    const isCurrentConnection = connection.id === current.connectionId;
    const baseItems = isCurrentConnection
      ? modelMenuItems(current.modelId, catalogModels)
      : (catalogModels ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
    const items = baseItems.map((item) => ({
      id: item.id,
      name: item.name,
      current: isCurrentConnection && item.id === current.modelId,
    }));
    return { connectionId: connection.id, label, items };
  });
}

/**
 * Normalizes a grouped model-menu row's connection id to what actually gets
 * submitted on selection (TASK.106 cut-1 stage B, §3 item 3): the active
 * connection's own group submits `undefined` — `SessionDraft.connectionId`'s
 * "unset ⇒ active connection" convention means a redundant explicit pin of
 * today's already-active connection is never written — every other
 * connection submits its real id. Exported for unit testing.
 */
export function startModelRowConnectionId(rowConnectionId: string, activeConnectionId: string | undefined): string | undefined {
  return rowConnectionId === activeConnectionId ? undefined : rowConnectionId;
}

/**
 * A grouped model-menu row's click handler (TASK.106 cut-1 stage B): sets
 * BOTH axes of the pair in one call — `setDraftModel` for the model id, and
 * `setDraftConnectionId` for the row's connection (already normalized by the
 * caller via `startModelRowConnectionId`) — the two axes always move
 * together, the same discipline `resolvePillTarget` (`ModelPill.tsx:121`)
 * applies to the live-session pill. Exported for unit testing.
 */
export function selectStartModelRow(
  connectionId: string | undefined,
  modelId: string,
  deps: ModelPickDeps = defaultModelPickDeps(),
): void {
  pickModelForDraft(modelId, deps);
  deps.tabsStore.getState().setDraftConnectionId(connectionId);
}

/**
 * TASK.39 (cut §2(d)/§3.8): the draft's own copy of the frozen Codex
 * permission-preset table. Duplicated on purpose from
 * `host/engines/codex/presets.ts`'s `codexPresetChoices()` output — the same
 * "small table crosses the `shared/**` freeze as a documented duplicate"
 * precedent as `CODEX_SUPPORTED_RANGE`/the onboarding channel literals
 * elsewhere in this track. There is no host yet at draft time to ask for its
 * live catalog, and it is harmless: the eventual host re-validates whatever
 * `presetId` the draft submits against ITS OWN copy of this same table
 * (host-authoritative membership check, cut §2(d)) — this duplicate can only
 * ever offer the same three ids the host also knows, never smuggle a raw
 * config value past that check.
 */
export const CODEX_DRAFT_PRESETS: readonly EnginePermissionPreset[] = [
  {
    id: "ask",
    label: "Ask for approval",
    description: "Codex works in this workspace and asks before going beyond it.",
  },
  {
    id: "approve-for-me",
    label: "Approve for me",
    description: "Codex keeps the workspace boundary and sends eligible approvals to automatic review.",
  },
  {
    id: "full-access",
    label: "Full access",
    description: "Codex can access files and the internet without sandbox or approval prompts.",
  },
];

/** Mirrors `DEFAULT_CODEX_PRESET` in `host/engines/codex/presets.ts` (duplicated for the same reason as the table above). */
export const DEFAULT_CODEX_DRAFT_PRESET = "ask";

/**
 * SLICE-CC C5 (cut §1.4): the Claude draft's copy of the FROZEN Claude
 * permission-preset table, duplicated from `host/engines/claude/presets.ts`'s
 * `claudePresetChoices()` output on exactly the `CODEX_DRAFT_PRESETS`
 * precedent above — there is no host at draft time to ask, the table is frozen
 * by construction, and the host re-validates whatever id the draft submits
 * against its OWN copy (`resolvePreset`), so this duplicate can only ever offer
 * the same three ids the host already knows.
 *
 * The three CLI modes the host table deliberately withholds — `dontAsk`,
 * `auto`, `bypassPermissions` — are equally absent here: an id this list does
 * not carry can never be picked, and the host would refuse it anyway.
 */
export const CLAUDE_DRAFT_PRESETS: readonly EnginePermissionPreset[] = [
  {
    id: "read-only",
    label: "Read-only",
    description: "Claude plans and reads files, but cannot execute the plan without switching preset.",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Claude asks before running commands or changing files (default).",
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Claude can accept file edits inside the workspace with fewer prompts.",
  },
];

/** Mirrors `DEFAULT_CLAUDE_PRESET` in `host/engines/claude/presets.ts`. */
export const DEFAULT_CLAUDE_DRAFT_PRESET = "ask";

/**
 * The Claude draft's model list. Unlike the preset table this is NOT a mirror
 * of a frozen host table — `host/engines/claude/models.ts` is explicit that the
 * real catalog is per-ACCOUNT and read live from the `initialize` response, and
 * a static enum was disproven by the live payload. Two facts make a draft-time
 * list nonetheless correct here:
 *
 *  1. There is no Claude catalog channel at draft time. The Claude doctor
 *     (`ClaudeDoctorReport`) reports status/version only — it never runs an
 *     `initialize`, so unlike `codexModels` there is nothing to fetch. Offering
 *     the "Default (recommended)" entry alone would silently remove the user's
 *     ability to pick a model on a new session.
 *  2. A wrong pick is HARMLESS and visible. `startClaudeEngine`'s `resolveModel`
 *     accepts an id only if the live catalog positively contains it, and
 *     otherwise boots on the CLI default AND queues a warning
 *     `engine_notice` that names the model — so an entry this account does not
 *     have degrades loudly, never silently mis-runs.
 *
 * The values are the `value` (send) ids captured live in
 * `w0-16-setmodel.jsonl`, never the `resolvedModel` (read-back) ids — sending a
 * resolved id is the exact conflation models.ts exists to prevent.
 */
export const CLAUDE_DRAFT_MODELS: readonly EngineModelChoice[] = [
  { id: "default", label: "Default (recommended)" },
  { id: "opus[1m]", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/**
 * Resolves the Claude draft's displayed model id. Same hazard as
 * `resolveCodexDraftModel`: `draft.model` is a single field shared with the
 * Core and Codex model chips and is NOT reset on an engine switch, so a leftover
 * id from another engine must never be displayed or submitted as if it were a
 * Claude id. Exported for unit testing.
 */
export function resolveClaudeDraftModel(draftModel: string | null, available: readonly EngineModelChoice[]): string {
  if (draftModel !== null && available.some((m) => m.id === draftModel)) {
    return draftModel;
  }
  return available[0]?.id ?? "";
}

/**
 * Resolves the Codex draft's displayed/selected model id. `draft.model` is a
 * single field shared with the Core engine's own model chip (tabs-store.ts,
 * outside this file's zone) and is NOT reset on an engine switch — a Core
 * model id left over from before switching to Codex must never be displayed
 * or submitted as if it were a valid Codex id, so this only trusts
 * `draftModel` when it is actually a member of the fetched Codex catalog,
 * falling back to the catalog's first entry otherwise. Exported for unit
 * testing.
 */
export function resolveCodexDraftModel(draftModel: string | null, available: readonly EngineModelChoice[]): string {
  if (draftModel !== null && available.some((m) => m.id === draftModel)) {
    return draftModel;
  }
  return available[0]?.id ?? "";
}

/**
 * TASK.81: a non-core draft's effort vocabulary for the CURRENT model —
 * mirrors `EngineModelMenu`'s own internal `efforts` lookup
 * (EngineControls.tsx) byte-for-byte, so this file and that component never
 * disagree about which models even have an effort row. `[]` when the model
 * is absent from the catalog or declares none (a non-reasoning model, or a
 * catalog that hasn't loaded yet). Exported for unit testing.
 */
export function draftModelEfforts(modelId: string, available: readonly EngineModelChoice[]): readonly string[] {
  return available.find((item) => item.id === modelId)?.efforts ?? [];
}

/**
 * Resolves the draft's displayed/selected effort for a non-core engine
 * (TASK.81) — the SAME "trust an explicit pick only while it stays valid,
 * else fall back to the catalog's first entry" rule
 * `resolveCodexDraftModel`/`resolveClaudeDraftModel` already use for the
 * model chip, applied to effort: a leftover pick from a since-switched model
 * (or a different engine entirely — `engineEffort` is never reset on an
 * engine switch, mirroring `enginePreset`) is harmless because it is only
 * ever trusted when the CURRENT model's vocabulary still contains it.
 * `EngineModelMenu`'s `effort.current` prop is required (not optional), so
 * the caller needs SOME value to show whenever the row is visible at all —
 * `undefined` only when the model has no effort vocabulary, which the
 * caller reads as "hide the row" (never sent anywhere unless the user picks
 * a row and `setDraftEngineEffort` actually fires). Exported for unit
 * testing.
 */
export function resolveDraftEngineEffort(draftEffort: string | undefined, efforts: readonly string[]): string | undefined {
  if (draftEffort !== undefined && efforts.includes(draftEffort)) {
    return draftEffort;
  }
  return efforts[0];
}

/** One selectable row in the Codex account-profile chip's dropdown. */
export interface CodexProfileChipOption {
  id: string;
  label: string;
  /** signed_out (cached, never a live doctor check) — visible but unpickable, `CodexEnginePane.tsx`'s `canSignIn` gate mirrored. */
  disabled: boolean;
}

/**
 * codex-profiles cut §3.3/W3-F: the chip sits next to the Agent selector, but
 * only once there is something real to pick between — the `system` pseudo-
 * profile alone (no registered accounts) has no choice to offer, so the chip
 * stays hidden and every draft implicitly runs on the ambient CODEX_HOME
 * (unchanged from pre-profiles behaviour). Exported for unit testing.
 */
export function shouldShowCodexProfileChip(isCodexDraft: boolean, profiles: readonly CodexProfileChipOption[]): boolean {
  return isCodexDraft && profiles.length > 0;
}

/**
 * The chip's displayed label: the draft's explicit pick once made, else
 * "System" — the same label for BOTH "never touched the chip" and "picked a
 * profile since removed from the list", so the chip never claims an account
 * that `createStartTabRequest` (start-session.ts) would not actually submit
 * (an absent `codexProfileId` resolves to the `system` pseudo-profile,
 * shared/tabs.ts's own documented default). Exported for unit testing.
 */
export function computeCodexProfileChipLabel(
  draftCodexProfileId: string | undefined,
  profiles: readonly CodexProfileChipOption[],
): string {
  if (draftCodexProfileId === undefined) {
    return "System";
  }
  return profiles.find((profile) => profile.id === draftCodexProfileId)?.label ?? "System";
}

/**
 * Whether the draft's account-profile pick has fallen out of sync with a
 * fresh profile catalog (R3-2 facet i): the profile the draft points at was
 * deleted/renamed away while the draft stayed open. The chip already falls
 * back to "System" for this case (`computeCodexProfileChipLabel` above), but
 * `createStartTabRequest` (start-session.ts) still forwards the stale id
 * verbatim (it has no catalog to check against) — the profile-catalog
 * refresh effect below is the only place both the id and a fresh catalog are
 * in scope at once, so it uses this to sanitize the draft back to `undefined`
 * (the `system` pseudo-profile) the moment the desync is detected. Never
 * touched (`undefined`) is not stale — there is nothing to resolve. Exported
 * for unit testing.
 */
export function isDraftCodexProfileIdStale(
  draftCodexProfileId: string | undefined,
  profiles: readonly CodexProfileChipOption[],
): boolean {
  return draftCodexProfileId !== undefined && !profiles.some((profile) => profile.id === draftCodexProfileId);
}

/**
 * Projects main's `codex.listProfiles()` snapshot into the chip's option
 * list. `disabled` reads the CACHED `lastCheck`/live `report` status
 * (never triggers a fresh doctor check of its own — this chip is a picker,
 * not a diagnostic surface). Exported for unit testing.
 */
export function deriveCodexProfileOptions(
  profiles: readonly {
    profile: { id: string; label: string; lastCheck?: { status: string } };
    report?: { status: string };
  }[],
): CodexProfileChipOption[] {
  return profiles.map(({ profile, report }) => ({
    id: profile.id,
    label: profile.label,
    disabled: (report?.status ?? profile.lastCheck?.status) === "signed_out",
  }));
}

/**
 * slice-start-composer-cut §5: preselect the last-used workspace once per
 * draft. Returns `recents[0]` ONLY when there IS a draft with no workspace
 * chosen yet AND at least one recent exists — `null` otherwise, so:
 * (a) an explicit user pick (`draft.workspace !== null`) is never overwritten;
 * (b) empty recents keep the "Choose a project first" gate (§3-D3);
 * (c) no draft at all is a no-op. Pure (no store writes); the effect below
 * owns the one-time `setDraftWorkspace` write. Exported for unit testing.
 */
export function seedWorkspaceFromRecents(
  draft: SessionDraft | null,
  recents: readonly string[],
): string | null {
  if (draft === null || draft.workspace !== null) {
    return null;
  }
  return recents[0] ?? null;
}

export function StartScreen({ onToast }: StartScreenProps) {
  const draft = useTabsStore((state) => state.draft);
  const hiddenWorkspaces = useTabsStore((state) => state.hiddenWorkspaces);
  const snapshot = useSettingsStore((state) => state.snapshot);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  // Core is always the local compatibility choice. Codex is appended only
  // after main returns its already-validated availability verdict.
  const [availableEngines, setAvailableEngines] = useState<readonly EngineId[]>(["core"]);
  // TASK.39 (cut §2(d)/§2(g)/§3.8): the doctor-provided Codex model catalog
  // for the draft picker (see this component's own `codexEngineSelected`
  // effect and the `CODEX_DRAFT_PRESETS` doc comment above for why the
  // preset table itself needs no fetch). The preset PICK itself lives on
  // the shared draft (`draft.enginePreset`, tabs-store.ts), not local
  // component state (W3 join): `submitStartDraft` and the automation
  // facade's `startScreenSubmit` both submit off the store alone, with no
  // access to this component's state, so a local-only pick would never
  // reach `createStartTabRequest`.
  const [codexModels, setCodexModels] = useState<readonly EngineModelChoice[]>([]);
  // codex-profiles cut §3.3/W3-F: the account-profile chip's own catalog,
  // fetched the same "once per codex-selected transition, live-refreshed via
  // engines-changed" way as `codexModels` above.
  const [codexProfileOptions, setCodexProfileOptions] = useState<readonly CodexProfileChipOption[]>([]);
  const [codexProfileMenuOpen, setCodexProfileMenuOpen] = useState(false);
  const codexProfileRootRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitGuardRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // TASK.81: image attach state. The attachment LIST itself is store-backed
  // (`draft.images`, mirrors the store-controlled `draft.prompt` textarea —
  // §4.1 above) so an automation facade could drive it the same way; the
  // error banner is presentation-only local state, same split Composer.tsx
  // uses for its own `imageError`.
  const [imageError, setImageError] = useState<string | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectHintVisible, setProjectHintVisible] = useState(true);
  const [projectHintHovered, setProjectHintHovered] = useState(false);
  const [projectFocusIndex, setProjectFocusIndex] = useState(0);
  const projectRootRef = useRef<HTMLDivElement>(null);
  const projectChipRef = useRef<HTMLButtonElement>(null);
  const projectItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFocusIndex, setModelFocusIndex] = useState(0);
  const modelRootRef = useRef<HTMLDivElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const modelItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Plain derived values (not hooks) — safe to compute ahead of the
  // `draft === null` early return below and reference from the effects'
  // dependency arrays, since none of them dereference `draft` unguarded
  // (`draft?.model ?? null`).
  const recents = deriveRecentWorkspaces(sessions, hiddenWorkspaces);
  // Active-connection view (TASK.45 v2): the former singleton's model/effort now
  // live on the active connection, so the resolved default is simply `view.model`
  // / `view.reasoningEffort`.
  const view = snapshot ? activeProviderView(snapshot.settings) : undefined;
  const providerId = view?.id;
  const pid = resolvePid(providerId);
  const activeConnectionId = snapshot?.settings.provider.activeConnectionId;
  // TASK.106 cut-1 P2 fix: the chip's own LABEL must resolve against the
  // connection the draft is actually pinned to, else the active connection
  // (`SessionDraft.connectionId`'s own "unset ⇒ active" convention) — not
  // unconditionally the active connection. `modelDisplayName` falls back to
  // the raw id on a catalog miss, so after a cross-connection pick (e.g.
  // picking "Kimi K2" while Anthropic stays active) the active connection's
  // catalog never contains the picked id and the chip would show the raw
  // `kimi-k2-...` id instead of "Kimi K2". `resolvedDefault` below is
  // deliberately left resolving off the active view (unchanged) — a pin only
  // ever affects this label lookup, never which model plays default when the
  // draft has no explicit pick at all.
  const chipConnectionId = draft?.connectionId ?? activeConnectionId;
  const chipConnection =
    snapshot && chipConnectionId !== undefined ? connectionById(snapshot.settings, chipConnectionId) : undefined;
  const catalogModels = providerModelsFor(
    chipConnection?.providerId,
    snapshot?.catalog,
    snapshot?.settings.provider.custom,
    chipConnection?.models,
  );
  const resolvedDefault = resolveProviderDefaultModel(view?.model, undefined, pid);
  const modelChip = computeModelChipDisplay(draft?.model ?? null, resolvedDefault, catalogModels);
  // The active-session ModelPill includes the persisted effort in its label.
  // A brand-new draft has no host yet, so its honest equivalent is the
  // provider default; an explicit model pick deliberately shows only the
  // model because its capabilities have not been negotiated with a host.
  const defaultEffort = view?.reasoningEffort;
  const modelChipLabel = draft?.model === null && defaultEffort !== undefined
    ? pillLabel(modelChip.label, defaultEffort, ["off"])
    : modelChip.label;
  // TASK.106 cut-1 stage B: the model popover's grouped list spans every
  // connected connection, not just the active one; the "current pair" it
  // checkmarks is the draft's explicit connection pin, else the active
  // connection — the SAME `chipConnectionId` the label above just resolved.
  const modelGroups = buildStartModelMenuGroups(
    snapshot?.settings.provider.connections ?? [],
    snapshot?.catalog,
    snapshot?.settings.provider.custom,
    { connectionId: chipConnectionId, modelId: modelChip.modelId },
  );
  // Flattened for roving-focus indexing (group header rows are never
  // focusable/counted — indexing is by clickable row only, §3 item 7).
  const modelMenuRows = modelGroups.flatMap((group) =>
    group.items.map((item, index) => ({
      ...item,
      connectionId: group.connectionId,
      groupLabel: group.label,
      isGroupStart: index === 0,
    })),
  );
  const projectRowCount = recents.length + 1; // +1 for the trailing "Browse…" row
  // TASK.39: hook-safe boolean (computed ahead of the `draft === null` early
  // return below, same discipline as the other plain derived values above)
  // gating the Codex draft catalog fetch effect.
  const codexEngineSelected = draft?.engine === "codex";
  const codexDraftModel = resolveCodexDraftModel(draft?.model ?? null, codexModels);
  // TASK.81: the effort row only ever shows for a model that actually
  // declares a vocabulary (EngineModelMenu's own internal gate, mirrored
  // here to decide whether to pass the `effort` prop at all — see
  // `draftModelEfforts`'s doc comment).
  const codexDraftEfforts = draftModelEfforts(codexDraftModel, codexModels);
  const codexDraftEffort = resolveDraftEngineEffort(draft?.engineEffort, codexDraftEfforts);
  // W3 join: displays the draft's own pick once made; falls back to the same
  // default the picker starts on before the user ever touches it.
  const codexDraftPreset = draft?.enginePreset ?? DEFAULT_CODEX_DRAFT_PRESET;
  // codex-profiles cut §3.3/W3-F: same "plain derived value ahead of the
  // draft===null early return" discipline as the other Codex draft values above.
  const showCodexProfileChip = shouldShowCodexProfileChip(codexEngineSelected, codexProfileOptions);
  const codexProfileChipLabel = computeCodexProfileChipLabel(draft?.codexProfileId, codexProfileOptions);

  useEffect(() => {
    let cancelled = false;
    window.anycode
      .listSessions()
      .then((list) => {
        if (!cancelled) {
          setSessions(list);
        }
      })
      .catch((error: unknown) => {
        console.warn("[StartScreen] listSessions failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.anycode
      .listAvailableEngines()
      .then(({ engineIds }) => {
        if (!cancelled) setAvailableEngines(engineIds);
      })
      .catch((error: unknown) => {
        // Absence/failure is fail-closed for optional engines, while the
        // historical Core start flow remains available.
        console.warn("[StartScreen] listAvailableEngines failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // TASK.41 residual (cut §5.5): the one-shot fetch above has no live
  // listener, so a Codex login/onboarding step completed while a
  // StartScreen is already mounted would not show up until remount. Wire
  // the same `engines-changed` push CodexEnginePane already subscribes to
  // (main fires it after every onboarding step) directly into this
  // component's own effect, independent of that pane's mount state (Settings
  // is usually unmounted, so relying solely on it relaying into tabs-store
  // would be unreliable) — re-fetches and refreshes the Agent selector live.
  useEffect(() => {
    return window.anycode.onEnginesChanged(() => {
      window.anycode
        .listAvailableEngines()
        .then(({ engineIds }) => setAvailableEngines(engineIds))
        .catch((error: unknown) => {
          console.warn("[StartScreen] listAvailableEngines (live refresh) failed", error);
        });
    });
  }, []);

  // TASK.39 (cut §2(g)/§3.8/§8): the draft's native model catalog comes from
  // the same bounded "codex doctor" onboarding already uses
  // (`window.anycode.codex.recheck()`) — fetched once per codex-selected
  // transition (not on every render: cut §8 residual explicitly calls out
  // not re-spawning the doctor per render), fail-soft on any error/non-ready
  // status (the picker then just shows nothing until the next transition or
  // an onboarding recheck elsewhere flips Codex ready).
  useEffect(() => {
    if (!codexEngineSelected) {
      return;
    }
    let cancelled = false;
    window.anycode.codex
      .recheck()
      .then((snapshot) => {
        if (!cancelled && snapshot.report.status === "ready" && snapshot.report.models) {
          setCodexModels(snapshot.report.models);
        }
      })
      .catch((error: unknown) => {
        console.warn("[StartScreen] codex.recheck (draft catalog) failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [codexEngineSelected]);

  // codex-profiles cut §3.3/W3-F: the account-profile chip's own catalog —
  // fetched once per codex-selected transition (same discipline as the model
  // catalog above), plus a live re-fetch on the SAME `engines-changed` push a
  // profile create/delete/repair already fires (main/codex-ipc.ts's
  // `onProfilesChanged`), so a profile added/removed in Settings while this
  // screen is mounted shows up without a remount. Fail-soft: any error just
  // leaves the chip hidden/stale until the next transition or push.
  //
  // codex-review L7-9 facet B (f1-review-ruling-fable-iter17.md): mount fires
  // one `refresh()` and every `engines-changed` push fires another, with no
  // ordering guarantee on their replies. An `AsyncEpochGate` scoped to this
  // effect instance ensures only the LAST-ISSUED request's reply is ever
  // applied — a slow, stale reply (e.g. one that still lists a
  // since-deleted profile) can never win over a newer one, regardless of
  // resolution order, so the R3-2 staleness sanitization below always runs
  // against the freshest catalog rather than a reply that a later refresh
  // has already superseded.
  useEffect(() => {
    if (!codexEngineSelected) {
      return;
    }
    let cancelled = false;
    const gate = createAsyncEpochGate();
    function refresh(): void {
      issueGuarded(
        gate,
        window.anycode.codex.listProfiles().catch((error: unknown) => {
          console.warn("[StartScreen] codex.listProfiles failed", error);
          return null;
        }),
        (snapshot) => {
          if (cancelled || snapshot === null) {
            return;
          }
          const options = deriveCodexProfileOptions(snapshot.profiles);
          setCodexProfileOptions(options);
          // R3-2 facet i: the profile the draft points at may have just
          // dropped out of this fresh catalog (deleted/renamed while the
          // draft stayed open) — sanitize immediately so the chip's
          // "System" fallback and the actual submit payload never diverge.
          if (isDraftCodexProfileIdStale(useTabsStore.getState().draft?.codexProfileId, options)) {
            useTabsStore.getState().setDraftCodexProfileId(undefined);
          }
        },
      );
    }
    refresh();
    const unsubscribe = window.anycode.onEnginesChanged(refresh);
    return () => {
      cancelled = true;
      gate.invalidate();
      unsubscribe();
    };
  }, [codexEngineSelected]);

  // slice-start-composer-cut §5: preselect the last-used workspace once per
  // draft (StartScreen unmounts on discardDraft, so this ref resets per
  // draft). Only fires while `draft.workspace === null` — an explicit pick
  // (recents click / Browse dialog) flips workspace non-null and stops the
  // seed from ever overwriting it; empty recents leave the §3-D3 gate intact.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    const seed = seedWorkspaceFromRecents(draft, recents);
    if (seed !== null) {
      seededRef.current = true;
      useTabsStore.getState().setDraftWorkspace(seed);
    }
  }, [draft, recents]);

  // WelcomeScreen.tsx precedent (:47-49): the one actionable field on an
  // otherwise-empty screen gets the initial focus.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // The folder chip needs a brief orientation cue when this state opens, then
  // should behave like a normal hover/focus tooltip instead of staying noisy.
  useEffect(() => {
    const timeout = window.setTimeout(() => setProjectHintVisible(false), PROJECT_HINT_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  // Outside mousedown closes the project popover (ModeMenu.tsx pattern);
  // clicking the model chip counts as "outside" here, so the two popovers
  // never end up open at once without any extra coordination.
  useEffect(() => {
    if (!projectMenuOpen) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (projectRootRef.current && !projectRootRef.current.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [projectMenuOpen]);

  // Outside mousedown closes the model popover — same pattern, independent state.
  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (modelRootRef.current && !modelRootRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [modelMenuOpen]);

  // Outside mousedown closes the Codex account-profile popover — same pattern.
  useEffect(() => {
    if (!codexProfileMenuOpen) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (codexProfileRootRef.current && !codexProfileRootRef.current.contains(event.target as Node)) {
        setCodexProfileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [codexProfileMenuOpen]);

  // Seed the project popover's roving focus at the current workspace (if it's
  // among the recents) whenever it opens, mirroring ModelPill's own seeding.
  useEffect(() => {
    if (!projectMenuOpen) {
      return;
    }
    const currentIndex = draft && draft.workspace !== null ? recents.indexOf(draft.workspace) : -1;
    setProjectFocusIndex(Math.max(0, currentIndex));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on
    // an open transition (mirrors ModeMenu/ModelPill's narrow deps); recomputing
    // on every recents/draft tick would fight the user's roving-arrow input.
  }, [projectMenuOpen]);

  useEffect(() => {
    if (projectMenuOpen) {
      projectItemRefs.current[projectFocusIndex]?.focus();
    }
  }, [projectMenuOpen, projectFocusIndex]);

  // Seed the model popover's roving focus at the current pick whenever it opens.
  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    setModelFocusIndex(Math.max(0, modelMenuRows.findIndex((row) => row.current)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same narrow-deps
    // discipline as the project popover's seeding effect above.
  }, [modelMenuOpen]);

  useEffect(() => {
    if (modelMenuOpen) {
      modelItemRefs.current[modelFocusIndex]?.focus();
    }
  }, [modelMenuOpen, modelFocusIndex]);

  if (draft === null) {
    return null;
  }

  const draftImages = draft.images ?? [];
  const sendDisabledReason = submitting ? "Sending…" : computeSendDisabledReason(draft, draftImages.length);
  const canSend = sendDisabledReason === undefined;
  const codexDraft = draft.engine === "codex";
  // SLICE-CC C5 (cut §1.4): the Claude draft's own branch of the composer
  // footer. Both values are plain derived reads (no fetch — see
  // CLAUDE_DRAFT_MODELS' doc comment for why there is nothing to fetch).
  const claudeDraft = draft.engine === "claude";
  const claudeDraftPreset = draft.enginePreset ?? DEFAULT_CLAUDE_DRAFT_PRESET;
  const claudeDraftModel = resolveClaudeDraftModel(draft.model, CLAUDE_DRAFT_MODELS);
  // TASK.81: same "only show the row when the model actually has a
  // vocabulary" discipline as the Codex branch above. `CLAUDE_DRAFT_MODELS`
  // does not currently declare any `efforts` (no live per-model catalog at
  // draft time — see that table's own doc comment), so this resolves to
  // `undefined` and the row stays hidden today; wiring is generic so it
  // lights up for free the moment that table ever gains real data.
  const claudeDraftEfforts = draftModelEfforts(claudeDraftModel, CLAUDE_DRAFT_MODELS);
  const claudeDraftEffort = resolveDraftEngineEffort(draft.engineEffort, claudeDraftEfforts);
  const showProjectHint = draft.workspace !== null && (projectHintVisible || projectHintHovered);

  async function submit(): Promise<void> {
    await guardedSubmit({
      canSend,
      guard: submitGuardRef,
      setSubmitting,
      submit: submitStartDraft,
      onToast,
    });
  }

  /**
   * TASK.81: validates + attaches files (file-picker or paste), reusing
   * Composer.tsx's exact `readComposerImageFile` decoder — no second image
   * pipeline. Re-reads the draft's CURRENT image list at write time (not the
   * `draftImages` closed over at render) so a slow multi-file read never
   * clobbers a concurrent remove.
   */
  async function addDraftImageFiles(files: readonly File[]): Promise<void> {
    const imageFiles = files.filter((file) => file.type.startsWith("image/") || file.name.match(/\.(png|jpe?g|gif|webp)$/i));
    if (imageFiles.length === 0) {
      return;
    }
    const slots = COMPOSER_IMAGE_MAX_PER_MESSAGE - (useTabsStore.getState().draft?.images?.length ?? 0);
    if (slots <= 0) {
      setImageError(`Only ${COMPOSER_IMAGE_MAX_PER_MESSAGE} images can be attached.`);
      return;
    }
    const accepted: QueuedPromptImage[] = [];
    let firstError: string | null = imageFiles.length > slots ? `Only ${COMPOSER_IMAGE_MAX_PER_MESSAGE} images can be attached.` : null;
    for (const file of imageFiles.slice(0, slots)) {
      try {
        const result = await readComposerImageFile(file);
        if (result.ok) {
          accepted.push(result.image);
        } else {
          firstError ??= result.reason;
        }
      } catch (error) {
        firstError ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (accepted.length > 0) {
      const current = useTabsStore.getState().draft?.images ?? [];
      useTabsStore.getState().setDraftImages([...current, ...accepted]);
      setImageError(null);
    }
    if (firstError !== null) {
      setImageError(firstError);
    }
  }

  function removeDraftImage(index: number): void {
    const current = useTabsStore.getState().draft?.images ?? [];
    useTabsStore.getState().setDraftImages(current.filter((_, i) => i !== index));
    setImageError(null);
  }

  function openImagePicker(): void {
    imageFileInputRef.current?.click();
  }

  function handleTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const pastedFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (pastedFiles.length > 0) {
      event.preventDefault();
      void addDraftImageFiles(pastedFiles);
    }
  }

  function closeProjectMenu(returnFocus: boolean): void {
    setProjectMenuOpen(false);
    if (returnFocus) {
      projectChipRef.current?.focus();
    }
  }

  function selectRecentProject(workspace: string): void {
    useTabsStore.getState().setDraftWorkspace(workspace);
    closeProjectMenu(true);
  }

  function selectBrowse(): void {
    // The native dialog is about to take focus regardless — no need to
    // return it to the chip first.
    setProjectMenuOpen(false);
    void pickFolderForDraft();
  }

  function onProjectChipKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setProjectMenuOpen(true);
    }
  }

  function onProjectMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setProjectFocusIndex((i) => nextRovingIndex(i, 1, projectRowCount));
        break;
      case "ArrowUp":
        event.preventDefault();
        setProjectFocusIndex((i) => nextRovingIndex(i, -1, projectRowCount));
        break;
      case "Home":
        event.preventDefault();
        setProjectFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setProjectFocusIndex(projectRowCount - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (projectFocusIndex < recents.length) {
          selectRecentProject(recents[projectFocusIndex]!);
        } else {
          selectBrowse();
        }
        break;
      case "Escape":
        event.preventDefault();
        closeProjectMenu(true);
        break;
      case "Tab":
        setProjectMenuOpen(false);
        break;
      default:
        break;
    }
  }

  function closeModelMenu(returnFocus: boolean): void {
    setModelMenuOpen(false);
    if (returnFocus) {
      modelChipRef.current?.focus();
    }
  }

  function selectModel(rowConnectionId: string, modelId: string): void {
    selectStartModelRow(startModelRowConnectionId(rowConnectionId, activeConnectionId), modelId);
    closeModelMenu(true);
  }

  function onModelChipKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setModelMenuOpen(true);
    }
  }

  function onModelMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const count = modelMenuRows.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setModelFocusIndex((i) => nextRovingIndex(i, 1, count));
        break;
      case "ArrowUp":
        event.preventDefault();
        setModelFocusIndex((i) => nextRovingIndex(i, -1, count));
        break;
      case "Home":
        event.preventDefault();
        setModelFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setModelFocusIndex(count - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const row = modelMenuRows[modelFocusIndex];
        if (row) {
          selectModel(row.connectionId, row.id);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        closeModelMenu(true);
        break;
      case "Tab":
        setModelMenuOpen(false);
        break;
      default:
        break;
    }
  }

  function selectCodexProfile(profileId: string): void {
    useTabsStore.getState().setDraftCodexProfileId(profileId);
    setCodexProfileMenuOpen(false);
  }

  /**
   * "Add account…" (codex-profiles cut §3.3/W3-F): reuses the existing
   * decoupled navigation seam (slash-menu.ts's `RUN_ACTION_EVENT`/
   * `SETTINGS_SELECT_PANE_EVENT`) rather than a new prop — `SettingsDialog`
   * (App.tsx) is unconditionally mounted for the app's whole lifetime and
   * already listens for exactly this "settings.open" + pane-select pair
   * (SettingsScreen.tsx), so no App.tsx wiring is needed for this screen to
   * open Settings on the Codex pane.
   */
  function openCodexAccountSettings(): void {
    setCodexProfileMenuOpen(false);
    window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
    window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: "codex" }));
  }

  return (
    <div className="start-screen">
      <div className="start-env-row">
        <div className="start-project" ref={projectRootRef}>
          {showProjectHint && (
            <div id="start-project-hint" className="start-project-hint" role="tooltip">
              Change the project for this task
            </div>
          )}
          <button
            ref={projectChipRef}
            type="button"
            className="start-folder"
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            aria-describedby={showProjectHint ? "start-project-hint" : undefined}
            onClick={() => setProjectMenuOpen((open) => !open)}
            onKeyDown={onProjectChipKeyDown}
            onMouseEnter={() => setProjectHintHovered(true)}
            onMouseLeave={() => setProjectHintHovered(false)}
            onFocus={() => setProjectHintHovered(true)}
            onBlur={() => setProjectHintHovered(false)}
          >
            <Folder />
            <span>{computeProjectLabel(draft.workspace)}</span>
          </button>

          {projectMenuOpen && (
            <div className="start-project-menu" role="menu" aria-label="Project" onKeyDown={onProjectMenuKeyDown}>
              {recents.length > 0 && (
                <ul className="start-recents">
                  {recents.map((workspace, index) => (
                    <li key={workspace}>
                      <button
                        ref={(el) => {
                          projectItemRefs.current[index] = el;
                        }}
                        type="button"
                        tabIndex={index === projectFocusIndex ? 0 : -1}
                        className="start-recent-item"
                        title={workspace}
                        onClick={() => selectRecentProject(workspace)}
                      >
                        {basename(workspace)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {recents.length > 0 && <div className="start-project-menu-divider" />}
              <button
                ref={(el) => {
                  projectItemRefs.current[recents.length] = el;
                }}
                type="button"
                tabIndex={recents.length === projectFocusIndex ? 0 : -1}
                className="start-project-menu-browse"
                onClick={() => selectBrowse()}
              >
                Browse…
              </button>
            </div>
          )}
        </div>
        {/* Design TASK.40 item 4: the selector is a choice of AGENT (which
            runtime drives the turn), not a product — labelled visibly so it
            no longer reads as a generic "Session engine" toggle. Group/pressed
            a11y semantics are unchanged; the visible label doubles as the
            group's accessible name via aria-labelledby. */}
        <div className="start-engine-switch" role="group" aria-labelledby="start-engine-switch-label">
          <span
            id="start-engine-switch-label"
            className="start-engine-switch-label"
            style={{ color: "var(--text-2)", fontSize: "var(--fs-sm)", marginRight: "var(--sp-1)", paddingLeft: "var(--sp-1)" }}
          >
            Agent
          </span>
          <button
            type="button"
            className={`start-engine-choice${draft.engine === "core" ? " start-engine-choice-selected" : ""}`}
            aria-pressed={draft.engine === "core"}
            onClick={() => useTabsStore.getState().setDraftEngine("core")}
          >
            AnyCode
          </button>
          {availableEngines.includes("codex") && (
            <button
              type="button"
              className={`start-engine-choice${codexDraft ? " start-engine-choice-selected" : ""}`}
              aria-pressed={codexDraft}
              onClick={() => useTabsStore.getState().setDraftEngine("codex")}
            >
              Codex
            </button>
          )}
          {/* SLICE-CC A4 (cut §1.2): visibility gated by availableEngines the
              same way as the Codex button above — canSpawn("claude") is
              unconditionally false until CC-C (main/tabs.ts), so
              ENGINES_LIST_CHANNEL never includes "claude" on a real CC-A
              build and this button never renders in production yet. Claude
              draft-model/preset selectors are CC-C's job. */}
          {shouldShowClaudeEngineButton(availableEngines) && (
            <button
              type="button"
              className={`start-engine-choice${draft.engine === "claude" ? " start-engine-choice-selected" : ""}`}
              aria-pressed={draft.engine === "claude"}
              onClick={() => useTabsStore.getState().setDraftEngine("claude")}
            >
              Claude
            </button>
          )}
        </div>
        {/* codex-profiles cut §3.3/W3-F: the account-profile chip sits next to
            (not inside) the Agent selector — visible only for a Codex draft
            with at least one registered profile (the `system` pseudo-profile
            alone has nothing to pick between). */}
        {showCodexProfileChip && (
          <div className="model-pill start-codex-profile" ref={codexProfileRootRef}>
            <button
              type="button"
              className="model-pill-chip"
              aria-haspopup="menu"
              aria-expanded={codexProfileMenuOpen}
              title={codexProfileChipLabel}
              onClick={() => setCodexProfileMenuOpen((open) => !open)}
            >
              <span className="model-pill-label">{codexProfileChipLabel}</span>
              <Chevron className="model-pill-chevron" />
            </button>

            {codexProfileMenuOpen && (
              <div className="model-pill-popover" role="menu" aria-label="Codex account">
                {codexProfileOptions.map((profile) => {
                  const current = profile.id === draft.codexProfileId;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      disabled={profile.disabled}
                      className={`model-pill-item${current ? " model-pill-item-current" : ""}`}
                      onClick={() => selectCodexProfile(profile.id)}
                    >
                      <span className="model-pill-item-check" aria-hidden="true">
                        {current ? <Check /> : null}
                      </span>
                      <span className="model-pill-item-name">{profile.label}</span>
                    </button>
                  );
                })}
                <div className="model-pill-divider" />
                <button type="button" className="model-pill-row" onClick={openCodexAccountSettings}>
                  <span className="model-pill-row-name">Add account…</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="start-intro">
        <BrandMark className="start-brand-mark" />
        <h1>What should we build in AnyCode?</h1>
      </div>

      <div className="start-presets" aria-label="Task starters">
        {STARTER_PRESETS.map(({ title, prompt, icon: Icon }) => (
          <button
            key={title}
            type="button"
            className="start-preset"
            onClick={() => {
              useTabsStore.getState().setDraftPrompt(applyStarterPreset(draft.prompt, prompt));
              textareaRef.current?.focus();
            }}
          >
            <Icon className="start-preset-icon" />
            <span>{title}</span>
          </button>
        ))}
      </div>

      <div className="composer start-composer">
        {/* TASK.81: image attachments, Composer.tsx's `.composer-pills` grammar
            verbatim — attach/paste only (no drag-and-drop: out of this
            task's scope, the DoD only calls for attach/paste parity). */}
        {draftImages.length > 0 && (
          <div className="composer-pills">
            {draftImages.map((image, index) => (
              <span key={`${image.name}-${index}`} className="composer-image-pill" title={image.name}>
                <span className="composer-image-pill-name">{image.name}</span>
                <span className="composer-image-pill-size">{formatImageSize(image.sizeBytes)}</span>
                <button
                  type="button"
                  className="composer-image-pill-remove"
                  aria-label={`Remove ${image.name}`}
                  title="Remove image"
                  onClick={() => removeDraftImage(index)}
                >
                  <X />
                </button>
              </span>
            ))}
          </div>
        )}
        {imageError !== null && <div className="composer-image-error">{imageError}</div>}
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          aria-label="First message"
          placeholder="What do you want to do?"
          value={draft.prompt}
          onChange={(event) => useTabsStore.getState().setDraftPrompt(event.target.value)}
          onPaste={handleTextareaPaste}
          onKeyDown={(event) => {
            if (isSendKeydown(event)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-footer-left">
            {/* TASK.81: attach affordance, shown for every engine branch alike —
                all three engines currently declare `supportsImages: true`
                (host/engines/{session-engine,claude/claude-engine,codex/codex-engine}.ts),
                mirroring Composer.tsx's own `engine?.capabilities.supportsImages
                ?? true` default-on fallback for "no live capability data yet". */}
            <input
              ref={imageFileInputRef}
              className="composer-file-input"
              type="file"
              accept={IMAGE_ACCEPT}
              multiple
              tabIndex={-1}
              onChange={(event) => {
                void addDraftImageFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              className="composer-attach"
              aria-label="Attach image"
              title="Attach image"
              disabled={submitting}
              onClick={openImagePicker}
            >
              <ImageIcon />
            </button>
            {codexDraft ? (
              // TASK.39 item 1: native Codex model + permission-preset pickers
              // (from the doctor-provided catalog, never AnyCode's provider
              // catalog) replace the old static "Codex" identity badge.
              // Selecting either only ever sends a bare presetId/model id —
              // the eventual host re-validates both against its own tables
              // regardless (host-authoritative, cut §2(d)/§2(j)).
              <>
                <EnginePresetMenu
                  permissions={{ presets: CODEX_DRAFT_PRESETS, activePresetId: codexDraftPreset }}
                  pendingPresetId={undefined}
                  disabled={false}
                  onPick={(id) => useTabsStore.getState().setDraftEnginePreset(id)}
                />
                {codexModels.length > 0 && (
                  <EngineModelMenu
                    model={{ current: codexDraftModel, available: codexModels }}
                    pendingModel={undefined}
                    disabled={false}
                    onPick={(id) => useTabsStore.getState().setDraftModel(id)}
                    {...(codexDraftEffort !== undefined
                      ? {
                          effort: {
                            current: codexDraftEffort,
                            onPick: (effort: string) => useTabsStore.getState().setDraftEngineEffort(effort),
                          },
                        }
                      : {})}
                  />
                )}
              </>
            ) : claudeDraft ? (
              // SLICE-CC C5 (cut §1.4): native Claude preset + model pickers,
              // the codex branch's shape exactly. Both only ever submit a bare
              // id on the draft; `startClaudeEngine` re-validates the preset
              // against the frozen table and the model against the LIVE
              // `initialize` catalog before either reaches the wire.
              <>
                <EnginePresetMenu
                  permissions={{ presets: CLAUDE_DRAFT_PRESETS, activePresetId: claudeDraftPreset }}
                  pendingPresetId={undefined}
                  disabled={false}
                  onPick={(id) => useTabsStore.getState().setDraftEnginePreset(id)}
                />
                <EngineModelMenu
                  model={{ current: claudeDraftModel, available: CLAUDE_DRAFT_MODELS }}
                  pendingModel={undefined}
                  disabled={false}
                  onPick={(id) => useTabsStore.getState().setDraftModel(id)}
                  {...(claudeDraftEffort !== undefined
                    ? {
                        effort: {
                          current: claudeDraftEffort,
                          onPick: (effort: string) => useTabsStore.getState().setDraftEngineEffort(effort),
                        },
                      }
                    : {})}
                />
              </>
            ) : (
              <>
                <ModeMenu mode={draft.mode} disabled={false} onChange={(mode) => useTabsStore.getState().setDraftMode(mode)} />
                <div className="model-pill start-model" ref={modelRootRef}>
              <button
                ref={modelChipRef}
                type="button"
                className="model-pill-chip"
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                title={modelChipLabel}
                onClick={() => setModelMenuOpen((open) => !open)}
                onKeyDown={onModelChipKeyDown}
              >
                <span className="model-pill-label">{modelChipLabel}</span>
                <Chevron className="model-pill-chevron" />
              </button>

              {modelMenuOpen && (
                <div className="start-model-menu" role="menu" aria-label="Model" onKeyDown={onModelMenuKeyDown}>
                  {/* TASK.106 cut-1 stage B: one group per connection, SlashMenu.tsx's
                      own "Fragment + role=presentation header before the first row of
                      a new group" pattern — the header never joins roving focus/tab
                      order (§3 item 7). */}
                  {modelMenuRows.map((row, index) => (
                    <Fragment key={`${row.connectionId}:${row.id}`}>
                      {row.isGroupStart && (
                        <div className="start-model-menu-group-label" role="presentation" data-connection-id={row.connectionId}>
                          {row.groupLabel}
                        </div>
                      )}
                      <button
                        ref={(el) => {
                          modelItemRefs.current[index] = el;
                        }}
                        type="button"
                        role="menuitemradio"
                        aria-checked={row.current}
                        tabIndex={index === modelFocusIndex ? 0 : -1}
                        className={`start-model-item${row.current ? " start-model-item-current" : ""}`}
                        data-connection-id={row.connectionId}
                        data-model-id={row.id}
                        onClick={() => selectModel(row.connectionId, row.id)}
                      >
                        <span className="start-model-item-check" aria-hidden="true">
                          {row.current ? <Check /> : null}
                        </span>
                        <span className="start-model-item-name">{row.name}</span>
                      </button>
                    </Fragment>
                  ))}
                </div>
              )}
                </div>
              </>
            )}
          </div>
          <span className="composer-hint composer-hint-hidden" />
          <div className="composer-footer-right">
            <button
              type="button"
              className="composer-send"
              aria-label="Send"
              title={sendDisabledReason}
              disabled={!canSend}
              onClick={() => void submit()}
            >
              <ArrowUp />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

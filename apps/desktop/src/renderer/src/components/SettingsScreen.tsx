/**
 * Settings UI (slice 2.2, design/slice-2.2-cut.md §2/§3, ruling
 * reviews/slice-2.2-forks-ruling.md §1/§2; provider-section v2 + OAuth-UX,
 * slice 2.5, design/slice-2.5-cut.md §5): provider/tools/ui fields, the
 * per-provider credential block (masked apiKey set/clear OR OAuth sign-in),
 * the always-allow rules editor, and the read-only / env-override /
 * weak-storage-consent notices. `SettingsScreen` itself has exactly one
 * consumer: the `SettingsDialog` below (native `<dialog>`, same pattern as
 * PermissionModal/SessionPicker) behind App.tsx's settings button once a
 * provider is configured — `ProviderSettings` (its Provider pane, extracted
 * slice R11) is what WelcomeScreen embeds directly (no dialog chrome) when
 * the app is unconfigured.
 *
 * SHELL (slice R16, design/slice-R16-cut.md §1/§2; sixth pane added by slice
 * P7.8; fullscreen redesign + Permissions split out of Tools, slice P7.16
 * design/slice-P7.16-cut.md §3/§5 W2): a full-window `<dialog>` with a wide
 * rail (Back-to-app + Search settings + a vertical `role="tablist"` of seven
 * sections: Provider · Permissions · Tools · MCP · Environment · Appearance ·
 * About) and a right content pane — a page-title block (`SETTINGS_PANES`'
 * label/description) above a single `role="tabpanel"` scroll column that
 * conditionally renders exactly one section's content at a time (never
 * CSS-hidden — see `ProviderSettings`' `<ConsentDialog>` top-layer hazard
 * note at its own definition below). `filterSettingsPanes` narrows the rail
 * to a search query (pure, keyword-indexed by `SETTINGS_SEARCH_INDEX`);
 * R16's original five sections were re-homed under the pane conditionals
 * verbatim; Updates folds into the About pane alongside a static identity
 * block and acknowledgements; Environment (P7.8) is the read-only
 * telemetry/repo-map status surface, data-sourced exactly like MCP above
 * (per-tab host data, not the settings-store snapshot). Permissions (split
 * out of the old combined Tools & Permissions pane by W2) renders
 * `PermissionsEditor` (P7.16 §4.1/W3): rules grouped by exact tool name, a
 * manual-add form routed through the same sanitized `buildAlwaysAllowRule`
 * the permission modal uses — see that component's own doc comment.
 *
 * CUSTODY (design §1 invariant, extended by slice 2.5 to OAuth tokens): this
 * component NEVER receives a decrypted secret/token value —
 * `SettingsSnapshot.secrets` is always `SecretStatus[]` (key/set/source/tier
 * only, shared/settings.ts, frozen 2.2.1/2.5.1), and the OAuth sign-in flow
 * carries only a `providerId` in either direction (settings-store's
 * `oauthStart`/`oauthCancel` — see its own CUSTODY note). The API-key
 * `<input>` is write-only: `secretFieldReducer` clears it back to `""` the
 * instant a value is submitted (success, plain refusal, OR parked for
 * consent — the value that survives a consent retry lives in
 * settings-store's `pendingConsent`, not in this component's own state), so
 * a stored secret is never echoed back into a rendered field.
 *
 * PROVIDER SELECTION (TASK.45 W12, replacing slice 2.5 §5's singleton
 * `<select>`): the ConnectionDrawer's template `<select>` is populated from
 * `snapshot.catalog` (optional/absent = empty). `shouldShowBaseUrlField`
 * treats "no selection" and the catalog's own `custom`/needsBaseUrl entry as
 * the SAME "needs a base URL" case — deliberately not hardcoding the
 * `"custom"` id string so the renderer stays data-driven off the frozen
 * `needsBaseUrl` flag alone.
 *
 * MCP status row (slice 3.2, design/slice-3.2-cut.md §5.1/§6, task 3.2.4):
 * status display only — a server-management UI is explicitly NOT in v1. MCP
 * status is per-tab data (each tab's host process owns its own McpManager,
 * design §2/§4.2) living on that tab's `DesktopState.mcpServers` (store.ts),
 * NOT on the settings-store snapshot above. `SettingsDialog`/`SettingsScreen`
 * are mounted by App.tsx as a SIBLING of the active tab's subtree (outside its
 * `<TabContext.Provider>`) — so unlike the migrated per-tab components
 * (`useTabStore`/`tab-context.tsx`), `useActiveMcpServers` below resolves the
 * active tab id directly off the shell-level tabs-store and looks up its store
 * via `tabRegistry`, the same two primitives App.tsx itself already uses to
 * pick `activeStore` — no new prop/context plumbing needed.
 */
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type SVGProps } from "react";
import { useStore } from "zustand";
import type { McpServerStatus, TelemetryStatus } from "@anycode/core";
import type {
  CatalogSummary,
  CatalogSummaryEntry,
  CustomProviderRecord,
  ProviderConnection,
  ProviderTransportId,
  SecretKey,
  SecretSource,
  SecretStatus,
  SecretTier,
  SettingsPatch,
  SettingsSnapshot,
} from "../../../shared/settings.js";
import type { UpdateStatus } from "../../../shared/updates.js";
import type { WireEnvStatus, WireRepoMapStatus } from "../../../shared/protocol.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { applyThemePreference } from "../theme.js";
import { tabRegistry } from "../tab-registry.js";
import { useTabsStore } from "../tabs-store.js";
import { CodexEnginePane } from "./CodexEnginePane.js";
import { ConnectionDrawer } from "./ConnectionDrawer.js";
import { ConnectionTile, connectionDisplayName, connectionSecretKey } from "./ConnectionTile.js";
import { ConsentDialog } from "./ConsentDialog.js";
import { PermissionsEditor } from "./PermissionsEditor.js";
import { McpServersPane } from "./McpServersPane.js";
import { SkillsPane } from "./SkillsPane.js";
import { SubagentsPane } from "./SubagentsPane.js";
import { ProfilePane } from "./ProfilePane.js";
import { KeyboardShortcutsPane } from "./KeyboardShortcutsPane.js";
import { BrandMark, Check, Chevron, Cube, FileIcon, Gear, ImageIcon, Info, Keyboard, Person, Plus, Robot, Search, ServerStack, Terminal } from "./icons.js";
import { nextRovingIndex } from "./ModeMenu.js";
import { SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";
import { readTurnNotifyEnabled, TURN_NOTIFY_KEY } from "../notifications.js";
import { applyDensity, DENSITY_KEY, readDensity, type Density } from "../density.js";
import "../settings.css";

const API_KEY_ENV_VAR = "ANYCODE_API_KEY";

export type SettingsPaneId = "profile" | "provider" | "codex" | "permissions" | "tools" | "mcp" | "skills" | "subagents" | "environment" | "appearance" | "shortcuts" | "about";

type SettingsIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Exported for SettingsScreen.test.ts (R4/P7.8/P7.16: pins the nav-rail's
 * data-driven pane list). P7.16 W2 (design/slice-P7.16-cut.md §3 table)
 * splits Permissions out of the old "Tools & Permissions" pane into its own
 * rail row, and grows every entry an `icon` (rail glyph) plus a one-line
 * `description` (the right pane's page-title subhead) — the rail stays the
 * single data-driven source for the tablist, the page-title block, AND the
 * search index below. P7.22/F19 W3 (design/slice-P7.22-cut.md §2-D7) inserts
 * "profile" FIRST (ref places Profile at the top of Personal) — the default
 * `requestedPane` initial value stays "provider", unrelated to array order.
 * P7.24/F20 W3 (design/slice-P7.24-cut.md §1.4) inserts "shortcuts" between
 * Appearance and About, mirroring the ref's Personal-section grouping.
 */
export const SETTINGS_PANES: ReadonlyArray<{ id: SettingsPaneId; label: string; description: string; icon: SettingsIcon }> = [
  { id: "profile", label: "Profile", description: "Your usage stats from local telemetry.", icon: Person },
  { id: "provider", label: "Provider", description: "Choose a provider, model, and credentials.", icon: Gear },
  { id: "codex", label: "Codex", description: "Discover, verify, and sign in to the Codex agent engine.", icon: Cube },
  { id: "permissions", label: "Permissions", description: "Rules that let tools run without asking.", icon: Check },
  { id: "tools", label: "Tools", description: "Concurrency, stall timeout, and turn limits.", icon: Terminal },
  { id: "mcp", label: "MCP", description: "Manage MCP servers for this project and your user profile.", icon: ServerStack },
  {
    id: "skills",
    label: "Skills",
    description: "Manage workspace and user skills. Enabled skills can be referenced in chat with $skill-name.",
    icon: FileIcon,
  },
  {
    id: "subagents",
    label: "Subagents",
    description: "Manage built-in, workspace, and user subagent profiles used by the Agent tool.",
    icon: Robot,
  },
  { id: "environment", label: "Environment", description: "Telemetry and repo-map status for this workspace.", icon: Info },
  { id: "appearance", label: "Appearance", description: "Theme, density, and notification preferences.", icon: ImageIcon },
  { id: "shortcuts", label: "Keyboard shortcuts", description: "View and customize keyboard shortcuts.", icon: Keyboard },
  { id: "about", label: "About", description: "App identity, updates, and acknowledgements.", icon: BrandMark },
];

/**
 * Static keyword index behind the rail search (design §3 "Search settings,
 * v1, honest scope"): a per-pane keyword bag, NOT a full-text field index —
 * `filterSettingsPanes` matches only a pane's label + this list, never the
 * content actually rendered inside the pane.
 */
export const SETTINGS_SEARCH_INDEX: Record<SettingsPaneId, readonly string[]> = {
  profile: ["profile", "usage", "stats", "tokens", "streak", "heatmap"],
  provider: ["api key", "model", "base url", "oauth", "sign in", "credentials"],
  codex: ["codex", "agent", "engine", "sign in", "chatgpt", "cli", "binary", "install", "update"],
  permissions: ["always allow", "rules", "bash", "pattern", "tool"],
  tools: ["concurrency", "stall timeout", "max turns", "tool"],
  mcp: ["mcp", "server", "status"],
  skills: ["skill", "skills", "import", "enable"],
  subagents: ["agent", "agents", "subagent", "subagents", "persona", "agent_type", "built-in"],
  environment: ["telemetry", "repo map", "environment"],
  appearance: ["theme", "density", "notifications", "dark", "light", "compact"],
  shortcuts: ["shortcut", "shortcuts", "keyboard", "keybinding", "hotkey", "combo", "record"],
  about: ["version", "update", "acknowledgements", "license"],
};

/**
 * Rail filter (pure — design §3): case-insensitive substring over each
 * pane's label + its `SETTINGS_SEARCH_INDEX` keywords. Empty/whitespace-only
 * query returns every pane id in `SETTINGS_PANES` order (the "all panes"
 * default); a query matching nothing returns `[]` — rendered by the rail as
 * a "No matching settings" empty state, not a special sentinel here.
 */
export function filterSettingsPanes(query: string): SettingsPaneId[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return SETTINGS_PANES.map((pane) => pane.id);
  }
  return SETTINGS_PANES.filter((pane) => {
    if (pane.label.toLowerCase().includes(needle)) {
      return true;
    }
    return SETTINGS_SEARCH_INDEX[pane.id].some((keyword) => keyword.toLowerCase().includes(needle));
  }).map((pane) => pane.id);
}

// ── pure helpers (unit-tested directly — see SettingsScreen.test.ts) ──

export type SecretFieldAction = { type: "change"; value: string } | { type: "submitted" };

/**
 * Reducer backing the masked API-key `<input>`. CUSTODY: `"submitted"`
 * always resets to `""` regardless of what happens next (success / plain
 * refusal / parked-for-consent) — the field itself never holds a value any
 * longer than it takes the user to click Save, and it never re-populates
 * from a `SecretStatus` (which structurally has no value to populate from).
 */
export function secretFieldReducer(state: string, action: SecretFieldAction): string {
  switch (action.type) {
    case "change":
      return action.value;
    case "submitted":
      return "";
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

const TIER_LABEL: Record<SecretTier, string> = {
  os_encrypted: "OS keychain",
  obfuscated: "obfuscated (weak)",
  plaintext: "plain text (weak)",
  unavailable: "unavailable",
};

const SOURCE_LABEL: Record<SecretSource, string> = {
  env: "environment variable",
  vault: "stored",
  plaintext: "stored",
  none: "not set",
};

/** Badge text + tone for a `SecretStatus` — never takes a plaintext value, only the status (design §1). */
export function describeSecretStatus(status: SecretStatus): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!status.set) {
    return { text: "Not set", tone: "muted" };
  }
  const tone: "ok" | "warn" = status.source === "env" || status.tier === "os_encrypted" ? "ok" : "warn";
  return { text: `${SOURCE_LABEL[status.source]} · ${TIER_LABEL[status.tier]}`, tone };
}

/* */
export function isEnvOverridden(envOverrides: readonly string[], envVarName: string): boolean {
  return envOverrides.includes(envVarName);
}

/** Text-input -> `number | undefined`, tolerant of blank/garbage input (garbage -> undefined, main's zod is still the final validator). */
export function parseOptionalInt(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Same blank-omission convention the retired v1 provider patch used, for the `tools` mirror fields. */
export function buildToolsPatch(concurrencyText: string, stallTimeoutText: string, maxTurnsText = ""): SettingsPatch {
  const tools: { concurrency?: number; stallTimeoutMs?: number; maxTurns?: number } = {};
  const concurrency = parseOptionalInt(concurrencyText);
  const stallTimeoutMs = parseOptionalInt(stallTimeoutText);
  const maxTurns = parseOptionalInt(maxTurnsText);
  if (concurrency !== undefined) {
    tools.concurrency = concurrency;
  }
  if (stallTimeoutMs !== undefined) {
    tools.stallTimeoutMs = stallTimeoutMs;
  }
  if (maxTurns !== undefined) tools.maxTurns = maxTurns;
  return { tools };
}

// ── provider-section v2 pure helpers (slice 2.5 §5; reused by ConnectionDrawer/ConnectionTile, TASK.45 W12) ──

/** Looks up the catalog entry matching the currently selected provider id; `undefined` for an empty/absent id, an empty catalog, or an id with no match (all three fold into the same legacy/custom fallback below). */
export function selectProviderEntry(catalog: CatalogSummary, id: string | undefined): CatalogSummaryEntry | undefined {
  if (!id) {
    return undefined;
  }
  return catalog.find((entry) => entry.id === id);
}

/**
 * Whether the baseUrl field should render (design §5 point 2): only the
 * catalog's `custom` entry needs one (`needsBaseUrl`), and "no selection"
 * (legacy, or no catalog at all) is byte-for-byte that same custom/legacy

 */
export function shouldShowBaseUrlField(selectedEntry: CatalogSummaryEntry | undefined): boolean {
  return !selectedEntry || selectedEntry.needsBaseUrl === true;
}

/** Every transport this build knows how to speak — the "custom"/no-selection option set (TASK.43 W5). */
const ALL_TRANSPORTS: ProviderTransportId[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

export const TRANSPORT_LABEL: Record<ProviderTransportId, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-chat-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};

/**
 * Options the transport `<select>` offers (TASK.43 W5, deliberately disposable
 * — W12 absorbs this into a drawer): a catalog entry restricts to its own
 * `supportedTransports` (the `custom` entry itself now declares all three, so
 * it naturally falls out of this same rule — no special-casing needed);
 * "no selection" (legacy, or no catalog at all) offers all three, same
 * "no selection ≡ custom" fold `shouldShowBaseUrlField` uses. NOT keyed off
 * `needsBaseUrl` — `vllm` also needsBaseUrl but must stay restricted to its
 * own (narrower) supportedTransports, unlike custom.
 */
export function transportOptions(selectedEntry: CatalogSummaryEntry | undefined): ProviderTransportId[] {
  return selectedEntry?.supportedTransports ?? ALL_TRANSPORTS;
}

// ── custom model-provider pure helpers (owner-decision #6, cut §9.2, TASK.54) ──
//
// `CustomProviderBridge`'s request/result shapes mirror main/provider-ipc.ts's
// handle* functions structurally (that module owns the actual CRUD/fetch
// logic + the URL/redirect/body-cap threat model; this file only renders and
// never re-implements any of it). The bridge itself is not yet in
// `window.anycode` (anycode-window.d.ts + preload/index.ts are a DIFFERENT
// lane's files — see the handoff report) — `customProviderBridge()` below
// reaches for it with an explicit, narrow cast rather than widening the
// frozen ambient `Window.anycode` type from this file.

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

/** The bridge surface this section drives (structural — tests inject a fake, mirrors `SettingsBridge`). */
export interface CustomProviderBridge {
  create(req: CustomProviderCreateRequest): Promise<CustomProviderMutationResult>;
  update(req: CustomProviderUpdateRequest): Promise<CustomProviderMutationResult>;
  delete(req: { id: string }): Promise<CustomProviderMutationResult>;
  fetchModels(
    req: { id: string } | { baseUrl: string; apiKey?: string; kind?: CustomProviderRecord["kind"] },
  ): Promise<FetchModelsOutcome>;
}

const CUSTOM_PROVIDER_KIND_LABEL: Record<CustomProviderRecord["kind"], string> = {
  "openai-compatible": "OpenAI-compatible (Chat Completions)",
  openai: "OpenAI (Responses)",
  anthropic: "Anthropic Messages",
};

export function customProviderKindLabel(kind: CustomProviderRecord["kind"]): string {
  return CUSTOM_PROVIDER_KIND_LABEL[kind];
}

/** List-row summary line for one saved custom provider — never renders a key (there is none to render, custody by construction). */
export function describeCustomProvider(record: CustomProviderRecord): string {
  const count = record.models.length;
  const modelsText = count === 0 ? "no models selected" : count === 1 ? "1 model" : `${count} models`;
  return `${record.baseUrl} · ${modelsText}`;
}

const CUSTOM_PROVIDER_MUTATION_ERROR_TEXT: Record<CustomProviderMutationReason, string> = {
  invalid: "Check the name, base URL, and API key and try again.",
  read_only: "Settings are read-only (a newer version wrote settings.json) — nothing was saved.",
  not_found: "That custom provider no longer exists.",
  weak_storage_needs_consent:
    "This machine has no secure keychain for storing the key — accept weak storage under Security to save it here.",
};

/** User-facing text for a refused custom-provider mutation. */
export function describeCustomProviderMutationError(reason: CustomProviderMutationReason): string {
  return CUSTOM_PROVIDER_MUTATION_ERROR_TEXT[reason];
}

const FETCH_MODELS_ERROR_TEXT: Record<FetchModelsFailureReason, string> = {
  invalid_request: "That request was invalid.",
  invalid_url: "Only https:// URLs (or http:// on localhost) are allowed.",
  redirect_blocked: "That endpoint redirected to a different address — refused for safety.",
  http_error: "The endpoint returned an error response.",
  response_too_large: "The endpoint's response was too large.",
  timeout: "The endpoint did not respond in time.",
  network_error: "Could not reach that endpoint.",
  invalid_response: "The endpoint's response wasn't a recognizable models list.",
};

/** User-facing text for a failed `/v1/models` fetch. */
export function describeFetchModelsError(reason: FetchModelsFailureReason): string {
  return FETCH_MODELS_ERROR_TEXT[reason];
}

/** Toggles `id` in a checkbox-list selection, preserving the existing order. */
export function toggleSelectedModel(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id];
}

/**
 * Shapes the create-request payload from the form's local state, or
 * `undefined` when a required field is blank — a client-side gate before the
 * IPC round-trip (main's zod schema is still the final validator, same
 * "belt and suspenders" relationship `buildToolsPatch` has with its own
 * server-side counterpart).
 */
export function buildCustomProviderCreateRequest(input: {
  name: string;
  baseUrl: string;
  kind: CustomProviderRecord["kind"];
  apiKey: string;
  selectedModels: readonly string[];
}): CustomProviderCreateRequest | undefined {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  if (name === "" || baseUrl === "" || apiKey === "") {
    return undefined;
  }
  return { name, baseUrl, kind: input.kind, apiKey, models: [...input.selectedModels] };
}

// ── auto-updater pure helpers (slice 2.6 §6) ──

/** Human-readable status line for the Updates section / global banner — renders only what `UpdateStatus` already carries (version/percent/message), never anything else. */
export function updateStatusText(status: UpdateStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "checking":
      return "Checking for updates…";
    case "available":
      // TASK.47 defect 2: darwin has no Developer ID yet — an honest message
      // instead of implying an in-app download/install is possible.
      return status.manualOnly
        ? `Update v${status.version} available — download from GitHub Releases.`
        : `Update v${status.version} available.`;
    case "downloading":
      return `Downloading update… ${status.percent}%`;
    case "downloaded":
      return `Update v${status.version} downloaded — restart to install.`;
    case "not-available":
      return "You're up to date.";
    case "error":
      return `Update check failed: ${status.message}`;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Whether the compact global banner (rendered by `SettingsDialog` even while closed) should show at all — only the two states worth surfacing unprompted (design §6: "non-intrusive"). */
export function shouldShowUpdateBanner(status: UpdateStatus): boolean {
  return status.kind === "available" || status.kind === "downloaded";
}

/**
 * TASK.47 defect 2: whether a status should render the darwin
 * honest-manual-path action (a GitHub Releases link) instead of the normal
 * in-app Download button. Only ever true for `available`; `downloaded` never
 * carries `manualOnly` because `download()` itself refuses `manual_only` on
 * darwin (main/updater.ts), so that state is structurally unreachable there.
 * Deliberately a plain `boolean` (not a `status is …` type predicate) —
 * TypeScript would otherwise narrow the ELSE branch of a ternary using this
 * to exclude EVERY `available` value (manualOnly true or false alike), not
 * just the manual-only ones; call sites re-check `status.kind === "available"`
 * themselves wherever they need the narrowed `version` field.
 */
export function showsManualUpdateLink(status: UpdateStatus): boolean {
  return status.kind === "available" && status.manualOnly === true;
}

/**
 * TASK.49/W14-fix: whether the About pane should render the running app's
 * version line — extracted into a pure, exported gate (same pattern as
 * `shouldShowUpdateBanner`/`showsManualUpdateLink` above) because this
 * package's tests run with no DOM/jsdom (SettingsScreen.test.ts's own
 * docstring), so this is the level at which "present -> renders, absent ->
 * does not render" is directly assertable. `appVersion` is absent whenever
 * main's `SettingsIpcDeps.getAppVersion` isn't supplied (settings-ipc.ts).
 */
export function shouldShowAppVersion(snapshot: Pick<SettingsSnapshot, "appVersion">): boolean {
  return snapshot.appVersion !== undefined;
}

export type McpRowKind = "running" | "completed" | "failed" | "idle";

/**
 * Presentation mapping for one MCP server row (slice R16): the R14 substatus
 * kind driving the row's glyph cell + the human detail string: connected ->
 * tool count (singular/plural, with an honest "truncated" marker when caps
 * dropped tools), failed -> the server's own error (bare "failed" fallback),
 * connecting/closed -> the state word.
 */
export function describeMcpServer(server: McpServerStatus): { kind: McpRowKind; detail: string } {
  switch (server.state) {
    case "connecting":
      return { kind: "running", detail: "connecting…" };
    case "connected": {
      const tools = `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
      return { kind: "completed", detail: server.toolsTruncated ? `${tools} · truncated` : tools };
    }
    case "failed":
      return { kind: "failed", detail: server.error ?? "failed" };
    case "closed":
      return { kind: "idle", detail: "closed" };
    default: {
      const exhaustive: never = server.state;
      return exhaustive;
    }
  }
}

/** Bespoke OAuth-flavoured status text ("Signed in"/"Not signed in") built from `SecretStatus` alone — same custody shape as `describeSecretStatus`, never a token. */
export function describeOAuthStatus(status: SecretStatus | undefined): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!status || !status.set) {
    return { text: "Not signed in", tone: "muted" };
  }
  const tone: "ok" | "warn" = status.source === "env" || status.tier === "os_encrypted" ? "ok" : "warn";
  return { text: "Signed in", tone };
}

/**
 * Environment pane text (slice P7.8, design slice-P7.8-cut.md §3.5): read-only
 * status + how-to-enable hint. `null` means the feature is opt-in and not
 * configured for this workspace — not an error, hence "muted" not "warn".
 */
export function describeTelemetryRow(s: TelemetryStatus | null): { text: string; tone: "ok" | "muted" | "warn" } {
  if (!s) {
    return {
      text: 'Disabled — opt-in via .anycode/config.json: { "telemetry": { "enabled": true } }',
      tone: "muted",
    };
  }
  const tone: "ok" | "warn" = s.dropped > 0 || s.lastWriteError ? "warn" : "ok";
  return { text: `Enabled — ${s.filePath} · ${s.written} written · ${s.dropped} dropped`, tone };
}

export function describeRepoMapRow(s: WireRepoMapStatus | null): { text: string; tone: "ok" | "muted" } {
  if (!s) {
    return {
      text: "Disabled — enable via ANYCODE_REPO_MAP=1 or .anycode/config.json: { \"repoMap\": { \"enabled\": true } }",
      tone: "muted",
    };
  }
  const truncatedSuffix = s.truncated ? " · truncated" : "";
  return {
    text: `Enabled — ${s.includedCount} of ${s.fileCount} files in system prompt · ~${s.maxTokens}-token budget${truncatedSuffix}`,
    tone: "ok",
  };
}

/**
 * Subscribes to the ACTIVE tab's `mcpServers` slice (design §6, task 3.2.4).
 * `SettingsScreen`/`SettingsDialog` are mounted outside any
 * `<TabContext.Provider>` (see the file-header note above), so this can't use
 * `useTabStore` like the migrated per-tab components do — instead it reads
 * the active tab id off the shell-level tabs-store and looks up that tab's
 * `DesktopStore` via `tabRegistry` directly, subscribing manually since the
 * underlying store INSTANCE itself changes whenever the active tab changes
 * (or there is none yet, e.g. WelcomeScreen's embed pre-configuration — []).
 */
function useActiveMcpServers(): McpServerStatus[] {
  const activeTabId = useStore(useTabsStore, (state) => state.activeTabId);
  const [servers, setServers] = useState<McpServerStatus[]>([]);

  useEffect(() => {
    const tabStore = activeTabId ? tabRegistry.getStore(activeTabId) : undefined;
    if (!tabStore) {
      setServers([]);
      return;
    }
    setServers(tabStore.getState().mcpServers);
    return tabStore.subscribe((state) => setServers(state.mcpServers));
  }, [activeTabId]);

  return servers;
}

/** Byte-for-byte mirror of `useActiveMcpServers` above, over `envStatus` instead (slice P7.8 §3.5). */
function useActiveEnvStatus(): WireEnvStatus | null {
  const activeTabId = useStore(useTabsStore, (state) => state.activeTabId);
  const [envStatus, setEnvStatus] = useState<WireEnvStatus | null>(null);

  useEffect(() => {
    const tabStore = activeTabId ? tabRegistry.getStore(activeTabId) : undefined;
    if (!tabStore) {
      setEnvStatus(null);
      return;
    }
    setEnvStatus(tabStore.getState().envStatus);
    return tabStore.subscribe((state) => setEnvStatus(state.envStatus));
  }, [activeTabId]);

  return envStatus;
}

// ── components ──

/** The action a tile's "Replace key"/"Sign in" control resolves to for one connection (TASK.45 W12-FIX §1). */
export type ReplaceKeyAction =
  | { kind: "oauthStart"; providerId: string; connectionId: string }
  | { kind: "clearSecret"; key: SecretKey };

/**
 * Resolves `openReplaceKey`'s action (TASK.45 W12-FIX §1): an OAuth connection
 * with no stored token starts a sign-in SCOPED TO THIS CONNECTION — never a
 * provider-wide bucket guess, the custody defect this fix closes (a sign-in
 * on a non-active same-provider connection must not land on the active one's
 * credential) — one with a token clears it, and a non-oauth connection falls
 * through to the drawer's credential field (`undefined`). Exported for direct
 * testing: this package's vitest config has no jsdom (see
 * ConnectionDrawer.test.ts's docstring), so click-driven behavior is proven
 * pure-logic here and end-to-end by the live smoke script.
 */
export function resolveReplaceKeyAction(
  connection: ProviderConnection,
  catalogEntry: CatalogSummaryEntry | undefined,
  secrets: readonly SecretStatus[],
): ReplaceKeyAction | undefined {
  if (catalogEntry?.authKind !== "oauth") {
    return undefined;
  }
  const key = connectionSecretKey(connection.id, "oauth");
  const status = secrets.find((s) => s.key === key);
  if (status?.set) {
    return { kind: "clearSecret", key };
  }
  return { kind: "oauthStart", providerId: connection.providerId, connectionId: connection.id };
}

/**
 * Reaches for `window.anycode.customProvider` (owner-decision #6, cut §9.2,
 * TASK.54) — not yet part of the frozen ambient `Window.anycode` type
 * (anycode-window.d.ts + preload/index.ts belong to a different lane, see the
 * handoff report), so this is an explicit, narrow, LAZILY-evaluated cast
 * (never touched at module load, same discipline `settings-store.ts`'s
 * `realBridge()` uses) rather than widening that frozen type from here.
 */
function customProviderBridge(): CustomProviderBridge {
  return (window as unknown as { anycode: { customProvider: CustomProviderBridge } }).anycode.customProvider;
}

export interface CustomProvidersSectionProps {
  providers: readonly CustomProviderRecord[];
  readOnly: boolean;
  /** Called after any successful mutation so the caller can reload the snapshot (`store.getState().load()`). */
  onChanged: () => void;
  /** Injectable for tests / isolation; defaults to the real `window.anycode.customProvider`. */
  bridge?: CustomProviderBridge;
}

/**
 * Custom OpenAI-compatible model-provider management (owner-decision #6, cut
 * §9.2, TASK.54): a list of saved endpoints (name/baseUrl/model count) each
 * with a Delete action, plus an "Add custom provider" form (name/baseUrl/
 * kind/key) whose "Fetch models" step calls main (the renderer never holds a
 * key long enough to call an arbitrary origin itself) and renders the
 * returned ids as checkboxes — only the CHECKED subset is what `Save` sends
 * on to `customProviderCreate`, becoming the record's curated `models[]`.
 * CUSTODY: the apiKey field is write-only, cleared by `resetForm` the instant
 * a request is sent (success OR refusal) — mirrors `secretFieldReducer`'s
 * "submitted always clears" rule; this component never receives a decrypted
 * key back (`CustomProviderMutationResult`/`FetchModelsOutcome` structurally
 * cannot carry one).
 */
function CustomProvidersSection({ providers, readOnly, onChanged, bridge }: CustomProvidersSectionProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [kind, setKind] = useState<CustomProviderRecord["kind"]>("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [fetchedModels, setFetchedModels] = useState<{ id: string }[] | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resolvedBridge(): CustomProviderBridge {
    return bridge ?? customProviderBridge();
  }

  function resetForm(): void {
    setName("");
    setBaseUrl("");
    setKind("openai-compatible");
    setApiKey("");
    setFetchedModels(null);
    setSelectedModels([]);
    setFormOpen(false);
  }

  async function doFetchModels(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const trimmedKey = apiKey.trim();
      const outcome = await resolvedBridge().fetchModels({
        baseUrl: baseUrl.trim(),
        kind,
        ...(trimmedKey !== "" ? { apiKey: trimmedKey } : {}),
      });
      if (!outcome.ok) {
        setError(describeFetchModelsError(outcome.reason));
        return;
      }
      setFetchedModels(outcome.models);
      setSelectedModels(outcome.models.map((m) => m.id));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    const req = buildCustomProviderCreateRequest({ name, baseUrl, kind, apiKey, selectedModels });
    if (req === undefined) {
      setError("Name, base URL, and API key are all required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await resolvedBridge().create(req);
      if (!result.ok) {
        setError(describeCustomProviderMutationError(result.reason));
        return;
      }
      resetForm();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await resolvedBridge().delete({ id });
      if (!result.ok) {
        setError(describeCustomProviderMutationError(result.reason));
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">Custom providers</div>
      {providers.length === 0 && (
        <p className="connection-grid-empty">No custom endpoints yet.</p>
      )}
      {providers.length > 0 && (
        <ul className="connection-grid" role="list" aria-label="Custom providers">
          {providers.map((p) => (
            <li role="listitem" key={p.id}>
              <div className="settings-field-row">
                <span>
                  {p.name} — {customProviderKindLabel(p.kind)}
                </span>
                <span>{describeCustomProvider(p)}</span>
                <button
                  type="button"
                  className="settings-button settings-button-danger"
                  disabled={readOnly || busy}
                  onClick={() => void remove(p.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error !== null && (
        <p className="settings-notice" role="alert">
          {error}
        </p>
      )}
      {!formOpen ? (
        <button type="button" className="settings-button" disabled={readOnly} onClick={() => setFormOpen(true)}>
          + Add custom provider
        </button>
      ) : (
        <>
          <label className="settings-field">
            <span className="settings-field-label">Name</span>
            <input
              className="settings-field-input"
              type="text"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Base URL</span>
            <input
              className="settings-field-input"
              type="text"
              placeholder="https://api.example.com"
              value={baseUrl}
              disabled={busy}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">Kind</span>
            <select
              className="settings-field-select"
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as CustomProviderRecord["kind"])}
            >
              <option value="openai-compatible">{customProviderKindLabel("openai-compatible")}</option>
              <option value="openai">{customProviderKindLabel("openai")}</option>
              <option value="anthropic">{customProviderKindLabel("anthropic")}</option>
            </select>
          </label>
          <label className="settings-field">
            <span className="settings-field-label">API key</span>
            <input
              className="settings-field-input"
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={busy}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <div className="settings-field-row">
            <button
              type="button"
              className="settings-button"
              disabled={busy || baseUrl.trim() === ""}
              onClick={() => void doFetchModels()}
            >
              Fetch models
            </button>
          </div>
          {fetchedModels !== null && (
            <fieldset className="settings-field">
              <legend className="settings-field-label">Models to show in the selector</legend>
              {fetchedModels.map((m) => (
                <label key={m.id} className="settings-field-row">
                  <input
                    type="checkbox"
                    checked={selectedModels.includes(m.id)}
                    onChange={() => setSelectedModels((prev) => toggleSelectedModel(prev, m.id))}
                  />
                  {m.id}
                </label>
              ))}
            </fieldset>
          )}
          <div className="settings-field-row">
            <button type="button" className="settings-button settings-button-primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="settings-button" disabled={busy} onClick={resetForm}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export interface ProviderSettingsProps {
  /** Injectable for tests / isolation; defaults to the app's singleton settings-store. */
  store?: SettingsStoreApi;
}

/**
 * Provider connections grid + drawer (TASK.45 W12, replacing the R11 singleton
 * form): a compact responsive grid of `ConnectionTile`s — one per user-created
 * connection — plus a trailing `+ Add connection` tile and, when an
 * `ANYCODE_API_KEY`-family env var overrides the runtime, a read-only
 * "Environment override" banner (cut §5: its outcome must never repaint a
 * stored connection's plaquette). Clicking a tile's body makes it the default
 * for NEW sessions (`connection-set-active`); Edit/Replace key/Check/Delete
 * live in the tile's own menu, never behind a body click (design §4). The
 * `ConnectionDrawer` (add/edit) and the weak-storage `ConsentDialog`
 * (`pendingConsent` only ever arises from a `setSecret` call, which now lives
 * inside the drawer) are the two dialogs this pane owns. Two consumers:
 * SettingsScreen below (dialog) and WelcomeScreen (first-run, cut §"Отдельный
 * first-run empty state") — WelcomeScreen conditionally narrows the grid to a
 * single first-connection prompt, see its own file.
 */
export function ProviderSettings({ store = useSettingsStore }: ProviderSettingsProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const pendingConsent = useStore(store, (s) => s.pendingConsent);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<"add" | "edit">("add");
  const [drawerConnectionId, setDrawerConnectionId] = useState<string | null>(null);
  const [drawerFocus, setDrawerFocus] = useState<"label" | "credential">("label");
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(new Set());
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Unreachable from both real mounts (SettingsScreen early-returns its own
  // loading row before this renders; App only mounts Welcome once the first
  // snapshot has loaded) — a null guard, not a loading state.
  if (!snapshot) {
    return null;
  }

  const readOnly = snapshot.readOnly;
  const catalog: CatalogSummary = snapshot.catalog ?? [];
  const connections = snapshot.settings.provider.connections;
  const activeConnectionId = snapshot.settings.provider.activeConnectionId;
  const envOverridden = isEnvOverridden(snapshot.envOverrides, API_KEY_ENV_VAR);
  // Captured as a plain local (not re-read off `snapshot` inside the nested
  // functions below) so TS's null-narrowing of `snapshot` — which does not
  // cross a nested function boundary — stays sound (same discipline the old
  // ProviderSettings singleton form used for `storedBaseUrl`).
  const secrets = snapshot.secrets;
  const editConnection = drawerConnectionId !== null ? connections.find((c) => c.id === drawerConnectionId) : undefined;
  // Roving focus targets: every tile's select-button, then the trailing "+
  // Add connection" tile (design §"Компактная сетка": keyboard navigation
  // across the whole grid, add tile included).
  const rovingCount = connections.length + 1;

  function openAdd(): void {
    setDrawerMode("add");
    setDrawerConnectionId(null);
    setDrawerFocus("label");
    setDrawerOpen(true);
  }

  function openEdit(id: string): void {
    setDrawerMode("edit");
    setDrawerConnectionId(id);
    setDrawerFocus("label");
    setDrawerOpen(true);
  }

  function openReplaceKey(connection: ProviderConnection, catalogEntry: CatalogSummaryEntry | undefined): void {
    // An OAuth connection's "Replace key" IS the sign-in/out toggle itself —
    // no drawer needed, mirroring the old OAuthCredentialBlock's direct action.
    const action = resolveReplaceKeyAction(connection, catalogEntry, secrets);
    if (action !== undefined) {
      if (action.kind === "clearSecret") {
        void store.getState().clearSecret(action.key);
      } else {
        void store.getState().oauthStart(action.providerId, action.connectionId);
      }
      return;
    }
    setDrawerMode("edit");
    setDrawerConnectionId(connection.id);
    setDrawerFocus("credential");
    setDrawerOpen(true);
  }

  async function check(id: string): Promise<void> {
    setCheckingIds((prev) => new Set(prev).add(id));
    try {
      await store.getState().connectionCheck({ id });
    } finally {
      setCheckingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function onTileKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = nextRovingIndex(index, 1, rovingCount);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = nextRovingIndex(index, -1, rovingCount);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rovingCount - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    tileRefs.current[next]?.focus();
  }

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Provider connections</div>
        {envOverridden && (
          <div className="connection-env-banner" role="status">
            <span className="connection-env-banner-label">Environment override</span>
            <span>
              {API_KEY_ENV_VAR} is set in the environment — it overrides every stored connection for new
              sessions. Your saved connections are unaffected and remain selected for later.
            </span>
          </div>
        )}
        <div className="connection-grid" role="list" aria-label="Provider connections">
          {connections.map((connection, index) => {
            const catalogEntry = selectProviderEntry(catalog, connection.providerId || undefined);
            const authKind = catalogEntry?.authKind ?? "api_key";
            const credentialStatus = snapshot.secrets.find((s) => s.key === connectionSecretKey(connection.id, authKind));
            const displayName = connectionDisplayName(connection, catalogEntry?.name ?? "Custom", connections);
            return (
              <div role="listitem" key={connection.id}>
                <ConnectionTile
                  connection={connection}
                  catalogEntry={catalogEntry}
                  displayName={displayName}
                  credentialStatus={credentialStatus}
                  selected={connection.id === activeConnectionId}
                  checking={checkingIds.has(connection.id)}
                  readOnly={readOnly}
                  tabIndex={index === 0 ? 0 : -1}
                  tileRef={(el) => {
                    tileRefs.current[index] = el;
                  }}
                  onSelect={() => {
                    if (connection.id !== activeConnectionId) {
                      void store.getState().connectionSetActive({ id: connection.id });
                    }
                  }}
                  onEdit={() => openEdit(connection.id)}
                  onReplaceKey={() => openReplaceKey(connection, catalogEntry)}
                  onCheck={() => void check(connection.id)}
                  onDelete={() => void store.getState().connectionDelete({ id: connection.id })}
                  onKeyDownRoving={(e) => onTileKeyDown(e, index)}
                />
              </div>
            );
          })}
          <button
            type="button"
            className="connection-tile connection-tile-add"
            tabIndex={connections.length === 0 ? 0 : -1}
            disabled={readOnly}
            ref={(el) => {
              tileRefs.current[connections.length] = el;
            }}
            onClick={openAdd}
            onKeyDown={(e) => onTileKeyDown(e, connections.length)}
          >
            <Plus aria-hidden="true" />
            <span>Add connection</span>
          </button>
        </div>
        {connections.length === 0 && (
          <p className="connection-grid-empty">No connections yet — add one to start a session.</p>
        )}
      </section>

      <CustomProvidersSection
        providers={snapshot.settings.provider.custom ?? []}
        readOnly={readOnly}
        onChanged={() => void store.getState().load()}
      />

      <ConnectionDrawer
        open={drawerOpen}
        mode={drawerMode}
        editConnection={editConnection}
        catalog={catalog}
        connections={connections}
        secrets={snapshot.secrets}
        readOnly={readOnly}
        initialFocus={drawerFocus}
        onClose={() => setDrawerOpen(false)}
        store={store}
      />

      <ConsentDialog
        open={pendingConsent !== null}
        onAccept={() => void store.getState().acceptWeakStorageConsent()}
        onDecline={() => store.getState().declineWeakStorageConsent()}
      />
    </>
  );
}

export interface SettingsScreenProps {
  /** Injectable for tests / isolation; defaults to the app's singleton settings-store. */
  store?: SettingsStoreApi;
  /** Present when mounted inside `SettingsDialog` (App.tsx's ready-state settings button) — renders a close "×". Omitted when embedded directly in WelcomeScreen, which has no dialog to close. */
  onClose?: () => void;
  /**
   * P7.23/F24 W2 pane-select seam (cut §4.6): the pane a slash-menu command
   * (MCP/Skills) asked to land on, forwarded down from `SettingsDialog`'s
   * always-mounted `SETTINGS_SELECT_PANE_EVENT` listener — see that
   * component's own comment for why the listener lives there and not here.
   * Seeds `requestedPane`'s initial value (so a fresh open lands directly on
   * the right pane, no flash of "provider") AND is re-applied on every
   * change via an effect below (so a second command while the dialog is
   * ALREADY open still switches panes).
   */
  initialPane?: SettingsPaneId;
}

export function SettingsScreen({ store = useSettingsStore, onClose, initialPane }: SettingsScreenProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const notice = useStore(store, (s) => s.notice);
  const updateStatus = useStore(store, (s) => s.updateStatus);
  // Slice 3.2 §6 (task 3.2.4): the active tab's MCP status, independent of
  // `store` above (that's the settings-store; MCP status lives on the
  // per-tab desktop store instead — see the hook's own doc comment).
  const mcpServers = useActiveMcpServers();
  // P7.19/F22 W3 (design/slice-P7.19-cut.md §4 W3): the active tab id, so
  // McpServersPane's bridge calls resolve a project-scope workspace
  // main-side (the renderer never supplies a filesystem path — tabId only,
  // design §3 trust boundary). Read directly off the shell-level tabs-store,
  // same primitive `useActiveMcpServers` above already uses internally.
  const activeTabId = useStore(useTabsStore, (state) => state.activeTabId);
  // Slice P7.8 §3.5: same per-tab data source as mcpServers above, mirrored.
  const envStatus = useActiveEnvStatus();

  // Slice 2.6 §6: wires the push status subscription for as long as this
  // screen is mounted (WelcomeScreen's embed gets live feedback while
  // visible; `SettingsDialog` below additionally keeps its own subscription
  // running for the whole app lifetime so the compact banner still updates
  // while the dialog itself is closed — see that component's own comment).
  useEffect(() => {
    return store.getState().subscribeUpdates();
  }, [store]);

  const [initialized, setInitialized] = useState(false);
  const [concurrency, setConcurrency] = useState("");
  const [stallTimeoutMs, setStallTimeoutMs] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  // R8(d): device-local preference — localStorage, NOT the settings vault
  // (no IPC, no snapshot field). Deliberately ignores readOnly: a locked
  // vault blocks vault WRITES; this key never touches the vault. Initializer
  // re-reads per mount (Welcome embed and dialog both get the live value).
  const [notifyTurnEnd, setNotifyTurnEnd] = useState(() => readTurnNotifyEnabled());
  // R19: device-local like the notification toggle above — same localStorage
  // rationale, same deliberate readOnly bypass. Initializer re-reads per mount.
  const [density, setDensity] = useState<Density>(() => readDensity());

  const [requestedPane, setRequestedPane] = useState<SettingsPaneId>(() => initialPane ?? "provider");
  const [searchQuery, setSearchQuery] = useState("");
  const navRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // P7.23/F24 W2: re-applies `initialPane` on every change, not just at
  // mount — the initializer above covers a fresh open (dialog was closed,
  // this mount IS the "settings.open" transition, cut §4.6's pairing), this
  // effect covers a second slash-menu command landing while the dialog is
  // ALREADY open (the prop changes on an already-mounted component, which an
  // initializer alone would never see). A no-op re-set on the mount render
  // (the initializer already used the same value) bails out for free —
  // React skips the re-render when the new state equals the old.
  useEffect(() => {
    if (initialPane !== undefined) {
      setRequestedPane(initialPane);
    }
  }, [initialPane]);

  // Rail filter (design §3): `visiblePanes` narrows on `searchQuery`, and
  // `activePane` falls back to the first visible match whenever the user's
  // actual selection (`requestedPane`) has been filtered out — deliberately
  // NOT synced back into `requestedPane` itself, so clearing the search
  // restores exactly what was selected before.
  const visiblePaneIds = filterSettingsPanes(searchQuery);
  const visiblePanes = SETTINGS_PANES.filter((pane) => visiblePaneIds.includes(pane.id));
  const activePane: SettingsPaneId | undefined = visiblePanes.some((pane) => pane.id === requestedPane)
    ? requestedPane
    : visiblePanes[0]?.id;

  function onNavKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const count = visiblePanes.length;
    if (count === 0) {
      return;
    }
    const current = visiblePanes.findIndex((pane) => pane.id === activePane);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = nextRovingIndex(current, 1, count); break;
      case "ArrowUp":   next = nextRovingIndex(current, -1, count); break;
      case "Home":      next = 0; break;
      case "End":       next = count - 1; break;
      default: return;
    }
    event.preventDefault();
    setRequestedPane(visiblePanes[next]!.id);
    navRefs.current[next]?.focus();
  }

  // Seeds the local form fields from the first snapshot that arrives (once —
  // re-syncing on every later snapshot would clobber in-progress typing with
  // whatever the store happens to hold after an unrelated mutation, e.g. an
  // always-allow rule removed from another part of this same screen).
  useEffect(() => {
    if (!initialized && snapshot) {
      setConcurrency(snapshot.settings.tools.concurrency?.toString() ?? "");
      setStallTimeoutMs(snapshot.settings.tools.stallTimeoutMs?.toString() ?? "");
      setMaxTurns(snapshot.settings.tools.maxTurns?.toString() ?? "");
      setTheme(snapshot.settings.ui.theme);
      setInitialized(true);
    }
  }, [snapshot, initialized]);

  if (!snapshot) {
    return (
      <div className="settings-screen">
        <div className="settings-shell">
          <div className="settings-rail">
            <div className="settings-rail-header">
              {onClose && (
                <button type="button" className="settings-back" onClick={onClose}>
                  <Chevron className="settings-back-chevron" />
                  Back to app
                </button>
              )}
            </div>
          </div>
          <div className="settings-content">
            <div className="settings-screen-loading">Loading settings…</div>
          </div>
        </div>
      </div>
    );
  }

  const readOnly = snapshot.readOnly;

  async function saveTools(): Promise<void> {
    await store.getState().setPatch(buildToolsPatch(concurrency, stallTimeoutMs, maxTurns));
  }

  function changeTheme(next: "system" | "light" | "dark"): void {
    setTheme(next);
    // Applies the preference live via theme.ts (design §2.5), which resolves
    // "system" to a concrete "light"/"dark" before stamping `<html data-theme>`
    // — unlike the old raw `dataset.theme = next` write, which stamped the
    // literal "system" that no CSS can consume. Persistence still flows through
    // setPatch; App.tsx's snapshot subscription re-applies the same resolved
    // value idempotently when that round-trip lands.
    applyThemePreference(next);
    void store.getState().setPatch({ ui: { theme: next } });
  }

  function toggleNotifyTurnEnd(): void {
    const next = !notifyTurnEnd;
    setNotifyTurnEnd(next);
    try {
      localStorage.setItem(TURN_NOTIFY_KEY, String(next));
    } catch {
      // Storage unavailable — the toggle still applies for this session's
      // reads that go through component state; readers fail open to enabled.
    }
    // Permission ask rides the enable gesture — never a surprise prompt.
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }

  function toggleDensity(): void {
    const next: Density = density === "compact" ? "comfortable" : "compact";
    setDensity(next);
    applyDensity(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      // Storage unavailable — the attribute is already stamped, so the mode
      // still applies for this window; it resets to the compact default on reload.
    }
  }

  const activePaneRecord = SETTINGS_PANES.find((pane) => pane.id === activePane);

  return (
    <div className="settings-screen">
      <div className="settings-shell">
        <div className="settings-rail">
          <div className="settings-rail-header">
            {onClose && (
              <button type="button" className="settings-back" onClick={onClose}>
                <Chevron className="settings-back-chevron" />
                Back to app
              </button>
            )}
          </div>

          <label className="settings-search">
            <Search className="settings-search-icon" />
            <input
              type="text"
              className="settings-search-input"
              placeholder="Search settings"
              aria-label="Search settings"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>

          <div
            className="settings-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={onNavKeyDown}
          >
            {visiblePanes.map((pane, index) => {
              const active = pane.id === activePane;
              const PaneIcon = pane.icon;
              return (
                <button
                  key={pane.id}
                  ref={(el) => { navRefs.current[index] = el; }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${pane.id}`}
                  aria-selected={active}
                  aria-controls={active ? `settings-pane-${pane.id}` : undefined}
                  tabIndex={active ? 0 : -1}
                  className="settings-nav-item"
                  onClick={() => setRequestedPane(pane.id)}
                >
                  <PaneIcon />
                  <span>{pane.label}</span>
                </button>
              );
            })}
            {visiblePanes.length === 0 && <div className="settings-nav-empty">No matching settings</div>}
          </div>
        </div>

        <div className="settings-content">
          {activePaneRecord && (
            <div className="settings-content-header">
              <h2 className="settings-page-title">{activePaneRecord.label}</h2>
              <p className="settings-page-description">{activePaneRecord.description}</p>
              {readOnly && (
                <div className="settings-banner-readonly" role="alert">
                  Settings file is a newer version than this app understands — changes are
                  disabled until you upgrade.
                </div>
              )}
              {notice && (
                <div className="settings-notice" role="alert">
                  {notice}
                </div>
              )}
            </div>
          )}

          {activePane && (
          <div
            key={activePane}
            className="settings-pane"
            role="tabpanel"
            id={`settings-pane-${activePane}`}
            aria-labelledby={`settings-tab-${activePane}`}
            tabIndex={0}
          >
            {activePane === "profile" && <ProfilePane />}

            {activePane === "provider" && <ProviderSettings store={store} />}

            {activePane === "codex" && <CodexEnginePane />}

            {activePane === "permissions" && <PermissionsEditor store={store} />}

            {activePane === "tools" && (
              <section className="settings-section">
                <div className="settings-section-title">Tools</div>
                <label className="settings-field">
                  <span className="settings-field-label">Tool concurrency</span>
                  <input
                    className="settings-field-input"
                    type="text"
                    inputMode="numeric"
                    value={concurrency}
                    disabled={readOnly}
                    placeholder="(default)"
                    onChange={(e) => setConcurrency(e.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">Stall timeout (ms)</span>
                  <input
                    className="settings-field-input"
                    type="text"
                    inputMode="numeric"
                    value={stallTimeoutMs}
                    disabled={readOnly}
                    placeholder="(default)"
                    onChange={(e) => setStallTimeoutMs(e.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">Maximum turns</span>
                  <input className="settings-field-input" type="text" inputMode="numeric" value={maxTurns}
                    disabled={readOnly} placeholder="100" onChange={(e) => setMaxTurns(e.target.value)} />
                </label>
                <div className="settings-field-row">
                  <button type="button" className="settings-button settings-button-primary" disabled={readOnly} onClick={() => void saveTools()}>
                    Save tools settings
                  </button>
                </div>
              </section>
            )}

          {activePane === "mcp" && <McpServersPane servers={mcpServers} tabId={activeTabId ?? undefined} />}

          {activePane === "skills" && <SkillsPane tabId={activeTabId ?? undefined} />}

          {activePane === "subagents" && <SubagentsPane tabId={activeTabId ?? undefined} />}

          {activePane === "environment" && (
            <>
              {envStatus ? (
                <>
                  <section className="settings-section">
                    <div className="settings-section-title">Telemetry</div>
                    <div className="settings-field-row">
                      {(() => {
                        const described = describeTelemetryRow(envStatus.telemetry);
                        return (
                          <span className={`settings-secret-status settings-secret-status-${described.tone}`}>
                            {described.text}
                          </span>
                        );
                      })()}
                    </div>
                    {envStatus.telemetry?.lastWriteError && (
                      <div className="settings-field-row">
                        <span className="settings-env-warning">Last write error: {envStatus.telemetry.lastWriteError}</span>
                      </div>
                    )}
                  </section>
                  <section className="settings-section">
                    <div className="settings-section-title">Repo map</div>
                    <div className="settings-field-row">
                      {(() => {
                        const described = describeRepoMapRow(envStatus.repoMap);
                        return (
                          <span className={`settings-secret-status settings-secret-status-${described.tone}`}>
                            {described.text}
                          </span>
                        );
                      })()}
                    </div>
                  </section>
                </>
              ) : (
                <section className="settings-section">
                  <div className="settings-section-title">Environment</div>
                  <div className="settings-mcp-empty">Status unavailable for this tab.</div>
                </section>
              )}
            </>
          )}

          {activePane === "appearance" && (
            <>
              <section className="settings-section">
                <div className="settings-section-title">Appearance</div>
                <label className="settings-field">
                  <span className="settings-field-label">Theme</span>
                  <select
                    className="settings-field-select"
                    value={theme}
                    disabled={readOnly}
                    onChange={(e) => changeTheme(e.target.value as "system" | "light" | "dark")}
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <div className="settings-field">
                  <span className="settings-field-label">Density</span>
                  <div className="settings-field-row">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={density === "compact"}
                      aria-labelledby="settings-density-caption"
                      className={`settings-switch${density === "compact" ? " settings-switch-on" : ""}`}
                      onClick={toggleDensity}
                    >
                      <span className="settings-switch-thumb" />
                    </button>
                    <span id="settings-density-caption" className="settings-switch-caption">
                      Compact — tighter spacing and smaller interface text
                    </span>
                  </div>
                </div>
                <div className="settings-field">
                  <span className="settings-field-label">Notifications</span>
                  <div className="settings-field-row">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={notifyTurnEnd}
                      aria-labelledby="settings-notify-turn-caption"
                      className={`settings-switch${notifyTurnEnd ? " settings-switch-on" : ""}`}
                      onClick={toggleNotifyTurnEnd}
                    >
                      <span className="settings-switch-thumb" />
                    </button>
                    <span id="settings-notify-turn-caption" className="settings-switch-caption">
                      Notify when a turn finishes in the background
                    </span>
                  </div>
                </div>
              </section>
            </>
          )}

          {activePane === "shortcuts" && <KeyboardShortcutsPane store={store} />}

          {activePane === "about" && (
            <>
              <section className="settings-section">
                <div className="settings-section-title">About</div>
                <div className="settings-about-identity">
                  <BrandMark className="settings-about-mark" />
                  <div className="settings-about-text">
                    <span className="settings-about-name">
                      <span className="welcome-wordmark-any">Any</span>Code
                    </span>
                    <div className="welcome-ramp" aria-hidden="true">
                      <span className="welcome-ramp-dot welcome-ramp-plan" />
                      <span className="welcome-ramp-dot welcome-ramp-build" />
                      <span className="welcome-ramp-dot welcome-ramp-edit" />
                      <span className="welcome-ramp-dot welcome-ramp-auto" />
                      <span className="welcome-ramp-dot welcome-ramp-yolo" />
                    </div>
                    <span className="settings-about-tag">A coding agent for any provider.</span>
                    {shouldShowAppVersion(snapshot) && (
                      <span className="settings-about-version">Version {snapshot.appVersion}</span>
                    )}
                  </div>
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section-title">Updates</div>
                <div className="settings-field-row">
                  <span className="settings-update-status">{updateStatusText(updateStatus)}</span>
                </div>
                <div className="settings-field-row">
                  {updateStatus.kind === "downloaded" ? (
                    <button
                      type="button"
                      className="settings-button settings-button-primary"
                      onClick={() => void store.getState().installUpdate()}
                    >
                      Restart to install
                    </button>
                  ) : updateStatus.kind === "available" ? (
                    updateStatus.manualOnly ? (
                      // TASK.47 defect 2: darwin has no Developer ID yet — an
                      // in-app Download button would only fail (Squirrel.Mac
                      // rejects the ad-hoc signature mismatch), so this opens
                      // the release page instead of downloading anything.
                      <button
                        type="button"
                        className="settings-button settings-button-primary"
                        onClick={() => void store.getState().openReleasesUpdate()}
                      >
                        Open GitHub Releases
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="settings-button settings-button-primary"
                        onClick={() => void store.getState().downloadUpdate()}
                      >
                        Download v{updateStatus.version}
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className="settings-button"
                      disabled={updateStatus.kind === "checking" || updateStatus.kind === "downloading"}
                      onClick={() => void store.getState().checkForUpdates()}
                    >
                      Check for updates
                    </button>
                  )}
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section-title">Acknowledgements</div>
                <p className="settings-about-ack">
                  Built with Electron, React, the Vercel AI SDK, the Model Context Protocol SDK,
                  zustand, marked, Shiki, xterm.js, and node-pty.
                </p>
              </section>
            </>
          )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface OAuthCredentialBlockProps {
  entry: CatalogSummaryEntry;
  /* */
  status: SecretStatus | undefined;
  /** True while THIS provider's sign-in round-trip is in flight (settings-store's `oauthPendingProviderId === entry.id`). */
  pending: boolean;
  readOnly: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}

/**
 * OAuth credential block (design §5 point 4): "Sign in" (pending -> "waiting
 * for browser…" + Cancel) / "Signed in" -> "Sign out". Never renders
 * anything beyond a `SecretStatus`-derived badge — no account label, no
 * token, structurally nothing else is available to render (custody).
 */
export function OAuthCredentialBlock({ entry, status, pending, readOnly, onSignIn, onCancel, onSignOut }: OAuthCredentialBlockProps) {
  const described = describeOAuthStatus(status);
  return (
    <div className="settings-oauth-block">
      <div className="settings-field-row">
        <span className={`settings-secret-status settings-secret-status-${described.tone}`}>{described.text}</span>
      </div>
      {pending ? (
        <div className="settings-field-row">
          <span className="settings-oauth-pending">Waiting for browser sign-in…</span>
          <button type="button" className="settings-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="settings-field-row">
          {status?.set ? (
            <button type="button" className="settings-button settings-button-danger" disabled={readOnly} onClick={onSignOut}>
              Sign out
            </button>
          ) : (
            <button type="button" className="settings-button settings-button-primary" disabled={readOnly} onClick={onSignIn}>
              Sign in with {entry.name}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface SettingsDialogProps {
  open: boolean;
  onClose(): void;
  store?: SettingsStoreApi;
}

/**
 * Non-intrusive global notice (design §6): a compact fixed banner that shows
 * ONLY for the two states worth surfacing unprompted (`available` /
 * `downloaded`, `shouldShowUpdateBanner`) — text plus a direct action (when
 * downloaded, "Restart to install"; TASK.47 defect 2, when darwin's
 * manual-only `available`, "Open GitHub Releases"), so the update is
 * actionable without ever needing to open Settings. Consent-first
 * throughout: install/download only fire on an explicit click here.
 */
function UpdateNoticeBanner({ status, store }: { status: UpdateStatus; store: SettingsStoreApi }) {
  if (!shouldShowUpdateBanner(status)) {
    return null;
  }
  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">{updateStatusText(status)}</span>
      {status.kind === "downloaded" && (
        <button type="button" className="update-banner-action" onClick={() => void store.getState().installUpdate()}>
          Restart to install
        </button>
      )}
      {showsManualUpdateLink(status) && (
        <button type="button" className="update-banner-action" onClick={() => void store.getState().openReleasesUpdate()}>
          Open GitHub Releases
        </button>
      )}
    </div>
  );
}

/**
 * Native-`<dialog>` wrapper around `SettingsScreen` for App.tsx's ready-state
 * settings button — same showModal/Esc pattern as PermissionModal/
 * SessionPicker. Slice 2.6 §6: this component is UNCONDITIONALLY mounted by
 * App.tsx regardless of `open` (only the `<dialog>` itself was previously
 * conditional), so it is the one place in this lane that is always alive for
 * the app's whole lifetime — the push subscription lives here (not only in
 * `SettingsScreen`, which unmounts whenever the dialog is closed) so the
 * compact `UpdateNoticeBanner` above keeps receiving status pushes even while
 * Settings is closed. `SettingsScreen`'s own subscribe (for the
 * WelcomeScreen-embedded, pre-configuration case, which never reaches this
 * wrapper) is a harmless second listener when both happen to be mounted at
 * once — same idempotent `set()`.
 */
export function SettingsDialog({ open, onClose, store = useSettingsStore }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const updateStatus = useStore(store, (s) => s.updateStatus);
  // P7.23/F24 W2 pane-select seam (cut §4.6): held HERE, not in
  // `SettingsScreen`, because this component is unconditionally mounted for
  // the app's whole lifetime (see the class doc comment above) while
  // `SettingsScreen` mounts/unmounts with `open`. A slash-menu MCP/Skills
  // command dispatches "settings.open" (App.tsx) immediately followed by
  // this event, synchronously, in the same tick — if the listener lived on
  // `SettingsScreen` instead, the very first open of a session would race
  // its own not-yet-mounted effect and drop the pane. Anchoring the listener
  // here guarantees it's already registered before any such pair can fire.
  const [selectedPane, setSelectedPane] = useState<SettingsPaneId | null>(null);

  useEffect(() => {
    function onSelectPane(event: Event): void {
      const detail = (event as CustomEvent<string>).detail;
      if (SETTINGS_PANES.some((pane) => pane.id === detail)) {
        setSelectedPane(detail as SettingsPaneId);
      }
    }
    window.addEventListener(SETTINGS_SELECT_PANE_EVENT, onSelectPane);
    return () => window.removeEventListener(SETTINGS_SELECT_PANE_EVENT, onSelectPane);
  }, []);

  useEffect(() => {
    return store.getState().subscribeUpdates();
  }, [store]);

  // TASK.45 W11-FIX (W13 live-dogfood finding): same one-time,
  // whole-app-lifetime wiring as `subscribeUpdates` above — a real request
  // outcome's advisory health (main's `applyConnectionHealthEvent`)
  // deliberately never fires the normal settings `onMutation` broadcast, so
  // without this the connection grid stayed on a stale reading (Unchecked,
  // or a prior status) until some UNRELATED settings mutation happened to
  // refresh the snapshot.
  useEffect(() => {
    return store.getState().subscribeProviderHealth();
  }, [store]);

  // R17 a11y: capture the pre-open focus when the dialog opens and restore it
  // when it closes. SettingsDialog is unconditionally mounted (see the note
  // below), so this is keyed on `open`, not mount; on close the `if (!open)
  // return` below React-unmounts the <dialog> before its own close()/return-
  // focus can run, so focus would otherwise drop to <body>. Declared before the
  // showModal effect so the capture precedes showModal()'s focus steal.
  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) {
    return <UpdateNoticeBanner status={updateStatus} store={store} />;
  }

  return (
    <>
      <UpdateNoticeBanner status={updateStatus} store={store} />
      <dialog
        ref={dialogRef}
        className="settings-dialog"
        aria-label="Settings"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <SettingsScreen store={store} onClose={onClose} initialPane={selectedPane ?? undefined} />
      </dialog>
    </>
  );
}

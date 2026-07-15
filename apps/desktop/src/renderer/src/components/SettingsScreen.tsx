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
 * PROVIDER SELECTION (slice 2.5 §5): the provider `<select>` is populated
 * from `snapshot.catalog` (optional/absent = empty, 2.5.1's additive-field
 * contract) and hidden entirely when the catalog is empty — degrading
 * byte-for-byte to the 2.2 layout (single `provider.apiKey` credential,
 * baseUrl always visible) for any main build that hasn't populated the
 * catalog yet. `providerSecretKey`/`shouldShowBaseUrlField` both treat "no
 * selection" and "the catalog's own `custom`/needsBaseUrl entry" as the SAME

 * key") — deliberately not hardcoding the `"custom"` id string so the
 * renderer stays data-driven off the frozen `needsBaseUrl` flag alone.
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
import { useEffect, useReducer, useRef, useState, type ComponentType, type KeyboardEvent, type SVGProps } from "react";
import { useStore } from "zustand";
import type { McpServerStatus, TelemetryStatus } from "@anycode/core";
import type {
  CatalogSummary,
  CatalogSummaryEntry,
  ProviderTransportId,
  SecretKey,
  SecretSource,
  SecretStatus,
  SecretTier,
  SettingsPatch,
} from "../../../shared/settings.js";
import type { UpdateStatus } from "../../../shared/updates.js";
import type { WireEnvStatus, WireRepoMapStatus } from "../../../shared/protocol.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { applyThemePreference } from "../theme.js";
import { tabRegistry } from "../tab-registry.js";
import { useTabsStore } from "../tabs-store.js";
import { CodexEnginePane } from "./CodexEnginePane.js";
import { ConsentDialog } from "./ConsentDialog.js";
import { PermissionsEditor } from "./PermissionsEditor.js";
import { McpServersPane } from "./McpServersPane.js";
import { SkillsPane } from "./SkillsPane.js";
import { SubagentsPane } from "./SubagentsPane.js";
import { ProfilePane } from "./ProfilePane.js";
import { KeyboardShortcutsPane } from "./KeyboardShortcutsPane.js";
import { BrandMark, Check, Chevron, Cube, FileIcon, Gear, ImageIcon, Info, Keyboard, Person, Robot, Search, ServerStack, Terminal } from "./icons.js";
import { nextRovingIndex } from "./ModeMenu.js";
import { SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";
import { readTurnNotifyEnabled, TURN_NOTIFY_KEY } from "../notifications.js";
import { applyDensity, DENSITY_KEY, readDensity, type Density } from "../density.js";
import "../settings.css";

const LEGACY_API_KEY: SecretKey = "provider.apiKey";
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

/**
 * Builds the `provider` patch, omitting a field entirely (rather than
 * sending it as `""`/`undefined`) when the input is blank — a deep-partial
 * merge (design §3) should mean "don't touch this field" for an
 * untouched/cleared input, not "overwrite it with an empty string". NB for
 * 2.2.5 integration: double check this omission convention against 2.2.2's
 * actual `settings-set` merge implementation once it lands.
 */
export function buildProviderPatch(model: string, baseUrl: string, transport = ""): SettingsPatch {
  const provider: { model?: string; baseUrl?: string; transport?: ProviderTransportId } = {};
  const trimmedModel = model.trim();
  const trimmedBaseUrl = baseUrl.trim();
  if (trimmedModel) {
    provider.model = trimmedModel;
  }
  if (trimmedBaseUrl) {
    provider.baseUrl = trimmedBaseUrl;
  }
  if (transport) {
    provider.transport = transport as ProviderTransportId;
  }
  return { provider };
}

/** Same blank-omission convention as `buildProviderPatch`, for the `tools` mirror fields. */
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

// ── provider-section v2 pure helpers (slice 2.5 §5) ──

/** Builds the `{provider:{id}}` patch sent immediately on a provider-selector change (design §5 point 1 — no "Save" gate, unlike model/baseUrl). */
export function buildProviderSelectPatch(id: string): SettingsPatch {
  return { provider: { id } };
}

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

/**
 * True when the PERSISTED transport (not the in-progress edit) is not one of
 * the currently selected provider's supported transports (TASK.43 W5 cut Risk
 * #3) — a stale/hand-edited value must surface as a field-error, never
 * silently fall back to anthropic. `undefined` (no override persisted) is
 * always supported — the catalog default wins.
 */
export function isTransportUnsupported(
  selectedEntry: CatalogSummaryEntry | undefined,
  persistedTransport: ProviderTransportId | undefined,
): boolean {
  if (persistedTransport === undefined) {
    return false;
  }
  return !transportOptions(selectedEntry).includes(persistedTransport);
}

/**
 * The vault key a credential block reads/writes/clears for the currently

 * own `needsBaseUrl` (custom) entry both use the bare legacy key — "legacy/
 * custom mode" is one storage location, not two — every OTHER catalog entry
 * gets a per-provider key keyed on its declared authKind.
 */
export function providerSecretKey(selectedEntry: CatalogSummaryEntry | undefined): SecretKey {
  if (!selectedEntry || selectedEntry.needsBaseUrl) {
    return LEGACY_API_KEY;
  }
  return selectedEntry.authKind === "oauth" ? `provider.${selectedEntry.id}.oauth` : `provider.${selectedEntry.id}.apiKey`;
}

/**
 * The `<select>`'s displayed value: the real selected id, or — when nothing
 * is selected yet (legacy) — the catalog's own `needsBaseUrl` (custom) entry,

 * `""` only if the catalog carries no custom-style entry at all. Kept
 * separate from `selectedEntry`/`providerSecretKey` (which stay legitimately
 * "no selection" until the user actually picks something) — this only
 * controls what option LOOKS selected.
 */
export function displayedProviderId(catalog: CatalogSummary, id: string | undefined): string {
  if (id) {
    return id;
  }
  return catalog.find((entry) => entry.needsBaseUrl)?.id ?? "";
}

/** Notice text shown after a provider change is accepted (exfil-mitigation, design §5/threat model 2.2: any redirect of credentials/prompts must be human-visible). */
export function providerChangeNotice(providerName: string): string {
  return `Provider changed to ${providerName} — applies to new tabs.`;
}

/** Notice text shown after a baseUrl change is accepted (same exfil-mitigation rationale as `providerChangeNotice`). */
export function baseUrlChangeNotice(): string {
  return "Base URL changed — applies to new tabs.";
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
      return `Update v${status.version} available.`;
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

export interface ProviderSettingsProps {
  /** Injectable for tests / isolation; defaults to the app's singleton settings-store. */
  store?: SettingsStoreApi;
}

/**
 * Provider + credential composition (slice R11 §2.1): the Provider section,
 * the coupled API-key/Sign-in section (credentialKey/selectedEntry derive
 * from providerId — the two sections are one unit), and the weak-storage
 * ConsentDialog (pendingConsent only ever arises from setSecret, which lives
 * here). Extracted from SettingsScreen's body as a markup recomposition:
 * rendered DOM is attribute-for-attribute identical to the pre-R11 sections.
 * Two consumers: SettingsScreen below (dialog) and WelcomeScreen (first-run);
 * R16's settings redesign reuses it as the Provider pane.
 */
export function ProviderSettings({ store = useSettingsStore }: ProviderSettingsProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const pendingConsent = useStore(store, (s) => s.pendingConsent);
  const oauthPendingProviderId = useStore(store, (s) => s.oauthPendingProviderId);

  const [initialized, setInitialized] = useState(false);
  const [providerId, setProviderId] = useState<string | undefined>(undefined);
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [transport, setTransport] = useState<ProviderTransportId | "">("");
  const [secretValue, dispatchSecret] = useReducer(secretFieldReducer, "");

  // Seeds the local form fields from the first snapshot that arrives (once —
  // same clobber-avoidance rationale as SettingsScreen's own seed effect).
  useEffect(() => {
    if (!initialized && snapshot) {
      setProviderId(snapshot.settings.provider.id);
      setModel(snapshot.settings.provider.model ?? "");
      setBaseUrl(snapshot.settings.provider.baseUrl ?? "");
      setTransport(snapshot.settings.provider.transport ?? "");
      setInitialized(true);
    }
  }, [snapshot, initialized]);

  // Unreachable from both real mounts (SettingsScreen early-returns its own
  // loading row before this renders; App only mounts Welcome once the first
  // snapshot has loaded) — a null guard, not a loading state.
  if (!snapshot) {
    return null;
  }

  const readOnly = snapshot.readOnly;
  const catalog: CatalogSummary = snapshot.catalog ?? [];
  const hasCatalog = catalog.length > 0;
  const selectedEntry = selectProviderEntry(catalog, providerId);
  const showBaseUrl = shouldShowBaseUrlField(selectedEntry);
  const credentialKey = providerSecretKey(selectedEntry);
  const credentialStatus = snapshot.secrets.find((s) => s.key === credentialKey);
  const envOverridden = isEnvOverridden(snapshot.envOverrides, API_KEY_ENV_VAR);
  // Captured as a plain local (not re-read off `snapshot` inside the nested
  // functions below) so TS's null-narrowing of `snapshot` — which does not
  // cross a nested function boundary — stays sound.
  const storedBaseUrl = snapshot.settings.provider.baseUrl ?? "";
  // TASK.43 W5, deliberately disposable (W12 absorbs this into a drawer):
  // the transport `<select>` options + a field-error against the PERSISTED
  // (not in-progress) value — an unsupported combination blocks readiness
  // (main's computeProviderReady) rather than silently falling back.
  const transportChoices = transportOptions(selectedEntry);
  const transportUnsupported = isTransportUnsupported(selectedEntry, snapshot.settings.provider.transport);

  async function changeProvider(newId: string): Promise<void> {
    setProviderId(newId);
    const result = await store.getState().setPatch(buildProviderSelectPatch(newId));
    if (result.ok) {
      const label = selectProviderEntry(catalog, newId)?.name ?? newId;
      store.getState().setNotice(providerChangeNotice(label));
    }
  }

  async function saveProvider(): Promise<void> {
    // Never resend a stale baseUrl for a provider that hides the field —
    // buildProviderPatch already omits a blank value entirely (deep-partial
    // merge, "don't touch this field").
    const effectiveBaseUrl = showBaseUrl ? baseUrl : "";
    const baseUrlChanged = showBaseUrl && baseUrl.trim() !== storedBaseUrl;
    const result = await store.getState().setPatch(buildProviderPatch(model, effectiveBaseUrl, transport));
    if (result.ok && baseUrlChanged) {
      store.getState().setNotice(baseUrlChangeNotice());
    }
  }

  async function saveSecret(): Promise<void> {
    const value = secretValue;
    // CUSTODY: clear the field the instant Save is clicked, before the async
    // round-trip even settles — the typed value must not still be visible in
    // a rendered `<input>` while the request is in flight or after it
    // returns (see secretFieldReducer's docstring).
    dispatchSecret({ type: "submitted" });
    if (!value) {
      return;
    }
    await store.getState().setSecret(credentialKey, value);
  }

  async function clearSecretValue(): Promise<void> {
    await store.getState().clearSecret(credentialKey);
  }

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Provider</div>
        {hasCatalog && (
          <label className="settings-field">
            <span className="settings-field-label">Provider</span>
            <select
              className="settings-field-select"
              value={displayedProviderId(catalog, providerId)}
              disabled={readOnly}
              onChange={(e) => void changeProvider(e.target.value)}
            >
              {catalog.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="settings-field">
          <span className="settings-field-label">Model</span>
          <input
            className="settings-field-input"
            type="text"
            list="settings-model-suggestions"
            value={model}
            disabled={readOnly}
            placeholder="e.g. claude-sonnet-5"
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="settings-model-suggestions">
            {(selectedEntry?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.id}
              </option>
            ))}
          </datalist>
        </label>
        {showBaseUrl && (
          <label className="settings-field">
            <span className="settings-field-label">Base URL</span>
            <input
              className="settings-field-input"
              type="text"
              value={baseUrl}
              disabled={readOnly}
              placeholder="(provider default)"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
        )}
        <label className="settings-field">
          <span className="settings-field-label">Transport</span>
          <select
            className="settings-field-select"
            value={transport}
            disabled={readOnly}
            onChange={(e) => setTransport(e.target.value as ProviderTransportId | "")}
          >
            <option value="">(provider default)</option>
            {transportChoices.map((t) => (
              <option key={t} value={t}>
                {TRANSPORT_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {transportUnsupported && (
          <div className="settings-env-warning" role="alert">
            "{TRANSPORT_LABEL[snapshot.settings.provider.transport as ProviderTransportId]}" is not supported by{" "}
            {selectedEntry?.name ?? "this provider"} — pick a supported transport above, readiness is blocked until you do.
          </div>
        )}
        <div className="settings-field-row">
          <button type="button" className="settings-button settings-button-primary" disabled={readOnly} onClick={() => void saveProvider()}>
            Save provider settings
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">{selectedEntry?.authKind === "oauth" ? "Sign-in" : "API key"}</div>
        {envOverridden && (
          <div className="settings-env-warning">
            {API_KEY_ENV_VAR} is set in the environment and overrides the stored credential.
          </div>
        )}
        {selectedEntry?.authKind === "oauth" ? (
          <OAuthCredentialBlock
            entry={selectedEntry}
            status={credentialStatus}
            pending={oauthPendingProviderId === selectedEntry.id}
            readOnly={readOnly}
            onSignIn={() => void store.getState().oauthStart(selectedEntry.id)}
            onCancel={() => void store.getState().oauthCancel(selectedEntry.id)}
            onSignOut={() => void clearSecretValue()}
          />
        ) : (
          <>
            <div className="settings-field-row">
              {credentialStatus && (
                <span className={`settings-secret-status settings-secret-status-${describeSecretStatus(credentialStatus).tone}`}>
                  {describeSecretStatus(credentialStatus).text}
                </span>
              )}
            </div>
            <label className="settings-field">
              <span className="settings-field-label">Set a new key (never displayed once saved)</span>
              <input
                className="settings-field-input"
                type="password"
                autoComplete="off"
                value={secretValue}
                disabled={readOnly}
                placeholder="sk-…"
                onChange={(e) => dispatchSecret({ type: "change", value: e.target.value })}
              />
            </label>
            <div className="settings-field-row">
              <button type="button" className="settings-button settings-button-primary" disabled={readOnly || !secretValue} onClick={() => void saveSecret()}>
                Save key
              </button>
              <button
                type="button"
                className="settings-button settings-button-danger"
                disabled={readOnly || !credentialStatus?.set}
                onClick={() => void clearSecretValue()}
              >
                Clear key
              </button>
            </div>
          </>
        )}
      </section>

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
                    <button
                      type="button"
                      className="settings-button settings-button-primary"
                      onClick={() => void store.getState().downloadUpdate()}
                    >
                      Download v{updateStatus.version}
                    </button>
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
function OAuthCredentialBlock({ entry, status, pending, readOnly, onSignIn, onCancel, onSignOut }: OAuthCredentialBlockProps) {
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
 * `downloaded`, `shouldShowUpdateBanner`) — text plus, when downloaded, a
 * direct "Restart to install" action, so the update is actionable without
 * ever needing to open Settings. Consent-first throughout: install only
 * fires on this explicit click.
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

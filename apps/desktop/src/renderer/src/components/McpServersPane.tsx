/**
 * MCP Servers settings pane (P7.19/F22 W3/W3-FIX, design/slice-P7.19-cut.md
 * §1/§4 W3): replaces the old status-only thin list (slice 3.2/R16) with a
 * MCP management page — row grammar/badges/controls per §1.1/§1.2, a
 * page toolbar with search + add/import actions per §1.3/§1.4, "Configured
 * servers" / "From .mcp.json" sections per §1.5, and an explicit-trust import
 * dialog.
 *
 * DATA JOIN (§4 W3): `McpConfigSnapshot` (fetched via the bridge on mount,
 * refetched from the RETURNED snapshot after every mutation — never a second
 * `get()` round-trip) is LEFT-JOINed by name with the active tab's runtime
 * `McpServerStatus[]` (passed down as `servers` — SettingsScreen already
 * subscribes via its own `useActiveMcpServers` hook; this component does not
 * re-subscribe, it only consumes). The dot/detail mapping REUSES
 * `describeMcpServer` from SettingsScreen.tsx verbatim for any entry that has
 * a live status row; an enabled entry with none (config changed since boot)
 * renders a neutral dot + "applies to newly started tasks" hint; a disabled entry
 * renders a hollow/off dot with no tools badge (§4 W3, config-only rows only
 * exist because of this join — the old status-only list could never show
 * them).
 *
 * CUSTODY (design §3, mirrored from the shared/mcp-config.ts module doc): an
 * env/header VALUE never renders here. `McpConfigEntryView`/
 * `McpImportCandidateView` carry `envKeys` (names only) and now `cwd` (W3-FIX:
 * a filesystem path is trusted config, not a secret — same class as
 * command/args); every masked `KEY=••••` chip/row is composed from a key
 * NAME alone. A value only ever flows OUT of this component, inside an
 * upsert `entry` payload (the edit form's "replace value" inputs are
 * write-only — an existing key's row never pre-fills a value,
 * `type="password"`, cleared on every re-render from `fields` since the
 * field state itself only ever holds what the user just typed) or the import
 * dialog's consent flag.
 *
 * TOGGLE IS LOSSLESS (W3-FIX, was FULL-REPLACE CAVEAT): the enable/disable
 * switch now calls the dedicated `mcp-config-set-enabled` channel
 * (`setMcpServerEnabled` core-side), which patches ONLY the `enabled` field
 * of the raw JSON entry and preserves every other field — cwd, secret env
 * values, args — byte-semantically. It no longer goes through
 * `mcp-config-upsert` (full-replace), so there is nothing to warn about and
 * no confirm step. The one remaining full-replace surface is a deliberate
 * EDIT via the form: `mcp-config-upsert` still replaces the whole entry, and
 * `McpConfigEntryView` still carries no secret env VALUES, so editing a
 * server without retyping its secrets drops them (per-key "leave blank to
 * remove, type a new value to replace" makes this explicit and intentional —
 * see `buildMcpFormEntryInput`/the env row UI below).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { McpServerStatus } from "@anycode/core";
import type {
  McpConfigDeleteRequest,
  McpConfigEntryView,
  McpConfigGetRequest,
  McpConfigMutationResult,
  McpConfigPromoteCompatRequest,
  McpConfigRefusalReason,
  McpConfigSetEnabledRequest,
  McpConfigSnapshot,
  McpConfigSource,
  McpHarnessKind,
  McpImportApplyRequest,
  McpImportApplyResult,
  McpImportApplyResultItem,
  McpImportCandidateView,
  McpImportScanRequest,
  McpImportScanResult,
  McpServerEntryInput,
  McpConfigUpsertRequest,
  McpPluginServerView,
  McpTransport,
} from "../../../shared/mcp-config.js";
import { describeMcpServer, type McpRowKind } from "./SettingsScreen.js";
import { Pencil, Search, Trash, X } from "./icons.js";
import { RUN_ACTION_EVENT, SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";
import type { McpSecretMutationResult, McpSecretsListResult } from "../../../shared/mcp-secrets.js";
import {
  MCP_SECRETS_NOTICE,
  canSubmitMcpSecret,
  mcpSecretFailureMessage,
  mcpSecretNameError,
  secretReferenceSnippet,
  sortedSecretNames,
} from "./mcp-secrets-model.js";

// ── bridge (DI, same ethic as SettingsScreen.tsx's SettingsBridge) ──

/** Subset of `window.anycode.mcpConfig` this pane drives, injectable so tests never touch a real `window`. */
export interface McpConfigBridge {
  get(req?: McpConfigGetRequest): Promise<McpConfigSnapshot>;
  upsert(req: McpConfigUpsertRequest): Promise<McpConfigMutationResult>;
  delete(req: McpConfigDeleteRequest): Promise<McpConfigMutationResult>;
  setEnabled(req: McpConfigSetEnabledRequest): Promise<McpConfigMutationResult>;
  promoteCompat(req: McpConfigPromoteCompatRequest): Promise<McpConfigMutationResult>;
  importScan(req?: McpImportScanRequest): Promise<McpImportScanResult>;
  importApply(req: McpImportApplyRequest): Promise<McpImportApplyResult>;
}

// ── pure helpers (unit-tested directly — see McpServersPane.test.ts) ──

export type McpDotKind = McpRowKind | "neutral" | "off";

export interface McpJoinedRow {
  entry: McpConfigEntryView;
  status: McpServerStatus | undefined;
  dotKind: McpDotKind;
  detail: string;
}

/**
 * Dot/detail for one joined row (§4 W3): a disabled entry is always "off"
 * regardless of any stale status row; an enabled entry with a live status
 * reuses `describeMcpServer` verbatim; an enabled entry with none is
 * "neutral" (config changed after this tab's boot — McpManager.start() is
 * once-only, design §2 non-goal).
 */
export function describeMcpConfigRow(
  entry: McpConfigEntryView,
  status: McpServerStatus | undefined,
): { kind: McpDotKind; detail: string } {
  // W5-FIX (finding 8): a shadowed row (a lower-priority source's definition of

  // it must never borrow the winner's connected/tools status. Render neutral.
  if (entry.shadowed) {
    return { kind: "neutral", detail: "shadowed by a higher-priority scope" };
  }
  if (!entry.enabled) {
    return { kind: "off", detail: "disabled" };
  }
  if (status) {
    return describeMcpServer(status);
  }
  return { kind: "neutral", detail: "applies to newly started tasks" };
}

/** LEFT-JOIN of the config snapshot's entries with the active tab's runtime statuses, by name. */
export function joinMcpRows(
  entries: readonly McpConfigEntryView[],
  servers: readonly McpServerStatus[],
): McpJoinedRow[] {
  const statusByName = new Map(servers.map((s) => [s.name, s] as const));
  return entries.map((entry) => {
    // W5-FIX (finding 8): only the CLAIMED (non-shadowed) row joins runtime
    // status — a shadowed same-named row must show neutral, not the winner's dot.
    const status = entry.shadowed ? undefined : statusByName.get(entry.name);
    const described = describeMcpConfigRow(entry, status);
    return { entry, status, dotKind: described.kind, detail: described.detail };
  });
}

/**
 * A failure the config view cannot show (GitHub #3): the loader skipped the
 * entry, so it has no row of its own, and a file-level problem has no server
 * name at all. Only non-shadowed names claimed by a rendered row are excluded —
 * those already carry the same or a better reason.
 */
export function unmatchedMcpStatuses(
  entries: readonly McpConfigEntryView[],
  plugins: readonly McpPluginServerView[],
  servers: readonly McpServerStatus[],
): McpServerStatus[] {
  const claimed = new Set([
    ...entries.filter((entry) => !entry.shadowed).map((entry) => entry.name),
    ...plugins.filter((plugin) => !plugin.shadowed).map((plugin) => plugin.name),
  ]);
  const seen = new Set<string>();
  return servers.filter((server) => {
    if (server.state !== "failed" || claimed.has(server.name)) {
      return false;
    }
    const key = `${server.name}\u0000${server.error ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Diagnostic rows for failures with no config row of their own — never silence. */
export function McpDiagnosticRows({ servers }: { servers: readonly McpServerStatus[] }) {
  if (servers.length === 0) {
    return null;
  }
  return (
    <div className="mcp-section">
      <div className="mcp-section-title">
        Startup problems <span className="mcp-section-count">{servers.length} item{servers.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="mcp-row-list">
        {servers.map((server, index) => (
          <li
            className="mcp-row mcp-dot-failed"
            key={`${server.name}-${index}`}
            data-mcp-name={server.name}
          >
            <div className="mcp-row-main">
              <span className="mcp-dot" aria-hidden="true" />
              <div className="mcp-row-lines">
                <div className="mcp-row-line1">
                  <span className="mcp-row-name settings-mcp-name">{server.name}</span>
                </div>
                <div className="mcp-row-hint" title={describeMcpServer(server).detail}>
                  {describeMcpServer(server).detail}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface McpRowSections {
  configured: McpJoinedRow[];
  compat: McpJoinedRow[];
}

/** "Configured servers" (project+user) vs "From .mcp.json" (compat, read-only) — design §1.5. */
export function partitionMcpRows(rows: readonly McpJoinedRow[]): McpRowSections {
  const configured: McpJoinedRow[] = [];
  const compat: McpJoinedRow[] = [];
  for (const row of rows) {
    (row.entry.source === "compat" ? compat : configured).push(row);
  }
  return { configured, compat };
}

/** Trivial name-filter (design §1.4: "no fuzzy engine") — case-insensitive substring on `entry.name` only. */
export function filterMcpRows(rows: readonly McpJoinedRow[], query: string): McpJoinedRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...rows];
  }
  return rows.filter((row) => row.entry.name.toLowerCase().includes(needle));
}

export function sourceBadgeLabel(source: McpConfigSource): string {
  switch (source) {
    case "project":
      return "Project";
    case "user":
      return "User";
    case "compat":
      return "Compat";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** Tools-count badge text — only for a connected row (disabled/neutral/failed/closed rows never show a stale count). */
export function toolsBadgeText(row: McpJoinedRow): string | undefined {
  if (row.dotKind !== "completed" || !row.status) {
    return undefined;
  }
  const n = row.status.toolCount;
  return `${n} tool${n === 1 ? "" : "s"}`;
}

/** Masked `KEY=••••` chip text, composed from key NAMES only (custody §3) — never a value. */
export function maskedEnvChips(envKeys: readonly string[]): string[] {
  return envKeys.map((key) => `${key}=••••`);
}

/** Best-effort inverse of main's `commandLine = [command, ...args].join(" ")` (whitespace split). */
export function parseCommandLine(commandLine: string): { command: string; args: string[] } {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);
  const [command = "", ...args] = parts;
  return { command, args };
}

/**
 * Compat-row "Import to project" (W5-FIX, finding 3) is done MAIN-side against
 * the REAL `.mcp.json` entry via the `promoteCompat` bridge — it needs only the
 * server NAME. The renderer no longer reconstructs an upsert payload from the
 * display-only view (which kept `enabled:true`, dropped `cwd`/`env`, and split
 * quoted args on whitespace). The request builder is a thin name+tab pass-through.
 */
export function buildPromoteCompatRequest(
  tabId: string | undefined,
  entry: McpConfigEntryView,
): McpConfigPromoteCompatRequest {
  return { tabId, name: entry.name };
}

export function mcpRefusalMessage(reason: McpConfigRefusalReason): string {
  switch (reason) {
    case "invalid":
      return "That entry isn't valid — check the command or URL and try again.";
    case "no_workspace":
      return "No project is open — open a workspace to use a project-scoped server.";
    case "read_only_source":
      return "This source is read-only — imported servers can't be edited here.";
    case "io_error":
      return "Couldn't save — the config file couldn't be read or written.";
    case "not_found":
      return "That server no longer exists in the config file — try refreshing.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** Compat (`.mcp.json`) rows are read-only (design §1.5/§3): no toggle/edit/delete, only "Import to project". */
export function canManageMcpEntry(entry: McpConfigEntryView): boolean {
  return entry.source !== "compat";
}

// ── request builders (pure — isolate the "what do we send" decision from the bridge call itself) ──

/** Toggle request (W3-FIX): a lean enabled-only patch, NOT a full-replace upsert — cwd/secret env values survive untouched. */
export function buildSetEnabledRequest(tabId: string | undefined, entry: McpConfigEntryView): McpConfigSetEnabledRequest {
  return { tabId, scope: entry.source === "user" ? "user" : "project", name: entry.name, enabled: !entry.enabled };
}

export function buildDeleteRequest(tabId: string | undefined, entry: McpConfigEntryView): McpConfigDeleteRequest {
  return { tabId, scope: entry.source === "user" ? "user" : "project", name: entry.name };
}

export function buildFormUpsertRequest(tabId: string | undefined, fields: McpFormFields): McpConfigUpsertRequest {
  return { tabId, scope: fields.scope, name: fields.name.trim(), entry: buildMcpFormEntryInput(fields) };
}

/**
 * Import-apply request (design §4 W3: consent gates `includeEnvValues` only —
 * W1/W2 (config-write.ts `buildImportEntry`) FORCE `enabled:false` on every
 * written entry unconditionally regardless of this flag; this builder just
 * makes sure the renderer relays the consent checkbox faithfully in both
 * directions, off and on.
 */
export function buildImportApplyRequest(
  tabId: string | undefined,
  scope: "project" | "user",
  selection: Record<string, boolean>,
  includeEnvValues: boolean,
): McpImportApplyRequest {
  // W5-FIX (finding 2): select on candidate IDENTITY (`id`), not name — two
  // same-named candidates from different harnesses are distinct, so choosing one
  // never copies the other's (possibly secret-bearing) definition.
  return { tabId, scope, ids: selectedImportIds(selection), includeEnvValues };
}

// ── add/edit form (one modal, design §4 W3) ──

export interface McpEnvRow {
  key: string;
  /** True for a row seeded from an existing `envKeys` entry (locked display, write-only replace input). */
  locked: boolean;
  value: string;
}

/** Existing keys render LOCKED — `KEY=••••` — with an empty write-only replace value (custody §3). */
export function envRowsFromKeys(envKeys: readonly string[]): McpEnvRow[] {
  return envKeys.map((key) => ({ key, locked: true, value: "" }));
}

/**
 * A locked row with no typed replacement is OMITTED from the built record
 * (so it drops out of the fully-replaced entry — "leave blank to remove");
 * a locked row WITH a typed value replaces it; a new (unlocked) row needs
 * both a key and a value to count.
 */
export function buildEnvRecord(rows: readonly McpEnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key || !row.value) {
      continue;
    }
    out[key] = row.value;
  }
  return out;
}

export function splitArgsText(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface McpFormFields {
  name: string;
  scope: "project" | "user";
  transport: McpTransport;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  enabled: boolean;
  envRows: McpEnvRow[];
}

export function blankMcpFormFields(defaultScope: "project" | "user"): McpFormFields {
  return {
    name: "",
    scope: defaultScope,
    transport: "stdio",
    command: "",
    argsText: "",
    cwd: "",
    url: "",
    enabled: true,
    envRows: [],
  };
}

/** Prefills the edit form from a view row — `cwd` (W3-FIX) now comes straight from the view; secret env VALUES are still never known (custody), so env rows stay locked/write-only. */
export function mcpFormFieldsForEdit(entry: McpConfigEntryView): McpFormFields {
  const parsed = entry.transport === "stdio" ? parseCommandLine(entry.commandLine) : { command: "", args: [] as string[] };
  return {
    name: entry.name,
    scope: entry.source === "user" ? "user" : "project",
    transport: entry.transport,
    command: parsed.command,
    argsText: parsed.args.join("\n"),
    cwd: entry.cwd ?? "",
    url: entry.transport === "http" ? entry.commandLine : "",
    enabled: entry.enabled,
    envRows: envRowsFromKeys(entry.envKeys),
  };
}

export function buildMcpFormEntryInput(fields: McpFormFields): McpServerEntryInput {
  const entry: McpServerEntryInput = { enabled: fields.enabled };
  if (fields.transport === "stdio") {
    entry.command = fields.command.trim();
    const args = splitArgsText(fields.argsText);
    if (args.length > 0) {
      entry.args = args;
    }
    const cwd = fields.cwd.trim();
    if (cwd) {
      entry.cwd = cwd;
    }
  } else {
    entry.url = fields.url.trim();
  }
  const env = buildEnvRecord(fields.envRows);
  if (Object.keys(env).length > 0) {
    entry.env = env;
  }
  return entry;
}

export function canSubmitMcpForm(fields: McpFormFields): boolean {
  if (!fields.name.trim()) {
    return false;
  }
  return fields.transport === "stdio" ? fields.command.trim().length > 0 : fields.url.trim().length > 0;
}

// ── import dialog helpers (design §4 W3) ──

/** Default checked for a candidate name not already configured (project/user) — never for an already-configured name. */
export function defaultImportSelection(candidates: readonly McpImportCandidateView[]): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const candidate of candidates) {
    // Keyed by identity (W5-FIX, finding 2), default-checked unless already configured.
    if (!(candidate.id in selection)) {
      selection[candidate.id] = !candidate.alreadyConfigured;
    }
  }
  return selection;
}

export interface McpImportGroup {
  harness: McpHarnessKind;
  sourcePath: string;
  candidates: McpImportCandidateView[];
}

/** Groups candidates by harness+sourcePath, first-seen order — one labeled group per source file. */
export function groupImportCandidates(candidates: readonly McpImportCandidateView[]): McpImportGroup[] {
  const order: string[] = [];
  const groups = new Map<string, McpImportGroup>();
  for (const candidate of candidates) {
    const key = `${candidate.harness}:${candidate.sourcePath}`;
    let group = groups.get(key);
    if (!group) {
      group = { harness: candidate.harness, sourcePath: candidate.sourcePath, candidates: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.candidates.push(candidate);
  }
  return order.map((key) => groups.get(key)!);
}

export function harnessLabel(harness: McpHarnessKind): string {
  switch (harness) {
    case "claude":
      return "Claude Code (user)";
    case "claude-project":
      return "Claude Code (project)";
    case "mcp-json":
      return ".mcp.json";
    case "codex":
      return "Codex";
    case "zcode":
      return "zcode";
    default: {
      const exhaustive: never = harness;
      return exhaustive;
    }
  }
}

/** The checked candidate IDENTITIES (W5-FIX, finding 2) — the apply request selects on these, never on name. */
export function selectedImportIds(selection: Record<string, boolean>): string[] {
  return Object.entries(selection)
    .filter(([, checked]) => checked)
    .map(([id]) => id);
}

/** Footer label (design §4 W3: "Import N servers (disabled until you enable them)"). */
export function importFooterLabel(selection: Record<string, boolean>): string {
  const n = selectedImportIds(selection).length;
  return `Import ${n} server${n === 1 ? "" : "s"} (disabled until you enable them)`;
}

export type McpEmptyKind = "none" | "no_match" | null;/**
 * "no_match" = the active query hid every configured row (or there are none but a query is active);
 * "none" = nothing configured and no active query (CTA state); null = rows visible.
 */
export function mcpEmptyKind(configuredTotal: number, filteredCount: number, query: string): McpEmptyKind {
  if (filteredCount > 0) return null;
  if (query.trim().length > 0) return "no_match";
  return "none";
}

export function importResultText(item: McpImportApplyResultItem): string {
  if (item.skipped === "exists") {
    return `${item.name}: skipped — already configured`;
  }
  return item.applied ? `${item.name}: imported (disabled)` : `${item.name}: not imported`;
}

// ── component ──

export interface McpServersPaneProps {
  /** Active tab's runtime MCP statuses — SettingsScreen's own `useActiveMcpServers()`, passed down (no re-subscription here). */
  servers: McpServerStatus[];
  /** Scope reference (Taskana 4758): a tab id or a workspace id `ws_…`, resolved main-side; omit for the pre-tab case (user-scope only). */
  tabId?: string;
  /** Injectable for tests / isolation; defaults to `window.anycode.mcpConfig` (same DI ethic as SettingsBridge). */
  bridge?: McpConfigBridge;
  /** Taskana 4758: reports the pane's count for the scope chip (null while loading). */
  onCountChange?: (count: number | null) => void;
}

/** The write-only secret bridge (preload `mcpSecrets.*`): list/set/delete, names only back. */
export interface McpSecretsBridge {
  list(): Promise<McpSecretsListResult>;
  set(req: { name: string; value: string }): Promise<McpSecretMutationResult>;
  delete(req: { name: string }): Promise<McpSecretMutationResult>;
}

/**
 * Presentational half of the secrets block: lists NAMES with their copyable
 * `${secret:NAME}` reference, a write-only form (password input, autocomplete
 * off, the value cleared as soon as the save settles), and a per-row delete.
 * No value is ever a prop, a list item, or rendered back.
 */
export function McpSecretsPanel({
  names,
  error,
  busy,
  onSave,
  onDelete,
}: {
  names: readonly string[];
  error: string | null;
  busy: boolean;
  onSave(name: string, value: string): Promise<void>;
  onDelete(name: string): void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameError = name === "" ? undefined : mcpSecretNameError(name);
  const canSave = canSubmitMcpSecret(name, value) && !busy;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSave) return;
    const pending = onSave(name, value);
    // The value leaves component state as soon as the call settles, win or lose.
    void Promise.resolve(pending).then(
      () => setValue(""),
      () => setValue(""),
    );
    setName("");
  }

  return (
    <details className="mcp-secrets-block">
      <summary className="mcp-section-title">
        Secrets <span className="mcp-section-count">{names.length}</span>
      </summary>
      <p className="settings-field-hint">{MCP_SECRETS_NOTICE}</p>
      {names.length > 0 && (
        <ul className="mcp-secret-list">
          {sortedSecretNames(names).map((secretName) => (
            <li key={secretName} className="mcp-secret-row">
              <code className="settings-mcp-name">{secretReferenceSnippet(secretName)}</code>
              <button
                type="button"
                className="settings-button"
                aria-label={`Delete secret ${secretName}`}
                onClick={() => onDelete(secretName)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="mcp-secret-form" autoComplete="off" onSubmit={submit}>
        <input
          className="settings-field-input"
          type="text"
          aria-label="Secret name"
          placeholder="NAME"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="settings-field-input"
          type="password"
          aria-label="Secret value"
          placeholder="value"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="settings-button settings-button-primary" disabled={!canSave}>
          Save secret
        </button>
        {nameError !== undefined && <span className="settings-field-hint" role="alert">{nameError}</span>}
      </form>
      {error !== null && (
        <div className="mcp-problem-strip" role="alert">
          <span>{error}</span>
        </div>
      )}
    </details>
  );
}

/** Container: loads names through the bridge and forwards write-only mutations. */
export function McpSecretsBlock({ bridge = window.anycode.mcpSecrets }: { bridge?: McpSecretsBridge }) {
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge.list().then((result) => {
      if (!cancelled && result.ok) setNames(result.names);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function save(secretName: string, secretValue: string): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await bridge.set({ name: secretName, value: secretValue });
    setBusy(false);
    if (result.ok) setNames(result.names);
    else setError(mcpSecretFailureMessage(result.reason));
  }

  async function remove(secretName: string): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await bridge.delete({ name: secretName });
    setBusy(false);
    if (result.ok) setNames(result.names);
    else setError(mcpSecretFailureMessage(result.reason));
  }

  return (
    <McpSecretsPanel
      names={names}
      error={error}
      busy={busy}
      onSave={save}
      onDelete={(secretName) => void remove(secretName)}
    />
  );
}

export function McpServersPane({ servers, tabId, bridge = window.anycode.mcpConfig, onCountChange }: McpServersPaneProps) {
  const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [dismissedProblems, setDismissedProblems] = useState<Set<string>>(new Set());
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "add" | "edit"; fields: McpFormFields } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importScanResult, setImportScanResult] = useState<McpImportScanResult | null>(null);
  const [importSelection, setImportSelection] = useState<Record<string, boolean>>({});
  const [importConsent, setImportConsent] = useState(false);
  const [importResults, setImportResults] = useState<McpImportApplyResultItem[] | null>(null);

  // Taskana 4706: the pane's WRITE target follows the header scope bar — a
  // tabId present means the bar resolved Project mode (SettingsScreen passes
  // the chosen tab); absent means Global (user-only snapshot). The add form
  // and the import dialog no longer carry their own scope radios; they seed
  // from this mode and show a one-line hint instead, so a write can never
  // land somewhere other than the visibly selected area.
  const scopeMode = tabId !== undefined ? "project" : "user";

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    void bridge.get({ tabId }).then((snap) => {
      if (!cancelled) {
        setSnapshot(snap);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, tabId]);

  const rows = snapshot ? joinMcpRows(snapshot.entries, servers) : [];
  const filtered = filterMcpRows(rows, searchQuery);
  const { configured, compat } = partitionMcpRows(filtered);
  const allConfigured = partitionMcpRows(rows).configured;
  // Taskana 4758: the scope chip's count = configured rows (compat excluded).
  const configuredCount = snapshot ? allConfigured.length : null;
  useEffect(() => {
    onCountChange?.(configuredCount);
  }, [configuredCount, onCountChange]);
  useEffect(() => () => onCountChange?.(null), [onCountChange]);
  const emptyKind = mcpEmptyKind(allConfigured.length, configured.length, searchQuery);
  const visibleProblems = (snapshot?.problems ?? []).filter((p) => !dismissedProblems.has(p));

  function openAddForm(): void {
    setFormError(null);
    setForm({ mode: "add", fields: blankMcpFormFields(scopeMode) });
  }

  function openEditForm(entry: McpConfigEntryView): void {
    setFormError(null);
    setForm({ mode: "edit", fields: mcpFormFieldsForEdit(entry) });
  }

  async function submitForm(): Promise<void> {
    if (!form || !canSubmitMcpForm(form.fields)) {
      return;
    }
    const result = await bridge.upsert(buildFormUpsertRequest(tabId, form.fields));
    if (result.ok) {
      setSnapshot(result.snapshot);
      setForm(null);
      setFormError(null);
    } else {
      setFormError(mcpRefusalMessage(result.reason));
    }
  }

  async function toggleEntry(entry: McpConfigEntryView): Promise<void> {
    if (!canManageMcpEntry(entry)) {
      return;
    }
    // W3-FIX: lossless enabled-only patch — no full-replace, no secret-clearing confirm needed.
    const result = await bridge.setEnabled(buildSetEnabledRequest(tabId, entry));
    if (result.ok) {
      setSnapshot(result.snapshot);
    }
  }

  async function deleteEntry(entry: McpConfigEntryView): Promise<void> {
    if (!canManageMcpEntry(entry)) {
      return;
    }
    const result = await bridge.delete(buildDeleteRequest(tabId, entry));
    if (result.ok) {
      setSnapshot(result.snapshot);
    }
    setConfirmDeleteName(null);
  }

  async function promoteCompatEntry(entry: McpConfigEntryView): Promise<void> {
    // W5-FIX (finding 3): promote main-side against the real .mcp.json entry —
    // forced disabled, args/cwd/env preserved verbatim, values never handled here.
    const result = await bridge.promoteCompat(buildPromoteCompatRequest(tabId, entry));
    if (result.ok) {
      setSnapshot(result.snapshot);
    }
  }

  async function openImportDialog(): Promise<void> {
    setImportOpen(true);
    setImportResults(null);
    setImportConsent(false);
    const scan = await bridge.importScan({ tabId });
    setImportScanResult(scan);
    setImportSelection(defaultImportSelection(scan.candidates));
  }

  function closeImportDialog(): void {
    setImportOpen(false);
    setImportScanResult(null);
    setImportResults(null);
  }

  function toggleImportRow(id: string): void {
    setImportSelection((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function applyImport(): Promise<void> {
    if (selectedImportIds(importSelection).length === 0) {
      return;
    }
    const result = await bridge.importApply(buildImportApplyRequest(tabId, scopeMode, importSelection, importConsent));
    if (result.ok) {
      setSnapshot(result.snapshot);
      setImportResults(result.results);
    }
  }

  return (
    <section className="settings-section mcp-pane">
      <div className="mcp-pane-toolbar">
        <label className="settings-search mcp-pane-search">
          <Search className="settings-search-icon" />
          <input
            type="text"
            className="settings-search-input"
            placeholder="Search MCP servers…"
            aria-label="Search MCP servers"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <div className="mcp-pane-actions">
          <button type="button" className="settings-button" aria-label="Add MCP server" onClick={openAddForm}>
            Add server
          </button>
          <button type="button" className="settings-button" aria-label="Import MCP servers" onClick={() => void openImportDialog()}>
            Import
          </button>
        </div>
      </div>

      <McpSecretsBlock />

      {visibleProblems.map((problem) => (
        <div key={problem} className="mcp-problem-strip" role="alert">
          <span>{problem}</span>
          <button
            type="button"
            className="mcp-problem-dismiss"
            aria-label="Dismiss"
            onClick={() => setDismissedProblems((prev) => new Set(prev).add(problem))}
          >
            <X />
          </button>
        </div>
      ))}

      <McpDiagnosticRows servers={unmatchedMcpStatuses(snapshot?.entries ?? [], snapshot?.pluginServers ?? [], servers).filter((server) => server.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))} />

      {!snapshot ? (
        <div className="settings-mcp-empty">Loading MCP servers…</div>
      ) : (
        <>
          <div className="mcp-section">
            <div className="mcp-section-title">
              Configured servers <span className="mcp-section-count">{configured.length} item{configured.length === 1 ? "" : "s"}</span>
            </div>
            {configured.length === 0 ? (
              <div className="mcp-empty-state">
                <div className="settings-mcp-empty">{emptyKind === "no_match" ? "No servers match your search." : "No MCP servers configured yet."}</div>
                {emptyKind === "none" && (
                  <div className="mcp-empty-actions">
                    <button type="button" className="settings-button settings-button-primary" onClick={openAddForm}>
                      Add server
                    </button>
                    <button type="button" className="settings-button" onClick={() => void openImportDialog()}>
                      Import
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <ul className="mcp-row-list">
                {configured.map((row) => (
                  <McpRowItem
                    key={row.entry.name}
                    row={row}
                    confirmDelete={confirmDeleteName === row.entry.name}
                    onToggle={() => void toggleEntry(row.entry)}
                    onEdit={() => openEditForm(row.entry)}
                    onRequestDelete={() => setConfirmDeleteName(row.entry.name)}
                    onCancelDelete={() => setConfirmDeleteName(null)}
                    onConfirmDelete={() => void deleteEntry(row.entry)}
                  />
                ))}
              </ul>
            )}
          </div>

          {compat.length > 0 && (
            <div className="mcp-section">
              <div className="mcp-section-title">
                From .mcp.json <span className="mcp-section-count">{compat.length} item{compat.length === 1 ? "" : "s"}</span>
                <span className="mcp-section-note">Read-only · imported from .mcp.json</span>
              </div>
              <ul className="mcp-row-list">
                {compat.map((row) => (
                  <McpRowItem
                    key={row.entry.name}
                    row={row}
                    confirmDelete={false}
                    onToggle={() => {}}
                    onEdit={() => {}}
                    onRequestDelete={() => {}}
                    onCancelDelete={() => {}}
                    onConfirmDelete={() => {}}
                    onPromote={() => void promoteCompatEntry(row.entry)}
                  />
                ))}
              </ul>
            </div>
          )}

          {/* Taskana 4732 S1-C (design 4732 §6 "Elsewhere"): plugin-contributed
              servers, READ-ONLY rows — no toggle/edit/delete here. Enable and
              consent live in Settings → Plugins (per plugin, user-global), so
              the section's only affordance is the pane-select cross-link. */}
          {(snapshot.pluginServers ?? []).length > 0 && (
            <div className="mcp-section">
              <div className="mcp-section-title">
                From plugins <span className="mcp-section-count">{(snapshot.pluginServers ?? []).length} item{(snapshot.pluginServers ?? []).length === 1 ? "" : "s"}</span>
                <span className="mcp-section-note">
                  Read-only ·{" "}
                  <button
                    type="button"
                    className="plugins-manage-link"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
                      window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: "plugins" }));
                    }}
                  >
                    Manage in Plugins
                  </button>
                </span>
              </div>
              <ul className="mcp-row-list">
                {(snapshot.pluginServers ?? []).map((server) => (
                  <McpPluginRowItem key={server.name} server={server} status={server.shadowed ? undefined : servers.find((item) => item.name === server.name)} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {form && (
        <McpFormDialog
          mode={form.mode}
          fields={form.fields}
          error={formError}
          scopeMode={scopeMode}
          onChange={(fields) => setForm({ mode: form.mode, fields })}
          onCancel={() => setForm(null)}
          onSubmit={() => void submitForm()}
        />
      )}

      {importOpen && (
        <McpImportDialog
          scan={importScanResult}
          selection={importSelection}
          consent={importConsent}
          scopeMode={scopeMode}
          results={importResults}
          onToggleRow={toggleImportRow}
          onConsentChange={setImportConsent}
          onApply={() => void applyImport()}
          onClose={closeImportDialog}
        />
      )}
    </section>
  );
}

// ── row (design §1.1/§1.2: line1 dot+name+badges, line2 muted transport+command, right-aligned controls) ──

interface McpRowItemProps {
  row: McpJoinedRow;
  confirmDelete: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  /** Compat rows only — promotes this .mcp.json server into the project config (design §1.5). */
  onPromote?: () => void;
}

function McpRowItem({
  row,
  confirmDelete,
  onToggle,
  onEdit,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onPromote,
}: McpRowItemProps) {
  const { entry, detail, dotKind } = row;
  const isCompat = !canManageMcpEntry(entry);
  const tools = toolsBadgeText(row);

  return (
    <li className={`mcp-row mcp-dot-${dotKind}`} data-mcp-name={entry.name}>
      <div className="mcp-row-main">
        <span className="mcp-dot" aria-hidden="true" />
        <div className="mcp-row-lines">
          <div className="mcp-row-line1">
            <span className="mcp-row-name settings-mcp-name">{entry.name}</span>
            <span className={`mcp-badge mcp-badge-${entry.source}`}>{sourceBadgeLabel(entry.source)}</span>
            {tools && <span className="mcp-badge mcp-badge-tools">{tools}</span>}
          </div>
          <div className="mcp-row-line2" title={entry.commandLine}>
            {entry.transport} · {entry.commandLine}
          </div>
          {(dotKind === "neutral" || dotKind === "failed") && <div className="mcp-row-hint">{detail}</div>}
        </div>
      </div>

      <div className="mcp-row-controls">
        {isCompat ? (
          <button type="button" className="settings-button mcp-promote-button" onClick={onPromote}>
            Import to project
          </button>
        ) : confirmDelete ? (
          <span className="mcp-confirm-row">
            <span className="mcp-confirm-text">Delete "{entry.name}"?</span>
            <button type="button" className="settings-button settings-button-danger" onClick={onConfirmDelete}>
              Delete
            </button>
            <button type="button" className="settings-button" onClick={onCancelDelete}>
              Cancel
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={entry.enabled}
              aria-label={`${entry.enabled ? "Disable" : "Enable"} ${entry.name}`}
              className={`settings-switch${entry.enabled ? " settings-switch-on" : ""}`}
              onClick={onToggle}
            >
              <span className="settings-switch-thumb" />
            </button>
            <button type="button" className="mcp-icon-button" aria-label={`Edit ${entry.name}`} onClick={onEdit}>
              <Pencil />
            </button>
            <button
              type="button"
              className="mcp-icon-button mcp-icon-button-danger"
              aria-label={`Delete ${entry.name}`}
              onClick={onRequestDelete}
            >
              <Trash />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

// ── add/edit dialog ──

interface McpFormDialogProps {
  mode: "add" | "edit";
  fields: McpFormFields;
  error: string | null;
  /** Taskana 4706: the pane's resolved write target (header scope bar) — displayed as a hint, no longer a radio. */
  scopeMode: "project" | "user";
  onChange: (fields: McpFormFields) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function McpFormDialog({ mode, fields, error, scopeMode, onChange, onCancel, onSubmit }: McpFormDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  function set<K extends keyof McpFormFields>(key: K, value: McpFormFields[K]): void {
    onChange({ ...fields, [key]: value });
  }

  function setEnvValue(index: number, value: string): void {
    const envRows = fields.envRows.slice();
    const row = envRows[index];
    if (!row) {
      return;
    }
    envRows[index] = { ...row, value };
    onChange({ ...fields, envRows });
  }

  function setNewEnvKey(index: number, key: string): void {
    const envRows = fields.envRows.slice();
    const row = envRows[index];
    if (!row) {
      return;
    }
    envRows[index] = { ...row, key };
    onChange({ ...fields, envRows });
  }

  function addEnvRow(): void {
    onChange({ ...fields, envRows: [...fields.envRows, { key: "", locked: false, value: "" }] });
  }

  function removeEnvRow(index: number): void {
    onChange({ ...fields, envRows: fields.envRows.filter((_, i) => i !== index) });
  }

  const canSubmit = canSubmitMcpForm(fields);

  return (
    <dialog
      ref={dialogRef}
      className="mcp-form-dialog"
      aria-label={mode === "add" ? "Add MCP server" : `Edit ${fields.name}`}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="mcp-dialog-header">
        <span className="mcp-dialog-title">{mode === "add" ? "Add MCP server" : `Edit ${fields.name}`}</span>
      </div>
      <div className="mcp-dialog-body">
        <label className="settings-field">
          <span className="settings-field-label">Name</span>
          <input
            className="settings-field-input"
            type="text"
            value={fields.name}
            disabled={mode === "edit"}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>

        {/* Taskana 4706: the scope radio is gone — the write target is the
            pane's header scope bar (ScopeSwitcher), restated here as a hint so
            the dialog itself names where the entry will land. Add mode only:
            an EDIT keeps the row's own source (badge-visible), while an add's
            scope is exactly the pane mode that seeded these fields. */}
        {mode === "add" && (
          <div className="mcp-row-hint">
            Adding to {scopeMode === "project" ? "this project's config" : "your global (user) config"}
          </div>
        )}

        <div className="settings-field">
          <span className="settings-field-label">Transport</span>
          <div className="mcp-radio-row">
            <label>
              <input type="radio" name="mcp-transport" checked={fields.transport === "stdio"} onChange={() => set("transport", "stdio")} />
              stdio
            </label>
            <label>
              <input type="radio" name="mcp-transport" checked={fields.transport === "http"} onChange={() => set("transport", "http")} />
              http
            </label>
          </div>
        </div>

        {fields.transport === "stdio" ? (
          <>
            <label className="settings-field">
              <span className="settings-field-label">Command</span>
              <input
                className="settings-field-input"
                type="text"
                value={fields.command}
                placeholder="node"
                onChange={(e) => set("command", e.target.value)}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field-label">Arguments (one per line)</span>
              <textarea
                className="settings-field-input mcp-textarea"
                value={fields.argsText}
                onChange={(e) => set("argsText", e.target.value)}
              />
            </label>
            <label className="settings-field">
              <span className="settings-field-label">Working directory (optional)</span>
              <input className="settings-field-input" type="text" value={fields.cwd} onChange={(e) => set("cwd", e.target.value)} />
            </label>
          </>
        ) : (
          <label className="settings-field">
            <span className="settings-field-label">URL</span>
            <input
              className="settings-field-input"
              type="text"
              value={fields.url}
              placeholder="https://…"
              onChange={(e) => set("url", e.target.value)}
            />
          </label>
        )}

        <div className="settings-field">
          <span className="settings-field-label">Environment variables</span>
          <div className="mcp-env-rows">
            {fields.envRows.map((row, index) =>
              row.locked ? (
                <div key={`locked-${row.key}-${index}`} className="mcp-env-row">
                  <span className="mcp-env-key settings-mcp-name">{row.key}=••••</span>
                  <input
                    className="settings-field-input"
                    type="password"
                    autoComplete="off"
                    placeholder="Leave blank to remove, or type a new value"
                    value={row.value}
                    onChange={(e) => setEnvValue(index, e.target.value)}
                  />
                </div>
              ) : (
                <div key={`new-${index}`} className="mcp-env-row">
                  <input
                    className="settings-field-input mcp-env-key-input"
                    type="text"
                    placeholder="KEY"
                    value={row.key}
                    onChange={(e) => setNewEnvKey(index, e.target.value)}
                  />
                  <input
                    className="settings-field-input"
                    type="password"
                    autoComplete="off"
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => setEnvValue(index, e.target.value)}
                  />
                  <button type="button" className="mcp-icon-button" aria-label="Remove variable" onClick={() => removeEnvRow(index)}>
                    <X />
                  </button>
                </div>
              ),
            )}
            <button type="button" className="settings-button" onClick={addEnvRow}>
              Add variable
            </button>
          </div>
          <span className="settings-field-hint">
            Typed values are saved in the config file as written. For a token, prefer a reference:{" "}
            <code>{"${secret:NAME}"}</code> (add the value under Secrets above) or <code>{"${env:NAME}"}</code>.
          </span>
        </div>

        <div className="settings-field-row">
          <button
            type="button"
            role="switch"
            aria-checked={fields.enabled}
            aria-labelledby="mcp-form-enabled-caption"
            className={`settings-switch${fields.enabled ? " settings-switch-on" : ""}`}
            onClick={() => set("enabled", !fields.enabled)}
          >
            <span className="settings-switch-thumb" />
          </button>
          <span id="mcp-form-enabled-caption" className="settings-switch-caption">
            Enabled
          </span>
        </div>

        {error && (
          <div className="mcp-problem-strip" role="alert">
            <span>{error}</span>
          </div>
        )}
      </div>
      <div className="mcp-dialog-actions">
        <button type="button" className="settings-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="settings-button settings-button-primary" disabled={!canSubmit} onClick={onSubmit}>
          {mode === "add" ? "Add server" : "Save changes"}
        </button>
      </div>
    </dialog>
  );
}

// ── import dialog (design §4 W3: grouped by harness, masked env chips, single consent checkbox) ──

interface McpImportDialogProps {
  scan: McpImportScanResult | null;
  selection: Record<string, boolean>;
  consent: boolean;
  /** Taskana 4706: the pane's resolved write target (header scope bar) — displayed as a hint, no longer a radio. */
  scopeMode: "project" | "user";
  results: McpImportApplyResultItem[] | null;
  onToggleRow: (id: string) => void;
  onConsentChange: (checked: boolean) => void;
  onApply: () => void;
  onClose: () => void;
}

function McpImportDialog({
  scan,
  selection,
  consent,
  scopeMode,
  results,
  onToggleRow,
  onConsentChange,
  onApply,
  onClose,
}: McpImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const groups = scan ? groupImportCandidates(scan.candidates) : [];

  return (
    <dialog
      ref={dialogRef}
      className="mcp-form-dialog mcp-import-dialog"
      aria-label="Import MCP servers"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="mcp-dialog-header">
        <span className="mcp-dialog-title">Import MCP servers</span>
      </div>
      <div className="mcp-dialog-body" data-mcp-scan-loaded={scan !== null}>
        {!scan ? (
          <div className="settings-mcp-empty">Scanning for MCP servers…</div>
        ) : groups.length === 0 ? (
          <div className="settings-mcp-empty">No MCP servers found in Claude, Codex, zcode, or .mcp.json.</div>
        ) : (
          <>
            {scan.problems.map((problem) => (
              <div key={problem} className="mcp-problem-strip" role="alert">
                <span>{problem}</span>
              </div>
            ))}
            {groups.map((group) => (
              <div key={`${group.harness}:${group.sourcePath}`} className="mcp-import-group">
                <div className="mcp-import-group-header">
                  <span className="mcp-import-harness">{harnessLabel(group.harness)}</span>
                  <span className="mcp-import-source settings-mcp-name">{group.sourcePath}</span>
                </div>
                {group.candidates.map((candidate) => (
                  <label
                    key={candidate.id}
                    className="mcp-import-row"
                    data-mcp-import-id={candidate.id}
                    data-mcp-import-name={candidate.name}
                    data-mcp-import-harness={candidate.harness}
                    data-mcp-import-already={candidate.alreadyConfigured}
                  >
                    <input type="checkbox" checked={selection[candidate.id] ?? false} onChange={() => onToggleRow(candidate.id)} />
                    <span className="mcp-import-name settings-mcp-name">{candidate.name}</span>
                    {candidate.alreadyConfigured && <span className="mcp-badge">already configured</span>}
                    {candidate.alreadyActiveViaCompat && <span className="mcp-badge">already active via compat</span>}
                    <span className="mcp-row-line2">
                      {candidate.transport} · {candidate.commandLine}
                    </span>
                    {candidate.envKeys.length > 0 && (
                      <span className="mcp-env-chips">
                        {maskedEnvChips(candidate.envKeys).map((chip) => (
                          <span key={chip} className="mcp-env-chip">
                            {chip}
                          </span>
                        ))}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            ))}

            {/* Taskana 4706: the "Add to" radio is gone — the write target is
                the pane's header scope bar (ScopeSwitcher), restated here as a
                hint so the dialog itself names where imports will land. */}
            <div className="mcp-import-scope">
              <div className="mcp-row-hint">
                Adding to {scopeMode === "project" ? "this project's config" : "your global (user) config"}
              </div>
            </div>

            <label className="mcp-consent-row">
              <input type="checkbox" checked={consent} onChange={(e) => onConsentChange(e.target.checked)} />
              Copy secret values from the source config
            </label>

            {results && (
              <div className="mcp-import-results">
                {results.map((item) => (
                  <div key={`${item.harness}:${item.name}`} className="mcp-import-result">
                    {importResultText(item)}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="mcp-dialog-actions">
        <button type="button" className="settings-button" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="settings-button settings-button-primary"
          disabled={selectedImportIds(selection).length === 0}
          onClick={onApply}
        >
          {importFooterLabel(selection)}
        </button>
      </div>
    </dialog>
  );
}

// ── Taskana 4732 S1-C: read-only plugin-contributed row (design 4732 §6) ──

/**
 * One plugin-contributed MCP server: name, owning plugin badge, transport
 * command/url, and — until consent is granted — a "Needs approval" note that
 * points at the Plugins pane. READ-ONLY by construction: no toggle, no edit,
 * no delete (enable/consent are plugin-scoped, user-global, and live in
 * Settings → Plugins; a `shadowed` row adds "overridden by your config").
 */
export function McpPluginRowItem({ server, status }: { server: McpPluginServerView; status?: McpServerStatus }) {
  return (
    <li className="mcp-row mcp-row-plugin" data-mcp-plugin-server={server.name}>
      <div className="mcp-row-main">
        <div className="mcp-row-lines">
          <div className="mcp-row-line1">
            <span className="mcp-row-name settings-mcp-name">{server.name}</span>
            <span className="mcp-badge mcp-badge-tools">plugin: {server.pluginName}</span>
            {server.shadowed && <span className="mcp-badge mcp-badge-user">overridden by your config</span>}
          </div>
          <div className="mcp-row-line2" title={server.pluginRoot !== "" ? server.pluginRoot : undefined}>
            {server.commandLine}
          </div>
          {status && <div className="mcp-row-hint">{describeMcpServer(status).detail}</div>}
          {!server.consentGranted && (
            <div className="mcp-row-hint plugins-mcp-approve">
              Needs approval —{" "}
              <button
                type="button"
                className="plugins-manage-link"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
                  window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: "plugins" }));
                }}
              >
                approve in Plugins
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

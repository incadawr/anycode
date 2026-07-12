/**
 * MCP config management control-plane IPC (design slice-P7.19-cut.md §3, §4 W2).
 * Registers `ipcMain.handle` for the five channels in shared/mcp-config.ts: a
 * read-only joined project/user/compat config view, upsert/delete of one server
 * entry, and scan/apply of an explicit-trust import from foreign harness
 * configs (Claude, Codex, zcode). Mirrors main/settings-ipc.ts exactly: the
 * handler logic is exported pure functions over a deps bag (unit-testable
 * without ipcMain), zod validates every renderer payload at this trust boundary

 *
 * Core runtime is imported ONLY through the `@anycode/core/mcp-admin` subpath
 * (never the core barrel, which would drag the ai-SDK into the thin main
 * process — same rule as `@anycode/core/persistence` in main/index.ts).
 *

 * never crosses to the renderer. `buildSnapshot` and `handleMcpImportScan`
 * project ONLY `envKeys` (key names) from the entries they read — the raw
 * `entry.env`/`entry.headers` values touched here (main-side, trusted process)
 * are never placed on a response object. A value only crosses renderer -> main,
 * inside an upsert/edit `entry` payload or during import-apply's main-side
 * foreign-file -> our-file copy.
 *
 * Path safety (design §3): the renderer NEVER supplies a filesystem path — only
 * `tabId` + `scope` + `name`/`entry`. The project path is resolved main-side
 * from `deps.workspaceForTab(tabId)` (tab-ipc.ts's `meta.workspace` fact), never
 * from a renderer-supplied string.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  applyMcpImport,
  deleteMcpServer,
  mcpServerEntrySchema,
  scanHarnessConfigs,
  setMcpServerEnabled,
  upsertMcpServer,
  type HarnessImportCandidate,
  type McpServerEntry,
} from "@anycode/core/mcp-admin";
import {
  MCP_CONFIG_DELETE_CHANNEL,
  MCP_CONFIG_GET_CHANNEL,
  MCP_CONFIG_PROMOTE_COMPAT_CHANNEL,
  MCP_CONFIG_SET_ENABLED_CHANNEL,
  MCP_CONFIG_UPSERT_CHANNEL,
  MCP_IMPORT_APPLY_CHANNEL,
  MCP_IMPORT_SCAN_CHANNEL,
} from "../shared/mcp-config.js";
import type {
  McpConfigEntryView,
  McpConfigMutationResult,
  McpConfigScope,
  McpConfigSnapshot,
  McpConfigSource,
  McpImportApplyResult,
  McpImportApplyResultItem,
  McpImportCandidateView,
  McpImportScanResult,
  McpServerEntryInput,
  McpTransport,
} from "../shared/mcp-config.js";

// ── fs port (structural — matches core's FileSystemPort by shape, no core-barrel import) ──

/**
 * The minimal file-system surface the mcp-admin functions need (readFile,
 * writeFile, exists, optionally rename), typed structurally rather than
 * importing core's `FileSystemPort` (no subpath exports it) — same "duplicated
 * on purpose, not value-imported" rule main/index.ts documents for its env
 * constants. `stat`/`mkdir`/`readdir` are included so the concrete Node
 * implementation below satisfies core's FileSystemPort shape structurally (the
 * mcp-admin functions only ever call readFile/writeFile/exists/rename).
 */
export interface McpConfigFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; mode?: number }>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename?(from: string, to: string): Promise<void>;
  /** Sets POSIX mode bits — config-write uses it to keep a secrets config private across tmp+rename (W5-FIX, finding 4). */
  chmod?(path: string, mode: number): Promise<void>;
}

/** Thin node:fs/promises implementation of McpConfigFs (main-process-local, no core import). */
export class NodeMcpConfigFs implements McpConfigFs {
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, "utf-8");
  }
  async writeFile(path: string, content: string): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, content, "utf-8");
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; mode?: number }> {
    const s = await fsp.stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), mode: s.mode };
  }
  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }
  async readdir(path: string): Promise<string[]> {
    return fsp.readdir(path);
  }
  async rename(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }
  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(path, mode);
  }
}

export interface McpConfigIpcDeps {
  /** `os.homedir()` in production; `ANYCODE_MCP_IMPORT_HOME`-overridable at the main/index.ts wiring site (dev/test only). */
  home(): string;
  /** Resolves the active tab's workspace from main's own tab-meta fact (tab-ipc.ts) — never a renderer-supplied path. */
  workspaceForTab(tabId: string): string | undefined;
  fs: McpConfigFs;
}



const scopeSchema: z.ZodType<McpConfigScope> = z.enum(["project", "user", "compat"]);

const entryInputSchema: z.ZodType<McpServerEntryInput> = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritEnv: z.boolean().optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const getSchema = z.object({ tabId: z.string().optional() });

const upsertSchema = z.object({
  tabId: z.string().optional(),
  scope: scopeSchema,
  name: z.string().min(1),
  entry: entryInputSchema,
});

const deleteSchema = z.object({
  tabId: z.string().optional(),
  scope: scopeSchema,
  name: z.string().min(1),
});

const setEnabledSchema = z.object({
  tabId: z.string().optional(),
  scope: scopeSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
});

const importScanSchema = z.object({ tabId: z.string().optional() });

const promoteCompatSchema = z.object({
  tabId: z.string().optional(),
  name: z.string().min(1),
});

const importApplySchema = z.object({
  tabId: z.string().optional(),
  scope: scopeSchema,
  // W5-FIX (finding 2): `ids` is the cross-source-safe selector (identity), `names`
  // the back-compat fallback. At least one is used; both optional so either driver works.
  ids: z.array(z.string().min(1)).optional(),
  names: z.array(z.string().min(1)).optional(),
  includeEnvValues: z.boolean(),
});

// ── path resolution helpers ──

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

function projectConfigPath(workspace: string): string {
  return `${stripTrailingSep(workspace)}/.anycode/config.json`;
}

function userConfigPath(home: string): string {
  return `${stripTrailingSep(home)}/.anycode/config.json`;
}

function compatConfigPath(workspace: string): string {
  return `${stripTrailingSep(workspace)}/.mcp.json`;
}

/** Resolves a request's workspace: undefined tabId or an unknown tab yields undefined (fail-soft, not a throw). */
function resolveWorkspace(deps: McpConfigIpcDeps, tabId: string | undefined): string | undefined {
  if (tabId === undefined) {
    return undefined;
  }
  return deps.workspaceForTab(tabId);
}

// ── raw config-file reading (mirrors core/mcp/config.ts's loadSource, but keeps
//    disabled entries too — the admin view must show a server that would never
//    reach the runtime spec list, config.ts §4 W2 "what status does NOT carry") ──

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reserved object keys that hit a prototype setter/built-in rather than a data property (W5-FIX, finding 7). */
const DANGEROUS_SERVER_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isDangerousServerName(name: string): boolean {
  return DANGEROUS_SERVER_NAMES.has(name);
}

/** Stable import-candidate identity (W5-FIX, finding 2): disambiguates same-named candidates across harnesses. */
function candidateId(candidate: HarnessImportCandidate): string {
  return `${candidate.harness} ${candidate.sourcePath} ${candidate.name}`;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Reads + validates one `mcpServers` config file. Missing = silent no-op; bad = a problems[] note. */
async function readServersFile(
  fs: McpConfigFs,
  path: string,
  problems: string[],
): Promise<Record<string, McpServerEntry> | undefined> {
  if (!(await fs.exists(path))) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    problems.push(`Could not read ${path}: ${describeError(error)}`);
    return undefined;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    problems.push(`Invalid JSON in ${path}: ${describeError(error)}`);
    return undefined;
  }
  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    problems.push(`${path}: expected a JSON object — skipped`);
    return undefined;
  }
  const rawServers = (parsedJson as Record<string, unknown>).mcpServers;
  if (rawServers === undefined) {
    return undefined;
  }
  if (typeof rawServers !== "object" || rawServers === null || Array.isArray(rawServers)) {
    problems.push(`${path}: "mcpServers" is not an object — skipped`);
    return undefined;
  }
  const out: Record<string, McpServerEntry> = {};
  for (const [name, rawEntry] of Object.entries(rawServers as Record<string, unknown>)) {
    // W5-FIX (finding 7): a reserved key would hit `out`'s prototype setter
    // (silent drop / pollution) rather than define a plain data property — skip.
    if (isDangerousServerName(name)) {
      problems.push(`${path}: skipped a server with a reserved unsafe name`);
      continue;
    }
    const parsed = mcpServerEntrySchema.safeParse(rawEntry);
    if (!parsed.success) {
      problems.push(`${path}: server '${name}' skipped — ${formatZodError(parsed.error)}`);
      continue;
    }
    out[name] = parsed.data;
  }
  return out;
}

function transportOf(entry: McpServerEntry): McpTransport {
  return entry.command !== undefined ? "stdio" : "http";
}

/** `command + args` (stdio) or `url` (http), joined MAIN-side (args are trusted config, they cross). */
function commandLineOf(entry: McpServerEntry): string {
  if (entry.command !== undefined) {
    return [entry.command, ...(entry.args ?? [])].join(" ");
  }
  return entry.url ?? "";
}

/** KEY NAMES only (custody) — never the env/header values. */
function envKeysOf(entry: McpServerEntry): string[] {
  return [...Object.keys(entry.env ?? {}), ...Object.keys(entry.headers ?? {})];
}

function toEntryView(name: string, entry: McpServerEntry, source: McpConfigSource, shadowed: boolean): McpConfigEntryView {
  const view: McpConfigEntryView = {
    name,
    source,
    enabled: (entry.enabled ?? true) === true,
    transport: transportOf(entry),
    commandLine: commandLineOf(entry),
    envKeys: envKeysOf(entry),
  };
  // cwd is trusted config (filesystem path), not a secret — safe to cross (W3-FIX).
  if (entry.cwd !== undefined) {
    view.cwd = entry.cwd;
  }
  if (shadowed) {
    view.shadowed = true;
  }
  return view;
}

/**
 * Builds the joined config view: reads project (if a workspace resolves),

 * rule (project > user > compat) — the highest source to define a name renders
 * unshadowed; every lower-priority definition of the SAME name still renders,
 * flagged `shadowed:true`, so the page can surface/edit it.
 */
async function buildSnapshot(deps: McpConfigIpcDeps, tabId: string | undefined): Promise<McpConfigSnapshot> {
  const workspace = resolveWorkspace(deps, tabId);
  const home = deps.home();
  const problems: string[] = [];

  const sources: { source: McpConfigSource; path: string }[] = [];
  if (workspace !== undefined) {
    sources.push({ source: "project", path: projectConfigPath(workspace) });
  }
  sources.push({ source: "user", path: userConfigPath(home) });
  if (workspace !== undefined) {
    sources.push({ source: "compat", path: compatConfigPath(workspace) });
  }

  const entries: McpConfigEntryView[] = [];
  const claimed = new Set<string>();
  for (const { source, path } of sources) {
    const servers = await readServersFile(deps.fs, path, problems);
    if (servers === undefined) {
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) {
      const shadowed = claimed.has(name);
      if (!shadowed) {
        claimed.add(name);
      }
      entries.push(toEntryView(name, entry, source, shadowed));
    }
  }

  return { entries, problems };
}

// ── handlers (exported for unit tests) ──

/** mcp-config-get: the joined project/user/compat snapshot. Always succeeds (fail-soft internally). */
export async function handleMcpConfigGet(deps: McpConfigIpcDeps, raw: unknown): Promise<McpConfigSnapshot> {
  const parsed = getSchema.safeParse(raw);
  const tabId = parsed.success ? parsed.data.tabId : undefined;
  return buildSnapshot(deps, tabId);
}

/** Validates an entry payload beyond the zod shape: exactly one of command/url (config.ts's resolveEntry rule). */
function validateEntryXor(entry: McpServerEntryInput): boolean {
  const hasCommand = entry.command !== undefined;
  const hasUrl = entry.url !== undefined;
  return hasCommand !== hasUrl;
}

/**
 * mcp-config-upsert: add/replace one server entry. Refuses `invalid` (bad
 * payload or a command/url shape violation), `read_only_source` (scope
 * `compat` — we never write a foreign harness's file), `no_workspace` (scope
 * `project` with no resolvable tab workspace), and `io_error` (the target file
 * exists but is not valid JSON/an object — config-write.ts never clobbers a
 * config it cannot understand).
 */
export async function handleMcpUpsert(deps: McpConfigIpcDeps, raw: unknown): Promise<McpConfigMutationResult> {
  const parsed = upsertSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  if (!validateEntryXor(parsed.data.entry)) {
    return { ok: false, reason: "invalid" };
  }
  const entryValidation = mcpServerEntrySchema.safeParse(parsed.data.entry);
  if (!entryValidation.success) {
    return { ok: false, reason: "invalid" };
  }
  const { scope, name, tabId } = parsed.data;
  if (scope === "compat") {
    return { ok: false, reason: "read_only_source" };
  }
  // W5-FIX (finding 7): a reserved prototype-key name is refused at the trust boundary.
  if (isDangerousServerName(name)) {
    return { ok: false, reason: "invalid" };
  }
  const configPath = await resolveScopePath(deps, scope, tabId);
  if (configPath === undefined) {
    return { ok: false, reason: "no_workspace" };
  }
  let result: { ok: true } | { ok: false; reason: "unsafe_name" };
  try {
    result = await upsertMcpServer(deps.fs, configPath, name, entryValidation.data);
  } catch (error) {
    console.warn(`[mcp-config-ipc] upsert failed for ${configPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  if (!result.ok) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * mcp-config-delete: remove one server entry from a scope's config file. Same
 * refusal set as upsert minus `invalid`-on-entry (there is no entry payload).
 */
export async function handleMcpDelete(deps: McpConfigIpcDeps, raw: unknown): Promise<McpConfigMutationResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { scope, name, tabId } = parsed.data;
  if (scope === "compat") {
    return { ok: false, reason: "read_only_source" };
  }
  const configPath = await resolveScopePath(deps, scope, tabId);
  if (configPath === undefined) {
    return { ok: false, reason: "no_workspace" };
  }
  try {
    await deleteMcpServer(deps.fs, configPath, name);
  } catch (error) {
    console.warn(`[mcp-config-ipc] delete failed for ${configPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * mcp-config-set-enabled (W3-FIX): patches ONLY `mcpServers[name].enabled` via
 * core's `setMcpServerEnabled` — every other field of the entry (cwd/env/
 * headers/args/etc) is preserved byte-semantically, unlike `handleMcpUpsert`
 * which requires the caller to resubmit the FULL entry (and a display-only
 * `McpConfigEntryView` never carries secret env/header values). Same scope
 * resolution + refusal set as upsert/delete, plus `not_found` when the name
 * no longer exists in the target scope's config file (e.g. a stale row from
 * a snapshot fetched before an out-of-band edit).
 */
export async function handleMcpSetEnabled(deps: McpConfigIpcDeps, raw: unknown): Promise<McpConfigMutationResult> {
  const parsed = setEnabledSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { scope, name, enabled, tabId } = parsed.data;
  if (scope === "compat") {
    return { ok: false, reason: "read_only_source" };
  }
  const configPath = await resolveScopePath(deps, scope, tabId);
  if (configPath === undefined) {
    return { ok: false, reason: "no_workspace" };
  }
  let result: { ok: true } | { ok: false; reason: "not_found" };
  try {
    result = await setMcpServerEnabled(deps.fs, configPath, name, enabled);
  } catch (error) {
    console.warn(`[mcp-config-ipc] setEnabled failed for ${configPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  if (!result.ok) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/**
 * mcp-config-promote-compat (W5-FIX, finding 3): promotes a compat
 * `<ws>/.mcp.json` server into the PROJECT `.anycode/config.json`. Reads the
 * REAL entry main-side (args/cwd/env/headers verbatim), forces `enabled:false`
 * (trust gate — never silently enable an import), and writes via core's
 * name-guarded `upsertMcpServer`. The renderer supplies only `{tabId, name}`;
 * it never reconstructs the entry from a display-only view (which dropped
 * cwd/env and split quoted args on whitespace) and never handles the values
 * (custody preserved). Refuses `no_workspace` (no tab), `not_found` (the compat
 * entry is gone), `invalid` (a reserved/unsafe name), and `io_error`.
 */
export async function handleMcpPromoteCompat(deps: McpConfigIpcDeps, raw: unknown): Promise<McpConfigMutationResult> {
  const parsed = promoteCompatSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, name } = parsed.data;
  if (isDangerousServerName(name)) {
    return { ok: false, reason: "invalid" };
  }
  const workspace = resolveWorkspace(deps, tabId);
  if (workspace === undefined) {
    return { ok: false, reason: "no_workspace" };
  }
  const compatProblems: string[] = [];
  let compatServers: Record<string, McpServerEntry> | undefined;
  try {
    compatServers = await readServersFile(deps.fs, compatConfigPath(workspace), compatProblems);
  } catch (error) {
    console.warn(`[mcp-config-ipc] promote-compat read failed for ${workspace}`, error);
    return { ok: false, reason: "io_error" };
  }
  const entry = compatServers?.[name];
  if (entry === undefined) {
    return { ok: false, reason: "not_found" };
  }
  // Trust gate: forced disabled; every other field (args/cwd/env/headers) verbatim.
  const promoted: McpServerEntry = { ...entry, enabled: false };
  let result: { ok: true } | { ok: false; reason: "unsafe_name" };
  try {
    result = await upsertMcpServer(deps.fs, projectConfigPath(workspace), name, promoted);
  } catch (error) {
    console.warn(`[mcp-config-ipc] promote-compat write failed for ${workspace}`, error);
    return { ok: false, reason: "io_error" };
  }
  if (!result.ok) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, snapshot: await buildSnapshot(deps, tabId) };
}

/** Resolves a non-compat scope to its config file path; `project` with no workspace yields undefined (`no_workspace`). */
async function resolveScopePath(
  deps: McpConfigIpcDeps,
  scope: "project" | "user",
  tabId: string | undefined,
): Promise<string | undefined> {
  if (scope === "user") {
    return userConfigPath(deps.home());
  }
  const workspace = resolveWorkspace(deps, tabId);
  if (workspace === undefined) {
    return undefined;
  }
  return projectConfigPath(workspace);
}

function toCandidateView(candidate: HarnessImportCandidate, alreadyConfigured: boolean): McpImportCandidateView {
  const view: McpImportCandidateView = {
    id: candidateId(candidate),
    harness: candidate.harness,
    sourcePath: candidate.sourcePath,
    name: candidate.name,
    transport: transportOf(candidate.entry),
    commandLine: commandLineOf(candidate.entry),
    envKeys: candidate.envKeys,
    hasSecrets: candidate.envKeys.length > 0,
    alreadyConfigured,
  };
  if (candidate.alreadyActiveViaCompat) {
    view.alreadyActiveViaCompat = true;
  }
  return view;
}

/**
 * mcp-import-scan: fans out over the fixed foreign-harness allowlist (W1's
 * `scanHarnessConfigs`, itself path-safe — no caller-supplied paths) and
 * projects each candidate through the custody-safe view (envKeys names only).
 * Always succeeds — per-source read problems surface in `problems[]`. A
 * candidate's `alreadyConfigured` is computed against the SAME joined snapshot
 * `mcp-config-get` would return (project + user rows, incl. shadowed).
 */
export async function handleMcpImportScan(deps: McpConfigIpcDeps, raw: unknown): Promise<McpImportScanResult> {
  const parsed = importScanSchema.safeParse(raw);
  const tabId = parsed.success ? parsed.data.tabId : undefined;
  const workspace = resolveWorkspace(deps, tabId) ?? "";
  const home = deps.home();

  const [scan, snapshot] = await Promise.all([
    scanHarnessConfigs(deps.fs, home, workspace),
    buildSnapshot(deps, tabId),
  ]);

  const configuredNames = new Set(
    snapshot.entries.filter((e) => e.source === "project" || e.source === "user").map((e) => e.name),
  );
  const candidates = scan.candidates.map((c) => toCandidateView(c, configuredNames.has(c.name)));
  return { candidates, problems: scan.problems };
}

/**
 * mcp-import-apply: re-scans the same allowlist (main is stateless between
 * scan and apply — no scan-result caching), filters to the consented `names`,
 * and calls W1's `applyMcpImport` against the resolved scope path. Forced
 * `enabled:false` and consent-gated env/header values are W1's guarantee
 * (config-write.ts `buildImportEntry`) — this handler does not re-implement or
 * undo it. Compat scope refused; project scope with no workspace refused.
 */
export async function handleMcpImportApply(deps: McpConfigIpcDeps, raw: unknown): Promise<McpImportApplyResult> {
  const parsed = importApplySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { scope, ids, names, includeEnvValues, tabId } = parsed.data;
  if (scope === "compat") {
    return { ok: false, reason: "read_only_source" };
  }
  const configPath = await resolveScopePath(deps, scope, tabId);
  if (configPath === undefined) {
    return { ok: false, reason: "no_workspace" };
  }

  const workspace = resolveWorkspace(deps, tabId) ?? "";
  const home = deps.home();

  // W5-FIX (finding 2): filter on candidate IDENTITY when `ids` is supplied
  // (the renderer's path) — a `name`-only filter would copy a same-named
  // candidate from a source the user never selected (cross-source credential
  // copy). `names` remains the back-compat fallback for the automation driver
  // (distinct names only), used only when no `ids` are given.
  const idSet = ids && ids.length > 0 ? new Set(ids) : undefined;
  const nameSet = idSet ? undefined : new Set(names ?? []);

  let results: McpImportApplyResultItem[];
  try {
    const scan = await scanHarnessConfigs(deps.fs, home, workspace);
    const selected = scan.candidates.filter((c) =>
      idSet ? idSet.has(candidateId(c)) : nameSet!.has(c.name),
    );
    results = await applyMcpImport(deps.fs, configPath, selected, { includeEnvValues });
  } catch (error) {
    console.warn(`[mcp-config-ipc] import-apply failed for ${configPath}`, error);
    return { ok: false, reason: "io_error" };
  }

  return { ok: true, results, snapshot: await buildSnapshot(deps, tabId) };
}

/** Wires the five channels onto ipcMain. A payload the handler cannot validate is answered with a safe negative. */
export function registerMcpConfigIpc(deps: McpConfigIpcDeps): void {
  ipcMain.handle(MCP_CONFIG_GET_CHANNEL, (_event, raw: unknown) => handleMcpConfigGet(deps, raw));
  ipcMain.handle(MCP_CONFIG_UPSERT_CHANNEL, (_event, raw: unknown) => handleMcpUpsert(deps, raw));
  ipcMain.handle(MCP_CONFIG_DELETE_CHANNEL, (_event, raw: unknown) => handleMcpDelete(deps, raw));
  ipcMain.handle(MCP_CONFIG_SET_ENABLED_CHANNEL, (_event, raw: unknown) => handleMcpSetEnabled(deps, raw));
  ipcMain.handle(MCP_CONFIG_PROMOTE_COMPAT_CHANNEL, (_event, raw: unknown) => handleMcpPromoteCompat(deps, raw));
  ipcMain.handle(MCP_IMPORT_SCAN_CHANNEL, (_event, raw: unknown) => handleMcpImportScan(deps, raw));
  ipcMain.handle(MCP_IMPORT_APPLY_CHANNEL, (_event, raw: unknown) => handleMcpImportApply(deps, raw));
}

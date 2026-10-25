/**
 * Language-server config management control-plane IPC (Taskana 4743).
 * Registers `ipcMain.handle` for the four channels in shared/lsp-config.ts:
 * the joined catalog/detection/config/trust status view, one-click enable of
 * a catalog preset, disable (remove) of a configured entry, and a custom
 * entry upsert. Mirrors main/mcp-config-ipc.ts exactly: exported pure handler
 * functions over a deps bag (unit-testable without ipcMain), zod `.strict()`
 * at this trust boundary, and the renderer never supplies a filesystem path —
 * only `tabId`, main resolves the workspace from its own tab meta.
 *
 * Core runtime is imported ONLY through `@anycode/core/lsp-admin` (never the
 * core barrel, which would drag the ai-SDK into the thin main process — same
 * rule as `@anycode/core/mcp-admin` in mcp-config-ipc.ts).
 *
 * Config semantics (brief §1): `lspServers` is read ONCE at host boot; these
 * handlers change the FILE, and the pane says changes apply to new
 * sessions/tabs. There is deliberately no reload action and no LspManager
 * touch here.
 *
 * Detection (main/lsp-detect.ts) is existence-only: nothing is installed,
 * nothing is executed, and only `found` + a coarse source cross to the
 * renderer — never a resolved absolute path.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { deleteLspServer, lspServerEntrySchema, upsertLspServer } from "@anycode/core/lsp-admin";
import type { LspServerEntry } from "@anycode/core/lsp-admin";
import {
  defaultTrustStorePath,
  resolveWorkspaceTrust,
} from "@anycode/core/workspace-trust";
import { LSP_CATALOG, findCatalogEntry } from "../shared/lsp-catalog.js";
import {
  LSP_CATALOG_STATUS_CHANNEL,
  LSP_CUSTOM_UPSERT_CHANNEL,
  LSP_DISABLE_CHANNEL,
  LSP_ENABLE_CHANNEL,
} from "../shared/lsp-config.js";
import type {
  LspCatalogStatusEntry,
  LspConfigScope,
  LspConfigStatus,
  LspEntryView,
  LspFoundSource,
  LspMutationResult,
} from "../shared/lsp-config.js";
import { detectCommand, type DetectedFile } from "./lsp-detect.js";

// ── fs port (structural — matches core's FileSystemPort by shape, no core-barrel import) ──

/**
 * The minimal file-system surface the lsp-admin functions need, typed
 * structurally like McpConfigFs in mcp-config-ipc.ts (same "duplicated on
 * purpose" rule). `stat` carries `isFile`/`mode` so detection's X_OK check
 * works over the same port the config writes use.
 */
export interface LspConfigFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; mode?: number }>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename?(from: string, to: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
}

/** Thin node:fs/promises implementation of LspConfigFs (main-process-local, no core import). */
export class NodeLspConfigFs implements LspConfigFs {
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

export interface LspConfigIpcDeps {
  /** `os.homedir()` in production; overridable at the main/index.ts wiring site (dev/test only, MCP precedent). */
  home(): string;
  /** Resolves the active tab's workspace from main's own tab-meta fact — never a renderer-supplied path. */
  workspaceForTab(tabId: string): string | undefined;
  fs: LspConfigFs;
  /** `process.env.PATH` in production; injectable for tests. */
  pathEnv?(): string | undefined;
  /** `process.platform` in production; injectable for tests. */
  platform?(): NodeJS.Platform;
  /**
   * Workspace trust for the pane's project notice: reuses the SAME core
   * resolver the host boot path uses (`@anycode/core/workspace-trust`,
   * never a second store). Injected because the once-approval map lives in
   * main/index.ts; absent => `projectTrusted: null` (the generic notice).
   */
  trust?: {
    /** The in-memory "trust once" hash for the workspace, if approved this run. */
    onceHash?(workspace: string): string | undefined;
  };
}

// ── request schemas (zod .strict() — the trust boundary; extra keys refuse as `invalid`) ──

const scopeSchema = z.enum(["project", "user"]);

const statusSchema = z
  .object({ tabId: z.string().optional() })
  .strict();

const enableSchema = z
  .object({
    tabId: z.string().optional(),
    presetId: z.string().min(1),
    scope: scopeSchema,
  })
  .strict();

const disableSchema = z
  .object({
    tabId: z.string().optional(),
    name: z.string().min(1),
    scope: scopeSchema,
  })
  .strict();

const customEntrySchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    extensions: z.array(z.string().min(1)).min(1),
  })
  .strict();

const customUpsertSchema = z
  .object({
    tabId: z.string().optional(),
    scope: scopeSchema,
    entry: customEntrySchema,
  })
  .strict();

// ── path resolution (mirror of mcp-config-ipc.ts) ──

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

function projectConfigPath(workspace: string): string {
  return `${stripTrailingSep(workspace)}/.anycode/config.json`;
}

function userConfigPath(home: string): string {
  return `${stripTrailingSep(home)}/.anycode/config.json`;
}

function resolveWorkspace(deps: LspConfigIpcDeps, tabId: string | undefined): string | undefined {
  if (tabId === undefined) {
    return undefined;
  }
  return deps.workspaceForTab(tabId);
}

async function resolveScopePath(
  deps: LspConfigIpcDeps,
  scope: LspConfigScope,
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

// ── configured-entry reading (keeps invalid entries visible as issues, mirrors the loader's fail-soft) ──

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Lowercases and ensures a leading dot (same normalization the core loader applies on read). */
export function normalizeLspExtension(ext: string): string {
  const lower = ext.trim().toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

/**
 * Reads one config file's `lspServers` into views + issues. Absent file =>
 * `[]`. A present-but-non-array `lspServers` reports an issue and yields `[]`
 * (the view must still render; writes to such a file are refused by the core
 * writer). Invalid entries are skipped with an issue — the same strings the
 * core loader would emit.
 */
async function readLspEntries(
  fs: LspConfigFs,
  path: string,
  issues: string[],
): Promise<LspEntryView[]> {
  if (!(await fs.exists(path))) {
    return [];
  }
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    issues.push(`Could not read LSP config ${path}: ${describeError(error)}`);
    return [];
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    issues.push(`Invalid JSON in LSP config ${path}: ${describeError(error)}`);
    return [];
  }
  if (typeof parsedJson !== "object" || parsedJson === null) {
    issues.push(`Invalid LSP config ${path}: top-level value is not an object`);
    return [];
  }
  const section = (parsedJson as { lspServers?: unknown }).lspServers;
  if (section === undefined) {
    return [];
  }
  if (!Array.isArray(section)) {
    issues.push(`Invalid LSP config ${path}: "lspServers" must be an array`);
    return [];
  }
  const views: LspEntryView[] = [];
  for (const item of section) {
    const parsed = lspServerEntrySchema.safeParse(item);
    if (!parsed.success) {
      issues.push(`Invalid LSP server in ${path}: ${formatZodError(parsed.error)}`);
      continue;
    }
    const entry = parsed.data;
    views.push({
      name: entry.name,
      command: entry.command,
      args: entry.args ?? [],
      extensions: entry.extensions.map(normalizeLspExtension),
      presetId: findCatalogEntry(entry.name) ? entry.name : null,
      hasInitOptions: entry.initializationOptions !== undefined,
    });
  }
  return views;
}

// ── detection ──

/** Runs existence-only detection for every catalog entry (see main/lsp-detect.ts). */
async function detectCatalog(
  deps: LspConfigIpcDeps,
  workspace: string | undefined,
): Promise<LspCatalogStatusEntry[]> {
  const home = deps.home();
  const entries: LspCatalogStatusEntry[] = [];
  for (const preset of LSP_CATALOG) {
    // nodeBin entries also look in <workspace>/node_modules/.bin; everything
    // else probes PATH + the common dirs only.
    const result = await detectCommand(preset.command, {
      pathEnv: deps.pathEnv?.(),
      platform: deps.platform?.() ?? process.platform,
      home,
      workspace: preset.nodeBin ? workspace : undefined,
      fileExists: async (path) => {
        if (!(await deps.fs.exists(path))) {
          return undefined;
        }
        try {
          const st = await deps.fs.stat(path);
          return { isFile: st.isFile, mode: st.mode } satisfies DetectedFile;
        } catch {
          return undefined;
        }
      },
    });
    entries.push({
      id: preset.id,
      label: preset.label,
      languages: preset.languages,
      command: preset.command,
      args: [...preset.args],
      extensions: [...preset.extensions],
      installHint: preset.installHint,
      found: result.found,
      foundSource: result.source as LspFoundSource | null,
    });
  }
  return entries;
}

// ── trust ──

/**
 * Whether the workspace's project spawn declarations may run: reuses the
 * SAME core resolver the host boot path uses, over the same trust store file
 * (`<home>/.anycode/workspace-trust.json` — defaultTrustStorePath), plus the
 * in-memory once-approval. Never throws; null when it cannot be determined
 * cheaply (no workspace, or a store read failure).
 */
async function resolveProjectTrusted(
  deps: LspConfigIpcDeps,
  workspace: string | undefined,
): Promise<boolean | null> {
  if (workspace === undefined) {
    return null;
  }
  const home = deps.home();
  try {
    const result = await resolveWorkspaceTrust(deps.fs, {
      workspace,
      home,
      storePath: defaultTrustStorePath(home),
      onceHash: deps.trust?.onceHash?.(workspace),
    });
    return result.projectTrusted;
  } catch {
    return null;
  }
}

// ── the status snapshot ──

async function buildStatus(deps: LspConfigIpcDeps, tabId: string | undefined): Promise<LspConfigStatus> {
  const workspace = resolveWorkspace(deps, tabId);
  const home = deps.home();
  const issues: string[] = [];

  const [projectEntries, userEntries, catalog] = await Promise.all([
    workspace !== undefined
      ? readLspEntries(deps.fs, projectConfigPath(workspace), issues)
      : Promise.resolve(null),
    readLspEntries(deps.fs, userConfigPath(home), issues),
    detectCatalog(deps, workspace),
  ]);

  const projectTrusted = await resolveProjectTrusted(deps, workspace);

  return {
    catalog,
    entries: { project: projectEntries, user: userEntries },
    issues,
    projectScopeAvailable: workspace !== undefined,
    projectTrusted,
  };
}

// ── handlers (exported for unit tests) ──

/** lsp-catalog-status: always succeeds (fail-soft internally). */
export async function handleLspCatalogStatus(deps: LspConfigIpcDeps, raw: unknown): Promise<LspConfigStatus> {
  const parsed = statusSchema.safeParse(raw);
  const tabId = parsed.success ? parsed.data.tabId : undefined;
  return buildStatus(deps, tabId);
}

/**
 * lsp-enable: writes the preset's `{name: id, command, args, extensions}`
 * into the scope's `lspServers` via core's guarded upsert. Refusals:
 * `invalid` (payload), `unknown_preset`, `no_workspace` (project scope with
 * no resolvable tab workspace), `io_error`, `invalid_shape` (non-array
 * `lspServers` the writer will not clobber).
 */
export async function handleLspEnable(deps: LspConfigIpcDeps, raw: unknown): Promise<LspMutationResult> {
  const parsed = enableSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const preset = findCatalogEntry(parsed.data.presetId);
  if (preset === undefined) {
    return { ok: false, reason: "unknown_preset" };
  }
  const configPath = await resolveScopePath(deps, parsed.data.scope, parsed.data.tabId);
  if (configPath === undefined) {
    return { ok: false, reason: "no_workspace" };
  }
  // Preset enable is a full replace-by-name by design: the preset IS the
  // canonical definition. initializationOptions on a same-name hand-written
  // entry are intentionally dropped (the pane's notice flow says remove +
  // re-add for hand-tuned entries; brief §6 excludes in-place editing).
  const entry: LspServerEntry = {
    name: preset.id,
    command: preset.command,
    args: [...preset.args],
    extensions: [...preset.extensions],
  };
  return writeAndRefresh(deps, configPath, parsed.data.tabId, (path) => upsertLspServer(deps.fs, path, entry));
}

/** lsp-disable: removes the named entry from the scope's `lspServers` (idempotent no-op when absent). */
export async function handleLspDisable(deps: LspConfigIpcDeps, raw: unknown): Promise<LspMutationResult> {
  const parsed = disableSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const configPath = await resolveScopePath(deps, parsed.data.scope, parsed.data.tabId);
  if (configPath === undefined) {
    return { ok: false, reason: "no_workspace" };
  }
  return writeAndRefresh(deps, configPath, parsed.data.tabId, (path) => deleteLspServer(deps.fs, path, parsed.data.name));
}

/**
 * lsp-custom-upsert: same entry schema as core minus `initializationOptions`.
 * Extensions are normalized to lowercase dot-prefixed form before the write;
 * empty/whitespace-only names and commands are refused (`invalid`) — command
 * is a single executable name or absolute path, args are separate.
 */
export async function handleLspCustomUpsert(deps: LspConfigIpcDeps, raw: unknown): Promise<LspMutationResult> {
  const parsed = customUpsertSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const input = parsed.data.entry;
  if (input.name.trim() === "" || input.command.trim() === "") {
    return { ok: false, reason: "invalid" };
  }
  const configPath = await resolveScopePath(deps, parsed.data.scope, parsed.data.tabId);
  if (configPath === undefined) {
    return { ok: false, reason: "no_workspace" };
  }
  const entry: LspServerEntry = {
    name: input.name.trim(),
    command: input.command.trim(),
    ...(input.args !== undefined && input.args.length > 0 ? { args: input.args } : {}),
    extensions: input.extensions.map(normalizeLspExtension),
  };
  return writeAndRefresh(deps, configPath, parsed.data.tabId, (path) => upsertLspServer(deps.fs, path, entry));
}

/** Shared tail: run the guarded write, map failures, refresh the status on success. */
async function writeAndRefresh(
  deps: LspConfigIpcDeps,
  configPath: string,
  tabId: string | undefined,
  write: (path: string) => Promise<{ ok: true } | { ok: false; reason: "unsafe_name" | "invalid_shape" } | void>,
): Promise<LspMutationResult> {
  let result: { ok: true } | { ok: false; reason: "unsafe_name" | "invalid_shape" } | void;
  try {
    result = await write(configPath);
  } catch (error) {
    console.warn(`[lsp-config-ipc] write failed for ${configPath}`, error);
    return { ok: false, reason: "io_error" };
  }
  // deleteLspServer returns void (delete-missing is a no-op success).
  if (result !== undefined && !result.ok) {
    return { ok: false, reason: result.reason === "unsafe_name" ? "invalid" : "invalid_shape" };
  }
  return { ok: true, status: await buildStatus(deps, tabId) };
}

/** Wires the four channels onto ipcMain. A payload the handler cannot validate is answered with a safe negative. */
export function registerLspConfigIpc(deps: LspConfigIpcDeps): void {
  ipcMain.handle(LSP_CATALOG_STATUS_CHANNEL, (_event, raw: unknown) => handleLspCatalogStatus(deps, raw));
  ipcMain.handle(LSP_ENABLE_CHANNEL, (_event, raw: unknown) => handleLspEnable(deps, raw));
  ipcMain.handle(LSP_DISABLE_CHANNEL, (_event, raw: unknown) => handleLspDisable(deps, raw));
  ipcMain.handle(LSP_CUSTOM_UPSERT_CHANNEL, (_event, raw: unknown) => handleLspCustomUpsert(deps, raw));
}

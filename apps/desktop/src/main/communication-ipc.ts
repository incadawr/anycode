/**
 * Sessions API control-plane IPC (Taskana 4747): the Settings → Sessions API
 * pane's only write path. Exported pure handlers over a deps bag (unit-testable
 * without ipcMain), zod `.strict()` on every payload, and the renderer NEVER
 * supplies a filesystem path: folders come only from the native dialog owned by
 * main (`pickFolder`), and `remove-workspace` is an exact-match lookup key.
 *
 * Writes go through `withSettingsFileLock` (the same discipline as
 * recognizer-set): load -> mutate `settings.communication` -> save -> apply the
 * live server, all inside the lock so the controller's apply order matches the
 * saved order. `settings-set` refuses the block (settings-ipc.ts), so this
 * module is its only writer.
 *
 * Every response is a projection built here, from an allow-list. Nothing in this
 * file reads the discovery file, so the bearer token cannot reach a payload.
 */
import { ipcMain } from "electron";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import type { AnycodeSettings } from "../shared/settings.js";
import {
  COMMUNICATION_ADD_WORKSPACE_CHANNEL,
  COMMUNICATION_AGENT_PROJECTS_GET_CHANNEL,
  COMMUNICATION_AGENT_PROJECTS_LIST_CHANNEL,
  COMMUNICATION_AGENT_PROJECTS_OFF_CHANNEL,
  COMMUNICATION_AGENT_PROJECTS_SET_CHANNEL,
  COMMUNICATION_COPY_CONFIG_CHANNEL,
  COMMUNICATION_GET_CHANNEL,
  COMMUNICATION_MAX_WORKSPACES,
  COMMUNICATION_REGENERATE_TOKEN_CHANNEL,
  COMMUNICATION_REMOVE_WORKSPACE_CHANNEL,
  COMMUNICATION_SET_DEFAULT_ACCESS_CHANNEL,
  COMMUNICATION_SET_ENABLED_CHANNEL,
  COMMUNICATION_SET_PORT_CHANNEL,
  COMMUNICATION_SET_SESSION_ACCESS_CHANNEL,
  COMMUNICATION_SET_SESSION_APPROVALS_CHANNEL,
  COMMUNICATION_SET_SESSION_HANDLE_CHANNEL,
} from "../shared/communication-config.js";
import type {
  AgentProjectsGetResult,
  AgentProjectsListResult,
  CommunicationCopyClient,
  CommunicationCopyConfigResult,
  CommunicationGetResult,
  CommunicationHandleResult,
  CommunicationMutationReason,
  CommunicationMutationResult,
  CommunicationRegenerateResult,
  CommunicationStatus,
  CommunicationView,
} from "../shared/communication-config.js";
import { normalizeHandle, type SessionAccessStore } from "./communication-sessions.js";
import type { AgentProjectsStore } from "./communication-agent-projects.js";
import { displayPathFor } from "./scope-workspaces.js";

/** The slice of the controller this module needs (structural, so tests can fake it). */
export interface CommunicationControllerLike {
  apply(input: { enabled: boolean; workspaces: string[]; port?: number }): Promise<CommunicationStatus>;
  regenerateToken(): Promise<{ ok: true; status: CommunicationStatus } | { ok: false; reason: "not_running" | "env_controlled"; status?: CommunicationStatus }>;
  status(): CommunicationStatus;
  discoveryFile(): string | undefined;
}

export interface CommunicationIpcDeps {
  settingsPath: string;
  logger: { warn(message: string): void; error(message: string): void };
  controller: CommunicationControllerLike;
  sessions: SessionAccessStore;
  /** Taskana 4763: per-session External approvals switch. Only this module writes it. */
  approvals: SessionAccessStore;
  /** Live tab list (root and child). Only tabId and sessionId are read here. */
  tabs(): ReadonlyArray<{ tabId: string; sessionId: string }>;
  /** The legacy env override; when set, every write is refused and the pane is read-only. */
  env(): string | undefined;
  /** Native folder dialog owned by main; resolves to an absolute path or undefined when cancelled. */
  pickFolder(): Promise<string | undefined>;
  /** Stable userData copy of the stdio adapter, or null when this build does not carry it. */
  stdioScriptPath(): string | null;
  realpath(path: string): Promise<string>;
  /** Taskana 4768: per-project agent-open switch. Only this module writes it (and main's create_session hook reads it). */
  agentProjects: AgentProjectsStore;
  /** Synchronous realpath used only to canonicalise the sidebar's workspace identity. */
  realpathSync(path: string): string;
  homedir(): string;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

type Block = NonNullable<AnycodeSettings["communication"]>;

const EMPTY_BLOCK: Block = { enabled: false, workspaces: [], defaultSessionAccess: "off" };

const emptyPayload = z.object({}).strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();
const portSchema = z.object({ port: z.number().int().min(0).max(65535).nullable() }).strict();
const removeSchema = z.object({ workspace: z.string().min(1).max(4096) }).strict();
const copySchema = z.object({ client: z.enum(["claude-code", "codex", "generic"]) }).strict();
const defaultAccessSchema = z.object({ access: z.enum(["off", "on"]) }).strict();
const sessionAccessSchema = z.object({ tabId: z.string().min(1).max(200), enabled: z.boolean() }).strict();
const sessionHandleSchema = z.object({ tabId: z.string().min(1).max(200), handle: z.string().max(200).nullable() }).strict();
const agentProjectWorkspaceSchema = z.object({ workspace: z.string().min(1).max(4096) }).strict();
const agentProjectSetSchema = z.object({ workspace: z.string().min(1).max(4096), enabled: z.boolean() }).strict();
const agentProjectOffSchema = z.object({ key: z.string().min(1).max(4096) }).strict();
const sessionApprovalsSchema = z.object({ tabId: z.string().min(1).max(200), enabled: z.boolean() }).strict();

function blockOf(settings: AnycodeSettings): Block {
  const raw = settings.communication;
  if (raw === undefined) return { ...EMPTY_BLOCK, workspaces: [] };
  return { ...raw, workspaces: [...raw.workspaces], defaultSessionAccess: raw.defaultSessionAccess ?? "off" };
}

function agentProjectRows(deps: CommunicationIpcDeps): CommunicationView["agentProjects"] {
  const home = deps.homedir();
  return deps.agentProjects.allowedKeys().map((key) => ({ key, name: basename(key) || key, displayPath: displayPathFor(key, home) }));
}

/**
 * The EXACT stored strings of listed folders that are not on disk right now
 * (ENOENT/ENOTDIR — the same "missing" family the server tolerates at startup).
 * A folder that exists but cannot be resolved (EACCES…) is NOT marked: that one
 * still fails the server start, and the status chip already says so. Recomputed
 * on every view, so a folder that comes back loses the mark without a restart.
 */
async function missingWorkspacesOf(deps: CommunicationIpcDeps, block: Block): Promise<string[]> {
  const missing: string[] = [];
  for (const workspace of block.workspaces) {
    try { await deps.realpath(workspace); } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") missing.push(workspace);
    }
  }
  return missing;
}

async function viewOf(deps: CommunicationIpcDeps, block: Block): Promise<CommunicationView> {
  return {
    enabled: block.enabled,
    workspaces: [...block.workspaces],
    missingWorkspaces: await missingWorkspacesOf(deps, block),
    port: block.port ?? null,
    defaultSessionAccess: block.defaultSessionAccess,
    status: deps.controller.status(),
    agentProjects: agentProjectRows(deps),
    tabs: deps.tabs().map((tab) => {
      const handle = deps.sessions.getHandle(tab.sessionId);
      return { tabId: tab.tabId, enabled: deps.sessions.isExposed(tab.sessionId), approvals: deps.approvals.isExposed(tab.sessionId), ...(handle !== undefined ? { handle } : {}) };
    }),
  };
}

function applyInput(block: Block) {
  return { enabled: block.enabled, workspaces: [...block.workspaces], ...(block.port !== undefined ? { port: block.port } : {}) };
}

/** Load -> mutate -> save -> apply, all under the settings lock. Read-only and env are refused before any write. */
async function mutateBlock(
  deps: CommunicationIpcDeps,
  mutate: (block: Block) => Promise<{ ok: true; block: Block; apply: boolean } | { ok: false; reason: CommunicationMutationReason }>,
): Promise<CommunicationMutationResult> {
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  return withSettingsFileLock(deps.settingsPath, async () => {
    const loaded = await loadSettings(deps.settingsPath, deps.logger);
    if (loaded.readOnly) return { ok: false, reason: "read_only" };
    const decided = await mutate(blockOf(loaded.settings));
    if (!decided.ok) return decided;
    const draft = structuredClone(loaded.settings);
    draft.communication = decided.block;
    try {
      await saveSettings(deps.settingsPath, draft);
    } catch {
      deps.logger.error("[main] communication settings could not be saved");
      return { ok: false, reason: "io_error" };
    }
    if (decided.apply) await deps.controller.apply(applyInput(decided.block));
    return { ok: true, view: await viewOf(deps, decided.block) };
  });
}

export async function handleCommunicationGet(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationGetResult> {
  if (!emptyPayload.safeParse(raw).success) return { ok: false, reason: "invalid" };
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return { ok: true, view: await viewOf(deps, blockOf(loaded.settings)), envControlled: deps.env() !== undefined && deps.env() !== "" };
}

export async function handleSetEnabled(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = enabledSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  return mutateBlock(deps, async (block) => ({ ok: true, apply: true, block: { ...block, enabled: parsed.data.enabled } }));
}

export async function handleSetPort(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = portSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  return mutateBlock(deps, async (block) => {
    const next: Block = { ...block };
    if (parsed.data.port === null) delete next.port;
    else next.port = parsed.data.port;
    return { ok: true, apply: true, block: next };
  });
}

export async function handleSetDefaultAccess(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = defaultAccessSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  // The default only seeds NEW sessions; it does not restart the server.
  return mutateBlock(deps, async (block) => ({ ok: true, apply: false, block: { ...block, defaultSessionAccess: parsed.data.access } }));
}

/**
 * Adds a folder chosen in the native dialog. The dialog is the only source: the
 * payload carries no path (`.strict()` rejects one). Validated: absolute,
 * resolvable, a directory, not a duplicate by realpath, under the cap.
 */
export async function handleAddWorkspace(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  if (!emptyPayload.safeParse(raw).success) return { ok: false, reason: "invalid" };
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  const picked = await deps.pickFolder();
  if (picked === undefined) return { ok: false, reason: "cancelled" };
  if (!isAbsolute(picked)) return { ok: false, reason: "invalid" };
  let resolved: string;
  try {
    resolved = await deps.realpath(picked);
    if (!(await deps.stat(resolved)).isDirectory()) return { ok: false, reason: "not_a_directory" };
  } catch {
    return { ok: false, reason: "io_error" };
  }
  return mutateBlock(deps, async (block) => {
    const existing = new Set<string>();
    for (const entry of block.workspaces) {
      try { existing.add(await deps.realpath(entry)); } catch { existing.add(entry); }
    }
    if (existing.has(resolved)) return { ok: false, reason: "duplicate" };
    if (block.workspaces.length >= COMMUNICATION_MAX_WORKSPACES) return { ok: false, reason: "too_many" };
    return { ok: true, apply: true, block: { ...block, workspaces: [...block.workspaces, resolved] } };
  });
}

/** Removes an EXACT stored entry. The value is a lookup key, never a new path; unknown => not_found. */
export async function handleRemoveWorkspace(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = removeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  return mutateBlock(deps, async (block) => {
    if (!block.workspaces.includes(parsed.data.workspace)) return { ok: false, reason: "not_found" };
    return { ok: true, apply: true, block: { ...block, workspaces: block.workspaces.filter((w) => w !== parsed.data.workspace) } };
  });
}

/** Sidebar check state. Main canonicalises; the renderer never learns a key. */
export async function handleAgentProjectsGet(deps: CommunicationIpcDeps, raw: unknown): Promise<AgentProjectsGetResult> {
  const parsed = agentProjectWorkspaceSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  return { ok: true, enabled: deps.agentProjects.isAllowed(parsed.data.workspace) };
}

/** Settings list: exact main-owned keys with display strings. */
export async function handleAgentProjectsList(deps: CommunicationIpcDeps, raw: unknown): Promise<AgentProjectsListResult> {
  if (!emptyPayload.safeParse(raw).success) return { ok: false, reason: "invalid" };
  return { ok: true, projects: agentProjectRows(deps) };
}

/** Sidebar toggle. The workspace is canonicalised by the store before any write. */
export async function handleAgentProjectsSet(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = agentProjectSetSchema.safeParse(raw);
  if (!parsed.success || !isAbsolute(parsed.data.workspace)) return { ok: false, reason: "invalid" };
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  if (!deps.agentProjects.setAllowed(parsed.data.workspace, parsed.data.enabled)) return { ok: false, reason: "io_error" };
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return { ok: true, view: await viewOf(deps, blockOf(loaded.settings)) };
}

/** Settings Off button: an EXACT stored key (a lookup key, never a new path); unknown => not_found. */
export async function handleAgentProjectsOff(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = agentProjectOffSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  if (!deps.agentProjects.hasExactKey(parsed.data.key)) return { ok: false, reason: "not_found" };
  if (!deps.agentProjects.forgetExactKey(parsed.data.key)) return { ok: false, reason: "io_error" };
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return { ok: true, view: await viewOf(deps, blockOf(loaded.settings)) };
}

/** New token = stop + start with the same config. The stdio adapter reads the file per process start, so connected clients must reconnect. */
export async function handleRegenerateToken(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationRegenerateResult> {
  if (!emptyPayload.safeParse(raw).success) return { ok: false, reason: "invalid" };
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  const result = await deps.controller.regenerateToken();
  if (!result.ok) return { ok: false, reason: result.reason === "env_controlled" ? "env_controlled" : "not_running" };
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return { ok: true, view: await viewOf(deps, blockOf(loaded.settings)) };
}

/** Per-session switch for a live tab. The renderer names a tabId; main resolves its session and refuses unknown tabs. */
export async function handleSetSessionAccess(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = sessionAccessSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  const tab = deps.tabs().find((candidate) => candidate.tabId === parsed.data.tabId);
  if (!tab || !deps.sessions.set(tab.sessionId, parsed.data.enabled)) return { ok: false, reason: "not_found" };
  // Sharing off also clears External approvals, so re-sharing never silently re-enables them (Taskana 4763).
  if (!parsed.data.enabled) deps.approvals.set(tab.sessionId, false);
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return { ok: true, view: await viewOf(deps, blockOf(loaded.settings)) };
}

/**
 * Taskana 4763: the per-session External approvals switch. It can be turned ON
 * only while the session is shared (access ON), and it is never set by any
 * Sessions API tool, host message or plugin: this handler is its only writer.
 */
export async function handleSetSessionApprovals(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationMutationResult> {
  const parsed = sessionApprovalsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  const tab = deps.tabs().find((candidate) => candidate.tabId === parsed.data.tabId);
  if (!tab) return { ok: false, reason: "not_found" };
  if (parsed.data.enabled && !deps.sessions.isExposed(tab.sessionId)) return { ok: false, reason: "not_found" };
  if (!deps.approvals.set(tab.sessionId, parsed.data.enabled)) return { ok: false, reason: "not_found" };
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return { ok: true, view: await viewOf(deps, blockOf(loaded.settings)) };
}

/**
 * Sets or clears the handle of a live tab's session. The renderer names a tabId;
 * main maps it to the session. Uniqueness is among live sessions (store-enforced).
 */
export async function handleSetSessionHandle(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationHandleResult> {
  const parsed = sessionHandleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const normalized = normalizeHandle(parsed.data.handle);
  if (!normalized.ok) return { ok: false, reason: "invalid" };
  const tab = deps.tabs().find((candidate) => candidate.tabId === parsed.data.tabId);
  if (!tab) return { ok: false, reason: "unknown_tab" };
  const isLive = (sessionId: string) => deps.tabs().some((candidate) => candidate.sessionId === sessionId);
  const result = deps.sessions.setHandle(tab.sessionId, normalized.handle, isLive);
  if (!result.ok) return { ok: false, reason: result.reason === "unknown_session" ? "unknown_tab" : result.reason };
  const loaded = await loadSettings(deps.settingsPath, deps.logger);
  return { ok: true, view: await viewOf(deps, blockOf(loaded.settings)) };
}

/** Single-quotes a path for a POSIX shell unless it is already safe. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** TOML basic-string escaping: backslash, quote and every control character. */
export function tomlString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    switch (char) {
      case "\\": return "\\\\";
      case "\"": return "\\\"";
      case "\b": return "\\b";
      case "\t": return "\\t";
      case "\n": return "\\n";
      case "\f": return "\\f";
      case "\r": return "\\r";
      default: return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
  return `"${escaped}"`;
}

/**
 * The copied MCP config points at the stdio adapter and the discovery FILE, never
 * at a token: the adapter reads the file itself. `json` is built with JSON.stringify.
 */
export function buildCopyConfig(client: CommunicationCopyClient, script: string, discovery: string): { json: string; note: string } {
  const json = JSON.stringify({ mcpServers: { "anycode-sessions": { command: "node", args: [script, discovery] } } }, null, 2);
  if (client === "claude-code") {
    return { json, note: `Add it with: claude mcp add anycode-sessions -- node ${shellQuote(script)} ${shellQuote(discovery)}` };
  }
  if (client === "codex") {
    return { json, note: `[mcp_servers.anycode-sessions]\ncommand = "node"\nargs = [${tomlString(script)}, ${tomlString(discovery)}]` };
  }
  return { json, note: "" };
}

export async function handleCopyConfig(deps: CommunicationIpcDeps, raw: unknown): Promise<CommunicationCopyConfigResult> {
  const parsed = copySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (deps.env() !== undefined && deps.env() !== "") return { ok: false, reason: "env_controlled" };
  if (deps.controller.status().state !== "listening") return { ok: false, reason: "not_running" };
  const discovery = deps.controller.discoveryFile();
  if (discovery === undefined) return { ok: false, reason: "not_running" };
  const script = deps.stdioScriptPath();
  if (script === null) return { ok: false, reason: "no_adapter" };
  return { ok: true, ...buildCopyConfig(parsed.data.client, script, discovery) };
}

/** Wires the Sessions API channels. Each handler is also exported for tests. */
export function registerCommunicationIpc(deps: CommunicationIpcDeps): void {
  ipcMain.handle(COMMUNICATION_GET_CHANNEL, (_event, raw: unknown) => handleCommunicationGet(deps, raw));
  ipcMain.handle(COMMUNICATION_SET_ENABLED_CHANNEL, (_event, raw: unknown) => handleSetEnabled(deps, raw));
  ipcMain.handle(COMMUNICATION_SET_PORT_CHANNEL, (_event, raw: unknown) => handleSetPort(deps, raw));
  ipcMain.handle(COMMUNICATION_ADD_WORKSPACE_CHANNEL, (_event, raw: unknown) => handleAddWorkspace(deps, raw));
  ipcMain.handle(COMMUNICATION_REMOVE_WORKSPACE_CHANNEL, (_event, raw: unknown) => handleRemoveWorkspace(deps, raw));
  ipcMain.handle(COMMUNICATION_REGENERATE_TOKEN_CHANNEL, (_event, raw: unknown) => handleRegenerateToken(deps, raw));
  ipcMain.handle(COMMUNICATION_COPY_CONFIG_CHANNEL, (_event, raw: unknown) => handleCopyConfig(deps, raw));
  ipcMain.handle(COMMUNICATION_SET_DEFAULT_ACCESS_CHANNEL, (_event, raw: unknown) => handleSetDefaultAccess(deps, raw));
  ipcMain.handle(COMMUNICATION_SET_SESSION_ACCESS_CHANNEL, (_event, raw: unknown) => handleSetSessionAccess(deps, raw));
  ipcMain.handle(COMMUNICATION_SET_SESSION_HANDLE_CHANNEL, (_event, raw: unknown) => handleSetSessionHandle(deps, raw));
  ipcMain.handle(COMMUNICATION_AGENT_PROJECTS_GET_CHANNEL, (_event, raw: unknown) => handleAgentProjectsGet(deps, raw));
  ipcMain.handle(COMMUNICATION_AGENT_PROJECTS_LIST_CHANNEL, (_event, raw: unknown) => handleAgentProjectsList(deps, raw));
  ipcMain.handle(COMMUNICATION_AGENT_PROJECTS_SET_CHANNEL, (_event, raw: unknown) => handleAgentProjectsSet(deps, raw));
  ipcMain.handle(COMMUNICATION_AGENT_PROJECTS_OFF_CHANNEL, (_event, raw: unknown) => handleAgentProjectsOff(deps, raw));
  ipcMain.handle(COMMUNICATION_SET_SESSION_APPROVALS_CHANNEL, (_event, raw: unknown) => handleSetSessionApprovals(deps, raw));
}

/**
 * Plugins IPC (Taskana 4732 S1-B, design §7): the `anycode:plugins-*`
 * channel family — list, check-updates, two-phase install
 * (prepare→confirm token→commit), update, rollback, pin, enable, remove,
 * MCP consent, reveal, auto-update toggle. Zod-validates every payload;
 * refusals use shared/plugins-config's reason union; the `plugins-changed`
 * PUSH (reason only) goes to every window after any mutation.
 *
 * PATH CUSTODY (design §4): the renderer NEVER sends filesystem paths.
 * File/folder installs are `source: {kind:"file"|"folder"}` and MAIN opens
 * the OS dialog itself. `reveal` takes a plugin NAME, resolves it to
 * `.store/<name>/<active>` main-side.
 *
 * TWO-PHASE INSTALL (design §6): prepare downloads/verifies/extracts to a
 * PREVIEW and returns a short-lived token bound to (name, version, sha256);
 * commit re-validates the token in ONE atomic shot (idempotent — a replayed
 * commit of an already-installed version is a no-op success) and performs
 * the install. Tokens are process-lifetime, single-use-after-success and
 * expire after 5 minutes.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ipcMain } from "electron";
import { z } from "zod";
import { scanPluginsAdmin } from "@anycode/core/plugins-admin";
import {
  PLUGINS_APPROVE_MCP_CHANNEL,
  PLUGINS_CHECK_UPDATES_CHANNEL,
  PLUGINS_CHANGED_CHANNEL,
  PLUGINS_INSTALL_COMMIT_CHANNEL,
  PLUGINS_INSTALL_PREPARE_CHANNEL,
  PLUGINS_LIST_CHANNEL,
  PLUGINS_REVEAL_CHANNEL,
  PLUGINS_REMOVE_CHANNEL,
  PLUGINS_ROLLBACK_CHANNEL,
  PLUGINS_SET_AUTO_UPDATE_CHANNEL,
  PLUGINS_SET_ENABLED_CHANNEL,
  PLUGINS_SET_PINNED_CHANNEL,
  PLUGINS_UPDATE_CHANNEL,
  type IndexEntryView,
  type PluginInstallPrepareResult,
  type PluginsMutationResult,
  type PluginsRefusalReason,
  type PluginsSnapshot,
  type PluginInstallSource,
  type PluginInstallPreview,
} from "../shared/plugins-config.js";
import type { FileSystemPort } from "@anycode/core";
import {
  checkPluginIndex,
  readCachedPluginIndex,
  type PluginIndex,
} from "./plugins/index-client.js";
import {
  capabilitiesSubset,
  createArchiveFetch,
  guessNameFromArchive,
  installFromIndex,
  previewArchive,
  readSanitizedState,
  removePlugin as storeRemovePlugin,
  rollbackPlugin as storeRollbackPlugin,
  setEnabled as storeSetEnabled,
  setPinned as storeSetPinned,
  stagingDir,
  storeDir,
  type PluginStoreFs,
  type PluginStoreOptions,
  type StoreRefusal,
} from "./plugins/store.js";
import { statePath } from "./plugins/store.js";
import type { McpConsentEntry } from "@anycode/core/plugins-admin";

// ── deps ──

export interface PluginsIpcDeps {
  home: string;
  appVersion: string;
  /** `app.isPackaged` — gates the index check status reporting only. */
  isPackaged: boolean;
  /** The real fs port (scan + store). */
  fs: FileSystemPort & PluginStoreFs;
  /** settings.json access for autoUpdateOfficial + officialIndexUrl + mcpConsent. */
  settings: {
    getPlugins(): Promise<{ autoUpdateOfficial: boolean; officialIndexUrl?: string; mcpConsent?: McpConsentEntry[] }>;
    setAutoUpdateOfficial(value: boolean): Promise<void>;
    setMcpConsent(entries: McpConsentEntry[]): Promise<void>;
  };
  /** OS dialogs (path custody). */
  pickTgzFile(): Promise<string | undefined>;
  pickPluginFolder(): Promise<string | undefined>;
  /** Binary file read fallback for picked .tgz files (fs.readFileBytes missing). */
  readBinaryFile?(path: string): Promise<Buffer | undefined>;
  /** Opens the plugin's store dir in Finder/Explorer. */
  revealPath(path: string): void;
  /** Broadcast target — every window (BrowserWindow.getAllWindows). */
  getWindows(): { webContents: { send(channel: string, payload: unknown): void } }[];
  /** Reserved names passed to discoverExtensions by the host (S1-A surface). */
  workspace: string;
  checkIndex?(): Promise<{ status: string; index?: PluginIndex; detail?: string }>;
  now?: () => number;
  logger?: { warn(message: string, ...args: unknown[]): void };
}

interface PendingInstall {
  token: string;
  source: PluginInstallSource;
  name: string;
  version: string;
  sha256?: string;
  /** Bytes for file/url installs (commit replays them). */
  bytes?: Buffer;
  expiresAt: number;
}

const TOKEN_TTL_MS = 5 * 60 * 1000;

// ── payload schemas ──

const installSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("official"), name: z.string().min(1), version: z.string().min(1).optional() }),
  z.object({ kind: z.literal("url"), url: z.string().min(1) }),
  z.object({ kind: z.literal("file") }),
  z.object({ kind: z.literal("folder") }),
  z.object({ kind: z.literal("git"), url: z.string().min(1), ref: z.string().optional() }),
]);

const prepareSchema = z.object({ source: installSourceSchema });
const commitSchema = z.object({
  token: z.string().min(1),
  source: installSourceSchema,
});
const nameSchema = z.object({ name: z.string().min(1) });
const setNameSchema = z.object({ name: z.string().min(1), value: z.boolean() });
const setAutoUpdateSchema = z.object({ value: z.boolean() });

function refusal(reason: StoreRefusal | "signature", detail?: string): { ok: false; reason: PluginsRefusalReason; detail?: string } {
  const mapped: PluginsRefusalReason =
    reason === "integrity" || reason === "signature" ? "integrity"
    : reason === "invalid" ? "invalid"
    : reason === "not_found" ? "not_found"
    : reason === "read_only_source" ? "read_only_source"
    : reason === "incompatible" ? "incompatible"
    : reason === "too_large" ? "too_large"
    : reason === "network" ? "network"
    : "io_error";
  return { ok: false, reason: mapped, ...(detail !== undefined ? { detail } : {}) };
}

// ── snapshot builder ──

async function buildSnapshot(deps: PluginsIpcDeps, indexCheck?: { status: string; index?: PluginIndex; detail?: string }): Promise<PluginsSnapshot> {
  const settings = await deps.settings.getPlugins();
  const scan = await scanPluginsAdmin(deps.fs, {
    workspace: deps.workspace,
    home: deps.home,
    pluginStatePath: statePath(deps.home),
    appVersion: deps.appVersion,
    mcpConsent: settings.mcpConsent ?? [],
  }).catch(() => ({ rows: [] as never[], problems: [] as string[] }));
  const cached = await readCachedPluginIndexSafe(deps);
  const index = indexCheck?.index ?? cached.index;
  const status =
    indexCheck !== undefined
      ? (indexCheck.status as PluginsSnapshot["index"]["status"])
      : cached.status === "unchecked"
        ? "unchecked"
        : ((cached.status as PluginsSnapshot["index"]["status"]) ?? "unchecked");

  // Rows: strip roots (path custody) + attach managed update availability.
  const rows = scan.rows.map((row) => ({
    ...row,
    root: undefined,
    ...(row.managed !== undefined
      ? {
          updateAvailable: updateFor(index, row.name, row.managed.active, row.managed.pinned, deps.appVersion, settings.autoUpdateOfficial),
        }
      : {}),
  }));

  // Available: default:true index entries not installed and not tombstoned.
  const state = await readSanitizedState(deps.fs, deps.home);
  const installedNames = new Set(scan.rows.map((row) => row.name));
  const available: IndexEntryView[] = [];
  if (index !== undefined) {
    for (const entry of index.plugins) {
      if (!entry.default || installedNames.has(entry.name) || state.state.removedDefaults.includes(entry.name)) continue;
      const compatible = entry.versions
        .filter((v) => v.engines?.anycode === undefined || v.engines.anycode === deps.appVersion)
        .sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))[0];
      available.push({
        name: entry.name,
        displayName: entry.displayName,
        description: entry.description,
        default: entry.default,
        ...(compatible !== undefined ? { version: compatible.version } : {}),
        ...(compatible === undefined ? { incompatibleReason: `no version compatible with AnyCode ${deps.appVersion}` } : {}),
        capabilities: compatible?.capabilities ?? entry.versions[0]?.capabilities ?? [],
      });
    }
  }

  return {
    plugins: rows,
    available,
    index: {
      status,
      ...(cached.checkedAt !== undefined ? { checkedAt: cached.checkedAt } : {}),
      ...(index?.serial !== undefined ? { serial: index.serial } : {}),
    },
    settings: {
      autoUpdateOfficial: settings.autoUpdateOfficial,
      indexConfigured: true,
    },
  };
}

async function readCachedPluginIndexSafe(deps: PluginsIpcDeps): Promise<{ status: string; index?: PluginIndex; checkedAt?: string }> {
  try {
    return await readCachedPluginIndex({ cacheDir: cacheDirFor(deps) });
  } catch {
    return { status: "unchecked" };
  }
}

function cacheDirFor(deps: PluginsIpcDeps): string {
  return join(deps.home, ".anycode", "plugins", ".cache");
}

function updateFor(
  index: PluginIndex | undefined,
  name: string,
  active: string,
  pinned: boolean,
  appVersion: string,
  autoUpdate: boolean,
): { version: string; needsApproval: boolean } | undefined {
  if (index === undefined || pinned) return undefined;
  const entry = index.plugins.find((p) => p.name === name);
  if (entry === undefined) return undefined;
  const candidate = entry.versions
    .filter((v) => v.engines?.anycode === undefined || v.engines.anycode === appVersion)
    .filter((v) => compareDesc(v.version, active) < 0)
    .sort((a, b) => compareDesc(a.version, b.version))[0];
  if (candidate === undefined) return undefined;
  return { version: candidate.version, needsApproval: !autoUpdate };
}

function compareDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── registration ──

export interface PluginsIpc {
  /** Broadcasts `plugins-changed` to every window (called after mutations + by the scheduler). */
  notifyChanged(reason: string): void;
  /** Snapshot for external callers (boot push). */
  snapshot(): Promise<PluginsSnapshot>;
  /** The scheduler's pass hook — index check + auto-update policy. */
  runUpdatePass(): Promise<{ installed: { name: string; from: string; to: string }[]; status: string }>;
}

export function registerPluginsIpc(deps: PluginsIpcDeps): PluginsIpc {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, PendingInstall>();
  let lastSerialFloor: number | undefined;

  function storeOpts(): PluginStoreOptions {
    return {
      home: deps.home,
      appVersion: deps.appVersion,
      fs: deps.fs,
      fetchImpl: createArchiveFetch(),
      now,
    };
  }

  function notifyChanged(reason: string): void {
    for (const window of deps.getWindows()) {
      window.webContents.send(PLUGINS_CHANGED_CHANNEL, { reason });
    }
  }

  async function checkIndex(): Promise<{ status: string; index?: PluginIndex; detail?: string }> {
    // Tests / embedders may inject the whole check; production hits the wire.
    if (deps.checkIndex !== undefined) {
      return deps.checkIndex();
    }
    const settings = await deps.settings.getPlugins();
    const result = await checkPluginIndex({
      cacheDir: cacheDirFor(deps),
      ...(settings.officialIndexUrl !== undefined ? { indexUrl: settings.officialIndexUrl } : {}),
      ...(lastSerialFloor !== undefined ? { serialFloor: lastSerialFloor } : {}),
    });
    if (result.index !== undefined && !result.expired) {
      lastSerialFloor = result.index.serial;
    }
    return { status: result.status, ...(result.index !== undefined ? { index: result.index } : {}), ...(result.detail !== undefined ? { detail: result.detail } : {}) };
  }

  function isDefaultInIndex(index: PluginIndex | undefined, name: string): boolean {
    return index?.plugins.some((entry) => entry.name === name && entry.default) ?? false;
  }

  async function handlePrepare(source: PluginInstallSource): Promise<PluginInstallPrepareResult> {
    const expiresAt = now() + TOKEN_TTL_MS;
    if (source.kind === "git") {
      return { ok: false, reason: "invalid", detail: "git sources arrive in Stage 2" };
    }
    if (source.kind === "official") {
      const check = await checkIndex();
      if (check.index === undefined) {
        return refusal(check.status === "signature-failed" || check.status === "rollback" ? "signature" : check.status === "expired" ? "incompatible" : check.status === "offline" ? "network" : "network", check.detail ?? `index unavailable (${check.status})`);
      }
      // Preview from the INDEX entry (no download yet — the sheet needs
      // name/version/capabilities/mcp list, all index-declared).
      const entry = check.index.plugins.find((p) => p.name === source.name);
      if (entry === undefined) {
        return refusal("not_found", `${source.name} is not in the official index`);
      }
      const candidate = entry.versions
        .filter((v) => v.engines?.anycode === undefined || v.engines.anycode === deps.appVersion)
        .sort((a, b) => compareDesc(a.version, b.version))
        .find((v) => source.version === undefined || v.version === source.version);
      if (candidate === undefined) {
        return refusal("incompatible", `no compatible version of ${source.name}`);
      }
      const mcpServers = candidate.capabilities
        .filter((capability) => capability.startsWith("mcp:"))
        .map((capability) => ({ name: capability.slice(4), command: "(index-declared)", args: [] }));
      const token = randomUUID();
      pending.set(token, {
        token,
        source,
        name: source.name,
        version: candidate.version,
        sha256: candidate.sha256,
        expiresAt,
      });
      return {
        ok: true,
        token,
        preview: {
          name: entry.name,
          version: candidate.version,
          displayName: entry.displayName,
          description: entry.description,
          source,
          sha256Prefix: candidate.sha256.slice(0, 8),
          capabilities: candidate.capabilities,
          mcpServers,
          hasHooks: candidate.capabilities.includes("hooks"),
        },
      };
    }
    if (source.kind === "url") {
      if (!/^https:\/\//i.test(source.url)) {
        return refusal("invalid", "only https:// URLs are accepted");
      }
      const fetchImpl = createArchiveFetch();
      const fetched = await fetchImpl(source.url);
      if (!fetched.ok) {
        return refusal("network", `download failed (${fetched.reason})`);
      }
      const preview = previewArchive(fetched.bytes);
      if (!preview.ok) {
        return refusal(preview.reason, preview.detail);
      }
      const token = randomUUID();
      pending.set(token, {
        token,
        source,
        name: preview.manifest.name,
        version: preview.manifest.version!,
        sha256: undefined,
        bytes: fetched.bytes,
        expiresAt,
      });
      return {
        ok: true,
        token,
        preview: {
          name: preview.manifest.name,
          version: preview.manifest.version!,
          displayName: preview.manifest.displayName,
          description: preview.manifest.description,
          source,
          sha256Prefix: preview.sha256Prefix,
          capabilities: preview.capabilities,
          mcpServers: preview.mcpServers,
          hasHooks: preview.capabilities.includes("hooks"),
          engines: preview.manifest.engines?.anycode,
          ...(preview.manifest.engines?.anycode !== undefined ? { incompatible: false } : {}),
        },
      };
    }
    if (source.kind === "file") {
      const path = await deps.pickTgzFile();
      if (path === undefined) {
        return { ok: false, reason: "invalid", detail: "no file picked" };
      }
      // Binary-safe read (a tgz through readFile's utf-8 decode corrupts bytes).
      let bytes: Buffer | undefined;
      if (typeof deps.fs.readFileBytes === "function") {
        bytes = Buffer.from(await deps.fs.readFileBytes(path));
      } else {
        bytes = await deps.readBinaryFile?.(path);
      }
      if (bytes === undefined) {
        return refusal("io_error", "could not read the picked file");
      }
      const preview = previewArchive(bytes);
      if (!preview.ok) {
        return refusal(preview.reason, preview.detail);
      }
      const token = randomUUID();
      pending.set(token, {
        token,
        source,
        name: preview.manifest.name,
        version: preview.manifest.version!,
        bytes,
        expiresAt,
      });
      return {
        ok: true,
        token,
        preview: {
          name: preview.manifest.name,
          version: preview.manifest.version!,
          displayName: preview.manifest.displayName,
          description: preview.manifest.description,
          source,
          sha256Prefix: preview.sha256Prefix,
          capabilities: preview.capabilities,
          mcpServers: preview.mcpServers,
          hasHooks: preview.capabilities.includes("hooks"),
        },
      };
    }
    // folder: dev link
    const path = await deps.pickPluginFolder();
    if (path === undefined) {
      return { ok: false, reason: "invalid", detail: "no folder picked" };
    }
    const manifestPath = join(path, ".anycode-plugin/plugin.json");
    let manifestText: string;
    try {
      manifestText = await deps.fs.readFile(manifestPath);
    } catch {
      return refusal("invalid", "the picked folder has no .anycode-plugin/plugin.json");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      return refusal("invalid", "manifest is not JSON");
    }
    const manifest = previewManifestJson(parsed);
    if (manifest === undefined) {
      return refusal("invalid", "manifest invalid");
    }
    const token = randomUUID();
    pending.set(token, {
      token,
      source,
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      expiresAt,
    });
    return {
      ok: true,
      token,
      preview: {
        name: manifest.name,
        version: manifest.version ?? "0.0.0",
        displayName: manifest.displayName,
        description: manifest.description,
        source,
        capabilities: [],
        mcpServers: [],
        hasHooks: false,
      },
    };
  }

  function previewManifestJson(parsed: unknown): { name: string; version?: string; displayName?: string; description?: string } | undefined {
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name === "") return undefined;
    return {
      name: record.name,
      ...(typeof record.version === "string" ? { version: record.version } : {}),
      ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
    };
  }

  async function handleCommit(token: string, source: PluginInstallSource): Promise<{ ok: true; snapshot: PluginsSnapshot } | { ok: false; reason: PluginsRefusalReason; detail?: string }> {
    const prepared = pending.get(token);
    if (prepared === undefined || prepared.expiresAt < now() || JSON.stringify(prepared.source) !== JSON.stringify(source)) {
      return refusal("invalid", "unknown, expired or mismatched install token — prepare again");
    }
    const opts = storeOpts();
    if (source.kind === "official") {
      const check = await checkIndex();
      if (check.index === undefined) {
        return refusal("network", `index unavailable (${check.status})`);
      }
      const result = await installFromIndex(opts, check.index, { name: source.name, version: prepared.version });
      if (!result.ok) {
        return refusal(result.reason, result.detail);
      }
      // Capability growth check on commit: compare state capabilities.
      const { state } = await readSanitizedState(deps.fs, deps.home);
      const entry = state.plugins[source.name];
      const indexEntry = check.index.plugins.find((p) => p.name === source.name);
      const indexVersion = indexEntry?.versions.find((v) => v.version === prepared.version);
      if (entry !== undefined && indexVersion !== undefined && !capabilitiesSubset(entry.capabilities, indexVersion.capabilities)) {
        // Explicit confirmation IS the approval — proceed.
      }
      pending.delete(token);
      notifyChanged("install");
      return { ok: true, snapshot: await buildSnapshot(deps, check) };
    }
    if (prepared.bytes !== undefined) {
      const { installFromBytes, installFromUrl } = await import("./plugins/store.js");
      const result = source.kind === "url"
        ? await installFromUrl(opts, source.url)
        : await installFromBytes(opts, prepared.bytes, { fileName: prepared.name });
      if (!result.ok) {
        return refusal(result.reason, result.detail);
      }
      pending.delete(token);
      notifyChanged("install");
      return { ok: true, snapshot: await buildSnapshot(deps) };
    }
    if (source.kind === "folder") {
      const { installLocalLink } = await import("./plugins/store.js");
      const path = await deps.pickPluginFolder();
      if (path === undefined) {
        return refusal("invalid", "no folder picked");
      }
      const result = await installLocalLink(opts, path);
      if (!result.ok) {
        return refusal(result.reason, result.detail);
      }
      pending.delete(token);
      notifyChanged("install");
      return { ok: true, snapshot: await buildSnapshot(deps) };
    }
    return refusal("invalid", "unsupported source");
  }

  // ── channel registration ──

  ipcMain.handle(PLUGINS_LIST_CHANNEL, async (): Promise<PluginsSnapshot> => {
    return buildSnapshot(deps);
  });

  ipcMain.handle(PLUGINS_CHECK_UPDATES_CHANNEL, async (): Promise<PluginsSnapshot> => {
    const check = await checkIndex();
    return buildSnapshot(deps, check);
  });

  ipcMain.handle(PLUGINS_INSTALL_PREPARE_CHANNEL, async (_event, payload: unknown): Promise<PluginInstallPrepareResult> => {
    const parsed = prepareSchema.safeParse(payload);
    if (!parsed.success) {
      return refusal("invalid", "payload rejected");
    }
    return handlePrepare(parsed.data.source);
  });

  ipcMain.handle(PLUGINS_INSTALL_COMMIT_CHANNEL, async (_event, payload: unknown) => {
    const parsed = commitSchema.safeParse(payload);
    if (!parsed.success) {
      return refusal("invalid", "payload rejected");
    }
    return handleCommit(parsed.data.token, parsed.data.source);
  });

  ipcMain.handle(PLUGINS_UPDATE_CHANNEL, async (_event, payload: unknown) => {
    const parsed = nameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    const check = await checkIndex();
    if (check.index === undefined) {
      return refusal("network", `index unavailable (${check.status})`);
    }
    const result = await installFromIndex(storeOpts(), check.index, { name: parsed.data.name });
    if (!result.ok) return refusal(result.reason, result.detail);
    notifyChanged("update");
    return { ok: true } satisfies PluginsMutationResult;
  });

  ipcMain.handle(PLUGINS_ROLLBACK_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = nameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    const result = await storeRollbackPlugin(storeOpts(), parsed.data.name);
    if (!result.ok) return refusal(result.reason, result.detail);
    notifyChanged("rollback");
    return { ok: true };
  });

  ipcMain.handle(PLUGINS_SET_PINNED_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = setNameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    const result = await storeSetPinned(storeOpts(), parsed.data.name, parsed.data.value);
    if (!result.ok) return refusal(result.reason, result.detail);
    notifyChanged("pin");
    return { ok: true };
  });

  ipcMain.handle(PLUGINS_SET_ENABLED_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = setNameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    const result = await storeSetEnabled(storeOpts(), parsed.data.name, parsed.data.value);
    if (!result.ok) return refusal(result.reason, result.detail);
    notifyChanged("enable");
    return { ok: true };
  });

  ipcMain.handle(PLUGINS_REMOVE_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = nameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    const cached = await readCachedPluginIndexSafe(deps);
    const result = await storeRemovePlugin(storeOpts(), parsed.data.name, isDefaultInIndex(cached.index, parsed.data.name));
    if (!result.ok) return refusal(result.reason, result.detail);
    notifyChanged("remove");
    return { ok: true };
  });

  ipcMain.handle(PLUGINS_APPROVE_MCP_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = nameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    // Grant consent for the plugin's CURRENT serversHash (read from scan).
    const scan = await scanPluginsAdmin(deps.fs, {
      workspace: deps.workspace,
      home: deps.home,
      pluginStatePath: statePath(deps.home),
      appVersion: deps.appVersion,
    });
    const row = scan.rows.find((candidate) => candidate.name === parsed.data.name);
    if (row === undefined || row.mcpServersHash === undefined) {
      return refusal("not_found", `${parsed.data.name} declares no MCP servers`);
    }
    const settings = await deps.settings.getPlugins();
    const consent = [...(settings.mcpConsent ?? [])];
    const existing = consent.findIndex((entry) => entry.plugin === parsed.data.name);
    const grant: McpConsentEntry = {
      plugin: parsed.data.name,
      serversHash: row.mcpServersHash,
      grantedAt: new Date(now()).toISOString(),
    };
    if (existing >= 0) {
      consent[existing] = grant;
    } else {
      consent.push(grant);
    }
    await deps.settings.setMcpConsent(consent);
    notifyChanged("consent");
    return { ok: true };
  });

  ipcMain.handle(PLUGINS_REVEAL_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = nameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    // Resolve main-side only (path custody): .store/<name>/<active>.
    const sanitized = await readSanitizedState(deps.fs, deps.home);
    const entry = sanitized.state.plugins[parsed.data.name];
    const dir = entry?.source.kind === "local"
      ? entry.source.path
      : entry !== undefined
        ? join(storeDir(deps.home), parsed.data.name, entry.active)
        : join(deps.home, ".anycode", "plugins", parsed.data.name);
    try {
      deps.revealPath(dir);
      return { ok: true };
    } catch (error) {
      return refusal("io_error", String(error));
    }
  });

  ipcMain.handle(PLUGINS_SET_AUTO_UPDATE_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = setAutoUpdateSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    await deps.settings.setAutoUpdateOfficial(parsed.data.value);
    notifyChanged("auto-update");
    return { ok: true };
  });

  return {
    notifyChanged,
    snapshot: () => buildSnapshot(deps),
    runUpdatePass: async () => {
      const check = await checkIndex();
      if (check.index === undefined) {
        return { installed: [], status: check.status };
      }
      const { runUpdatePass: storePass } = await import("./plugins/store.js");
      const settings = await deps.settings.getPlugins();
      const result = await storePass({
        ...storeOpts(),
        checkIndex: async () => check,
        autoUpdateOfficial: settings.autoUpdateOfficial,
        onInstalled: () => notifyChanged("update"),
      });
      if (result.installed.length > 0) {
        notifyChanged("update");
      }
      return { installed: result.installed, status: result.status };
    },
  };
}

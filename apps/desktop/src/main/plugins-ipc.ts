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

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ipcMain } from "electron";
import { z } from "zod";
import {
  capabilities,
  pluginManifestSchema,
  rangeMatches,
  scanPluginsAdmin,
  serversHash,
  type McpConsentEntry,
} from "@anycode/core/plugins-admin";
import type { FileSystemPort } from "@anycode/core";
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
import {
  checkPluginIndex,
  readCachedPluginIndex,
  type PluginIndex,
} from "./plugins/index-client.js";
import {
  capabilitiesSubset,
  compareVersionsDesc,
  createArchiveFetch,
  guessNameFromArchive,
  installFromBytes,
  installFromIndex,
  installLocalLink,
  previewArchive,
  readSanitizedState,
  removePlugin as storeRemovePlugin,
  rollbackPlugin as storeRollbackPlugin,
  runUpdatePass as storeRunUpdatePass,
  setEnabled as storeSetEnabled,
  setPinned as storeSetPinned,
  stagingDir,
  storeDir,
  withPluginStateLock,
  type PluginStoreFs,
  type PluginStoreOptions,
  type StoreRefusal,
} from "./plugins/store.js";
import { statePath, writePluginState } from "./plugins/store.js";
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
  /** Fallback scan workspace (used when no live tab exposes one). */
  workspace: string;
  /**
   * Taskana 4732 xfix M6: resolved on EVERY scan (not frozen at registration)
   * so the pane follows the live tab workspace; see activePluginsWorkspace.
   */
  activeWorkspace?(): string | undefined;
  /**
   * Test/embedder seam for the whole index check. Receives the persisted
   * anti-rollback floor exactly as the production path passes it to
   * checkPluginIndex (Taskana 4732 xfix H2).
   */
  checkIndex?(opts: { serialFloor?: number }): Promise<{ status: string; index?: PluginIndex; detail?: string; expired?: boolean }>;
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
  /**
   * Taskana 4732 xfix H3: for folder installs, the EXACT path main's picker
   * resolved at PREPARE time. Commit reuses it — a second OS dialog at
   * commit (the old behaviour) could install a DIFFERENT folder than the
   * one the sheet previewed.
   */
  folderPath?: string;
  /** Picked .tgz basename (file installs) — state.json provenance (xfix L3). */
  fileName?: string;
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
  // Taskana 4732 xfix H1(b): the confirmation sheet's "Install and allow MCP
  // servers" checkbox — main records the consent grant (hash main-computed)
  // when true. Optional on the wire so stale renderers keep working.
  allowMcp: z.boolean().optional(),
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
    workspace: workspaceOf(deps),
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
      // Taskana 4732 xfix H4: engines.anycode is a RANGE (">=0.0.35", "^0.1.0")
      // — string equality against the app version matched nothing. Same
      // rangeMatches the store layer uses, at every IPC surface.
      const compatible = entry.versions
        .filter((v) => v.engines?.anycode === undefined || rangeMatches(v.engines.anycode, deps.appVersion))
        .sort((a, b) => compareVersionsDesc(a.version, b.version))[0];
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
    // `checkedAt` (xfix L1) comes from the cache's own fetchedAt, so the
    // pane's "Last checked" is real rather than "Not checked yet" forever.
    return await readCachedPluginIndex({ cacheDir: cacheDirFor(deps) });
  } catch {
    return { status: "unchecked" };
  }
}

/**
 * The workspace the Plugins pane scans (Taskana 4732 xfix M6): the first live
 * tab's workspace — the runtime's own project tier — falling back to `fallback`
 * (home) when no tab has one. Pure; main supplies the tab list.
 */
export function activePluginsWorkspace(tabs: readonly { workspace?: string }[], fallback: string): string {
  return tabs.find((tab) => tab.workspace !== undefined && tab.workspace !== "")?.workspace ?? fallback;
}

/** Scan workspace for this call (live tab when known, else the configured fallback). */
function workspaceOf(deps: PluginsIpcDeps): string {
  return deps.activeWorkspace?.() ?? deps.workspace;
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
  // Taskana 4732 xfix H4: range matching (see buildSnapshot's available list).
  const candidate = entry.versions
    .filter((v) => v.engines?.anycode === undefined || rangeMatches(v.engines.anycode, appVersion))
    .filter((v) => compareVersionsDesc(v.version, active) < 0)
    .sort((a, b) => compareVersionsDesc(a.version, b.version))[0];
  if (candidate === undefined) return undefined;
  return { version: candidate.version, needsApproval: !autoUpdate };
}

// ── serial-floor persistence (Taskana 4732 xfix H2) ──

/**
 * state.json's persisted anti-rollback floor (`lastIndexSerial`). undefined =
 * never checked, or no readable state — the only case with no floor at all.
 */
async function readPersistedSerialFloor(deps: PluginsIpcDeps): Promise<number | undefined> {
  try {
    const { state } = await readSanitizedState(deps.fs, deps.home);
    return state.lastIndexSerial;
  } catch {
    return undefined; // fail-soft
  }
}

/** Raise-only write of the floor into state.json, under the state lock. */
async function persistSerialFloor(deps: PluginsIpcDeps, serial: number): Promise<void> {
  await withPluginStateLock(deps.home, async () => {
    const { state } = await readSanitizedState(deps.fs, deps.home);
    if ((state.lastIndexSerial ?? -1) >= serial) return;
    state.lastIndexSerial = serial;
    await writePluginState(deps.fs, statePath(deps.home), state);
  });
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
  // Taskana 4732 xfix H2: the anti-rollback serial floor must SURVIVE a
  // restart. state.json's `lastIndexSerial` (written by every successful
  // update pass) is the persisted floor — seed from it here so a replayed
  // lower-serial index is refused after relaunch, not only within one
  // process lifetime. Fail-soft: an unreadable/absent state means no floor.
  let lastSerialFloor: number | undefined;
  // Every index check awaits this seed first, so the first check after a
  // restart can never run without the persisted floor.
  const floorSeeded: Promise<void> = readPersistedSerialFloor(deps).then((persisted) => {
    if (persisted !== undefined && (lastSerialFloor === undefined || persisted > lastSerialFloor)) {
      lastSerialFloor = persisted;
    }
  });

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
    await floorSeeded;
    const floorOpts = lastSerialFloor !== undefined ? { serialFloor: lastSerialFloor } : {};
    // Tests / embedders may inject the whole check; production hits the wire.
    let result: { status: string; index?: PluginIndex; detail?: string; expired?: boolean };
    if (deps.checkIndex !== undefined) {
      result = await deps.checkIndex(floorOpts);
    } else {
      const settings = await deps.settings.getPlugins();
      result = await checkPluginIndex({
        cacheDir: cacheDirFor(deps),
        ...(settings.officialIndexUrl !== undefined ? { indexUrl: settings.officialIndexUrl } : {}),
        ...floorOpts,
      });
    }
    if (result.index !== undefined && !result.expired) {
      // Raise-only, in memory AND persisted: the next launch seeds from it.
      if (lastSerialFloor === undefined || result.index.serial > lastSerialFloor) {
        lastSerialFloor = result.index.serial;
      }
      await persistSerialFloor(deps, result.index.serial).catch(() => undefined);
    }
    return { status: result.status, ...(result.index !== undefined ? { index: result.index } : {}), ...(result.detail !== undefined ? { detail: result.detail } : {}) };
  }

  // Taskana 4732 xfix M1: a cached index past its own expiresAt must not
  // serve installs/updates (design §4) — the check returns it for LISTING
  // with status "expired", so every mutating surface refuses on that status.
  function indexUsableForInstall(check: { status: string; index?: PluginIndex }): boolean {
    return check.index !== undefined && check.status !== "expired";
  }

  function isDefaultInIndex(index: PluginIndex | undefined, name: string): boolean {
    return index?.plugins.some((entry) => entry.name === name && entry.default) ?? false;
  }

  async function handlePrepare(source: PluginInstallSource): Promise<PluginInstallPrepareResult> {
    const expiresAt = now() + TOKEN_TTL_MS;
    // xfix L10: expired tokens are evicted here (bounded by install attempts).
    for (const [staleToken, staleInstall] of pending) {
      if (staleInstall.expiresAt < now()) pending.delete(staleToken);
    }
    if (source.kind === "git") {
      return { ok: false, reason: "invalid", detail: "git sources arrive in Stage 2" };
    }
    if (source.kind === "official") {
      const check = await checkIndex();
      // Taskana 4732 xfix M1: an expired (cached-past-expiry) index lists but
      // never installs — the old gate let prepare/commit/update proceed on it.
      if (!indexUsableForInstall(check)) {
        return refusal(check.status === "signature-failed" || check.status === "rollback" ? "signature" : check.status === "expired" ? "incompatible" : check.status === "offline" ? "network" : "network", check.detail ?? `index unavailable (${check.status})`);
      }
      // Preview from the INDEX entry (no download yet — the sheet needs
      // name/version/capabilities/mcp list, all index-declared).
      const entry = check.index!.plugins.find((p) => p.name === source.name);
      if (entry === undefined) {
        return refusal("not_found", `${source.name} is not in the official index`);
      }
      const candidate = entry.versions
        .filter((v) => v.engines?.anycode === undefined || rangeMatches(v.engines.anycode, deps.appVersion))
        .sort((a, b) => compareVersionsDesc(a.version, b.version))
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
      // Taskana 4732 xfix H3: pin the sha256 of the EXACT previewed bytes —
      // commit installs `bytes` and verifies this hash, so a server that
      // serves different content at commit time can never swap the payload.
      const previewSha = createHash("sha256").update(fetched.bytes).digest("hex");
      pending.set(token, {
        token,
        source,
        name: preview.manifest.name,
        version: preview.manifest.version!,
        sha256: previewSha,
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
          // xfix L4: compute the real compat verdict with rangeMatches — the
          // old hardcode showed "compatible" for a too-new plugin until commit.
          ...(preview.manifest.engines?.anycode !== undefined
            ? { incompatible: !rangeMatches(preview.manifest.engines.anycode, deps.appVersion) }
            : {}),
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
        fileName: path.split(/[\\/]/).pop() ?? path,
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
    // Taskana 4732 xfix M7: run the REAL manifest schema (not a name-only
    // peek) so the sheet previews the folder plugin's derived capabilities
    // and — critically — its MCP servers, which the old preview hardcoded
    // to [] (the user confirmed a sheet that lied about what would install).
    const manifestResult = pluginManifestSchema.safeParse(parsed);
    if (!manifestResult.success) {
      return refusal("invalid", `manifest invalid: ${manifestResult.error.issues[0]?.message ?? "shape"}`);
    }
    const manifest = manifestResult.data;
    const caps = capabilities(manifest);
    const capabilityList: string[] = [];
    if (caps.skills > 0) capabilityList.push("skills");
    if (caps.agents > 0) capabilityList.push("agents");
    if (caps.workflows > 0) capabilityList.push("workflows");
    capabilityList.push(...caps.mcp.map((name) => `mcp:${name}`));
    if (caps.commands > 0) capabilityList.push("commands");
    if (caps.hooks) capabilityList.push("hooks");
    if (caps.docs) capabilityList.push("docs");
    capabilityList.push(...caps.engineSupport.map((name) => `engineSupport:${name}`));
    if (caps.promptOverlays > 0) capabilityList.push("promptOverlays");
    const mcpServers = Object.entries(manifest.mcpServers ?? {}).map(([name, server]) => ({
      name,
      command: "command" in server ? String(server.command) : "stdio",
      args: "args" in server && Array.isArray(server.args) ? server.args.map(String) : [],
    }));
    const token = randomUUID();
    pending.set(token, {
      token,
      source,
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      // xfix H3: bind the token to the folder main picked HERE — commit
      // reuses it and never re-opens the dialog.
      folderPath: path,
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
        capabilities: capabilityList.sort(),
        mcpServers,
        hasHooks: caps.hooks,
        ...(manifest.engines?.anycode !== undefined
          ? {
              engines: manifest.engines.anycode,
              incompatible: !rangeMatches(manifest.engines.anycode, deps.appVersion),
            }
          : {}),
      },
    };
  }

  /**
   * Taskana 4732 xfix H1(b): records an MCP consent grant for the plugin
   * main just installed — the hash is computed MAIN-side from the installed
   * plugin's manifest (never renderer-supplied), matching what discovery
   * will check at the next host boot. Fail-soft: a consent write failure
   * must not fail an otherwise-successful install.
   */
  async function recordInstallConsent(name: string): Promise<void> {
    try {
      const scan = await scanPluginsAdmin(deps.fs, {
        workspace: workspaceOf(deps),
        home: deps.home,
        pluginStatePath: statePath(deps.home),
        appVersion: deps.appVersion,
      });
      const row = scan.rows.find((candidate) => candidate.name === name);
      if (row === undefined || row.mcpServersHash === undefined) {
        return; // no MCP servers — nothing to consent to
      }
      const settings = await deps.settings.getPlugins();
      const consent = [...(settings.mcpConsent ?? [])];
      const grant: McpConsentEntry = {
        plugin: name,
        serversHash: row.mcpServersHash,
        grantedAt: new Date(now()).toISOString(),
      };
      const existing = consent.findIndex((entry) => entry.plugin === name);
      if (existing >= 0) {
        consent[existing] = grant;
      } else {
        consent.push(grant);
      }
      await deps.settings.setMcpConsent(consent);
    } catch {
      // fail-soft: the install stands; the user can Approve MCP from the row.
    }
  }

  async function handleCommit(token: string, source: PluginInstallSource, allowMcp: boolean): Promise<{ ok: true; snapshot: PluginsSnapshot } | { ok: false; reason: PluginsRefusalReason; detail?: string }> {
    const prepared = pending.get(token);
    if (prepared === undefined || prepared.expiresAt < now() || JSON.stringify(prepared.source) !== JSON.stringify(source)) {
      return refusal("invalid", "unknown, expired or mismatched install token — prepare again");
    }
    const opts = storeOpts();
    if (source.kind === "official") {
      const check = await checkIndex();
      // xfix M1: expired index refuses commit too.
      if (!indexUsableForInstall(check)) {
        return refusal("network", `index unavailable (${check.status})`);
      }
      const result = await installFromIndex(opts, check.index!, { name: source.name, version: prepared.version });
      if (!result.ok) {
        return refusal(result.reason, result.detail);
      }
      // Capability growth check on commit: compare state capabilities.
      const { state } = await readSanitizedState(deps.fs, deps.home);
      const entry = state.plugins[source.name];
      const indexEntry = check.index!.plugins.find((p) => p.name === source.name);
      const indexVersion = indexEntry?.versions.find((v) => v.version === prepared.version);
      if (entry !== undefined && indexVersion !== undefined && !capabilitiesSubset(entry.capabilities, indexVersion.capabilities)) {
        // Explicit confirmation IS the approval — proceed.
      }
      pending.delete(token);
      if (allowMcp) {
        await recordInstallConsent(source.name);
      }
      notifyChanged("install");
      return { ok: true, snapshot: await buildSnapshot(deps, check) };
    }
    if (prepared.bytes !== undefined) {
      // Taskana 4732 xfix H3: commit installs the EXACT previewed bytes —
      // never a re-download. The URL pin is the sha256 computed at prepare over
      // these very bytes; installFromBytes refuses any difference.
      const result = source.kind === "url"
        ? await installFromBytes(opts, prepared.bytes, {
          fileName: prepared.name,
          expectedName: prepared.name,
          expectedSha256: prepared.sha256,
          source: { kind: "url", url: source.url },
        })
        : await installFromBytes(opts, prepared.bytes, { fileName: prepared.fileName ?? prepared.name });
      if (!result.ok) {
        return refusal(result.reason, result.detail);
      }
      pending.delete(token);
      if (allowMcp) {
        await recordInstallConsent(result.value.name);
      }
      notifyChanged("install");
      return { ok: true, snapshot: await buildSnapshot(deps) };
    }
    if (source.kind === "folder") {
      // xfix H3: the token carries the folder main picked at PREPARE —
      // reusing it (no second OS dialog) is what binds preview to install.
      if (prepared.folderPath === undefined) {
        return refusal("invalid", "stale install token — prepare again");
      }
      const result = await installLocalLink(opts, prepared.folderPath);
      if (!result.ok) {
        return refusal(result.reason, result.detail);
      }
      pending.delete(token);
      if (allowMcp) {
        await recordInstallConsent(result.value.name);
      }
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
    return handleCommit(parsed.data.token, parsed.data.source, parsed.data.allowMcp ?? false);
  });

  ipcMain.handle(PLUGINS_UPDATE_CHANNEL, async (_event, payload: unknown) => {
    const parsed = nameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    const check = await checkIndex();
    // xfix M1: expired index refuses updates.
    if (!indexUsableForInstall(check)) {
      return refusal("network", `index unavailable (${check.status})`);
    }
    const result = await installFromIndex(storeOpts(), check.index!, { name: parsed.data.name });
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
    // Taskana 4732 xfix M4: tombstoning must not depend on the OFFLINE cache
    // alone — with no cached (or stale) index the old code derived
    // isDefault=false and the next update pass silently reinstalled the
    // plugin the user explicitly removed. Derive from any index copy we can
    // reach WITHOUT network: the cache; when that is silent, tombstone any
    // official-trust store entry unconditionally (a default it may have been
    // — the cost of a wrong tombstone is zero: it only blocks auto-reinstall
    // of a plugin the user removed).
    const cached = await readCachedPluginIndexSafe(deps);
    let isDefault = isDefaultInIndex(cached.index, parsed.data.name);
    if (!isDefault) {
      const { state } = await readSanitizedState(deps.fs, deps.home);
      isDefault = state.plugins[parsed.data.name]?.trust === "official";
    }
    const result = await storeRemovePlugin(storeOpts(), parsed.data.name, isDefault);
    if (!result.ok) return refusal(result.reason, result.detail);
    notifyChanged("remove");
    return { ok: true };
  });

  ipcMain.handle(PLUGINS_APPROVE_MCP_CHANNEL, async (_event, payload: unknown): Promise<PluginsMutationResult> => {
    const parsed = nameSchema.safeParse(payload);
    if (!parsed.success) return refusal("invalid");
    // Grant consent for the plugin's CURRENT serversHash (read from scan).
    const scan = await scanPluginsAdmin(deps.fs, {
      workspace: workspaceOf(deps),
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
      // xfix M1: an expired index never drives an automatic install either.
      if (!indexUsableForInstall(check)) {
        return { installed: [], status: check.status };
      }
      const settings = await deps.settings.getPlugins();
      const result = await storeRunUpdatePass({
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

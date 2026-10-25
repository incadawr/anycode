/**
 * Managed plugin STORE (Taskana 4732 S1-B, design §3/§5): download → verify
 * (sha256+size) → extract → validate manifest → atomic rename into
 * `.store/<name>/<version>/` → rewrite `state.json` (tmp+rename). Also:
 * rollback (swap active/previous + pin), remove (tombstone for defaults),
 * GC (boot-only), staging wipe, `.local` dev links, and the update
 * selection policy (compat-gated, capability-subset auto-update).
 *
 * PURE over injected deps: fs, fetch, clock — no Electron, no global state,
 * no network at import time. `PluginStoreFs` is structural (satisfied by
 * fsp + a mkdir helper), `PluginArchiveFetch` fetches bytes with redirect
 * host checks.
 *
 * ADDENDUM hardening: `sanitizeStateEntries` re-validates state.json
 * `plugins` keys against the manifest name pattern and `active` as a STRICT
 * semver (no `/`, no `..`) before ANY path is built from them, so
 * `.store/<name>/<active>` can never escape the store root; invalid entries
 * are dropped with a problem (and the next write persists the drop).
 */

import { dirname, join, resolve } from "node:path";
import {
  capabilities,
  isValidSemver,
  pluginManifestSchema,
  rangeMatches,
  type PluginCapabilities,
  type PluginManifest,
} from "@anycode/core/plugins-admin";
import {
  emptyPluginState,
  readPluginState,
  serversHash,
  writePluginState,
  PLUGIN_STATE_FILE,
  type McpConsentEntry,
  type PluginStateEntry,
  type PluginsState,
} from "@anycode/core/plugins-admin";
import { extractTgz } from "./archive.js";
import { sha256Hex, type PluginIndex } from "./index-client.js";
import { sanitizePluginState } from "./store-state.js";
import { OFFICIAL_ARTIFACT_REDIRECT_HOSTS, PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES, PLUGIN_FETCH_TIMEOUT_MS } from "../../shared/plugin-trust.js";

export {
  defaultPluginStatePath,
  readPluginState,
  writePluginState,
  emptyPluginState,
  serversHash,
  PLUGIN_STATE_FILE,
} from "@anycode/core/plugins-admin";
export { isStoreVersionSafe, sanitizePluginState } from "./store-state.js";

// ── injected deps ──

export interface PluginStoreFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean }>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  /** Binary-safe write for extracted archive members. */
  writeFileBytes?(path: string, data: Buffer, opts?: { mode?: number }): Promise<void>;
  /** Picks a .tgz file — main opens the OS dialog (path custody, design §4). */
  pickFile?(filters: { name: string; extensions: string[] }[]): Promise<string | undefined>;
  /** Picks a folder — main opens the OS dialog. */
  pickFolder?(): Promise<string | undefined>;
}

export type ArchiveFetchResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "network" | "too_large" | "forbidden_redirect" };

export type PluginArchiveFetch = (url: string) => Promise<ArchiveFetchResult>;

export interface PluginStoreOptions {
  /** `~/.anycode` — the store lives at `<home>/.anycode/plugins`. */
  home: string;
  appVersion: string;
  fs: PluginStoreFs;
  fetchImpl?: PluginArchiveFetch;
  now?: () => number;
  /** rng for staging dir names (tests inject deterministic). */
  randomId?: () => string;
}

// ── layout helpers ──

/** `<home>/.anycode/plugins` */
export function pluginsRoot(home: string): string {
  return `${home.replace(/[/\\]+$/, "")}/.anycode/plugins`;
}

export function storeDir(home: string): string {
  return join(pluginsRoot(home), ".store");
}

export function stagingDir(home: string): string {
  return join(pluginsRoot(home), ".staging");
}

export function cacheDir(home: string): string {
  return join(pluginsRoot(home), ".cache");
}

export function statePath(home: string): string {
  return join(pluginsRoot(home), PLUGIN_STATE_FILE);
}

/**
 * Taskana 4732 xfix L7/concurrency: every state.json read-modify-write runs
 * under one per-state-file queue. Two overlapping mutations (an install and a
 * remove, a pin and an update pass) used to read the same snapshot and the
 * later write silently dropped the earlier change. Serialization is in-process
 * only — the desktop main process is the sole writer of state.json.
 */
const stateQueues = new Map<string, Promise<unknown>>();
export function withPluginStateLock<T>(home: string, task: () => Promise<T>): Promise<T> {
  const key = statePath(home);
  const next = (stateQueues.get(key) ?? Promise.resolve()).then(task);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  stateQueues.set(key, settled);
  void settled.then(() => {
    if (stateQueues.get(key) === settled) stateQueues.delete(key);
  });
  return next;
}

export type StoreRefusal =
  | "invalid"
  | "not_found"
  | "read_only_source"
  | "incompatible"
  | "integrity"
  | "too_large"
  | "network"
  | "io_error";

export interface StoreProblem {
  message: string;
}

export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: StoreRefusal; detail: string };

/** Reads + sanitizes state.json (invalid name/active entries dropped with problems). */
export async function readSanitizedState(
  fs: PluginStoreFs,
  home: string,
): Promise<{ state: PluginsState; problems: string[] }> {
  const read = await readPluginState(fs, statePath(home));
  const sanitized = sanitizePluginState(read.state, read.problems);
  return { state: sanitized.state, problems: sanitized.problems };
}

// ── manifest validation ──

async function loadManifestFromEntries(entries: { path: string; type: "file" | "dir"; data?: Buffer }[]): Promise<
  { ok: true; manifest: PluginManifest; manifestBytes: string } | { ok: false; reason: StoreRefusal; detail: string }
> {
  const manifestEntry = entries.find((e) => e.type === "file" && e.path === ".anycode-plugin/plugin.json");
  if (manifestEntry === undefined) {
    return { ok: false, reason: "invalid", detail: "archive does not carry .anycode-plugin/plugin.json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestEntry.data?.toString("utf8") ?? "");
  } catch (error) {
    return { ok: false, reason: "invalid", detail: `manifest is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = pluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "invalid", detail: `manifest invalid: ${result.error.issues[0]?.message ?? "shape"}` };
  }
  if (result.data.version === undefined) {
    return { ok: false, reason: "invalid", detail: "managed installs require a semver `version`" };
  }
  if (!isValidSemver(result.data.version)) {
    return { ok: false, reason: "invalid", detail: `manifest version ${JSON.stringify(result.data.version)} is not semver` };
  }
  return { ok: true, manifest: result.data, manifestBytes: manifestEntry.data!.toString("utf8") };
}

/** Capability set of a parsed manifest as a sorted string list (index-comparable). */
function capabilityList(manifest: PluginManifest): string[] {
  const caps = capabilities(manifest);
  const list: string[] = [];
  if (caps.skills > 0) list.push("skills");
  if (caps.agents > 0) list.push("agents");
  if (caps.workflows > 0) list.push("workflows");
  list.push(...caps.mcp.map((name) => `mcp:${name}`));
  if (caps.commands > 0) list.push("commands");
  if (caps.hooks) list.push("hooks");
  if (caps.docs) list.push("docs");
  list.push(...caps.engineSupport.map((name) => `engineSupport:${name}`));
  if (caps.promptOverlays > 0) list.push("promptOverlays");
  return list.sort();
}

// ── staging ──

async function makeStagingDir(opts: PluginStoreOptions): Promise<string> {
  const dir = join(stagingDir(opts.home), opts.randomId?.() ?? randomHex());
  await opts.fs.mkdir(dir);
  return dir;
}

function randomHex(): string {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

/** Boot-only: wipes every staging directory (crash residue, design §3/§5). */
export async function wipeStaging(fs: PluginStoreFs, home: string): Promise<void> {
  const staging = stagingDir(home);
  if (!(await fs.exists(staging))) return;
  for (const entry of await fs.readdir(staging)) {
    try {
      await fs.rm(join(staging, entry));
    } catch {
      // fail-soft: a stuck staging dir never fails boot
    }
  }
}

/** Boot-only GC (design §5): delete `.store/<name>/<v>` not in {active, previous}. */
export async function gcStore(fs: PluginStoreFs, home: string): Promise<{ removed: string[]; problems: string[] }> {
  const { state } = await readSanitizedState(fs, home);
  const removed: string[] = [];
  const problems: string[] = [];
  const store = storeDir(home);
  if (!(await fs.exists(store))) return { removed, problems };
  const keep = new Map<string, Set<string>>();
  for (const [name, entry] of Object.entries(state.plugins)) {
    if (entry.source.kind === "local") continue;
    keep.set(name, new Set([entry.active, ...(entry.previous !== undefined ? [entry.previous] : [])]));
  }
  for (const name of await fs.readdir(store)) {
    const keepVersions = keep.get(name);
    const pluginDir = join(store, name);
    if (keepVersions === undefined) {
      // Orphaned plugin dir (state entry removed) — GC it.
      try {
        await fs.rm(pluginDir);
        problems.push(`GC removed orphaned store directory ${name}`);
      } catch {
        // fail-soft
      }
      continue;
    }
    try {
      const versions = await fs.readdir(pluginDir);
      for (const version of versions) {
        if (!keepVersions.has(version)) {
          await fs.rm(join(pluginDir, version));
          removed.push(`${name}/${version}`);
        }
      }
    } catch (error) {
      problems.push(`GC could not list ${pluginDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, problems };
}

// ── install core (shared by official/url/file) ──

interface InstallRequest {
  /** Expected plugin name (index entry name for official; verified against the manifest). */
  expectedName: string;
  /** Expected version; undefined = take the manifest's. */
  expectedVersion?: string;
  trust: "official" | "third-party";
  source: PluginStateEntry["source"];
  /** sha256 + size pin (index-pinned for official; undefined = accept+record). */
  pinned?: { sha256: string; size: number };
}

function installArchive(
  opts: PluginStoreOptions,
  request: InstallRequest,
  bytes: Buffer,
): Promise<StoreResult<{ state: PluginsState; name: string; version: string; manifest: PluginManifest; capabilities: string[] }>> {
  return withPluginStateLock(opts.home, () => installArchiveUnlocked(opts, request, bytes));
}

async function installArchiveUnlocked(
  opts: PluginStoreOptions,
  request: InstallRequest,
  bytes: Buffer,
): Promise<StoreResult<{ state: PluginsState; name: string; version: string; manifest: PluginManifest; capabilities: string[] }>> {
  const { fs, home } = opts;
  if (request.pinned !== undefined) {
    const actual = sha256Hex(bytes);
    if (actual !== request.pinned.sha256) {
      return { ok: false, reason: "integrity", detail: `sha256 mismatch: index says ${request.pinned.sha256.slice(0, 8)}…, archive is ${actual.slice(0, 8)}…` };
    }
    if (bytes.length !== request.pinned.size) {
      return { ok: false, reason: "integrity", detail: `size mismatch: index says ${request.pinned.size}, archive is ${bytes.length}` };
    }
  }

  const extracted = extractTgz(bytes);
  if (!extracted.ok) {
    const refusal: StoreRefusal = extracted.refusal === "too_large" ? "too_large" : "invalid";
    return { ok: false, reason: refusal, detail: extracted.detail };
  }

  const manifestResult = await loadManifestFromEntries(extracted.entries);
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const { manifest } = manifestResult;
  if (manifest.name !== request.expectedName) {
    return { ok: false, reason: "invalid", detail: `manifest name ${JSON.stringify(manifest.name)} does not match the requested ${JSON.stringify(request.expectedName)}` };
  }
  if (request.expectedVersion !== undefined && manifest.version !== request.expectedVersion) {
    return { ok: false, reason: "invalid", detail: `manifest version ${manifest.version} does not match the requested ${request.expectedVersion}` };
  }
  if (manifest.engines?.anycode !== undefined && !rangeMatches(manifest.engines.anycode, opts.appVersion)) {
    return { ok: false, reason: "incompatible", detail: `plugin needs AnyCode ${manifest.engines.anycode}, this app is ${opts.appVersion}` };
  }
  const version = manifest.version!;

  // Target: .store/<name>/<version>/ — reuse if already present and valid.
  const targetDir = join(storeDir(home), manifest.name, version);
  if (!(await fs.exists(targetDir))) {
    const staging = await makeStagingDir(opts);
    try {
      for (const entry of extracted.entries) {
        const dest = join(staging, entry.path);
        if (entry.type === "dir") {
          await fs.mkdir(dest);
          continue;
        }
        await fs.mkdir(dirname(dest));
        if (entry.data !== undefined) {
          const writer = fs.writeFileBytes ?? ((path: string, data: Buffer, o?: { mode?: number }) => fs.writeFile(path, data.toString("utf8"), o));
          await writer(dest, entry.data, { mode: entry.mode });
        }
      }
      // Containment discipline: rename only inside the store root.
      const contained = resolve(targetDir).startsWith(resolve(storeDir(home)));
      if (!contained) {
        return { ok: false, reason: "invalid", detail: "install target escapes the store root" };
      }
      await fs.mkdir(dirname(targetDir));
      await fs.rename(staging, targetDir);
    } catch (error) {
      await fs.rm(staging).catch(() => undefined);
      return { ok: false, reason: "io_error", detail: `staging write failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // State rewrite: previous = old active (when different), active = version.
  const { state } = await readSanitizedState(fs, home);
  const existing = state.plugins[manifest.name];
  const caps = capabilityList(manifest);
  const entry: PluginStateEntry = {
    source: request.source,
    trust: request.trust,
    active: version,
    ...(existing !== undefined && existing.active !== version ? { previous: existing.active } : existing?.previous !== undefined ? { previous: existing.previous } : {}),
    enabled: true,
    pinned: false,
    ...(request.pinned !== undefined || existing?.sha256 !== undefined
      ? { sha256: request.pinned?.sha256 ?? existing?.sha256 }
      : {}),
    installedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
    capabilities: caps,
  };
  state.plugins[manifest.name] = entry;
  try {
    await writePluginState(fs, statePath(home), state);
  } catch (error) {
    return { ok: false, reason: "io_error", detail: `state write failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, value: { state, name: manifest.name, version, manifest, capabilities: caps } };
}

// ── public install paths ──

/** Installs from the signed index's pinned artifact (official channel). */
export async function installFromIndex(
  opts: PluginStoreOptions,
  index: PluginIndex,
  request: { name: string; version?: string },
): Promise<StoreResult<{ name: string; version: string; manifest: PluginManifest; capabilities: string[]; mcpServers: { name: string; command: string; args: string[] }[] }>> {
  const entry = index.plugins.find((p) => p.name === request.name);
  if (entry === undefined) {
    return { ok: false, reason: "not_found", detail: `plugin ${request.name} is not in the official index` };
  }
  const compatible = entry.versions
    .filter((v) => v.engines?.anycode === undefined || rangeMatches(v.engines!.anycode, opts.appVersion))
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
  const pick = request.version !== undefined
    ? compatible.find((v) => v.version === request.version) ?? entry.versions.find((v) => v.version === request.version)
    : compatible[0];
  if (pick === undefined) {
    return { ok: false, reason: "incompatible", detail: `no version of ${request.name} is compatible with AnyCode ${opts.appVersion}` };
  }
  if (pick.engines?.anycode !== undefined && !rangeMatches(pick.engines.anycode, opts.appVersion)) {
    return { ok: false, reason: "incompatible", detail: `${request.name} ${pick.version} needs AnyCode ${pick.engines.anycode}` };
  }
  const fetchImpl = opts.fetchImpl;
  if (fetchImpl === undefined) {
    return { ok: false, reason: "network", detail: "no fetch implementation wired" };
  }
  const fetched = await fetchImpl(pick.url);
  if (!fetched.ok) {
    return { ok: false, reason: fetched.reason === "too_large" ? "too_large" : "network", detail: `artifact download failed (${fetched.reason})` };
  }
  const result = await installArchive(opts, {
    expectedName: request.name,
    expectedVersion: pick.version,
    trust: "official",
    source: { kind: "official" },
    pinned: { sha256: pick.sha256, size: pick.size },
  }, fetched.bytes);
  if (!result.ok) {
    return result;
  }
  const mcp = result.value.manifest.mcpServers ?? {};
  return {
    ok: true,
    value: {
      name: result.value.name,
      version: result.value.version,
      manifest: result.value.manifest,
      capabilities: result.value.capabilities,
      mcpServers: Object.entries(mcp).map(([name, server]) => ({
        name,
        command: "command" in server ? String(server.command) : "stdio",
        args: "args" in server && Array.isArray(server.args) ? server.args.map(String) : [],
      })),
    },
  };
}

/** Shared version ordering (newest first) — the ONE sort every surface uses (Taskana 4732 xfix M3). */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Installs from raw bytes (a picked .tgz file, or the bytes a URL preview
 * already downloaded — path custody lives in ipc). `expectedSha256` (Taskana
 * 4732 xfix H3) pins the EXACT previewed bytes: a mismatch refuses, so commit
 * can never install content the user did not see on the sheet.
 */
export async function installFromBytes(
  opts: PluginStoreOptions,
  bytes: Buffer,
  meta: {
    fileName: string;
    expectedName?: string;
    expectedSha256?: string;
    source?: PluginStateEntry["source"];
  },
): Promise<StoreResult<{ name: string; version: string; manifest: PluginManifest; capabilities: string[] }>> {
  if (meta.expectedSha256 !== undefined && sha256Hex(bytes) !== meta.expectedSha256) {
    return { ok: false, reason: "integrity", detail: "archive bytes differ from the previewed artifact" };
  }
  return installArchive(opts, {
    expectedName: meta.expectedName ?? guessNameFromArchive(bytes) ?? "",
    trust: "third-party",
    source: meta.source ?? { kind: "file", fileName: meta.fileName },
    ...(meta.expectedSha256 !== undefined ? { pinned: { sha256: meta.expectedSha256, size: bytes.length } } : {}),
  }, bytes);
}

/** Installs from a URL (https only — enforced by the default fetch impl). */
export async function installFromUrl(
  opts: PluginStoreOptions,
  url: string,
): Promise<StoreResult<{ name: string; version: string; manifest: PluginManifest; capabilities: string[] }>> {
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, reason: "invalid", detail: "only https:// URLs are accepted" };
  }
  const fetchImpl = opts.fetchImpl;
  if (fetchImpl === undefined) {
    return { ok: false, reason: "network", detail: "no fetch implementation wired" };
  }
  const fetched = await fetchImpl(url);
  if (!fetched.ok) {
    return { ok: false, reason: "network", detail: `download failed (${fetched.reason})` };
  }
  const guessed = guessNameFromArchive(fetched.bytes);
  const result = await installArchive(opts, {
    expectedName: guessed ?? "",
    trust: "third-party",
    source: { kind: "url", url },
  }, fetched.bytes);
  return result.ok ? { ok: true, value: result.value } : result;
}

/**
 * Dev link (design §3 "local directory"): no copy — state records the
 * absolute path; discovery reads it in place. The manifest must validate.
 */
export function installLocalLink(
  opts: PluginStoreOptions,
  path: string,
): Promise<StoreResult<{ name: string; version: string; capabilities: string[] }>> {
  return withPluginStateLock(opts.home, () => installLocalLinkUnlocked(opts, path));
}

async function installLocalLinkUnlocked(
  opts: PluginStoreOptions,
  path: string,
): Promise<StoreResult<{ name: string; version: string; capabilities: string[] }>> {
  const manifestPath = `${path.replace(/[/\\]+$/, "")}/.anycode-plugin/plugin.json`;
  if (!(await opts.fs.exists(manifestPath))) {
    return { ok: false, reason: "invalid", detail: "the picked folder has no .anycode-plugin/plugin.json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await opts.fs.readFile(manifestPath));
  } catch (error) {
    return { ok: false, reason: "invalid", detail: `manifest is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const manifest = pluginManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    return { ok: false, reason: "invalid", detail: "manifest invalid" };
  }
  const { state } = await readSanitizedState(opts.fs, opts.home);
  const name = manifest.data.name;
  state.plugins[name] = {
    source: { kind: "local", path },
    trust: "local",
    active: manifest.data.version ?? "0.0.0",
    enabled: true,
    pinned: false,
    installedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
    capabilities: capabilityList(manifest.data),
  };
  try {
    await writePluginState(opts.fs, statePath(opts.home), state);
  } catch (error) {
    return { ok: false, reason: "io_error", detail: String(error) };
  }
  return { ok: true, value: { name, version: manifest.data.version ?? "0.0.0", capabilities: capabilityList(manifest.data) } };
}

/** Peeks at a bytes archive's manifest name WITHOUT installing (URL/file preview). */
export function guessNameFromArchive(bytes: Buffer): string | undefined {
  const extracted = extractTgz(bytes);
  if (!extracted.ok) return undefined;
  const entry = extracted.entries.find((e) => e.type === "file" && e.path === ".anycode-plugin/plugin.json");
  if (entry === undefined) return undefined;
  try {
    const parsed = pluginManifestSchema.safeParse(JSON.parse(entry.data?.toString("utf8") ?? ""));
    return parsed.success ? parsed.data.name : undefined;
  } catch {
    return undefined;
  }
}

/** Full preview of an archive (for the confirmation sheet) WITHOUT installing. */
export function previewArchive(bytes: Buffer): {
  ok: true;
  manifest: PluginManifest;
  capabilities: string[];
  mcpServers: { name: string; command: string; args: string[] }[];
  sha256Prefix: string;
} | { ok: false; reason: StoreRefusal; detail: string } {
  const extracted = extractTgz(bytes);
  if (!extracted.ok) {
    return { ok: false, reason: extracted.refusal === "too_large" ? "too_large" : "invalid", detail: extracted.detail };
  }
  const manifestResult = loadManifestFromEntriesSync(extracted.entries);
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const mcp = manifestResult.manifest.mcpServers ?? {};
  return {
    ok: true,
    manifest: manifestResult.manifest,
    capabilities: capabilityList(manifestResult.manifest),
    mcpServers: Object.entries(mcp).map(([name, server]) => ({
      name,
      command: "command" in server ? String(server.command) : "stdio",
      args: "args" in server && Array.isArray(server.args) ? server.args.map(String) : [],
    })),
    sha256Prefix: sha256Hex(bytes).slice(0, 8),
  };
}

function loadManifestFromEntriesSync(entries: { path: string; type: "file" | "dir"; data?: Buffer }[]): { ok: true; manifest: PluginManifest } | { ok: false; reason: StoreRefusal; detail: string } {
  const manifestEntry = entries.find((e) => e.type === "file" && e.path === ".anycode-plugin/plugin.json");
  if (manifestEntry === undefined) {
    return { ok: false, reason: "invalid", detail: "archive does not carry .anycode-plugin/plugin.json" };
  }
  try {
    const parsed = pluginManifestSchema.safeParse(JSON.parse(manifestEntry.data?.toString("utf8") ?? ""));
    if (!parsed.success || parsed.data.version === undefined || !isValidSemver(parsed.data.version)) {
      return { ok: false, reason: "invalid", detail: "manifest invalid or missing semver version" };
    }
    return { ok: true, manifest: parsed.data };
  } catch (error) {
    return { ok: false, reason: "invalid", detail: `manifest is not JSON: ${String(error)}` };
  }
}

// ── lifecycle: rollback / remove / pin / enable ──

/** Rollback: swap active/previous, pin (design §5). */
export function rollbackPlugin(opts: PluginStoreOptions, name: string): Promise<StoreResult<PluginsState>> {
  return withPluginStateLock(opts.home, () => rollbackPluginUnlocked(opts, name));
}

async function rollbackPluginUnlocked(opts: PluginStoreOptions, name: string): Promise<StoreResult<PluginsState>> {
  const { fs, home } = opts;
  const { state } = await readSanitizedState(fs, home);
  const entry = state.plugins[name];
  if (entry === undefined) {
    return { ok: false, reason: "not_found", detail: `no managed plugin named ${name}` };
  }
  if (entry.source.kind === "local") {
    return { ok: false, reason: "read_only_source", detail: "local dev links have no versions to roll back" };
  }
  if (entry.previous === undefined) {
    return { ok: false, reason: "not_found", detail: `${name} has no previous version to roll back to` };
  }
  const previousDir = join(storeDir(home), name, entry.previous);
  if (!(await fs.exists(previousDir))) {
    return { ok: false, reason: "not_found", detail: `previous version directory ${entry.previous} is missing` };
  }
  const oldActive = entry.active;
  state.plugins[name] = { ...entry, active: entry.previous, previous: oldActive, pinned: true };
  try {
    await writePluginState(fs, statePath(home), state);
  } catch (error) {
    return { ok: false, reason: "io_error", detail: String(error) };
  }
  return { ok: true, value: state };
}

/** Remove: delete state entry (+ store dirs at next GC); tombstone defaults. */
export function removePlugin(opts: PluginStoreOptions, name: string, isDefault: boolean): Promise<StoreResult<PluginsState>> {
  return withPluginStateLock(opts.home, () => removePluginUnlocked(opts, name, isDefault));
}

async function removePluginUnlocked(opts: PluginStoreOptions, name: string, isDefault: boolean): Promise<StoreResult<PluginsState>> {
  const { fs, home } = opts;
  const { state } = await readSanitizedState(fs, home);
  const entry = state.plugins[name];
  if (entry === undefined) {
    return { ok: false, reason: "not_found", detail: `no managed plugin named ${name}` };
  }
  delete state.plugins[name];
  if (isDefault && !state.removedDefaults.includes(name)) {
    state.removedDefaults.push(name);
  }
  try {
    await writePluginState(fs, statePath(home), state);
    // Immediate cleanup of the store dir (GC would also catch it at boot).
    const pluginDir = join(storeDir(home), name);
    if (entry.source.kind !== "local" && (await fs.exists(pluginDir))) {
      await fs.rm(pluginDir);
    }
  } catch (error) {
    return { ok: false, reason: "io_error", detail: String(error) };
  }
  return { ok: true, value: state };
}

/** Pin/unpin. */
export function setPinned(opts: PluginStoreOptions, name: string, pinned: boolean): Promise<StoreResult<PluginsState>> {
  return withPluginStateLock(opts.home, () => setPinnedUnlocked(opts, name, pinned));
}

async function setPinnedUnlocked(opts: PluginStoreOptions, name: string, pinned: boolean): Promise<StoreResult<PluginsState>> {
  const { fs, home } = opts;
  const { state } = await readSanitizedState(fs, home);
  const entry = state.plugins[name];
  if (entry === undefined) {
    return { ok: false, reason: "not_found", detail: `no managed plugin named ${name}` };
  }
  state.plugins[name] = { ...entry, pinned };
  try {
    await writePluginState(fs, statePath(home), state);
  } catch (error) {
    return { ok: false, reason: "io_error", detail: String(error) };
  }
  return { ok: true, value: state };
}

/**
 * Enable/disable is USER-GLOBAL by name (state.json `disabled`), covering
 * managed, project and legacy plugins (design §3).
 */
export function setEnabled(opts: PluginStoreOptions, name: string, enabled: boolean): Promise<StoreResult<PluginsState>> {
  return withPluginStateLock(opts.home, () => setEnabledUnlocked(opts, name, enabled));
}

async function setEnabledUnlocked(opts: PluginStoreOptions, name: string, enabled: boolean): Promise<StoreResult<PluginsState>> {
  const { fs, home } = opts;
  const { state } = await readSanitizedState(fs, home);
  if (!enabled && !state.disabled.includes(name)) {
    state.disabled.push(name);
  } else if (enabled) {
    state.disabled = state.disabled.filter((n) => n !== name);
  }
  try {
    await writePluginState(fs, statePath(home), state);
  } catch (error) {
    return { ok: false, reason: "io_error", detail: String(error) };
  }
  return { ok: true, value: state };
}

// ── update selection + auto-update policy (design §5) ──

export interface UpdateCandidate {
  name: string;
  version: string;
  /** True when the capability set grew (needs explicit approval). */
  needsApproval: boolean;
}

/**
 * Compat-gated selection: highest version satisfying engines AND > active.
 * With `activeCapabilities` supplied, `needsApproval` is computed from the
 * candidate's INDEX-declared capabilities (subset check).
 */
export function selectUpdate(
  index: PluginIndex,
  current: { name: string; active: string; pinned: boolean },
  appVersion: string,
): UpdateCandidate | undefined {
  const entry = index.plugins.find((p) => p.name === current.name);
  if (entry === undefined || current.pinned) return undefined;
  // Taskana 4732 xfix M3: SORT before picking — the index schema does not
  // enforce version ordering, and `candidates[0]` on an ascending list
  // picked the OLDEST compatible version (the IPC surface sorts; this
  // sibling did not, so the scheduler could auto-install a lower version
  // than the pane advertised).
  const candidates = entry.versions
    .filter((v) => v.engines?.anycode === undefined || rangeMatches(v.engines!.anycode, appVersion))
    .filter((v) => compareVersionsDesc(v.version, current.active) < 0)
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
  const pick = candidates[0];
  if (pick === undefined) return undefined;
  return { name: current.name, version: pick.version, needsApproval: false };
}

/** True when new capabilities are a SUBSET of old (auto-updatable, design §5). */
export function capabilitiesSubset(oldCaps: readonly string[], newCaps: readonly string[]): boolean {
  const oldSet = new Set(oldCaps);
  return newCaps.every((capability) => oldSet.has(capability));
}

/**
 * The periodic update pass: check the index, auto-install official updates
 * whose capability set did not grow, remember `lastIndexSerial`. Returns
 * what changed (never throws).
 */
export async function runUpdatePass(
  opts: PluginStoreOptions & {
    checkIndex: () => Promise<{ status: string; index?: PluginIndex }>;
    autoUpdateOfficial: boolean;
    onInstalled?: (name: string, from: string, to: string) => void;
  },
): Promise<{ installed: { name: string; from: string; to: string }[]; needsApproval: UpdateCandidate[]; status: string }> {
  const check = await opts.checkIndex();
  if (check.index === undefined) {
    return { installed: [], needsApproval: [], status: check.status };
  }
  const { state } = await readSanitizedState(opts.fs, opts.home);
  const installed: { name: string; from: string; to: string }[] = [];
  const needsApproval: UpdateCandidate[] = [];

  // Default official plugins: silent auto-install when no MCP/hooks.
  for (const entry of check.index.plugins) {
    if (!entry.default || state.removedDefaults.includes(entry.name) || state.plugins[entry.name] !== undefined) {
      continue;
    }
    const newest = entry.versions
      .filter((v) => v.engines?.anycode === undefined || rangeMatches(v.engines!.anycode, opts.appVersion))
      .sort((a, b) => compareVersionsDesc(a.version, b.version))[0];
    if (newest === undefined) continue;
    const hasSensitive = newest.capabilities.some((c) => c.startsWith("mcp:") || c === "hooks");
    if (hasSensitive) continue; // needs approval via the pane
    const result = await installFromIndex(opts, check.index, { name: entry.name, version: newest.version });
    if (result.ok) {
      installed.push({ name: entry.name, from: "(none)", to: result.value.version });
      opts.onInstalled?.(entry.name, "(none)", result.value.version);
    }
  }

  // Updates for installed official plugins.
  for (const [name, entry] of Object.entries(state.plugins)) {
    // xfix L2: a user-disabled plugin is not auto-updated (burns no rollback slot).
    if (entry.source.kind !== "official" || entry.pinned || state.disabled.includes(name)) continue;
    const candidate = selectUpdate(check.index, { name, active: entry.active, pinned: entry.pinned }, opts.appVersion);
    if (candidate === undefined) continue;
    const indexEntry = check.index.plugins.find((p) => p.name === name);
    const indexVersion = indexEntry?.versions.find((v) => v.version === candidate.version);
    const newCaps = indexVersion?.capabilities ?? [];
    const canAuto = opts.autoUpdateOfficial && capabilitiesSubset(entry.capabilities, newCaps);
    if (canAuto) {
      const result = await installFromIndex(opts, check.index, { name, version: candidate.version });
      if (result.ok) {
        installed.push({ name, from: entry.active, to: candidate.version });
        opts.onInstalled?.(name, entry.active, candidate.version);
        continue;
      }
    }
    needsApproval.push({ name, version: candidate.version, needsApproval: true });
  }

  // Remember the serial (anti-rollback floor).
  if (check.index.serial !== undefined) {
    const serial = check.index.serial;
    await withPluginStateLock(opts.home, async () => {
      const { state: fresh } = await readSanitizedState(opts.fs, opts.home);
      if ((fresh.lastIndexSerial ?? -1) >= serial) return; // raise-only floor
      fresh.lastIndexSerial = serial;
      try {
        await writePluginState(opts.fs, statePath(opts.home), fresh);
      } catch {
        // advisory
      }
    });
  }
  return { installed, needsApproval, status: check.status };
}

/** App-version reselect after an app update (design §5): switch to a compatible version when active became incompatible. */
export async function reselectAfterAppUpdate(
  opts: PluginStoreOptions & { checkIndex: () => Promise<{ status: string; index?: PluginIndex }> },
): Promise<{ switched: { name: string; from: string; to: string }[]; status: string }> {
  const check = await opts.checkIndex();
  if (check.index === undefined) {
    return { switched: [], status: check.status };
  }
  const { fs, home } = opts;
  const { state } = await readSanitizedState(fs, home);
  const switched: { name: string; from: string; to: string }[] = [];
  for (const [name, entry] of Object.entries(state.plugins)) {
    if (entry.source.kind !== "official") continue;
    const indexEntry = check.index.plugins.find((p) => p.name === name);
    if (indexEntry === undefined) continue;
    // Read the active version's manifest to check its engines range.
    const manifestPath = join(storeDir(home), name, entry.active, ".anycode-plugin/plugin.json");
    let activeCompatible = true;
    if (await fs.exists(manifestPath)) {
      try {
        const manifest = pluginManifestSchema.safeParse(JSON.parse(await fs.readFile(manifestPath)));
        if (manifest.success && manifest.data.engines?.anycode !== undefined) {
          activeCompatible = rangeMatches(manifest.data.engines!.anycode, opts.appVersion);
        }
      } catch {
        // unreadable manifest: leave as-is (discovery reports the problem)
      }
    }
    if (activeCompatible) continue;
    // Switch to the highest compatible (any, not just > active).
    const compatible = indexEntry.versions
      .filter((v) => v.engines?.anycode === undefined || rangeMatches(v.engines!.anycode, opts.appVersion))
      .sort((a, b) => compareVersionsDesc(a.version, b.version))[0];
    if (compatible === undefined || compatible.version === entry.active) continue;
    const result = await installFromIndex(opts, check.index, { name, version: compatible.version });
    if (result.ok) {
      switched.push({ name, from: entry.active, to: compatible.version });
    }
  }
  return { switched, status: check.status };
}

// ── MCP consent writer (settings.json `plugins.mcpConsent`, design §4) ──

/**
 * Legacy grandfathering migration (design §4): every legacy user-dir
 * plugin with MCP servers gets a consent entry for its CURRENT serversHash,
 * once — detected via the absence of the `plugins` settings block at all.
 */
export async function legacyMcpGrandfathering(
  opts: PluginStoreOptions & {
    readMcpConsent: () => Promise<readonly McpConsentEntry[] | undefined>;
    writeMcpConsent: (entries: readonly McpConsentEntry[]) => Promise<void>;
  },
): Promise<{ granted: string[]; skipped: boolean }> {
  const existing = await opts.readMcpConsent();
  if (existing !== undefined) {
    return { granted: [], skipped: true }; // already migrated (or user-managed)
  }
  const granted: string[] = [];
  const entries: McpConsentEntry[] = [];
  const legacyRoot = pluginsRoot(opts.home);
  if (await opts.fs.exists(legacyRoot)) {
    for (const dir of await opts.fs.readdir(legacyRoot)) {
      if (dir.startsWith(".")) continue;
      const manifestPath = join(legacyRoot, dir, ".anycode-plugin/plugin.json");
      if (!(await opts.fs.exists(manifestPath))) continue;
      try {
        const parsed = pluginManifestSchema.safeParse(JSON.parse(await opts.fs.readFile(manifestPath)));
        if (!parsed.success || !parsed.data.mcpServers || Object.keys(parsed.data.mcpServers).length === 0) continue;
        entries.push({
          plugin: parsed.data.name,
          serversHash: serversHash(parsed.data.mcpServers),
          grantedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
        });
        granted.push(parsed.data.name);
      } catch {
        // fail-soft per plugin
      }
    }
  }
  // Always write — even an empty list — so the migration is marked done. An
  // absent mcpConsent would re-run the grandfathering on every boot and grant
  // consent to any legacy dir hand-dropped later (a consent bypass).
  await opts.writeMcpConsent(entries);
  return { granted, skipped: false };
}

// ── default archive fetch (production) ──

/**
 * Taskana 4732 xfix M2: the artifact download is BOUNDED while streaming.
 * The old implementation buffered the entire response (`arrayBuffer()`)
 * before any size check — a malicious URL could push gigabytes into main
 * memory (the 20 MB compressed cap only ran after the full download). Now:
 *  - `content-length` (when present) over the cap refuses immediately;
 *  - the body is read in chunks with a hard cumulative byte cap.
 */
export function createArchiveFetch(fetchImpl: typeof fetch = fetch): PluginArchiveFetch {
  return async (url): Promise<ArchiveFetchResult> => {
    if (!/^https:\/\//i.test(url)) {
      return { ok: false, reason: "forbidden_redirect" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, reason: "forbidden_redirect" };
      }
      if (!response.ok) {
        return { ok: false, reason: "network" };
      }
      // Redirect custody: verify the FINAL url host against the allowlist
      // when the implementation reports one (undici does via response.url).
      const finalUrl = (response as Response & { url?: string }).url ?? url;
      const host = safeHost(finalUrl);
      if (host !== undefined && !OFFICIAL_ARTIFACT_REDIRECT_HOSTS.includes(host)) {
        return { ok: false, reason: "forbidden_redirect" };
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES) {
        return { ok: false, reason: "too_large" };
      }
      const bytes = await readCapped(response);
      return bytes;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false, reason: "network" };
      }
      return { ok: false, reason: "network" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Streams a response body into a Buffer, refusing over the compressed cap. */
async function readCapped(response: Response): Promise<ArchiveFetchResult> {
  if (response.body === null) {
    // No stream surface (odd transports, tests): fall back to arrayBuffer,
    // still bounded by the post-hoc length check below.
    const buffered = Buffer.from(await response.arrayBuffer());
    return buffered.length > PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES
      ? { ok: false, reason: "too_large" }
      : { ok: true, bytes: buffered };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.byteLength;
      if (total > PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

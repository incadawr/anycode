/**
 * Network control-plane IPC (TASK.141 §6): the handler behind
 * `PROXY_CHECK_CHANNEL`, which answers "does this profile actually carry traffic
 * to this target?" by materialising the profile and SPAWNING one probe child
 * (main/proxy-probe.ts).
 *
 * Every dependency is injected — settings reader, boot env, the system-proxy
 * cache, the vault read, the env composer, the spawner — for the reason the rest
 * of main's IPC modules give: the handler logic is a plain async function over a
 * deps bag, so the whole decision tree (including the branches that must NOT
 * spawn) is unit-testable without Electron, without a vault and without a
 * network.
 *
 * ── The honesty rules this handler exists to enforce (design review B-11) ──
 *
 * A probe that only reported "did the request succeed?" would go green in three
 * situations where the proxy was never touched, and each of them is a way for a
 * user to believe a broken profile works:
 *  1. the target matched the profile's own exemption list (`bypassed_by_no_proxy`);
 *  2. the profile resolved to no proxy at all — a `system` profile the OS
 *     answered DIRECT for, or a value too broken to honour (`direct`);
 *  3. the OS answer was SOCKS, which the env model cannot express
 *     (`socks_unsupported`).
 * In all three the handler returns `proxyUsed: false` and does not spawn at all:
 * there is no proxy to probe, and a request that proves the TARGET is up would
 * be answering a question nobody asked.
 *
 * The fourth case does spawn but is equally not about the profile: when the boot
 * env owns the proxy family, the child goes out through the SHELL's proxy no
 * matter what the profile says (TASK.132's law, gated in main/host-env.ts). The
 * result then carries `shellOverride: true` and `proxyUsed: false`, and the
 * detail says so in words.
 */

import { ipcMain } from "electron";
import { LOOPBACK_NO_PROXY } from "../shared/engines.js";
import {
  PROXY_CHECK_CHANNEL,
  composeProxyUrl,
  findProxyProfile,
  isProxyProfileUrl,
  maskProxyUrl,
  type MaterializedProxy,
  type ProxyCheckRequest,
  type ProxyCheckResult,
  type ProxyCheckVerdict,
  type ProxyProfile,
  type SystemProxyResolver,
} from "../shared/proxy.js";
import type { AnycodeSettings } from "../shared/settings.js";
import { maskProxyCredentials, runProxyProbe, type ProxyProbeSpawner } from "./proxy-probe.js";

/**
 * The target probed when nothing else names one: no explicit target, no active
 * connection, or an active connection with no `baseUrl` of its own (a catalog
 * provider's endpoint lives in the catalog, which main does not read here).
 * Anthropic's API answers 401 to an unauthenticated request, which is exactly
 * what the probe wants — proof the round trip completed, with no credential.
 */
export const DEFAULT_PROXY_CHECK_TARGET = "https://api.anthropic.com/";

/**
 * The four variables that make the shell the owner of the proxy family.
 *
 * Duplicated from main/host-env.ts rather than imported: that module is not a
 * dependency of this one in either direction, and a four-string list is cheaper
 * to repeat than to couple to. The GATE itself stays injectable
 * (`shellOwnsProxyFamily`) so the wiring can hand over the same predicate the
 * env builder actually uses, and this local copy is only the default.
 */
const PROXY_FAMILY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

/** Mirrors host-env's `envPresent`: defined and not blank. */
function envPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

/** Default shell-wins gate: any of the four proxy variables present in the boot env. */
export function bootEnvOwnsProxyFamily(bootEnv: NodeJS.ProcessEnv): boolean {
  return PROXY_FAMILY_KEYS.some((name) => envPresent(bootEnv, name));
}

// ── NO_PROXY matching ──

/** Default ports, so `NO_PROXY=host:443` matches `https://host/` (which has no explicit port). */
const SCHEME_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** Strips IPv6 brackets so `[::1]` in a list matches the `::1` a URL reports. */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * True when `targetUrl` is exempt from proxying by a `NO_PROXY`-syntax list.
 *
 * Implements the semantics undici and curl actually use, which is why the UI
 * hint must show suffixes and not JetBrains globs (`192.168.*` matches nothing
 * here, deliberately — pretending otherwise would be a promise the child breaks):
 *  - entries are separated by commas or whitespace;
 *  - `*` alone exempts everything;
 *  - a leading dot is optional — `corp.internal` and `.corp.internal` both match
 *    `api.corp.internal`, and both match the bare `corp.internal`;
 *  - an entry may pin a port (`host:8080`), and then the target's port — explicit
 *    or the scheme default — has to match;
 *  - matching is case-insensitive, and IPv6 literals match bracketed or not.
 */
export function noProxyMatchesTarget(list: string, targetUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  const host = unbracket(url.hostname).toLowerCase();
  const port = url.port === "" ? (SCHEME_PORTS[url.protocol] ?? "") : url.port;
  for (const rawEntry of list.split(/[,\s]+/)) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry === "") {
      continue;
    }
    if (entry === "*") {
      return true;
    }
    const split = splitEntryPort(entry);
    if (split.port !== undefined && split.port !== port) {
      continue;
    }
    const pattern = unbracket(split.host.startsWith(".") ? split.host.slice(1) : split.host);
    if (pattern === "") {
      continue;
    }
    if (host === pattern || host.endsWith(`.${pattern}`)) {
      return true;
    }
  }
  return false;
}

/** Splits a NO_PROXY entry's optional `:port`, honouring bracketed IPv6 literals. */
function splitEntryPort(entry: string): { host: string; port?: string } {
  const closing = entry.lastIndexOf("]");
  const colon = entry.lastIndexOf(":");
  if (colon === -1 || colon < closing) {
    return { host: entry };
  }
  // A BARE IPv6 literal (`::1`, `fe80::1`) has several colons and no brackets,
  // and its last colon belongs to the address. `LOOPBACK_NO_PROXY` ships both
  // spellings (`[::1]` and `::1`), so getting this wrong would parse the bare
  // one as host `::` on port `1` and stop exempting a loopback endpoint.
  if (!entry.startsWith("[") && entry.indexOf(":") !== colon) {
    return { host: entry };
  }
  const port = entry.slice(colon + 1);
  return /^\d+$/.test(port) ? { host: entry.slice(0, colon), port } : { host: entry };
}

/** The exemption list a child would actually receive: the mandatory loopback default plus the profile's own entries. */
export function effectiveNoProxy(profileNoProxy: string | undefined): string {
  const extra = profileNoProxy?.trim() ?? "";
  return extra === "" ? LOOPBACK_NO_PROXY : `${LOOPBACK_NO_PROXY},${extra}`;
}

// ── deps ──

export interface NetworkIpcDeps {
  /** The live settings document, or null before boot finished loading it. */
  readSettings: () => AnycodeSettings | null;
  /** The env this process was started with — the shell-wins gate reads it. */
  bootEnv: NodeJS.ProcessEnv;
  /** `process.execPath`. The probe adds `ELECTRON_RUN_AS_NODE=1` itself. */
  execPath: string;
  /** The target-keyed system-proxy cache (main/system-proxy.ts). A Check takes the ASYNC path — a fresh answer, not the cache. */
  systemProxy: SystemProxyResolver;
  /** Reads a profile's plaintext password from the vault. Never returned to the renderer; used to compose the userinfo and to redact it back out of every text. */
  readPassword: (profileId: string) => Promise<string | undefined>;
  /**
   * Composes the FULL env for the probe child from a materialised proxy —
   * wired to the same code path a real spawn takes (boot env + host-env's
   * `applyConnectionProxy`), so the probe cannot drift into testing an env
   * nothing else builds. Injected rather than imported so the tests can assert
   * exactly what the handler passes down.
   */
  composeProbeEnv: (proxy: MaterializedProxy | undefined) => NodeJS.ProcessEnv;
  /** Runs the probe child. */
  spawn: ProxyProbeSpawner;
  /** Overrides the shell-wins gate; defaults to the four-variable check over `bootEnv`. */
  shellOwnsProxyFamily?: (bootEnv: NodeJS.ProcessEnv) => boolean;
  timeoutMs?: number;
}

/** The named caveat that rides every verdict taken while the shell owns the family. */
export const SHELL_OVERRIDE_NOTE = "a shell-exported proxy overrides every profile";

// ── request validation ──

/**
 * Validates the renderer payload at this trust boundary. Hand-rolled rather than
 * zod because the shape is three fields and importing a schema module here would
 * buy nothing; the rules are the frozen `ProxyCheckRequest`.
 */
export function parseProxyCheckRequest(raw: unknown): ProxyCheckRequest | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as { profileId?: unknown; target?: unknown };
  if (typeof candidate.profileId !== "string" || candidate.profileId.trim() === "") {
    return undefined;
  }
  const profileId = candidate.profileId;
  if (candidate.target === undefined) {
    return { profileId };
  }
  if (typeof candidate.target !== "object" || candidate.target === null) {
    return undefined;
  }
  const target = candidate.target as { kind?: unknown; connectionId?: unknown; url?: unknown };
  if (target.kind === "connection" && typeof target.connectionId === "string" && target.connectionId !== "") {
    return { profileId, target: { kind: "connection", connectionId: target.connectionId } };
  }
  if (target.kind === "url" && typeof target.url === "string" && target.url !== "") {
    return { profileId, target: { kind: "url", url: target.url } };
  }
  return undefined;
}

/** True for a target we are willing to probe: an absolute http(s) URL with a host. */
function isProbeTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Resolves which URL the probe hits (TASK.141 §6 as reshaped by review B-11):
 * the request's explicit target, else the named connection's `baseUrl`, else the
 * ACTIVE connection's, else the default endpoint.
 *
 * A connection with no `baseUrl` of its own falls through to the default rather
 * than failing: it is a catalog provider, whose endpoint main does not resolve
 * here, and refusing to check the profile because of that would be a worse
 * answer than checking it against a reachable host. `targetUrl` comes back in
 * the result either way, so the UI never has to guess which host was probed.
 */
export function resolveProbeTarget(
  settings: AnycodeSettings,
  request: ProxyCheckRequest,
  fallback: string = DEFAULT_PROXY_CHECK_TARGET,
): { ok: true; targetUrl: string } | { ok: false; reason: "invalid" | "not_found" } {
  if (request.target?.kind === "url") {
    return isProbeTarget(request.target.url)
      ? { ok: true, targetUrl: request.target.url }
      : { ok: false, reason: "invalid" };
  }
  const connections = settings.provider.connections;
  if (request.target?.kind === "connection") {
    const connectionId = request.target.connectionId;
    const named = connections.find((connection) => connection.id === connectionId);
    if (named === undefined) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: true, targetUrl: usableBaseUrl(named.baseUrl) ?? fallback };
  }
  const activeId = settings.provider.activeConnectionId;
  const active = activeId === undefined ? undefined : connections.find((connection) => connection.id === activeId);
  return { ok: true, targetUrl: usableBaseUrl(active?.baseUrl) ?? fallback };
}

function usableBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl !== undefined && isProbeTarget(baseUrl) ? baseUrl : undefined;
}

// ── the handler ──

/** A verdict reached without spawning anything: no proxy was in play to probe. */
function noProxyVerdict(
  verdict: ProxyCheckVerdict,
  targetUrl: string,
  shellOverride: boolean,
  detail: string,
): ProxyCheckResult {
  return { ok: true, verdict, targetUrl, proxyUsed: false, shellOverride, detail: withShellNote(detail, shellOverride) };
}

function withShellNote(detail: string, shellOverride: boolean): string {
  return shellOverride ? `${SHELL_OVERRIDE_NOTE}; ${detail}` : detail;
}

/**
 * Resolves the proxy URL a profile would put in the child env for ONE target, or
 * a no-proxy verdict when it would put none.
 *
 * The `system` branch takes the RESOLVER's async path on purpose: a Check is a
 * user asking a question right now, and answering it from a cache that may
 * predate the network change they are checking for would defeat the button. It
 * also warms the cache the synchronous consumers read, so the answer the user
 * just saw is the answer the next spawn uses.
 */
async function proxyBaseFor(
  deps: NetworkIpcDeps,
  profile: ProxyProfile,
  targetUrl: string,
): Promise<{ base: string } | { verdict: ProxyCheckVerdict; detail: string }> {
  if (profile.mode === "system") {
    const outcome = await deps.systemProxy.resolve(targetUrl);
    switch (outcome.kind) {
      case "proxy":
        return { base: outcome.url };
      case "socks_unsupported":
        return {
          verdict: "socks_unsupported",
          detail: "the system proxy for this target is SOCKS, which an env-based proxy cannot express",
        };
      case "direct":
        return { verdict: "direct", detail: "the system has no proxy for this target" };
      case "unresolved":
        return { verdict: "direct", detail: "the system proxy for this target has not been resolved yet" };
    }
  }
  const url = profile.url;
  if (url === undefined || url.trim() === "" || !isProxyProfileUrl(url)) {
    return { verdict: "direct", detail: "this profile has no usable proxy URL, so it carries no traffic" };
  }
  return { base: url };
}

/**
 * Handles one `proxy-check` request. At most ONE child is spawned, and only
 * after every reason NOT to spawn has been ruled out.
 */
export async function handleProxyCheck(deps: NetworkIpcDeps, raw: unknown): Promise<ProxyCheckResult> {
  const request = parseProxyCheckRequest(raw);
  if (request === undefined) {
    return { ok: false, reason: "invalid" };
  }
  const settings = deps.readSettings();
  if (settings === null) {
    // Boot has not loaded the registry yet, so no profile id can be resolved —
    // "not found" is the literal truth, and inventing a network verdict for a
    // profile nobody can read would be worse.
    return { ok: false, reason: "not_found" };
  }
  const profile = findProxyProfile(settings, request.profileId);
  if (profile === undefined) {
    return { ok: false, reason: "not_found" };
  }
  const target = resolveProbeTarget(settings, request);
  if (!target.ok) {
    return { ok: false, reason: target.reason };
  }
  const targetUrl = target.targetUrl;
  const shellOverride = (deps.shellOwnsProxyFamily ?? bootEnvOwnsProxyFamily)(deps.bootEnv);

  const base = await proxyBaseFor(deps, profile, targetUrl);
  if (!("base" in base)) {
    return noProxyVerdict(base.verdict, targetUrl, shellOverride, base.detail);
  }
  if (noProxyMatchesTarget(effectiveNoProxy(profile.noProxy), targetUrl)) {
    return noProxyVerdict(
      "bypassed_by_no_proxy",
      targetUrl,
      shellOverride,
      "this target matches the profile's exemption list, so it never reaches the proxy",
    );
  }
  const password = await deps.readPassword(profile.id);
  const url = composeProxyUrl(base.base, profile.login, password);
  if (url === undefined) {
    return noProxyVerdict(
      "direct",
      targetUrl,
      shellOverride,
      "this profile's proxy URL could not be composed, so it carries no traffic",
    );
  }
  const materialized: MaterializedProxy =
    profile.noProxy !== undefined && profile.noProxy.trim() !== ""
      ? { url, noProxy: profile.noProxy }
      : { url };
  const secrets = password === undefined || password === "" ? [] : [password];
  const outcome = await runProxyProbe(deps.spawn, {
    targetUrl,
    env: deps.composeProbeEnv(materialized),
    execPath: deps.execPath,
    // When the shell owns the family the child goes out through the SHELL's
    // proxy and this profile was never in play — the verdict describes the
    // shell's network path, not the profile's, and must not claim otherwise.
    proxyUsed: !shellOverride,
    timeoutMs: deps.timeoutMs,
    secrets,
  });
  const via = maskProxyCredentials(maskProxyUrl(url), secrets);
  const detail = shellOverride
    ? `${SHELL_OVERRIDE_NOTE}; the profile (${via}) was not exercised: ${outcome.detail}`
    : `via ${via}: ${outcome.detail}`;
  return {
    ok: true,
    verdict: outcome.verdict,
    targetUrl,
    proxyUsed: !shellOverride,
    shellOverride,
    detail,
  };
}

/** Registers the network channels on ipcMain. Mirrors main/mcp-config-ipc.ts's split: logic above, wiring here. */
export function registerNetworkIpc(deps: NetworkIpcDeps): void {
  ipcMain.handle(PROXY_CHECK_CHANNEL, (_event, raw: unknown) => handleProxyCheck(deps, raw));
}

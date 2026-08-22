/**
 * System-proxy resolution (TASK.141 §4): what the OS — or the PAC script the OS
 * points at — would do for ONE target URL, flattened into the single proxy URL
 * an env-based model can express.
 *
 * Children cannot execute a PAC in any form and cannot read macOS network
 * preferences, so only main can answer this question, and the only thing in main
 * that already knows how is Chromium: `session.defaultSession.resolveProxy(url)`
 * runs the same resolution stack the browser engine uses, PAC included
 * (`Session.resolveProxy`, verified at
 * `apps/desktop/node_modules/electron/electron.d.ts:13152` — NOT `:1578`, which
 * is `App.resolveProxy`, a different stack; design review L-01).
 *
 * Electron is INJECTED (`SystemProxyResolverDeps.resolveProxy`) rather than
 * imported: this module has to be unit-testable in a plain node vitest
 * environment, and the parser — the part that carries the real risk — has to be
 * exercised over hand-written candidate lists no live OS would produce on
 * demand.
 *
 * ── Named limitations (each one a fact about the env model, not a TODO) ──
 *
 * 1. THE CANDIDATE FALLBACK CHAIN IS LOST (design review M-01). Chromium answers
 *    with a LIST — `PROXY p1:3128; PROXY p2:3128; DIRECT` — and walks it: if p1
 *    refuses the connection it tries p2, then goes direct. An env variable holds
 *    exactly one value, so a child gets the first supported candidate and
 *    NOTHING else; when that candidate is down, the child loses the network
 *    where Chromium itself would have recovered. This is a real behavioural
 *    difference from "the system proxy", and the editor hint has to say so
 *    rather than call the two equivalent.
 * 2. ONE ANSWER PER TARGET, ONE TARGET PER SPAWN. A PAC that routes different
 *    hosts through different proxies cannot be expressed in `HTTPS_PROXY` — the
 *    child gets one proxy for all of its traffic. The cache is keyed by target
 *    so that different call sites at least get the answer for THEIR target
 *    (design review B-10), but within one child the flattening stands.
 * 3. A LIVE CHILD NEVER SEES A NETWORK CHANGE. The env is composed at spawn
 *    time; refreshing the cache moves the NEXT spawn, never a running one — the
 *    same parity TASK.139 fixed for "a live session does not migrate".
 * 4. SOCKS IS NOT SILENCE. A SOCKS-only answer is reported as
 *    `socks_unsupported`, not as `direct`: the OS DOES have a proxy configured,
 *    we cannot express it in the env model (undici's env proxying is HTTP(S)
 *    only), and quietly sending corporate traffic straight out would be the
 *    worst of the three possible answers.
 */

import type { SystemProxyOutcome, SystemProxyResolver } from "../shared/proxy.js";

// ── candidate parsing (pure) ──

/**
 * One entry of a Chromium proxy list. `unknown` is kept rather than dropped so
 * the parser's output can prove "we saw something we did not understand", which
 * is what separates a malformed answer (`unresolved`) from an empty one.
 */
export interface ProxyCandidate {
  kind: "direct" | "proxy" | "https" | "socks" | "unknown";
  /** Host of a `proxy`/`https`/`socks` candidate. */
  host?: string;
  /** Port of a `proxy`/`https`/`socks` candidate; defaulted by scheme when the entry omits it. */
  port?: number;
  /** The entry exactly as Chromium wrote it, for diagnostics. */
  raw: string;
}

/** Default ports for a candidate whose entry omits one (Chromium always emits one; PAC scripts do not have to). */
const DEFAULT_PORTS: Record<string, number> = { PROXY: 80, HTTPS: 443, SOCKS: 1080, SOCKS4: 1080, SOCKS5: 1080 };

/**
 * Splits a Chromium/PAC proxy list into candidates.
 *
 * The wire format is the PAC `FindProxyForURL` return value: entries separated
 * by `;`, each entry a keyword optionally followed by `host:port`. Keywords are
 * compared case-insensitively — Chromium emits upper case, but the string can
 * also come straight out of a hand-written PAC script that does not.
 *
 * IPv6 literals arrive bracketed (`PROXY [::1]:3128`), so the host/port split
 * happens at the LAST colon and only outside brackets; splitting at the first
 * colon would turn `[::1]:3128` into host `[` and a garbage port.
 */
export function parseProxyCandidates(list: string): ProxyCandidate[] {
  const out: ProxyCandidate[] = [];
  for (const rawEntry of list.split(";")) {
    const raw = rawEntry.trim();
    if (raw === "") {
      continue;
    }
    const match = /^([A-Za-z0-9]+)(?:\s+(\S+))?$/.exec(raw);
    if (match === null) {
      out.push({ kind: "unknown", raw });
      continue;
    }
    const keyword = (match[1] ?? "").toUpperCase();
    const endpoint = match[2];
    if (keyword === "DIRECT") {
      // A `DIRECT host:port` entry is nonsense; treat the keyword as decisive
      // and ignore the trailing junk rather than failing the whole list.
      out.push({ kind: "direct", raw });
      continue;
    }
    const kind = keyword === "PROXY" ? "proxy" : keyword === "HTTPS" ? "https" : keyword.startsWith("SOCKS") ? "socks" : undefined;
    if (kind === undefined || endpoint === undefined) {
      out.push({ kind: "unknown", raw });
      continue;
    }
    const endpointParts = splitHostPort(endpoint);
    if (endpointParts === undefined) {
      out.push({ kind: "unknown", raw });
      continue;
    }
    const port = endpointParts.port ?? DEFAULT_PORTS[keyword] ?? 0;
    if (endpointParts.host === "" || !Number.isInteger(port) || port <= 0 || port > 65535) {
      out.push({ kind: "unknown", raw });
      continue;
    }
    out.push({ kind, host: endpointParts.host, port, raw });
  }
  return out;
}

/** Splits `host:port` / `[v6]:port` / `host`; undefined when the port half is present but not a number. */
function splitHostPort(endpoint: string): { host: string; port?: number } | undefined {
  const closing = endpoint.lastIndexOf("]");
  const colon = endpoint.lastIndexOf(":");
  if (colon === -1 || colon < closing) {
    return { host: endpoint };
  }
  // A bare IPv6 literal keeps its last colon: `::1` is an address, not host
  // `::` on port `1`. Chromium brackets its own output, but a hand-written PAC
  // script is under no such obligation.
  if (!endpoint.startsWith("[") && endpoint.indexOf(":") !== colon) {
    return { host: endpoint };
  }
  const host = endpoint.slice(0, colon);
  const portText = endpoint.slice(colon + 1);
  if (!/^\d+$/.test(portText)) {
    return undefined;
  }
  return { host, port: Number(portText) };
}

/**
 * Flattens a Chromium proxy list into the one outcome an env can carry.
 *
 * The rules, in the order they are applied:
 *  - SOCKS candidates are SKIPPED, because the env model cannot express them;
 *  - the first remaining candidate decides — `DIRECT` means direct even when a
 *    `PROXY` follows it, because the list is ordered by what the system would
 *    actually TRY first, and promoting a fallback proxy over a leading DIRECT
 *    would route traffic through a proxy the system was not going to use;
 *  - if nothing but SOCKS candidates were understood, the answer is
 *    `socks_unsupported` — the OS has a proxy, we cannot honour it, and the user
 *    is entitled to be told (`SOCKS5 h:1; DIRECT` is therefore `direct`: the OS
 *    itself named a usable fallback, so there is nothing to refuse);
 *  - anything else — an empty string, whitespace, or a list we understood none
 *    of — is `unresolved`: "nobody has a usable answer for this target yet",
 *    which every consumer materialises as direct but which stays worth retrying.
 */
export function systemProxyOutcomeFor(list: string): SystemProxyOutcome {
  const candidates = parseProxyCandidates(list);
  let sawSocks = false;
  for (const candidate of candidates) {
    if (candidate.kind === "socks") {
      sawSocks = true;
      continue;
    }
    if (candidate.kind === "direct") {
      return { kind: "direct" };
    }
    if (candidate.kind === "proxy" || candidate.kind === "https") {
      const scheme = candidate.kind === "https" ? "https" : "http";
      return { kind: "proxy", url: `${scheme}://${candidate.host}:${String(candidate.port)}` };
    }
  }
  return sawSocks ? { kind: "socks_unsupported" } : { kind: "unresolved" };
}

// ── the target-keyed cache ──

/**
 * The cache key for a target URL: its ORIGIN (`scheme://host:port`).
 *
 * Keying on the full URL would give every request path its own cache slot and
 * every one of them a cold first read; keying on the origin collapses
 * `https://api.anthropic.com/v1/models` and `https://api.anthropic.com/` onto
 * one entry, which is the granularity the env model can act on anyway — a child
 * gets ONE proxy for a host, never a per-path one. Returns undefined for a
 * string that is not a URL; such a target is never asked about.
 */
export function systemProxyCacheKey(targetUrl: string): string | undefined {
  try {
    const url = new URL(targetUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export interface SystemProxyResolverDeps {
  /**
   * `session.defaultSession.resolveProxy` — injected so the tests never load
   * Electron. Resolves to a PAC-shaped candidate list; a rejection means "could
   * not ask", which is NOT the same as "no proxy" (see `resolve`).
   */
  resolveProxy: (targetUrl: string) => Promise<string>;
  /** Reports a rejected resolve. Optional; a swallowed failure is a stale cache, not a crash. */
  onError?: (targetUrl: string, error: unknown) => void;
  /**
   * Upper bound on tracked targets (default 32). The set grows from whatever
   * consumers ask about — pinned connections, engine targets, the probe — and a
   * bound keeps a pathological caller from turning it into a leak. Eviction is
   * oldest-first.
   */
  maxTargets?: number;
}

/**
 * The cache the whole app reads system-proxy answers through. Extends the frozen
 * `SystemProxyResolver` seam with the refresh surface `main/index.ts` drives.
 */
export interface SystemProxyCache extends SystemProxyResolver {
  /** Registers a target so the next `refreshAll` covers it, without resolving now. */
  track(targetUrl: string): void;
  /** Re-resolves every tracked target. Never rejects: one failed target must not abort the sweep. */
  refreshAll(): Promise<void>;
  /** The tracked targets, in insertion order — diagnostics and tests. */
  targets(): readonly string[];
}

/**
 * Builds the resolver/cache.
 *
 * ── What the cache assumes about refresh timing ──
 *
 * `cached` is allowed to be STALE and is allowed to be EMPTY, and both are
 * correct answers rather than bugs to work around:
 *
 *  - EMPTY: the first synchronous read of a target nobody has resolved yet
 *    returns `{kind:"unresolved"}`, which materialises DIRECT. Before
 *    `app.whenReady` there is no session to ask at all, so this is not
 *    avoidable; inventing a proxy would be strictly worse than not using one.
 *    That first read TRACKS the target, so the next refresh fills it and the
 *    NEXT spawn is right. A `system` profile can therefore send its very first
 *    child direct — an accepted, named window, not a promise of immediacy.
 *  - STALE: the answer is refreshed at three moments, and between any two of
 *    them a network change is invisible: (1) at boot after `app.whenReady`;
 *    (2) on every settings mutation, through `refreshProviderState`; (3)
 *    fire-and-forget after each fork spawn, so that a network change seen by
 *    THIS spawn's resolve is already cached for the next one. Nothing polls,
 *    because a poll would still be a window — just a shorter one — and would
 *    burn a resolve per interval forever.
 *
 * A rejected resolve does NOT clear a previously good answer. "Could not ask
 * Chromium" is ignorance, not a DIRECT answer, and downgrading a working
 * corporate proxy to direct on a transient failure is exactly the class of
 * silent leak the rest of this slice refuses.
 */
export function createSystemProxyResolver(deps: SystemProxyResolverDeps): SystemProxyCache {
  const answers = new Map<string, SystemProxyOutcome>();
  /** Insertion-ordered set of tracked keys; a Map key set is already ordered. */
  const inFlight = new Map<string, Promise<SystemProxyOutcome>>();
  const maxTargets = deps.maxTargets ?? 32;

  function remember(key: string): void {
    if (answers.has(key)) {
      return;
    }
    answers.set(key, { kind: "unresolved" });
    while (answers.size > maxTargets) {
      const oldest = answers.keys().next();
      if (oldest.done === true) {
        break;
      }
      answers.delete(oldest.value);
    }
  }

  function cached(targetUrl: string): SystemProxyOutcome {
    const key = systemProxyCacheKey(targetUrl);
    if (key === undefined) {
      return { kind: "unresolved" };
    }
    const known = answers.get(key);
    if (known === undefined) {
      // A sync consumer asking about a target nobody resolved teaches the cache
      // that this target matters, so the next refresh covers it.
      remember(key);
      return { kind: "unresolved" };
    }
    return known;
  }

  async function resolve(targetUrl: string): Promise<SystemProxyOutcome> {
    const key = systemProxyCacheKey(targetUrl);
    if (key === undefined) {
      return { kind: "unresolved" };
    }
    const running = inFlight.get(key);
    if (running !== undefined) {
      // Two forks composed for the same target in the same tick share one
      // Chromium round trip instead of racing to overwrite the same slot.
      return running;
    }
    const attempt = (async (): Promise<SystemProxyOutcome> => {
      try {
        // Chromium is asked about the ORIGIN, matching the cache key: the answer
        // is stored per origin, so asking per path would make the stored answer
        // and the question disagree.
        const list = await deps.resolveProxy(key);
        const outcome = systemProxyOutcomeFor(list);
        answers.set(key, outcome);
        return outcome;
      } catch (error) {
        deps.onError?.(targetUrl, error);
        remember(key);
        return answers.get(key) ?? { kind: "unresolved" };
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, attempt);
    return attempt;
  }

  return {
    cached,
    resolve,
    track(targetUrl: string): void {
      const key = systemProxyCacheKey(targetUrl);
      if (key !== undefined) {
        remember(key);
      }
    },
    async refreshAll(): Promise<void> {
      await Promise.all([...answers.keys()].map((key) => resolve(key)));
    },
    targets(): readonly string[] {
      return [...answers.keys()];
    },
  };
}

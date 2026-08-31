/**
 * Codex version-support POLICY (codex-profiles cut §7.1, TASK.53): which
 * versions AnyCode calls "supported", sourced from the git-hosted
 * `codex-support.json` manifest (raw URL, OG-3: public repo) with the
 * compiled-in `BUNDLED_CODEX_MANIFEST` as the fail-closed fallback.
 *
 * The manifest is policy and ONLY policy: it never carries a URL, a
 * checksum, or a package name (those are compile-time constants in
 * shared/codex-support.ts), so a forged manifest cannot redirect a download
 * or execute code — its worst case is lying about which VERSIONS are
 * supported. Two independent layers cap even that:
 *  1. validation rejects any manifest whose declared `minimum` is below
 *     `CODEX_MIN_FLOOR` (or that is structurally garbage) — fallback: bundled;
 *  2. the verdict itself rejects any version below the floor regardless of
 *     what ranges the manifest claims OR what the user risk-accepted.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUNDLED_CODEX_MANIFEST, CODEX_MIN_FLOOR, type CodexSupportManifest } from "../shared/codex-support.js";
import {
  compareCodexVersions,
  judgeCodexVersion,
  parseCodexRange,
  parseCodexSemver,
  supportedRangeText,
  type CodexSupportPolicy,
  type CodexVersionVerdict,
} from "../shared/codex-version-policy.js";

/**
 * Raw-URL of the policy manifest in the public AnyCode repository (OG-3
 * resolved: repo is public, no token needed). Editing that file in git
 * changes supported-version policy WITHOUT an AnyCode release.
 */
export const CODEX_MANIFEST_URL = "https://raw.githubusercontent.com/incadawr/anycode/master/codex-support.json";

/** Refresh throttle (cut §7.1: "не чаще 1 раза в 6 ч и по кнопке"). */
export const CODEX_MANIFEST_REFRESH_INTERVAL_MS = 6 * 3600_000;

/** Network-manifest body cap: policy documents are tiny; anything bigger is refused as garbage. */
export const CODEX_MANIFEST_MAX_BYTES = 256 * 1024;

/** Bounded fetch: a hung raw-URL must never hold a refresh open indefinitely. */
export const CODEX_MANIFEST_FETCH_TIMEOUT_MS = 10_000;

// ── semver + range evaluation ──
//
// TASK.206: the comparator grammar, the range evaluator and the verdict itself
// moved to shared/codex-version-policy.ts so the HOST — which is the process
// that actually decides whether a Codex child starts, and may never import
// from main/** — judges by the SAME code as this file's Settings/Doctor/
// installer callers. Everything below is the manifest-shaped facade over that
// core; `parseCodexSemver` is re-exported because codex-install.ts imports it
// from here.

export { parseCodexSemver };

// ── manifest validation (layer 1 of the fail-closed pair) ──

/**
 * Returns the manifest if it is structurally sound AND cannot lower policy
 * below the compile-time floor; null otherwise. Unknown extra fields are
 * tolerated (dropped by projection), unknown syntax is not.
 */
export function validateCodexManifest(raw: unknown): CodexSupportManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  if (source.schemaVersion !== "anycode.codex-support.v1") return null;
  if (typeof source.updatedAt !== "string") return null;
  if (!Array.isArray(source.supported) || source.supported.length === 0) return null;
  const supported: CodexSupportManifest["supported"] = [];
  for (const entry of source.supported) {
    if (typeof entry !== "object" || entry === null) return null;
    const { range, status, note } = entry as { range?: unknown; status?: unknown; note?: unknown };
    if (typeof range !== "string" || parseCodexRange(range) === null) return null;
    if (typeof status !== "string") return null;
    supported.push({ range, status, ...(typeof note === "string" ? { note } : {}) });
  }
  if (typeof source.recommended !== "string" || parseCodexSemver(source.recommended) === null) return null;
  if (typeof source.minimum !== "string") return null;
  const minimum = parseCodexSemver(source.minimum);
  const floor = parseCodexSemver(CODEX_MIN_FLOOR);
  if (minimum === null || floor === null) return null;
  // Downgrade attack: a manifest may NARROW the range, never declare support
  // below the compiled floor (cut §7.1).
  if (compareCodexVersions(minimum, floor) < 0) return null;
  return {
    schemaVersion: "anycode.codex-support.v1",
    updatedAt: source.updatedAt,
    supported,
    recommended: source.recommended,
    minimum: source.minimum,
  };
}

/** The manifest actually used for verdicts: the validated input, or BUNDLED on ANY failure. */
export function effectiveCodexManifest(raw: unknown): CodexSupportManifest {
  return validateCodexManifest(raw) ?? BUNDLED_CODEX_MANIFEST;
}

/** Display form of the manifest's supported set — what `CodexDoctorReport.supportedRange` carries so the renderer never hardcodes a range string. */
export function manifestSupportedRange(manifest: CodexSupportManifest): string {
  return supportedRangeText(manifestRanges(manifest));
}

/** The manifest reduced to the ranges a verdict consults, in manifest order. */
function manifestRanges(manifest: CodexSupportManifest): string[] {
  return manifest.supported.map((entry) => entry.range);
}

// ── verdict (layer 2: the floor holds here on its own) ──

export interface CodexVersionPolicy {
  manifest: CodexSupportManifest;
  /** `settings.codex.riskAcceptedVersions` — per-version explicit consent (cut §7.4). */
  riskAcceptedVersions: readonly string[];
}

export type { CodexVersionVerdict };

/**
 * The manifest-shaped policy flattened to the shape a verdict — and the host
 * carrier — actually consume (TASK.206). One projection, used by
 * `codexVersionVerdict` below and by main/index.ts's `engineEnv` overlay, so
 * the screen and the host can never be judging different range sets.
 */
export function codexSupportPolicyFor(policy: CodexVersionPolicy): CodexSupportPolicy {
  return { ranges: manifestRanges(policy.manifest), riskAcceptedVersions: policy.riskAcceptedVersions };
}

/**
 * Judges one version string against the policy — see `judgeCodexVersion`
 * (shared/codex-version-policy.ts) for the ordering rules, including the
 * compiled `CODEX_MIN_FLOOR` that no manifest and no risk acceptance can
 * override.
 */
export function codexVersionVerdict(version: string, policy: CodexVersionPolicy): CodexVersionVerdict {
  return judgeCodexVersion(version, codexSupportPolicyFor(policy));
}

// ── active policy (module seam) ──
//
// main/index.ts owns the wiring: at boot it loads `riskAcceptedVersions` from
// settings and kicks an advisory manifest refresh; codex-install.ts updates
// the risk list after an explicit acceptance. runCodexDoctor defaults its
// verdict to this state (its own `versionPolicy` option overrides for tests),
// which is how policy reaches the doctor WITHOUT touching the frozen
// codex-ipc deps surface. Until any wiring runs, the state equals the
// bundled manifest with no acceptances — exactly the fail-closed default.

const DEFAULT_POLICY: CodexVersionPolicy = { manifest: BUNDLED_CODEX_MANIFEST, riskAcceptedVersions: [] };
let activePolicy: CodexVersionPolicy = DEFAULT_POLICY;

export function activeCodexVersionPolicy(): CodexVersionPolicy {
  return activePolicy;
}

/**
 * Merges a patch into the active policy and reports whether it actually
 * CHANGED anything (BM4): a caller re-spawning the doctor on every settled
 * refresh — identical or not — judges a stale cached version against the
 * old policy until the NEXT recheck happens to fire for some unrelated
 * reason. Comparing the merged result against the current policy lets a
 * refresh chain re-trigger a recheck exactly when it would change a verdict.
 */
export function setActiveCodexVersionPolicy(patch: Partial<CodexVersionPolicy>): boolean {
  const next: CodexVersionPolicy = { ...activePolicy, ...patch };
  const changed = JSON.stringify(next) !== JSON.stringify(activePolicy);
  activePolicy = next;
  return changed;
}

/** Test hygiene: restores the compile-time default. */
export function resetActiveCodexVersionPolicy(): void {
  activePolicy = DEFAULT_POLICY;
}

// ── network refresh + on-disk cache (`~/.anycode/codex/manifest.json`) ──

export interface CodexManifestRefreshOptions {
  /** Cache file path (production: `~/.anycode/codex/manifest.json`). */
  cacheFile: string;
  url?: string;
  fetchImpl?: typeof fetch;
  /** Clock seam for the 6h throttle. */
  now?: () => number;
  /** Explicit "Refresh" button: bypasses the throttle, still sends If-None-Match. */
  force?: boolean;
}

export interface CodexManifestRefreshResult {
  manifest: CodexSupportManifest;
  source: "network" | "cache" | "bundled";
}

interface ManifestCacheFile {
  fetchedAt: string;
  etag?: string;
  manifest: CodexSupportManifest;
}

/** Reads and RE-VALIDATES the cache — a tampered cache file (the disk is 0644-world) degrades to null, never to a widened range. */
function readManifestCache(cacheFile: string): ManifestCacheFile | null {
  let raw: string;
  try {
    raw = readFileSync(cacheFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; etag?: unknown; manifest?: unknown };
    if (typeof parsed.fetchedAt !== "string") return null;
    const manifest = validateCodexManifest(parsed.manifest);
    if (manifest === null) return null;
    return { fetchedAt: parsed.fetchedAt, ...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}), manifest };
  } catch {
    return null;
  }
}

/**
 * Refreshes the policy manifest from the raw URL. NEVER throws and never
 * returns garbage: every failure path (offline, non-200, oversized body,
 * unparsable JSON, validation refusal) resolves to the best known truth —
 * a previously cached VALID manifest if one exists, else BUNDLED. A fresh
 * (< 6h) valid cache short-circuits without any network I/O unless `force`.
 */
export async function refreshCodexManifest(options: CodexManifestRefreshOptions): Promise<CodexManifestRefreshResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? CODEX_MANIFEST_URL;
  const now = options.now ?? Date.now;
  const cached = readManifestCache(options.cacheFile);

  if (!options.force && cached !== null) {
    const age = now() - Date.parse(cached.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < CODEX_MANIFEST_REFRESH_INTERVAL_MS) {
      return { manifest: cached.manifest, source: "cache" };
    }
  }

  const fallback = (): CodexManifestRefreshResult =>
    cached !== null ? { manifest: cached.manifest, source: "cache" } : { manifest: BUNDLED_CODEX_MANIFEST, source: "bundled" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CODEX_MANIFEST_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          ...(cached?.etag !== undefined ? { "if-none-match": cached.etag } : {}),
        },
        // Policy travels on the pinned raw URL only — a redirect elsewhere is refused, not followed.
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 304 && cached !== null) {
      return { manifest: cached.manifest, source: "cache" };
    }
    if (response.status !== 200) return fallback();
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > CODEX_MANIFEST_MAX_BYTES) return fallback();
    const manifest = validateCodexManifest(JSON.parse(body));
    if (manifest === null) return fallback();
    const etag = response.headers.get("etag");
    const cachePayload: ManifestCacheFile = {
      fetchedAt: new Date(now()).toISOString(),
      ...(etag !== null ? { etag } : {}),
      manifest,
    };
    try {
      mkdirSync(dirname(options.cacheFile), { recursive: true });
      writeFileSync(options.cacheFile, `${JSON.stringify(cachePayload, null, 2)}\n`);
    } catch {
      // Advisory cache: failing to persist never fails the refresh itself.
    }
    return { manifest, source: "network" };
  } catch {
    return fallback();
  }
}

/** Explicit cache-drop (used by tests and the "Refresh" path when a cache is known-poisoned). */
export function dropCodexManifestCache(cacheFile: string): void {
  rmSync(cacheFile, { force: true });
}

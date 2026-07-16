/**
 * Version-support policy + npm-artifact resolution constants for the bundled
 * Codex downloader (codex-profiles cut §3.8/§7, amended §A4). VALUE-ONLY
 * module, zero runtime imports, zero I/O — every function here is pure and
 * every constant is compile-time, so this file is safe from host/**,
 * main/**, and the renderer alike (same discipline as codex-doctor.ts /
 * codex-quota.ts).
 *
 * The origin of the download artifact is a COMPILATION-TIME constant here,
 * never something a network-fetched manifest can carry or override (cut
 * §7.1: "Подделанный манифест не может перенаправить загрузку" — a forged
 * manifest's worst-case damage is lying about which VERSIONS are supported,
 * never redirecting the download itself).
 */

/** The one npm package every Codex artifact — main shim and every per-platform build — is published under. */
export const CODEX_NPM_PACKAGE = "@openai/codex";

/** The only registry host this loader will ever fetch from. */
export const CODEX_NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Compile-time version FLOOR: the manifest (network or bundled) may narrow
 * the supported range, but can never claim a version below this floor is
 * supported — closing a downgrade-attack-via-forged-manifest vector (cut
 * §7.1).
 */
export const CODEX_MIN_FLOOR = "0.144.0";

/**
 * Shape of the version-support policy document (`codex-support.json`, cut
 * §7.1) — either fetched live (with ETag caching, refreshed at most every
 * 6h) or falling back to `BUNDLED_CODEX_MANIFEST` on ANY failure (network
 * down, non-200, unparsable, wrong `schemaVersion`, or a range below
 * `CODEX_MIN_FLOOR`) — fail-closed by construction: garbage from the network
 * never WIDENS what this binary will call "supported".
 */
export interface CodexSupportManifest {
  schemaVersion: "anycode.codex-support.v1";
  updatedAt: string;
  supported: Array<{ range: string; status: string; note?: string }>;
  recommended: string;
  minimum: string;
}

/**
 * Fallback used whenever the network manifest is unavailable or fails
 * validation (cut §7.1, fail-closed). Mirrors the range verified by the
 * `codex-fixes` track's live 10/10 smoke.
 */
export const BUNDLED_CODEX_MANIFEST: CodexSupportManifest = {
  schemaVersion: "anycode.codex-support.v1",
  updatedAt: "2026-07-14T00:00:00Z",
  supported: [{ range: ">=0.144.0 <0.145.0", status: "tested", note: "живой смоук 10/10, codex-fixes" }],
  recommended: "0.144.3",
  minimum: CODEX_MIN_FLOOR,
};

/**
 * `platform`+`arch` -> npm version-suffix (amended §A4.2, W0-R2 probe): the
 * artifact is NOT a separately-named npm package per platform — it is the
 * SAME `@openai/codex` package published under a version string suffixed
 * `-<platform>-<arch>` (e.g. `0.144.5-darwin-arm64`). Exactly 6 combinations
 * live in the registry (probe confirmed all 6); anything else is
 * unsupported and must fail closed — never guessed.
 */
const SUPPORTED_PLATFORM_SUFFIXES = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
]);

/** `process.platform`+`process.arch` -> the npm version-suffix, or `null` for an unsupported combination (fail-closed). */
export function codexPlatformSuffix(platform: string, arch: string): string | null {
  const suffix = `${platform}-${arch}`;
  return SUPPORTED_PLATFORM_SUFFIXES.has(suffix) ? suffix : null;
}

/**
 * platform-suffix -> Rust target triple. Copied VERBATIM from the live
 * `PLATFORM_PACKAGE_BY_TARGET`-derived layout observed in the real
 * `bin/codex.js` shim of 0.144.x (amended §A4.2, W0-R2 §5, verified
 * 2026-07-16) — not invented. Used to compute where the real bytes live
 * inside the downloaded tarball (`vendor/<triple>/...`).
 */
export const CODEX_TRIPLE_BY_PLATFORM: Readonly<Record<string, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/**
 * Relative path of the main Codex binary INSIDE the installed version tree
 * (`~/.anycode/codex/bin/<version>/<this>`), per the `vendor/<triple>/...`
 * layout the real tarball uses (amended §A4.2/§A4.3, W0-R2 §4) — NOT
 * `bin/codex-<triple>` as originally guessed in the un-amended cut §7.2.
 * `.exe` is appended on `win32` triples only.
 */
export function codexBinaryRelPath(triple: string): string {
  const isWindows = triple.includes("windows");
  return `vendor/${triple}/bin/codex${isWindows ? ".exe" : ""}`;
}

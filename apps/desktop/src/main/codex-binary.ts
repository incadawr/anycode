import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import { checkCodexBinaryTrust, type CodexPathStat } from "../shared/codex-binary-trust.js";
import { CODEX_TRIPLE_BY_PLATFORM, codexBinaryRelPath, codexPlatformSuffix } from "../shared/codex-support.js";

export interface CodexBinaryResolution {
  path: string | null;
  reason?: string;
}

/** Stat shape mirrors `fs.Stats` exactly, so the production seam below is a straight passthrough. */
export interface CodexBinaryFs {
  stat(path: string): { isFile(): boolean; isDirectory(): boolean; mode: number; uid: number; gid: number };
  /** Symlinks resolved: `execve` reads the TARGET, so the target is what must be trusted. */
  realpath(path: string): string;
  /** Directory listing for the `installed` rung (TASK.53). Optional: a seam without it simply yields no installed candidates — it never breaks the rest of the ladder. */
  readdir?(path: string): string[];
}

const nodeFs: CodexBinaryFs = {
  stat(path) {
    return statSync(path);
  },
  realpath(path) {
    return realpathSync(path);
  },
  readdir(path) {
    return readdirSync(path);
  },
};

/** The POSIX identity the trust policy judges ownership against; `undefined` getters on Windows collapse to a value the policy ignores. */
export interface CodexIdentity {
  uid: number;
  /** Supplementary groups (`process.getgroups()`). Not read by the trust policy itself (membership is not trust — see shared/codex-binary-trust.ts) but kept as part of the identity snapshot callers pass around. */
  gids: readonly number[];
  /** `process.getegid()` — judged by the policy's Linux user-private-group case. Optional so an identity built before this field existed still satisfies the type; omitted, it falls back to a sentinel no real gid can match, i.e. that trust case simply never fires. */
  egid?: number;
}

function currentIdentity(): CodexIdentity {
  return {
    uid: process.getuid?.() ?? -1,
    gids: process.getgroups?.() ?? [],
    egid: process.getegid?.() ?? -1,
  };
}

function toPathStat(path: string, stat: { isFile(): boolean; isDirectory(): boolean; mode: number; uid: number; gid: number }): CodexPathStat {
  return { path, isFile: stat.isFile(), isDirectory: stat.isDirectory(), mode: stat.mode, uid: stat.uid, gid: stat.gid };
}

/**
 * Every directory that can be used to swap the binary out from under us: the
 * FULL ancestor chain (up to the filesystem root) of the resolved file's
 * directory, plus — when the candidate path is a symlink — the same chain
 * for the directory holding that symlink. A single-level check misses a
 * writable GRANDPARENT that can rename or replace an otherwise-safe
 * immediate directory (W5.5-review High), so every ancestor up to `/` is
 * walked, not just the leaf. Deduplicated: a shared ancestor (the common
 * case) is only statted and judged once.
 */
function ancestorDirectories(resolvedFile: string, originalPath: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const walk = (start: string): void => {
    let current = start;
    for (;;) {
      if (!seen.has(current)) {
        seen.add(current);
        ordered.push(current);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  walk(dirname(resolvedFile));
  if (resolvedFile !== originalPath) walk(dirname(originalPath));
  return ordered;
}

/**
 * The execute-time trust gate (shared/codex-binary-trust.ts owns the policy;
 * this owns main's filesystem reads for it). Run at DISCOVERY by
 * `resolveCodexBinary` below AND again immediately before every `spawn()` in
 * main/codex-doctor.ts — re-validation at spawn is the point: a path validated
 * once at discovery and executed later is exactly the TOCTOU the policy exists
 * to narrow. It narrows, and does not close, that window (see the policy
 * module's header — the residual is real and is not papered over here).
 */
export function checkCodexBinaryPathTrust(
  path: string,
  fs: CodexBinaryFs = nodeFs,
  platform: NodeJS.Platform = process.platform,
  identity: CodexIdentity = currentIdentity(),
): string | null {
  if (platform === "win32") return null;
  try {
    const resolved = fs.realpath(path);
    // A symlink lets an attacker swap the LINK instead of the target, so the
    // link's own ancestor chain is part of the trusted set too.
    const directories = ancestorDirectories(resolved, path).map((dir) => toPathStat(dir, fs.stat(dir)));
    return checkCodexBinaryTrust({
      file: toPathStat(resolved, fs.stat(resolved)),
      directories,
      uid: identity.uid,
      egid: identity.egid ?? -1,
      platform,
    });
  } catch {
    return "Codex binary path does not exist";
  }
}

/** Main validates an explicit absolute path; it never searches or shells out. */
export function resolveCodexBinary(
  raw: string | undefined,
  fs: CodexBinaryFs = nodeFs,
  platform = process.platform,
  identity: CodexIdentity = currentIdentity(),
): CodexBinaryResolution {
  if (raw === undefined || raw.trim() === "") return { path: null };
  const path = raw.trim();
  const isAbsolutePath = platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!isAbsolutePath) return { path: null, reason: "Codex binary path must be absolute" };
  try {
    const stat = fs.stat(path);
    if (!stat.isFile()) return { path: null, reason: "Codex binary path is not a file" };
    if (platform !== "win32" && (stat.mode & 0o111) === 0) {
      return { path: null, reason: "Codex binary is not executable" };
    }
  } catch {
    return { path: null, reason: "Codex binary path does not exist" };
  }
  const untrusted = checkCodexBinaryPathTrust(path, fs, platform, identity);
  if (untrusted !== null) return { path: null, reason: untrusted };
  return { path };
}

// ── discovery ladder (TASK.41, cut §2(g)) ──
//
// Onboarding without a mandatory env var: `ANYCODE_CODEX_BIN` (wins) ->
// settings.codex.binaryPath (validated) -> a PATH scan -> common per-platform
// install locations -> an explicit file picker (main/codex-ipc.ts drives that
// last rung — it is a user gesture, not something this pure module can do).
// Every rung is validated through `resolveCodexBinary` above (absolute +
// exists + executable) — PATH/common candidates are built by plain
// `path.join`, NEVER by shell interpolation (no `which`/`where`, no `shell:
// true` spawn anywhere in this file or its main/codex-doctor.ts consumer).

/** `picker` is not produced by `discoverCodexBinary` (it never opens a dialog) — main/codex-ipc.ts stamps it on the explicit file-picker rung, the ladder's final step. `installed` = a version downloaded by main/codex-install.ts into `~/.anycode/codex/bin/` (TASK.53), the last automatic rung. */
export type CodexBinarySource = "env" | "settings" | "path" | "common" | "installed" | "picker" | "none";

export interface CodexBinaryDiscovery {
  path: string | null;
  source: CodexBinarySource;
  /** The last rejection reason seen while walking the ladder (diagnostic only — the ladder still fails closed on `path:null`). */
  reason?: string;
}

/** `codex` on POSIX, `codex.exe` on Windows — the file name every ladder rung looks for. */
export function codexBinaryFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "codex.exe" : "codex";
}

/** Splits `PATH` into absolute candidate binary paths. Pure `path.join` — no shell, no `which`/`where`. */
export function candidatesFromPath(pathEnv: string | undefined, platform: NodeJS.Platform): string[] {
  if (pathEnv === undefined || pathEnv.trim() === "") return [];
  const separator = platform === "win32" ? ";" : ":";
  const fileName = codexBinaryFileName(platform);
  return pathEnv
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .map((segment) => (platform === "win32" ? win32.join(segment, fileName) : posix.join(segment, fileName)));
}

/**
 * Common per-platform install locations (cut §2(g)), independent of `PATH`:
 * `~/.npm-global/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`
 * on POSIX (in that order); `%APPDATA%\npm` on Windows. A missing HOME/
 * APPDATA simply drops the entries that need it — never throws.
 */
export function commonInstallLocations(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const fileName = codexBinaryFileName(platform);
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData !== undefined && appData.trim() !== "" ? [win32.join(appData, "npm", fileName)] : [];
  }
  const home = env.HOME;
  const dirs: string[] = [];
  if (home !== undefined && home.trim() !== "") {
    dirs.push(posix.join(home, ".npm-global", "bin"));
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  if (home !== undefined && home.trim() !== "") {
    dirs.push(posix.join(home, ".local", "bin"));
  }
  return dirs.map((dir) => posix.join(dir, fileName));
}

/**
 * Candidate binaries installed by our own downloader (cut §7.2 п.8 —
 * `~/.anycode/codex/bin/<version>/vendor/<triple>/bin/codex`), newest version
 * first. Version directories are matched strictly (`X.Y.Z`) so temp litter
 * (`.tmp-*`, `.download-*`) and junk never become candidates. Yields `[]` —
 * never throws — when HOME is unset, the tree does not exist, the platform
 * has no artifact, or the fs seam carries no `readdir`.
 */
export function installedCodexCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
  fs: CodexBinaryFs = nodeFs,
): string[] {
  if (fs.readdir === undefined) return [];
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  if (home === undefined || home.trim() === "") return [];
  const suffix = codexPlatformSuffix(platform, arch);
  const triple = suffix !== null ? CODEX_TRIPLE_BY_PLATFORM[suffix] : undefined;
  if (triple === undefined) return [];
  const paths = platform === "win32" ? win32 : posix;
  const binRoot = paths.join(home, ".anycode", "codex", "bin");
  let entries: string[];
  try {
    entries = fs.readdir(binRoot);
  } catch {
    return [];
  }
  const parse = (name: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(name);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  return entries
    .map((name) => ({ name, version: parse(name) }))
    .filter((entry): entry is { name: string; version: [number, number, number] } => entry.version !== null)
    .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2])
    .map((entry) => paths.join(binRoot, entry.name, ...codexBinaryRelPath(triple).split("/")));
}

export interface CodexDiscoveryInputs {
  /** `ANYCODE_CODEX_BIN`, if set — a documented dev/diagnostic override with top ladder priority. */
  envOverride?: string;
  /** `settings.codex.binaryPath` — the user's previously validated/picked path. */
  settingsPath?: string;
  /** Full process env, read for `PATH`/`HOME`/`APPDATA` (discovery never mutates or shells out with it). */
  env: NodeJS.ProcessEnv;
  fs?: CodexBinaryFs;
  platform?: NodeJS.Platform;
  /** CPU arch for the `installed` rung's triple lookup; defaults to `process.arch`. */
  arch?: string;
  /** Test seam; production reads the live process identity (uid + supplementary groups). */
  identity?: CodexIdentity;
}

/**
 * Walks the discovery ladder in priority order, returning the FIRST rung that
 * resolves to an absolute, existing, executable file. A rung that finds
 * nothing simply falls through to the next one — it does not abort the
 * ladder (an env override pointing at a since-uninstalled dev build must not
 * brick discovery for a user who also has a real PATH install). Version
 * compatibility is diagnosed by the doctor (main/codex-doctor.ts) against
 * whatever this function returns, not by trying further rungs.
 */
export function discoverCodexBinary(inputs: CodexDiscoveryInputs): CodexBinaryDiscovery {
  const fs = inputs.fs ?? nodeFs;
  const platform = inputs.platform ?? process.platform;
  const arch = inputs.arch ?? process.arch;
  const identity = inputs.identity ?? currentIdentity();
  const rungs: Array<{ source: CodexBinarySource; candidates: string[] }> = [
    { source: "env", candidates: inputs.envOverride !== undefined && inputs.envOverride.trim() !== "" ? [inputs.envOverride] : [] },
    { source: "settings", candidates: inputs.settingsPath !== undefined && inputs.settingsPath.trim() !== "" ? [inputs.settingsPath] : [] },
    { source: "path", candidates: candidatesFromPath(inputs.env.PATH, platform) },
    { source: "common", candidates: commonInstallLocations(inputs.env, platform) },
    { source: "installed", candidates: installedCodexCandidates(inputs.env, platform, arch, fs) },
  ];
  let lastReason: string | undefined;
  for (const rung of rungs) {
    for (const candidate of rung.candidates) {
      const resolved = resolveCodexBinary(candidate, fs, platform, identity);
      if (resolved.path !== null) {
        return { path: resolved.path, source: rung.source };
      }
      if (resolved.reason !== undefined) {
        lastReason = resolved.reason;
      }
    }
  }
  return { path: null, source: "none", ...(lastReason !== undefined ? { reason: lastReason } : {}) };
}

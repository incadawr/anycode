/**
 * Claude Code CLI binary discovery ladder (SLICE-CC A2, cut §1.2 mirror of
 * main/codex-binary.ts): `ANYCODE_CLAUDE_BIN` -> `settings.claude.binaryPath`
 * -> a PATH scan -> common per-platform install locations -> an explicit file
 * picker (main/claude-ipc.ts drives that last rung, same as codex). Every rung
 * is validated through `resolveClaudeBinary` below (absolute + exists +
 * executable) — PATH/common candidates are built by plain `path.join`, NEVER
 * by shell interpolation (no `which`/`where`, no `shell: true` spawn anywhere
 * in this file or its main/claude-doctor.ts consumer).
 *
 * NO "installed" rung: unlike Codex (TASK.53, `~/.anycode/codex/bin/**`),
 * AnyCode does not download/manage a Claude Code binary in this track
 * (OG-CC-2, licensing — cut §1.2 "НЕ делаем").
 *
 * Trust policy is imported AS-IS from shared/codex-binary-trust.ts (cut §1.2:
 * "политика движко-агностична; переименование = запрещённый рефакторинг
 * общего файла") — the policy judges ownership/writability of a path about to
 * be executed, and that judgment has nothing to do with which CLI it is.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import { checkCodexBinaryTrust, type CodexPathStat } from "../shared/codex-binary-trust.js";

export interface ClaudeBinaryResolution {
  path: string | null;
  reason?: string;
}

/** Stat shape mirrors `fs.Stats` exactly, so the production seam below is a straight passthrough. */
export interface ClaudeBinaryFs {
  stat(path: string): { isFile(): boolean; isDirectory(): boolean; mode: number; uid: number; gid: number };
  /** Symlinks resolved: `execve` reads the TARGET, so the target is what must be trusted. */
  realpath(path: string): string;
}

const nodeFs: ClaudeBinaryFs = {
  stat(path) {
    return statSync(path);
  },
  realpath(path) {
    return realpathSync(path);
  },
};

/** The POSIX identity the trust policy judges ownership against; duplicated from main/codex-binary.ts's own `CodexIdentity` (cross-engine main/main import is not a sanctioned seam — see this file's header). */
export interface ClaudeIdentity {
  uid: number;
  gids: readonly number[];
  egid?: number;
}

function currentIdentity(): ClaudeIdentity {
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
 * for the directory holding that symlink. Mirrors main/codex-binary.ts's
 * `ancestorDirectories` exactly (duplicated, not imported — see file header).
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
 * The execute-time trust gate. Run at DISCOVERY by `resolveClaudeBinary` below
 * AND again immediately before every spawn in main/claude-doctor.ts —
 * re-validation at spawn narrows (does not close) the TOCTOU window, exactly
 * the same discipline as main/codex-binary.ts's `checkCodexBinaryPathTrust`.
 */
export function checkClaudeBinaryPathTrust(
  path: string,
  fs: ClaudeBinaryFs = nodeFs,
  platform: NodeJS.Platform = process.platform,
  identity: ClaudeIdentity = currentIdentity(),
): string | null {
  if (platform === "win32") return null;
  try {
    const resolved = fs.realpath(path);
    const directories = ancestorDirectories(resolved, path).map((dir) => toPathStat(dir, fs.stat(dir)));
    return checkCodexBinaryTrust({
      file: toPathStat(resolved, fs.stat(resolved)),
      directories,
      uid: identity.uid,
      egid: identity.egid ?? -1,
      platform,
    });
  } catch {
    return "Claude binary path does not exist";
  }
}

/** Main validates an explicit absolute path; it never searches or shells out. */
export function resolveClaudeBinary(
  raw: string | undefined,
  fs: ClaudeBinaryFs = nodeFs,
  platform = process.platform,
  identity: ClaudeIdentity = currentIdentity(),
): ClaudeBinaryResolution {
  if (raw === undefined || raw.trim() === "") return { path: null };
  const path = raw.trim();
  const isAbsolutePath = platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!isAbsolutePath) return { path: null, reason: "Claude binary path must be absolute" };
  try {
    const stat = fs.stat(path);
    if (!stat.isFile()) return { path: null, reason: "Claude binary path is not a file" };
    if (platform !== "win32" && (stat.mode & 0o111) === 0) {
      return { path: null, reason: "Claude binary is not executable" };
    }
  } catch {
    return { path: null, reason: "Claude binary path does not exist" };
  }
  const untrusted = checkClaudeBinaryPathTrust(path, fs, platform, identity);
  if (untrusted !== null) return { path: null, reason: untrusted };
  return { path };
}

// ── discovery ladder (cut §1.2) ──
//
// Onboarding without a mandatory env var: `ANYCODE_CLAUDE_BIN` (wins) ->
// settings.claude.binaryPath (validated) -> a PATH scan -> common per-platform
// install locations -> an explicit file picker (main/claude-ipc.ts drives that
// last rung). Every rung is validated through `resolveClaudeBinary` above.

/** `picker` is not produced by `discoverClaudeBinary` (it never opens a dialog) — main/claude-ipc.ts stamps it on the explicit file-picker rung, the ladder's final step. */
export type ClaudeBinarySource = "env" | "settings" | "path" | "common" | "picker" | "none";

export interface ClaudeBinaryDiscovery {
  path: string | null;
  source: ClaudeBinarySource;
  /** The last rejection reason seen while walking the ladder (diagnostic only — the ladder still fails closed on `path:null`). */
  reason?: string;
}

/** `claude` on POSIX, `claude.exe` on Windows — the file name every ladder rung looks for. */
export function claudeBinaryFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

/** Splits `PATH` into absolute candidate binary paths. Pure `path.join` — no shell, no `which`/`where`. */
export function candidatesFromPath(pathEnv: string | undefined, platform: NodeJS.Platform): string[] {
  if (pathEnv === undefined || pathEnv.trim() === "") return [];
  const separator = platform === "win32" ? ";" : ":";
  const fileName = claudeBinaryFileName(platform);
  return pathEnv
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .map((segment) => (platform === "win32" ? win32.join(segment, fileName) : posix.join(segment, fileName)));
}

/**
 * Common per-platform install locations (cut §1.2), independent of `PATH`:
 * `~/.local/bin` (the native installer — first, per the cut's own ordering),
 * `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin` on POSIX (in that
 * order); `%APPDATA%\npm` on Windows. A missing HOME/APPDATA simply drops the
 * entries that need it — never throws.
 */
export function commonInstallLocations(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const fileName = claudeBinaryFileName(platform);
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData !== undefined && appData.trim() !== "" ? [win32.join(appData, "npm", fileName)] : [];
  }
  const home = env.HOME;
  const dirs: string[] = [];
  if (home !== undefined && home.trim() !== "") {
    dirs.push(posix.join(home, ".local", "bin"));
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  if (home !== undefined && home.trim() !== "") {
    dirs.push(posix.join(home, ".npm-global", "bin"));
  }
  return dirs.map((dir) => posix.join(dir, fileName));
}

export interface ClaudeDiscoveryInputs {
  /** `ANYCODE_CLAUDE_BIN`, if set — a documented dev/diagnostic override with top ladder priority. */
  envOverride?: string;
  /** `settings.claude.binaryPath` — the user's previously validated/picked path. */
  settingsPath?: string;
  /** Full process env, read for `PATH`/`HOME`/`APPDATA` (discovery never mutates or shells out with it). */
  env: NodeJS.ProcessEnv;
  fs?: ClaudeBinaryFs;
  platform?: NodeJS.Platform;
  /** Test seam; production reads the live process identity (uid + supplementary groups). */
  identity?: ClaudeIdentity;
}

/**
 * Walks the discovery ladder in priority order, returning the FIRST rung that
 * resolves to an absolute, existing, executable file. A rung that finds
 * nothing simply falls through to the next one — it does not abort the
 * ladder. Version compatibility is diagnosed by the doctor
 * (main/claude-doctor.ts) against whatever this function returns, not by
 * trying further rungs.
 */
export function discoverClaudeBinary(inputs: ClaudeDiscoveryInputs): ClaudeBinaryDiscovery {
  const fs = inputs.fs ?? nodeFs;
  const platform = inputs.platform ?? process.platform;
  const identity = inputs.identity ?? currentIdentity();
  const rungs: Array<{ source: ClaudeBinarySource; candidates: string[] }> = [
    { source: "env", candidates: inputs.envOverride !== undefined && inputs.envOverride.trim() !== "" ? [inputs.envOverride] : [] },
    { source: "settings", candidates: inputs.settingsPath !== undefined && inputs.settingsPath.trim() !== "" ? [inputs.settingsPath] : [] },
    { source: "path", candidates: candidatesFromPath(inputs.env.PATH, platform) },
    { source: "common", candidates: commonInstallLocations(inputs.env, platform) },
  ];
  let lastReason: string | undefined;
  for (const rung of rungs) {
    for (const candidate of rung.candidates) {
      const resolved = resolveClaudeBinary(candidate, fs, platform, identity);
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

/**
 * AnyCode's fixed default profile directory for the Claude engine (cut §0.2
 * invariant 2 C1 / §0.3-6, VERIFY-1+R1-validated mechanism): the directory
 * CC-B will spawn every claude child with as `CLAUDE_CONFIG_DIR`, never the
 * default `~/.claude`. CC-A/CC-B/CC-C/CC-D-min run on this ONE profile;
 * multi-profile UI (`~/.anycode/claude/profile-<id>`) is CC-E.
 */
export function defaultClaudeProfileDir(home: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(home, ".anycode", "claude", "profile-default");
}

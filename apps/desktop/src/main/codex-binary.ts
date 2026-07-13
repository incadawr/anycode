import { statSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";

export interface CodexBinaryResolution {
  path: string | null;
  reason?: string;
}

export interface CodexBinaryFs {
  stat(path: string): { isFile(): boolean; mode: number };
}

const nodeFs: CodexBinaryFs = {
  stat(path) {
    return statSync(path);
  },
};

/** Main validates an explicit absolute path; it never searches or shells out. */
export function resolveCodexBinary(raw: string | undefined, fs: CodexBinaryFs = nodeFs, platform = process.platform): CodexBinaryResolution {
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
    return { path };
  } catch {
    return { path: null, reason: "Codex binary path does not exist" };
  }
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

/** `picker` is not produced by `discoverCodexBinary` (it never opens a dialog) — main/codex-ipc.ts stamps it on the explicit file-picker rung, the ladder's fifth and final step. */
export type CodexBinarySource = "env" | "settings" | "path" | "common" | "picker" | "none";

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

export interface CodexDiscoveryInputs {
  /** `ANYCODE_CODEX_BIN`, if set — a documented dev/diagnostic override with top ladder priority. */
  envOverride?: string;
  /** `settings.codex.binaryPath` — the user's previously validated/picked path. */
  settingsPath?: string;
  /** Full process env, read for `PATH`/`HOME`/`APPDATA` (discovery never mutates or shells out with it). */
  env: NodeJS.ProcessEnv;
  fs?: CodexBinaryFs;
  platform?: NodeJS.Platform;
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
  const rungs: Array<{ source: CodexBinarySource; candidates: string[] }> = [
    { source: "env", candidates: inputs.envOverride !== undefined && inputs.envOverride.trim() !== "" ? [inputs.envOverride] : [] },
    { source: "settings", candidates: inputs.settingsPath !== undefined && inputs.settingsPath.trim() !== "" ? [inputs.settingsPath] : [] },
    { source: "path", candidates: candidatesFromPath(inputs.env.PATH, platform) },
    { source: "common", candidates: commonInstallLocations(inputs.env, platform) },
  ];
  let lastReason: string | undefined;
  for (const rung of rungs) {
    for (const candidate of rung.candidates) {
      const resolved = resolveCodexBinary(candidate, fs, platform);
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

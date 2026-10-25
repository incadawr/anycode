/**
 * Language-server binary detection (Taskana 4743): does the executable a
 * catalog entry names exist ANYWHERE this app can reasonably expect to find
 * it? Pure over an injected `{pathEnv, platform, fileExists, execAccessible,
 * home?, workspace?}` — no `which`/`where`, no shell, and above all NO SPAWN:
 * the app never executes a found binary, existence and the executable bit are
 * the whole answer (brief §0 security posture). Mirrors
 * main/claude-binary.ts's `candidatesFromPath` idiom (plain `path.join` per
 * PATH segment) and `commonInstallLocations` (a GUI-launched Electron app
 * often inherits a minimal PATH, so the common tool dirs matter as much as
 * PATH itself), generalized to arbitrary command names.
 *
 * Coarse source only (`"path" | "project" | null`): the resolved absolute
 * path never crosses to the renderer (Taskana 4743 brief §2.3).
 */

import { posix, win32 } from "node:path";

/** Minimal stat view of one candidate file. */
export interface DetectedFile {
  isFile: boolean;
  /** POSIX mode bits; `undefined` when the fs seam can't stat mode (Windows). */
  mode?: number;
}

export interface LspDetectInputs {
  /** The `PATH` environment variable as the app received it. */
  pathEnv: string | undefined;
  platform: NodeJS.Platform;
  /**
   * Existence check for one candidate path. Returning `undefined` means "not
   * a thing we can classify" (missing, or the seam cannot stat it) — the
   * candidate is skipped, never counted as found.
   */
  fileExists(path: string): DetectedFile | undefined | Promise<DetectedFile | undefined>;
  /** The user's home dir; `undefined` drops the `~`-relative extra dirs. */
  home?: string;
  /** The active workspace; enables the `<workspace>/node_modules/.bin` lookup. */
  workspace?: string;
}

export type LspDetectSource = "path" | "project";

export interface LspDetectResult {
  /**
   * `true` only for a PATH hit. `source: "project"` with `found: false` means
   * the binary is present only in the project's `node_modules/.bin`: the app
   * spawns by PATH (never from the project, which would bypass workspace
   * trust), so such a server will not start from there.
   */
  found: boolean;
  /**
   * Where the first hit came from; `null` when no hit. `"project"` pairs with
   * `found: false` (see above).
   */
  source: LspDetectSource | null;
}

/** The file names tried for a command on each platform: bare, plus PATHEXT-style suffixes on win32. */
export function candidateFileNames(command: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
}

/**
 * Extra directories probed beyond `PATH` (Taskana 4743 brief §2.3): the
 * per-user bin dirs a GUI-launched app's minimal PATH routinely misses
 * (`~/.local/bin`, `~/go/bin`, `~/.cargo/bin`, `~/.npm-global/bin`) plus the
 * system-wide Homebrew locations. `~`-relative entries drop out when `home`
 * is absent — never throws.
 */
export function extraDetectDirs(home: string | undefined, platform: NodeJS.Platform): string[] {
  const dirs: string[] = [];
  if (platform !== "win32") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  if (home !== undefined && home.trim() !== "") {
    const base = home.replace(/[/\\]+$/, "");
    if (platform === "win32") {
      dirs.push(win32.join(base, "AppData", "Roaming", "npm"));
    } else {
      dirs.push(
        posix.join(base, ".local", "bin"),
        posix.join(base, "go", "bin"),
        posix.join(base, ".cargo", "bin"),
        posix.join(base, ".npm-global", "bin"),
      );
    }
  }
  return dirs;
}

function joinPath(platform: NodeJS.Platform, dir: string, name: string): string {
  return platform === "win32" ? win32.join(dir, name) : posix.join(dir, name);
}

/** Splits `PATH` into trimmed, non-empty directory segments (no shell, no `which`). */
export function pathDirs(pathEnv: string | undefined, platform: NodeJS.Platform): string[] {
  if (pathEnv === undefined || pathEnv.trim() === "") return [];
  const separator = platform === "win32" ? ";" : ":";
  return pathEnv
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function isExecutable(stat: DetectedFile, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true; // no X_OK bit on Windows
  if (stat.mode === undefined) return true; // seam can't see the bits — existence is the answer
  return (stat.mode & 0o111) !== 0;
}

/**
 * Detects one command. Probes, in order: every `PATH` dir, the common extra
 * dirs, then (only when the caller passes a workspace — the catalog entry's
 * `nodeBin` flag decides whether main passes it) `<workspace>/node_modules/.bin`.
 * First hit wins and names its source. A `node_modules/.bin` hit is reported
 * as `found: false, source: "project"` (the app spawns by PATH, so it would
 * not start). NEVER spawns or execs anything.
 */
export async function detectCommand(command: string, inputs: LspDetectInputs): Promise<LspDetectResult> {
  const names = candidateFileNames(command.trim(), inputs.platform);
  const dirs = [...pathDirs(inputs.pathEnv, inputs.platform), ...extraDetectDirs(inputs.home, inputs.platform)];

  for (const dir of dirs) {
    for (const name of names) {
      const stat = await inputs.fileExists(joinPath(inputs.platform, dir, name));
      if (stat !== undefined && stat.isFile && isExecutable(stat, inputs.platform)) {
        return { found: true, source: "path" };
      }
    }
  }

  if (inputs.workspace !== undefined && inputs.workspace.trim() !== "") {
    const binDir = joinPath(inputs.platform, inputs.workspace.replace(/[/\\]+$/, ""), "node_modules/.bin");
    for (const name of names) {
      const stat = await inputs.fileExists(joinPath(inputs.platform, binDir, name));
      if (stat !== undefined && stat.isFile && isExecutable(stat, inputs.platform)) {
        return { found: false, source: "project" };
      }
    }
  }

  return { found: false, source: null };
}

import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Strict startup gate for disposable development automation. Throws before profile use on any mismatch. */
export function initializeIsolatedSmoke(app: {
  isPackaged: boolean;
  commandLine: { hasSwitch(name: string): boolean };
  getAppPath(): string;
  setPath(name: "userData" | "sessionData", path: string): void;
  getPath(name: "userData" | "sessionData"): string;
}, env: NodeJS.ProcessEnv, makeDirectory: (path: string) => void = mkdirSync): boolean {
  if (env.ANYCODE_ISOLATED_SMOKE === undefined) return false;
  try {
    if (env.ANYCODE_ISOLATED_SMOKE !== "1" || env.ANYCODE_AUTOMATION !== "1" || app.isPackaged || !app.commandLine.hasSwitch("use-mock-keychain")) throw new Error();
    const root = env.ANYCODE_ISOLATED_ROOT;
    if (!root || !isAbsolute(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error();
    const rootStat = lstatSync(root);
    if ((rootStat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) throw new Error();
    const canonicalRoot = realpathSync(root);
    if (dirname(canonicalRoot) !== realpathSync(tmpdir())) throw new Error();
    const expected: Record<string, string> = {
      ANYCODE_SUBAGENTS_HOME: root, ANYCODE_PROFILE_HOME: root, ANYCODE_CODEX_PROFILES_HOME: root,
      ANYCODE_MCP_IMPORT_HOME: root, ANYCODE_SKILLS_IMPORT_HOME: root,
      ANYCODE_TELEMETRY_DIR: join(root, "telemetry"), ANYCODE_USER_DATA_DIR: join(root, "user-data"),
      ANYCODE_DB_PATH: join(root, "db.sqlite"), ANYCODE_AUTOMATION_INFO: join(root, "automation.json"),
      ANYCODE_SETTINGS_PATH: join(root, "settings.json"), ANYCODE_SECRETS_PATH: join(root, "secrets.json"),
      CODEX_HOME: join(root, "codex-home"), CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      ANYCODE_CODEX_BIN: join(root, "unavailable-engine"), ANYCODE_CLAUDE_BIN: join(root, "unavailable-engine"),
    };
    for (const [key, value] of Object.entries(expected)) if (env[key] !== value) throw new Error();
    // The harness may pre-seed settings and its inert executable only. Every
    // other application path must be created inside this fresh private root.
    for (const leaf of readdirSync(root)) {
      if (leaf !== "settings.json" && leaf !== "unavailable-engine") throw new Error();
      const stat = lstatSync(join(root, leaf));
      if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error();
    }
    const binary = join(root, "unavailable-engine");
    if (!lstatSync(binary).isFile() || readFileSync(binary, "utf8") !== "#!/bin/sh\nexit 1\n") throw new Error();
    if (!env.ANYCODE_EXPECTED_DESKTOP_ROOT || realpathSync(app.getAppPath()) !== realpathSync(env.ANYCODE_EXPECTED_DESKTOP_ROOT) || !env.ANYCODE_SMOKE_IDENTITY) throw new Error();
    const userData = join(root, "user-data");
    const sessionData = join(root, "session-data");
    // Only fresh directories are accepted: nested links in a reused profile
    // could redirect Chromium outside the disposable root.
    makeDirectory(userData);
    makeDirectory(sessionData);
    if (realpathSync(userData) !== join(canonicalRoot, "user-data") || realpathSync(sessionData) !== join(canonicalRoot, "session-data")) throw new Error();
    app.setPath("userData", userData);
    app.setPath("sessionData", sessionData);
    if (realpathSync(app.getPath("userData")) !== realpathSync(userData) || realpathSync(app.getPath("sessionData")) !== realpathSync(sessionData)) throw new Error();
    // Discovery and spawned programs must never inherit a user's executable search path.
    env.PATH = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin:/usr/sbin:/sbin";
    writeFileSync(join(root, "identity.json"), JSON.stringify({ nonce: env.ANYCODE_SMOKE_IDENTITY, desktopRoot: realpathSync(app.getAppPath()), userData: realpathSync(userData), sessionData: realpathSync(sessionData) }), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    throw new Error("Isolated automation profile initialization failed; application startup aborted.");
  }
}

/** In-memory fixture format: never delegates to the operating system keychain. */
export const isolatedSmokeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`fixture:${value}`, "utf8"),
  decryptString: (value: Buffer) => {
    const text = value.toString("utf8");
    if (!text.startsWith("fixture:")) throw new Error("Invalid fixture credential");
    return text.slice(8);
  },
};

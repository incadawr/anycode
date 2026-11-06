import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Strict startup gate for disposable development automation. Throws before profile use on any mismatch. */
export function initializeIsolatedSmoke(app: {
  isPackaged: boolean;
  commandLine: { hasSwitch(name: string): boolean; getSwitchValue(name: string): string };
  getAppPath(): string;
  setPath(name: "userData" | "sessionData", path: string): void;
  getPath(name: "userData" | "sessionData"): string;
}, env: NodeJS.ProcessEnv, makeDirectory: (path: string) => void = mkdirSync): boolean {
  if (env.ANYCODE_ISOLATED_SMOKE === undefined) return false;
  try {
    if (env.ANYCODE_ISOLATED_SMOKE !== "1" || env.ANYCODE_AUTOMATION !== "1" || app.isPackaged || !app.commandLine.hasSwitch("use-mock-keychain") || app.commandLine.getSwitchValue("remote-debugging-port") !== "0") throw new Error();
    const root = env.ANYCODE_ISOLATED_ROOT;
    if (!root || !isAbsolute(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error();
    const rootStat = lstatSync(root);
    if ((rootStat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) throw new Error();
    const canonicalRoot = realpathSync(root);
    if (dirname(canonicalRoot) !== realpathSync(tmpdir())) throw new Error();
    if (!env.ANYCODE_EXPECTED_DESKTOP_ROOT || realpathSync(app.getAppPath()) !== realpathSync(env.ANYCODE_EXPECTED_DESKTOP_ROOT) || !env.ANYCODE_SMOKE_IDENTITY) throw new Error();
    const nativeFixtures = env.ANYCODE_ISOLATED_NATIVE_FIXTURES;
    const binaries: Record<string, string> = {};
    if (nativeFixtures !== undefined) {
      if (nativeFixtures !== "1" || env.ANYCODE_ENGINE_SWITCH_ENABLED !== "1") throw new Error();
      const node = env.ANYCODE_ISOLATED_FIXTURE_NODE;
      if (!node || !isAbsolute(node) || basename(realpathSync(node)) !== "node" || /[\r\n]/.test(node) || !lstatSync(realpathSync(node)).isFile()) throw new Error();
      const source = readFileSync(join(app.getAppPath(), "src/host/engine-switch-fixtures/native-double.mjs"), "utf8").replace(/^#![^\n]*\n/, "");
      for (const engine of ["codex", "claude"]) {
        const path = join(root, `${engine}-double`);
        const prefix = `#!${realpathSync(node)}\nprocess.argv.push(${JSON.stringify(`--double-log=${join(root, `${engine}.jsonl`)}`)}${engine === "claude" ? ', "--double-claude"' : ""});\n`;
        binaries[`${engine}-double`] = prefix + source;
        if (readFileSync(path, "utf8") !== binaries[`${engine}-double`]) throw new Error();
      }
    }
    const expected: Record<string, string> = {
      ANYCODE_SUBAGENTS_HOME: root, ANYCODE_PROFILE_HOME: root, ANYCODE_CODEX_PROFILES_HOME: root,
      ANYCODE_MCP_IMPORT_HOME: root, ANYCODE_SKILLS_IMPORT_HOME: root,
      ANYCODE_TELEMETRY_DIR: join(root, "telemetry"), ANYCODE_USER_DATA_DIR: join(root, "user-data"),
      ANYCODE_DB_PATH: join(root, "db.sqlite"), ANYCODE_AUTOMATION_INFO: join(root, "automation.json"),
      ANYCODE_SETTINGS_PATH: join(root, "settings.json"), ANYCODE_SECRETS_PATH: join(root, "secrets.json"),
      CODEX_HOME: join(root, "codex-home"), CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      ANYCODE_CODEX_BIN: join(root, nativeFixtures ? "codex-double" : "unavailable-engine"), ANYCODE_CLAUDE_BIN: join(root, nativeFixtures ? "claude-double" : "unavailable-engine"),
    };
    for (const [key, value] of Object.entries(expected)) if (env[key] !== value) throw new Error();
    // The harness may seed settings, an inert binary, or exact copies of the
    // reviewed native fixture in the explicit engine-switch mode. Every
    // other application path must be created inside this fresh private root.
    for (const leaf of readdirSync(root)) {
      if (leaf !== "settings.json" && leaf !== "unavailable-engine" && !(leaf in binaries)) throw new Error();
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
    writeFileSync(join(root, "identity.json"), JSON.stringify({ pid: process.pid, nonce: env.ANYCODE_SMOKE_IDENTITY, desktopRoot: realpathSync(app.getAppPath()), userData: realpathSync(userData), sessionData: realpathSync(sessionData) }), { flag: "wx", mode: 0o600 });
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

/** Discovery in native-fixture mode can see only the reviewed binaries and their directory metadata. */
export function isolatedNativeBinaryFs(root: string) {
  const files = new Set([join(root, "codex-double"), join(root, "claude-double")].flatMap(path => [resolve(path), realpathSync(path)]));
  const directories = new Set<string>();
  for (const start of [resolve(root), realpathSync(root)]) {
    let path = start;
    while (true) { directories.add(path); const parent = dirname(path); if (parent === path) break; path = parent; }
  }
  function allowed(path: string) { if (!files.has(resolve(path)) && !directories.has(resolve(path))) throw new Error("Binary is outside the isolated fixture allowlist"); }
  return {
    stat(path: string) { allowed(path); return statSync(path); },
    realpath(path: string) { allowed(path); return realpathSync(path); },
    readdir: (_path: string): string[] => [],
  };
}

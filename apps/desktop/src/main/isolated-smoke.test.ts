import { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSmokeEnv } from "../../scripts/model-overrides-smoke-env.mjs";
import { initializeIsolatedSmoke, isolatedNativeBinaryFs, isolatedSmokeStorage } from "./isolated-smoke.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anycode-isolation-test-")); roots.push(root);
  writeFileSync(join(root, "unavailable-engine"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const env = buildSmokeEnv({ PATH: "/dangerous/user/bin" }, root, 1234, join(root, "unavailable-engine"));
  const desktopRoot = env.ANYCODE_EXPECTED_DESKTOP_ROOT!;
  const paths: Record<string, string> = {};
  const app = { isPackaged: false, commandLine: { hasSwitch: vi.fn(() => true), getSwitchValue: vi.fn(() => "0") }, getAppPath: () => desktopRoot, setPath: vi.fn((name: string, path: string) => { paths[name] = path; }), getPath: vi.fn((name: string) => paths[name]!) };
  return { root, env, app };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("isolated automation startup", () => {
  it("sets and checks both actual paths and replaces the inherited search path", () => {
    const { env, app, root } = fixture();
    expect(initializeIsolatedSmoke(app, env)).toBe(true);
    expect(app.getPath("userData")).toBe(join(root, "user-data"));
    expect(app.getPath("sessionData")).toBe(join(root, "session-data"));
    expect(env.PATH).not.toContain("dangerous");
  });
  it.each(["gate", "keychain", "port", "packaged", "path", "worktree", "setPath", "ignoredPath", "mkdir", "symlink", "nestedSymlink", "hardlink"])("fails closed for %s", (fault) => {
    const { env, app, root } = fixture();
    if (fault === "gate") delete env.ANYCODE_AUTOMATION;
    if (fault === "keychain") app.commandLine.hasSwitch.mockReturnValue(false);
    if (fault === "port") app.commandLine.getSwitchValue.mockReturnValue("9222");
    if (fault === "packaged") app.isPackaged = true;
    if (fault === "path") env.ANYCODE_SETTINGS_PATH = join(tmpdir(), "real-settings.json");
    if (fault === "worktree") env.ANYCODE_EXPECTED_DESKTOP_ROOT = root;
    if (fault === "setPath") app.setPath.mockImplementation(() => { throw new Error("failed"); });
    if (fault === "ignoredPath") app.getPath.mockReturnValue(tmpdir());
    if (fault === "mkdir") writeFileSync(join(root, "user-data"), "fixture");
    if (fault === "symlink") symlinkSync(tmpdir(), join(root, "user-data"));
    if (fault === "hardlink") linkSync(join(root, "unavailable-engine"), join(root, "settings.json"));
    if (fault === "nestedSymlink") { mkdirSync(join(root, "session-data")); symlinkSync(tmpdir(), join(root, "session-data", "Cache")); }
    expect(() => initializeIsolatedSmoke(app, env)).toThrow("startup aborted");
    if (["gate", "keychain", "port", "packaged", "path", "worktree", "symlink"].includes(fault)) expect(app.setPath).not.toHaveBeenCalled();
  });
  function nativeFixture(orchestration = false) {
    const h = fixture();
    const node = realpathSync(process.execPath);
    Object.assign(h.env, { ANYCODE_ENGINE_SWITCH_ENABLED: "1", ANYCODE_ISOLATED_NATIVE_FIXTURES: "1", ANYCODE_ISOLATED_FIXTURE_NODE: node });
    if (orchestration) h.env.ANYCODE_ISOLATED_ORCHESTRATION_FIXTURES = "1";
    const source = readFileSync(join(h.app.getAppPath(), "src/host/engine-switch-fixtures/native-double.mjs"), "utf8").replace(/^#![^\n]*\n/, "");
    for (const engine of ["codex", "claude"]) {
      const binary = join(h.root, `${engine}-double`);
      const prefix = `#!${node}\nprocess.argv.push(${orchestration ? '"--double-orchestration", ' : ""}${JSON.stringify(`--double-log=${join(h.root, `${engine}.jsonl`)}`)}${engine === "claude" ? ', "--double-claude"' : ""});\n`;
      writeFileSync(binary, prefix + source, { mode: 0o700 });
      h.env[engine === "codex" ? "ANYCODE_CODEX_BIN" : "ANYCODE_CLAUDE_BIN"] = binary;
    }
    return h;
  }
  it("admits the exact orchestration fixture variant and rejects mismatched flags", () => {
    const accepted = nativeFixture(true);
    expect(initializeIsolatedSmoke(accepted.app,accepted.env)).toBe(true);
    const mismatched = nativeFixture();
    mismatched.env.ANYCODE_ISOLATED_ORCHESTRATION_FIXTURES = "1";
    expect(() => initializeIsolatedSmoke(mismatched.app,mismatched.env)).toThrow("startup aborted");
    const unsupported = nativeFixture(true);
    unsupported.env.ANYCODE_ISOLATED_ORCHESTRATION_FIXTURES = "2";
    expect(() => initializeIsolatedSmoke(unsupported.app,unsupported.env)).toThrow("startup aborted");
  });
  it("admits only exact native fixture copies in the explicit development mode", () => {
    const { app, env, root } = nativeFixture();
    expect(initializeIsolatedSmoke(app, env)).toBe(true);
    const fs = isolatedNativeBinaryFs(root);
    expect(fs.stat(join(root, "codex-double")).isFile()).toBe(true);
    expect(() => fs.stat(process.execPath)).toThrow("allowlist");
    expect(() => fs.realpath(join(root, "unavailable-engine"))).toThrow("allowlist");
    expect(fs.readdir(root)).toEqual([]);
  });
  it.each(["bytes", "extra", "path", "flag", "interpreter", "packaged"])("rejects native fixture fault: %s", fault => {
    const { app, env, root } = nativeFixture();
    if (fault === "bytes") writeFileSync(join(root, "codex-double"), "#!/bin/sh\nexit 0\n");
    if (fault === "extra") writeFileSync(join(root, "unreviewed"), "fixture");
    if (fault === "path") env.ANYCODE_CODEX_BIN = process.execPath;
    if (fault === "flag") delete env.ANYCODE_ENGINE_SWITCH_ENABLED;
    if (fault === "interpreter") env.ANYCODE_ISOLATED_FIXTURE_NODE = "/bin/sh";
    if (fault === "packaged") app.isPackaged = true;
    expect(() => initializeIsolatedSmoke(app, env)).toThrow("startup aborted");
    expect(app.setPath).not.toHaveBeenCalled();
  });
  it("aborts before setting an Electron path when directory creation fails", () => {
    const { app, env } = fixture();
    const makeDirectory = vi.fn(() => { throw new Error("synthetic failure"); });
    expect(() => initializeIsolatedSmoke(app, env, makeDirectory)).toThrow("startup aborted");
    expect(makeDirectory).toHaveBeenCalledOnce();
    expect(app.setPath).not.toHaveBeenCalled();
    expect(app.getPath).not.toHaveBeenCalled();
  });
  it("uses fixture storage without any operating system dependency", () => {
    expect(isolatedSmokeStorage.isEncryptionAvailable()).toBe(true);
    expect(isolatedSmokeStorage.decryptString(isolatedSmokeStorage.encryptString("fake-key"))).toBe("fake-key");
  });
});

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PROXY_ENV_KEYS, SESSION_ENV_KEYS } from "./boot-test-env.js";

vi.mock("./workspace-trust.js", () => ({
  establishHostWorkspaceTrust: async () => { throw new Error("authentication failed"); },
}));

it("records a failure from the real host boot catch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-boot-diagnostic-"));
  const oldArgv = process.argv;
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  try {
    // vi.stubEnv writes through `process.env[name]` (a REAL mutation, so
    // os.homedir() follows it); `process.env = {...}` would only swap the JS
    // object and leave the host pointed at the developer's real ~/.anycode.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ANYCODE_")) vi.stubEnv(key, undefined);
    }
    // Boot CREATES the session pair when it is absent, so an unstubbed key would
    // never be recorded for restoration and would survive cleanup.
    for (const key of SESSION_ENV_KEYS) vi.stubEnv(key, undefined);
    // Boot scans the proxy family BEFORE the trust gate this test mocks to
    // fail: a credentialed ambient HTTP(S)_PROXY would still bind a loopback
    // relay and tie the test to the developer's shell.
    for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, undefined);
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
    vi.stubEnv("XDG_CACHE_HOME", join(dir, "cache"));
    vi.stubEnv("ANYCODE_DIAGNOSTICS_DIR", dir);
    vi.stubEnv("ANYCODE_DB_PATH", join(dir, "anycode.sqlite"));
    vi.stubEnv("ANYCODE_SETTINGS_PATH", join(dir, "settings.json"));
    process.argv = [process.execPath, "host", "--session", "boot-test"];
    Object.defineProperty(process, "parentPort", { configurable: true, value: { on: () => {}, postMessage: () => {} } });
    await import("./index.js");
    let diagnostic = "";
    for (let i = 0; i < 100; i++) {
      try { diagnostic = await readFile(join(dir, "boot-test.jsonl"), "utf8"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    expect(JSON.parse(diagnostic)).toMatchObject({ code: "auth" });
    // Evidence that no shutdown barrier is needed here (unlike the effort boot):
    // the mocked trust gate throws before the DB path is even read, so the boot
    // never reached the database and no in-flight host can read the restored
    // environment afterwards.
    expect(existsSync(join(dir, "anycode.sqlite"))).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    process.argv = oldArgv;
    if (oldPort) Object.defineProperty(process, "parentPort", oldPort);
    else Reflect.deleteProperty(process, "parentPort");
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

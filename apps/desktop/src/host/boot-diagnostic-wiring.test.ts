import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

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
  } finally {
    vi.unstubAllEnvs();
    process.argv = oldArgv;
    if (oldPort) Object.defineProperty(process, "parentPort", oldPort);
    else Reflect.deleteProperty(process, "parentPort");
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

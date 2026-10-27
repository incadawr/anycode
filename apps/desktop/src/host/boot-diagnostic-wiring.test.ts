import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("./workspace-trust.js", () => ({
  establishHostWorkspaceTrust: async () => { throw new Error("authentication failed"); },
}));

it("records a failure from the real host boot catch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-boot-diagnostic-"));
  const oldEnv = { ...process.env };
  const oldArgv = process.argv;
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    process.env.ANYCODE_DIAGNOSTICS_DIR = dir;
    process.argv = [process.execPath, "host", "--session", "boot-test"];
    Object.defineProperty(process, "parentPort", { configurable: true, value: { on: () => {}, postMessage: () => {} } });
    await import("./index.js");
    let diagnostic = "";
    for (let i = 0; i < 100; i++) {
      try { diagnostic = await readFile(join(dir, "boot-test.jsonl"), "utf8"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    expect(JSON.parse(diagnostic)).toMatchObject({ code: "auth" });
  } finally {
    process.env = oldEnv;
    process.argv = oldArgv;
    if (oldPort) Object.defineProperty(process, "parentPort", oldPort);
    else Reflect.deleteProperty(process, "parentPort");
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

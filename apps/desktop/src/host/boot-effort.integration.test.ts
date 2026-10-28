import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

class FakePort extends EventEmitter {
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  send(message: unknown) { this.emit("message", { data: message }); }
}

/**
 * Hermetic environment for a test that boots the REAL host.
 *
 * `process.env = {...}` only swaps the JS object: it does NOT reach the C
 * environment, so `os.homedir()` keeps returning the developer's real home and
 * the host opens the real `~/.anycode/anycode.sqlite` (a phantom project in the
 * real sidebar on every run). `vi.stubEnv` writes through `process.env[name]`,
 * a real mutation that `os.homedir()` follows — and `vi.unstubAllEnvs()` undoes
 * it. Every path input the host honours is pinned to the throwaway dir too.
 */
describe("host boot effort selection", () => {
  it("retains a saved off selection when switching from GLM-5.2 to GLM-5.3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-effort-test-"));
    const dbPath = join(dir, "anycode.sqlite");
    const oldCwd = process.cwd();
    const parent = new EventEmitter() as EventEmitter & { postMessage: (value: unknown) => void };
    parent.postMessage = () => {};
    const oldParent = (process as any).parentPort;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    try {
      // Ambient ANYCODE_* from the developer's shell must not shape this boot.
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("ANYCODE_")) vi.stubEnv(key, undefined);
      }
      vi.stubEnv("HOME", dir);
      vi.stubEnv("USERPROFILE", dir);
      vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
      vi.stubEnv("XDG_CACHE_HOME", join(dir, "cache"));
      vi.stubEnv("ANYCODE_MODEL", "glm-5.2");
      vi.stubEnv("ANYCODE_BASE_URL", "https://api.z.ai/api/anthropic");
      vi.stubEnv("ANYCODE_API_KEY", "test");
      vi.stubEnv("ANYCODE_REASONING_EFFORT", "off");
      vi.stubEnv("ANYCODE_SETTINGS_PATH", join(dir, "settings.json"));
      vi.stubEnv("ANYCODE_DB_PATH", dbPath);
      vi.stubEnv("ANYCODE_DIAGNOSTICS_DIR", join(dir, "diagnostics"));
      process.chdir(dir);
      (process as any).parentPort = parent;
      await import("./index.js");
      const port = new FakePort();
      parent.emit("message", { ports: [port], data: {} });
      await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
      port.send({ type: "ui_ready" });
      await vi.waitFor(() => expect(port.messages.some((m) => m.type === "host_ready")).toBe(true));
      expect(port.messages.find((m) => m.type === "host_ready").reasoningEffort).toBe("off");
      expect(port.messages.find((m) => m.type === "host_ready")).not.toHaveProperty("reasoningEffortDefault");
      port.send({ type: "set_model", model: "glm-5.3" });
      await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed")).toBe(true));
      expect(port.messages.find((m) => m.type === "model_changed").reasoningEffort).toBe("off");
      expect(port.messages.find((m) => m.type === "model_changed")).not.toHaveProperty("reasoningEffortDefault");
      parent.emit("message", { ports: [], data: { type: "shutdown" } });
      await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 15000 });
      // Guard: the host wrote its session into the TEMP database (proves it never
      // fell back to the developer's real ~/.anycode/anycode.sqlite).
      expect(existsSync(dbPath)).toBe(true);
      expect(statSync(dbPath).size).toBeGreaterThan(0);
    } finally {
      process.chdir(oldCwd);
      vi.unstubAllEnvs();
      (process as any).parentPort = oldParent;
      exit.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

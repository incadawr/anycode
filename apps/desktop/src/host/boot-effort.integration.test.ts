import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

class FakePort extends EventEmitter {
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  send(message: unknown) { this.emit("message", { data: message }); }
}

describe("host boot effort selection", () => {
  it("retains a saved off selection when switching from GLM-5.2 to GLM-5.3", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".effort-test-"));
    const oldCwd = process.cwd();
    const oldEnv = process.env;
    const parent = new EventEmitter() as EventEmitter & { postMessage: (value: unknown) => void };
    parent.postMessage = () => {};
    const oldParent = (process as any).parentPort;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    try {
      process.chdir(dir);
      process.env = { PATH: oldEnv.PATH, HOME: dir, ANYCODE_MODEL: "glm-5.2", ANYCODE_BASE_URL: "https://api.z.ai/api/anthropic", ANYCODE_API_KEY: "test", ANYCODE_REASONING_EFFORT: "off", ANYCODE_SETTINGS_PATH: join(dir, "settings.json") };
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
    } finally {
      process.chdir(oldCwd);
      process.env = oldEnv;
      (process as any).parentPort = oldParent;
      exit.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

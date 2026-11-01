import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { UtilityProcess } from "electron";

const faults = vi.hoisted(() => ({ write: false, close: false, closes: 0 }));
vi.mock("node:fs", async (load) => {
  const fs = await load<typeof import("node:fs")>();
  return {
    ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (faults.write) throw new Error("injected append failure");
      return (fs.writeSync as (...args: unknown[]) => number)(...args);
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      faults.closes++;
      if (faults.close) throw new Error("injected close failure");
    },
  };
});

import { recordHostFailure } from "../host/error-diagnostics.js";
import { TabHostManager } from "./tabs.js";

afterEach(() => { faults.write = false; faults.close = false; faults.closes = 0; });

it.each(["write", "close"] as const)("respawns after diagnostics %s failure", (failure) => {
  const dir = mkdtempSync(join(tmpdir(), "host-diag-fault-"));
  try {
    const hosts: EventEmitter[] = [];
    const manager = new TabHostManager({
      fork: () => {
        const host = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn(), pid: hosts.length + 1 });
        hosts.push(host);
        return host as unknown as UtilityProcess;
      },
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as never, port2: {} as never }),
      getWindow: () => ({ isDestroyed: () => false, webContents: { postMessage() {}, send() {} } }),
      env: () => ({}), logger: { log() {}, warn() {}, error() {} },
      recordHostFailure: (id, reason, code, stderr) => recordHostFailure(dir, id, reason, code, stderr),
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "fault", resume: false });
    if (!created.ok) throw new Error("create failed");
    faults[failure] = true;
    expect(() => hosts[0]!.emit("exit", 17)).not.toThrow();
    expect(faults.closes).toBe(1);
    expect(hosts).toHaveLength(2);
    expect(created.tab.proc).toBe(hosts[1]);
    expect(created.tab.state).toBe("running");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

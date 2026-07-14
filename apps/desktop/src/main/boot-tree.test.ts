/**

 * the `not_ready` spawn guard (never spawn a keyless host), the readiness flip
 * (unconfigured -> ready re-enables createTab), and the fresh-env-per-fork
 * discipline (a rotated key persisted to the vault is read on the next respawn).
 * The full deferred-auto-tab wiring lives in main/index.ts (electron top-level,
 * un-importable); this covers the pieces it composes.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { UtilityProcess } from "electron";
import { TabHostManager, type HostForkFn, type TabLogger, type WindowLike } from "./tabs.js";

const silentLogger: TabLogger = { log() {}, warn() {}, error() {} };

let pidSeq = 0;
class FakeHost extends EventEmitter {
  readonly pid = ++pidSeq;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

function liveFork(hosts: FakeHost[]): HostForkFn {
  return () => {
    const host = new FakeHost();
    hosts.push(host);
    queueMicrotask(() => host.emit("spawn"));
    return host as unknown as UtilityProcess;
  };
}

function window(): WindowLike {
  return {
    isDestroyed: () => false,
    webContents: { postMessage: () => {}, send: () => {} },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("TabHostManager — provider readiness guard (R2 step 7)", () => {
  it("refuses createTab with not_ready and spawns nothing when not ready", () => {
    const hosts: FakeHost[] = [];
    const manager = new TabHostManager({
      fork: liveFork(hosts),
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as never, port2: {} as never }),
      getWindow: () => window(),
      env: () => ({}),
      providerReady: () => false,
      logger: silentLogger,
    });

    expect(manager.canSpawn()).toBe(false);
    const r = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    expect(r).toEqual({ ok: false, reason: "not_ready" });
    expect(hosts).toHaveLength(0);
    expect(manager.count()).toBe(0);
  });

  it("createTab succeeds after readiness flips true", () => {
    const hosts: FakeHost[] = [];
    let ready = false;
    const manager = new TabHostManager({
      fork: liveFork(hosts),
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as never, port2: {} as never }),
      getWindow: () => window(),
      env: () => ({}),
      providerReady: () => ready,
      logger: silentLogger,
    });

    expect(manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false }).ok).toBe(false);
    ready = true; // simulate a successful secret-set flipping readiness
    const r = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    expect(r.ok).toBe(true);
    expect(manager.count()).toBe(1);
  });

  it("defaults to ready when no gate is injected (pre-2.2 behaviour)", () => {
    const hosts: FakeHost[] = [];
    const manager = new TabHostManager({
      fork: liveFork(hosts),
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as never, port2: {} as never }),
      getWindow: () => window(),
      env: () => ({}),
      logger: silentLogger,
    });
    expect(manager.canSpawn()).toBe(true);
    expect(manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false }).ok).toBe(true);
  });
});

describe("TabHostManager — fresh env per fork (I3, key rotation)", () => {
  it("evaluates the env function on every fork so a respawn picks up a rotated key", async () => {
    // A dying fork forces respawns; a counter-based env proves each fork read fresh.
    let seq = 0;
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      queueMicrotask(() => host.emit("exit", 1));
      return host as unknown as UtilityProcess;
    });
    const manager = new TabHostManager({
      fork: forkSpy,
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as never, port2: {} as never }),
      getWindow: () => window(),
      env: () => ({ ANYCODE_API_KEY: `rotated-${seq++}` }),
      providerReady: () => true,
      logger: silentLogger,
    });

    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();

    // At least two forks happened (initial + respawns), each with a distinct key.
    expect(forkSpy.mock.calls.length).toBeGreaterThan(1);
    const key0 = forkSpy.mock.calls[0]?.[2]?.env?.ANYCODE_API_KEY;
    const key1 = forkSpy.mock.calls[1]?.[2]?.env?.ANYCODE_API_KEY;
    expect(key0).toBe("rotated-0");
    expect(key1).toBe("rotated-1");
    expect(key0).not.toBe(key1);
  });
});

describe("TabHostManager — worktree relocation", () => {
  it("gracefully rehosts the same tab/session in the worktree and forwards deferred cleanup", async () => {
    const hosts: FakeHost[] = [];
    const forkSpy = vi.fn(liveFork(hosts));
    const manager = new TabHostManager({
      fork: forkSpy,
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as never, port2: {} as never }),
      getWindow: () => window(),
      env: () => ({}),
      logger: silentLogger,
    });
    const created = manager.createTab({ workspace: "/repo", sessionId: "s1", resume: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = hosts[0]!;
    first.postMessage.mockImplementation((message: { type?: string }) => {
      if (message.type === "shutdown") queueMicrotask(() => first.emit("exit", 0));
    });

    first.emit("message", {
      type: "anycode:worktree-transition",
      sessionId: "s1",
      fromWorkspace: "/repo",
      toWorkspace: "/repo/.anycode/worktrees/task-5",
      projectRoot: "/repo",
      worktree: {
        id: "task-5",
        path: "/repo/.anycode/worktrees/task-5",
        branch: "anycode-wt/task-5",
        baseRef: "HEAD",
        ownedByAnyCode: true,
      },
    });
    await flush();

    expect(hosts).toHaveLength(2);
    expect(forkSpy.mock.calls[1]?.[0]).toBe("/fake/host.js");
    expect(forkSpy.mock.calls[1]?.[1]).toEqual(["--resume", "s1"]);
    expect(forkSpy.mock.calls[1]?.[2]?.cwd).toBe("/repo/.anycode/worktrees/task-5");
    expect(manager.getTab(created.tab.tabId)).toMatchObject({
      sessionId: "s1",
      workspace: "/repo/.anycode/worktrees/task-5",
      projectRoot: "/repo",
      state: "running",
    });

    const second = hosts[1]!;
    second.postMessage.mockImplementation((message: { type?: string }) => {
      if (message.type === "shutdown") queueMicrotask(() => second.emit("exit", 0));
    });
    second.emit("message", {
      type: "anycode:worktree-transition",
      sessionId: "s1",
      fromWorkspace: "/repo/.anycode/worktrees/task-5",
      toWorkspace: "/repo",
      projectRoot: "/repo",
      cleanup: {
        path: "/repo/.anycode/worktrees/task-5",
        mode: "auto",
        ownedByAnyCode: true,
        branch: "anycode-wt/task-5",
      },
    });
    await flush();

    expect(forkSpy.mock.calls[2]?.[2]?.cwd).toBe("/repo");
    expect(forkSpy.mock.calls[2]?.[2]?.env?.ANYCODE_WORKTREE_CLEANUP_JSON).toContain('"mode":"auto"');
    expect(forkSpy.mock.calls[2]?.[2]?.env?.ANYCODE_WORKTREE_CLEANUP_JSON).toContain('"branch":"anycode-wt/task-5"');
    expect(manager.getTab(created.tab.tabId)).toMatchObject({ workspace: "/repo", projectRoot: "/repo" });
    expect(manager.getTab(created.tab.tabId)?.worktree).toBeUndefined();
  });
});

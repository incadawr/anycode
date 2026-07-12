/**
 * manager.test.ts (slice 6.1 B7): LspManager against the REAL fixture via
 * NodeExecutionAdapter — the full model-facing outcome matrix and the hostile
 * server suite (§6#3/#4):
 *   - no_server (no matching extension / no spawnPersistent),
 *   - happy diagnostics + clean-file empty publish,
 *   - initializing (server slow past the edit budget) — §6#4a,
 *   - timeout (server publishes a foreign URI) — §6#4d,
 *   - server_failed + exactly-one spawn / no respawn (--exit-now, --garbage) — §6#4b/#4e,
 *   - lazy-spawn (no spawn before the first matching touch),
 *   - extension match (first spec wins) + LSP_MAX_SERVERS cap,
 *   - disposeAll bounded, all servers reaped incl. SIGKILL escalation — §6#3.
 *

 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { LspManager } from "./manager.js";
import { LSP_DISPOSE_DEADLINE_MS, LSP_MAX_SERVERS } from "../types/config.js";
import type { ExecutionPort, PersistentChildHandle, PersistentChildRequest } from "../ports/execution.js";
import type { LspServerSpec } from "../ports/lsp.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-lsp-server.cjs", import.meta.url));
const CWD = process.cwd();

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

/** ExecutionPort delegating to the real adapter but counting spawnPersistent calls (no-respawn / lazy-spawn proofs). */
function spyExec(): { exec: ExecutionPort; spawnCount: () => number } {
  const adapter = new NodeExecutionAdapter();
  let count = 0;
  const exec: ExecutionPort = {
    run: adapter.run.bind(adapter),
    runBinary: adapter.runBinary!.bind(adapter),
    spawnPersistent: (req: PersistentChildRequest): PersistentChildHandle => {
      count += 1;
      return adapter.spawnPersistent!(req);
    },
  };
  return { exec, spawnCount: () => count };
}

function tsSpec(name: string, flags: string[] = []): LspServerSpec {
  return { name, command: process.execPath, args: [FIXTURE, ...flags], extensions: [".ts"] };
}

describe("LspManager (fixture integration)", () => {
  const managers: LspManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.map((m) => m.disposeAll()));
    managers.length = 0;
  });

  function makeManager(specs: LspServerSpec[], exec?: ExecutionPort): LspManager {
    const manager = new LspManager(exec ?? new NodeExecutionAdapter(), specs, CWD);
    managers.push(manager);
    return manager;
  }

  it("returns no_server when no spec matches the file extension", async () => {
    const manager = makeManager([tsSpec("ts")]);
    const outcome = await manager.diagnosticsAfterWrite("/proj/script.py", "print(1)\n");
    expect(outcome).toEqual({ available: false, reason: "no_server" });
  });

  it("returns no_server when the ExecutionPort cannot spawn persistent children", async () => {
    const execWithoutSpawn: ExecutionPort = { run: async () => ({ status: "completed", exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 0 }) };
    const manager = makeManager([tsSpec("ts")], execWithoutSpawn);
    const outcome = await manager.diagnosticsAfterWrite("/proj/a.ts", "x\n");
    expect(outcome).toEqual({ available: false, reason: "no_server" });
  });

  it("does not spawn a server until the first matching write (lazy-spawn)", async () => {
    const { exec, spawnCount } = spyExec();
    const manager = makeManager([tsSpec("ts")], exec);
    expect(spawnCount()).toBe(0);
    expect(manager.status()[0]!.state).toBe("not_started");
    // A non-matching file must not spawn anything either.
    await manager.diagnosticsAfterWrite("/proj/readme.py", "x\n");
    expect(spawnCount()).toBe(0);
  });

  it(
    "spawns lazily, initializes, and returns an error diagnostic for a DIAG marker",
    async () => {
      const { exec, spawnCount } = spyExec();
      const manager = makeManager([tsSpec("ts")], exec);
      const outcome = await manager.diagnosticsAfterWrite("/proj/edit.ts", "ok\nDIAG:type mismatch\n");
      expect(outcome.available).toBe(true);
      if (outcome.available) {
        expect(outcome.diagnostics).toHaveLength(1);
        expect(outcome.diagnostics[0]!.severity).toBe("error");
        expect(outcome.diagnostics[0]!.line).toBe(2);
        expect(outcome.diagnostics[0]!.message).toBe("type mismatch");
      }
      expect(spawnCount()).toBe(1);
      expect(manager.status()[0]!.state).toBe("ready");
      expect(manager.status()[0]!.pid).toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    "returns available with an empty diagnostics list for a clean file (didChange on the same server)",
    async () => {
      const manager = makeManager([tsSpec("ts")]);
      const first = await manager.diagnosticsAfterWrite("/proj/f.ts", "DIAG:boom\n");
      expect(first.available).toBe(true);
      const clean = await manager.diagnosticsAfterWrite("/proj/f.ts", "clean code\n");
      expect(clean).toEqual({ available: true, diagnostics: [] });
    },
    15_000,
  );

  it(
    "returns reason:initializing (no crash) when the server does not finish init within the edit budget (§6#4a)",
    async () => {
      const manager = makeManager([tsSpec("slow", ["--no-init-reply"])]);
      const outcome = await manager.diagnosticsAfterWrite("/proj/slow.ts", "x\n");
      expect(outcome).toEqual({ available: false, reason: "initializing" });
      expect(manager.status()[0]!.state).toBe("initializing");
    },
    15_000,
  );

  it(
    "returns reason:timeout when the server publishes for a foreign URI (§6#4d)",
    async () => {
      const manager = makeManager([tsSpec("wrong", ["--wrong-uri"])]);
      const outcome = await manager.diagnosticsAfterWrite("/proj/mine.ts", "DIAG:not attributed\n");
      expect(outcome).toEqual({ available: false, reason: "timeout" });
    },
    15_000,
  );

  it(
    "marks a server crashed on immediate exit and never respawns it (§6#4e)",
    async () => {
      const { exec, spawnCount } = spyExec();
      const manager = makeManager([tsSpec("dead", ["--exit-now"])], exec);
      const first = await manager.diagnosticsAfterWrite("/proj/a.ts", "x\n");
      expect(first).toEqual({ available: false, reason: "server_failed" });
      expect(manager.status()[0]!.state).toBe("crashed");

      const second = await manager.diagnosticsAfterWrite("/proj/a.ts", "y\n");
      expect(second).toEqual({ available: false, reason: "server_failed" });
      // Exactly one spawn attempt — no restart storm.
      expect(spawnCount()).toBe(1);
    },
    15_000,
  );

  it(
    "marks a server crashed on a garbage stream and fails subsequent edits fast (§6#4b)",
    async () => {
      const { exec, spawnCount } = spyExec();
      const manager = makeManager([tsSpec("garbage", ["--garbage"])], exec);
      const first = await manager.diagnosticsAfterWrite("/proj/a.ts", "x\n");
      expect(first).toEqual({ available: false, reason: "server_failed" });
      expect(manager.status()[0]!.state).toBe("crashed");
      const second = await manager.diagnosticsAfterWrite("/proj/a.ts", "y\n");
      expect(second).toEqual({ available: false, reason: "server_failed" });
      expect(spawnCount()).toBe(1);
    },
    15_000,
  );

  it("matches the first spec that owns the extension and never spawns the shadowed one", async () => {
    const { exec } = spyExec();
    const manager = makeManager([tsSpec("first"), tsSpec("second")], exec);
    const outcome = await manager.diagnosticsAfterWrite("/proj/a.ts", "DIAG:e\n");
    expect(outcome.available).toBe(true);
    const status = manager.status();
    expect(status[0]!.name).toBe("first");
    expect(status[0]!.state).toBe("ready");
    expect(status[1]!.name).toBe("second");
    expect(status[1]!.state).toBe("not_started");
  });

  it("caps the number of managed servers at LSP_MAX_SERVERS", () => {
    const specs = Array.from({ length: LSP_MAX_SERVERS + 3 }, (_, i) => tsSpec(`s${i}`));
    const manager = makeManager(specs);
    expect(manager.status()).toHaveLength(LSP_MAX_SERVERS);
  });

  it(
    "disposeAll reaps every live server within the deadline, escalating to SIGKILL for a hostile one (§6#3)",
    async () => {
      const specs: LspServerSpec[] = [
        { name: "hostile", command: process.execPath, args: [FIXTURE, "--ignore-term"], extensions: [".ts"] },
        { name: "polite", command: process.execPath, args: [FIXTURE], extensions: [".js"] },
      ];
      const manager = new LspManager(new NodeExecutionAdapter(), specs, CWD);
      // Both become live+ready (--ignore-term still replies to initialize).
      expect((await manager.diagnosticsAfterWrite("/proj/a.ts", "DIAG:x\n")).available).toBe(true);
      expect((await manager.diagnosticsAfterWrite("/proj/b.js", "DIAG:y\n")).available).toBe(true);
      const status = manager.status();
      const hostilePid = status.find((s) => s.name === "hostile")!.pid!;
      const politePid = status.find((s) => s.name === "polite")!.pid!;

      const t0 = Date.now();
      await manager.disposeAll();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(LSP_DISPOSE_DEADLINE_MS + 750);
      expect(await waitPidDead(hostilePid, 5000)).toBe(true);
      expect(await waitPidDead(politePid, 5000)).toBe(true);
      expect(manager.status().every((s) => s.state === "disposed")).toBe(true);
    },
    20_000,
  );

  // -------------------------------------------------------------------------
  // Slice P7.25/F3: onStatusChange live-status notify (coalesced, fail-soft).
  // -------------------------------------------------------------------------

  /** Drains queued microtasks so a coalesced notifyStatusChange has fired. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }

  /**
   * Stub ExecutionPort that spawns a child which never replies to initialize
   * (so the server stays `initializing`) and captures its onStderr/onExit
   * callbacks for manual driving — isolates a stderr append from any state
   * transition.
   */
  function stubExec(): {
    exec: ExecutionPort;
    capture: { onStderr?: (t: string) => void; onExit?: (i: { code: number | null; signal: string | null }) => void };
  } {
    const capture: {
      onStderr?: (t: string) => void;
      onExit?: (i: { code: number | null; signal: string | null }) => void;
    } = {};
    const exec: ExecutionPort = {
      run: async () => ({
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      }),
      spawnPersistent: (req: PersistentChildRequest): PersistentChildHandle => {
        capture.onStderr = req.onStderr;
        capture.onExit = req.onExit;
        return { pid: 4242, exited: false, write: () => {}, kill: async () => {} };
      },
    };
    return { exec, capture };
  }

  it(
    "notifies onStatusChange on the initializing and ready transitions",
    async () => {
      let calls = 0;
      const manager = new LspManager(new NodeExecutionAdapter(), [tsSpec("ts")], CWD, () => {
        calls += 1;
      });
      managers.push(manager);
      const outcome = await manager.diagnosticsAfterWrite("/proj/a.ts", "clean code\n");
      await flushMicrotasks();
      expect(outcome.available).toBe(true);
      expect(manager.status()[0]!.state).toBe("ready");
      // Two distinct bursts (initializing, then ready in a later tick).
      expect(calls).toBe(2);
    },
    15_000,
  );

  it(
    "notifies onStatusChange on a crash transition",
    async () => {
      let calls = 0;
      const manager = new LspManager(new NodeExecutionAdapter(), [tsSpec("dead", ["--exit-now"])], CWD, () => {
        calls += 1;
      });
      managers.push(manager);
      await manager.diagnosticsAfterWrite("/proj/a.ts", "x\n");
      await flushMicrotasks();
      expect(manager.status()[0]!.state).toBe("crashed");
      // initializing + crashed (both genuine transitions).
      expect(calls).toBeGreaterThanOrEqual(2);
    },
    15_000,
  );

  it("coalesces a disposeAll of N servers into a single onStatusChange fire", async () => {
    let calls = 0;
    const specs = [tsSpec("a"), tsSpec("b"), tsSpec("c")];
    const manager = new LspManager(new NodeExecutionAdapter(), specs, CWD, () => {
      calls += 1;
    });
    // Not pushed to `managers`: disposed explicitly here; a second afterEach
    // dispose would be a no-op (already disposed) anyway.
    await manager.disposeAll();
    await flushMicrotasks();
    // Three not_started -> disposed transitions collapse into ONE burst.
    expect(calls).toBe(1);
    expect(manager.status().every((s) => s.state === "disposed")).toBe(true);
  });

  it("does NOT notify onStatusChange on a stderr-tail append (not a state transition)", async () => {
    let calls = 0;
    const { exec, capture } = stubExec();
    const manager = new LspManager(exec, [tsSpec("ts")], CWD, () => {
      calls += 1;
    });
    // Spawn happens synchronously at the head of diagnosticsAfterWrite (state ->
    // initializing); the stub never replies so it stays initializing until the
    // diagnostics budget expires. Do not await yet — capture the pending promise.
    const pending = manager.diagnosticsAfterWrite("/proj/a.ts", "x\n").catch(() => undefined);
    await flushMicrotasks();
    expect(manager.status()[0]!.state).toBe("initializing");
    expect(calls).toBe(1); // the initializing transition

    capture.onStderr!("boot warning: something\n");
    capture.onStderr!("more noise\n");
    await flushMicrotasks();
    expect(manager.status()[0]!.stderrTail).toContain("boot warning");
    expect(calls).toBe(1); // stderr appends did NOT notify

    await pending; // let the 3s diagnostics budget settle (no leaked timer)
  }, 10_000);

  it(
    "a throwing status listener never breaks manager transitions (fail-soft)",
    async () => {
      const manager = new LspManager(new NodeExecutionAdapter(), [tsSpec("ts")], CWD, () => {
        throw new Error("listener boom");
      });
      managers.push(manager);
      const outcome = await manager.diagnosticsAfterWrite("/proj/a.ts", "clean code\n");
      await flushMicrotasks();
      // Despite the listener throwing on every transition, init reached ready
      // and the diagnostics outcome is intact.
      expect(outcome.available).toBe(true);
      expect(manager.status()[0]!.state).toBe("ready");
    },
    15_000,
  );

  it(
    "swallows an async status listener's rejection — never surfaces as an unhandled rejection (W1-FIX)",
    async () => {
      const rejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);
      try {
        // The listener is typed () => void, but a rogue caller can hand a real
        // async function — its returned promise rejects on every transition.
        const manager = new LspManager(new NodeExecutionAdapter(), [tsSpec("ts")], CWD, async () => {
          throw new Error("async listener boom");
        });
        managers.push(manager);
        const outcome = await manager.diagnosticsAfterWrite("/proj/a.ts", "clean code\n");
        await flushMicrotasks();
        // One more macrotask so a real (unfixed) unhandled rejection has had a
        // chance to fire before the assertion below.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(rejections).toHaveLength(0);
        // Despite the async listener rejecting on every transition, init still

        expect(outcome.available).toBe(true);
        expect(manager.status()[0]!.state).toBe("ready");
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    },
    15_000,
  );

  it(
    "records the server stderr tail in status for /lsp troubleshooting",
    async () => {
      // A server that writes to stderr before crashing surfaces its tail.
      const spec: LspServerSpec = {
        name: "noisy",
        command: process.execPath,
        args: ["-e", "process.stderr.write('boot failure detail'); process.exit(3);"],
        extensions: [".ts"],
      };
      const manager = makeManager([spec]);
      const outcome = await manager.diagnosticsAfterWrite("/proj/a.ts", "x\n");
      expect(outcome.available).toBe(false);
      expect(manager.status()[0]!.stderrTail).toContain("boot failure detail");
    },
    15_000,
  );
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { InProcessTaskManager } from "./manager.js";
import {
  BACKGROUND_DISPOSE_DEADLINE_MS,
  BACKGROUND_TASK_BUFFER_MAX_BYTES,
  MAX_CONCURRENT_BACKGROUND_TASKS,
} from "../types/config.js";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `predicate` until it is true or the deadline passes; returns the final value. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/** Polls until `pid` is reaped (ESRCH) or the deadline, tolerating OS reap lag. */
async function waitPidDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  return waitFor(() => !isPidAlive(pid), timeoutMs);
}

/** Polls until the pid file exists and holds a valid pid, then returns it (NaN on timeout). */
async function readPid(pidFile: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = (await readFile(pidFile, "utf-8")).trim();
      const n = Number(text);
      if (text.length > 0 && !Number.isNaN(n)) return n;
    } catch {
      // pid file not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return NaN;
}

describe("InProcessTaskManager", () => {
  const exec = new NodeExecutionAdapter();
  let tmpDir: string;
  let manager: InProcessTaskManager;

  afterEach(async () => {
    // Reap any survivors so the test suite itself leaves zero orphans.
    await manager?.disposeAll();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function fresh(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-tasks-"));
    manager = new InProcessTaskManager(exec);
  }

  it("runs a short command to completion and maps status/exit + queues one notice", async () => {
    await fresh();
    const res = manager.start({ command: "echo hi", cwd: tmpDir });
    expect(res.ok).toBe(true);
    const taskId = res.ok ? res.taskId : "";
    expect(taskId).toBe("task-1");

    await waitFor(() => manager.get(taskId)?.status === "completed");
    const snap = manager.get(taskId);
    expect(snap?.status).toBe("completed");
    expect(snap?.exitCode).toBe(0);
    expect(snap?.endedAt).toBeGreaterThanOrEqual(snap!.startedAt);

    const notices = manager.drainNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ taskId, status: "completed", exitCode: 0 });
    expect(notices[0]!.durationMs).toBeGreaterThanOrEqual(0);
    // exactly-once: a second drain is empty
    expect(manager.drainNotices()).toHaveLength(0);
  });

  it("maps a non-zero exit to failed with the exit code", async () => {
    await fresh();
    const res = manager.start({ command: "exit 7", cwd: tmpDir });
    const taskId = res.ok ? res.taskId : "";
    await waitFor(() => manager.get(taskId)?.status === "failed");
    const snap = manager.get(taskId);
    expect(snap?.status).toBe("failed");
    expect(snap?.exitCode).toBe(7);
  });

  it("maps an unspawnable command (bad cwd) to spawn_error", async () => {
    await fresh();
    const res = manager.start({ command: "echo hi", cwd: join(tmpDir, "does-not-exist-xyz") });
    const taskId = res.ok ? res.taskId : "";
    await waitFor(() => manager.get(taskId)?.status === "spawn_error");
    expect(manager.get(taskId)?.status).toBe("spawn_error");
    const notices = manager.drainNotices();
    expect(notices[0]?.status).toBe("spawn_error");
  });

  // §6#1 — orphan étude: kill reaps the whole process group (pid ESRCH).
  it(
    "kills a live background task and leaves no orphaned process",
    async () => {
      await fresh();
      const pidFile = join(tmpDir, "pid.txt");
      // `exec sleep` replaces the shell image, so $$ is the exact long-running pid.
      const res = manager.start({ command: `echo $$ > ${pidFile}; exec sleep 300`, cwd: tmpDir });
      const taskId = res.ok ? res.taskId : "";
      const pid = await readPid(pidFile);
      expect(Number.isNaN(pid)).toBe(false);
      expect(isPidAlive(pid)).toBe(true);
      expect(manager.get(taskId)?.status).toBe("running");

      expect(manager.kill(taskId)).toBe(true);
      expect(await waitPidDead(pid)).toBe(true);
      await waitFor(() => manager.get(taskId)?.status === "killed");
      expect(manager.get(taskId)?.status).toBe("killed");
      const notices = manager.drainNotices();
      expect(notices[0]?.status).toBe("killed");
    },
    20_000,
  );


  it(
    "escalates to SIGKILL for a TERM-ignoring background task",
    async () => {
      await fresh();
      const pidFile = join(tmpDir, "pid.txt");
      const res = manager.start({
        command: `echo $$ > ${pidFile}; trap '' TERM; while true; do sleep 0.2; done`,
        cwd: tmpDir,
      });
      const taskId = res.ok ? res.taskId : "";
      const pid = await readPid(pidFile);
      expect(isPidAlive(pid)).toBe(true);

      expect(manager.kill(taskId)).toBe(true);
      // SIGTERM is ignored; death only happens after the SIGKILL_GRACE escalation.
      expect(await waitPidDead(pid)).toBe(true);
      await waitFor(() => manager.get(taskId)?.status === "killed");
      expect(manager.get(taskId)?.status).toBe("killed");
    },
    20_000,
  );

  // §6#2 — disposeAll aborts all live tasks, reaps them, and is bounded.
  it(
    "disposeAll reaps every live task within the bounded deadline",
    async () => {
      await fresh();
      const pidA = join(tmpDir, "a.pid");
      const pidB = join(tmpDir, "b.pid");
      const pidC = join(tmpDir, "c.pid");
      manager.start({ command: `echo $$ > ${pidA}; exec sleep 300`, cwd: tmpDir });
      manager.start({ command: `echo $$ > ${pidB}; exec sleep 300`, cwd: tmpDir });
      // one TERM-ignoring task forces the SIGKILL escalation path inside the bound
      manager.start({
        command: `echo $$ > ${pidC}; trap '' TERM; while true; do sleep 0.2; done`,
        cwd: tmpDir,
      });

      const a = await readPid(pidA);
      const b = await readPid(pidB);
      const c = await readPid(pidC);
      expect(isPidAlive(a) && isPidAlive(b) && isPidAlive(c)).toBe(true);

      const started = Date.now();
      await manager.disposeAll();
      const elapsed = Date.now() - started;
      // Bounded: reaping (SIGTERM->750ms->SIGKILL) finishes well under the deadline,
      // and even the worst case never exceeds the deadline by more than close/flush slack.
      expect(elapsed).toBeLessThan(BACKGROUND_DISPOSE_DEADLINE_MS + 2000);

      expect(await waitPidDead(a)).toBe(true);
      expect(await waitPidDead(b)).toBe(true);
      expect(await waitPidDead(c)).toBe(true);
    },
    20_000,
  );


  // until an explicit kill. The manager wires no external abort signal.
  it(
    "keeps a task running until an explicit kill (independent lifecycle)",
    async () => {
      await fresh();
      const pidFile = join(tmpDir, "pid.txt");
      const res = manager.start({ command: `echo $$ > ${pidFile}; exec sleep 300`, cwd: tmpDir });
      const taskId = res.ok ? res.taskId : "";
      const pid = await readPid(pidFile);

      // Nothing external touches it: still running and alive after a real wait.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(manager.get(taskId)?.status).toBe("running");
      expect(isPidAlive(pid)).toBe(true);

      expect(manager.kill(taskId)).toBe(true);
      expect(await waitPidDead(pid)).toBe(true);
      expect(await waitFor(() => manager.get(taskId)?.status === "killed")).toBe(true);
    },
    20_000,
  );

  // §6#7 — readOutput cursor increments (marker-synchronized, not sleep-based).
  it(
    "returns the appended-since-last-read increment via a per-task cursor",
    async () => {
      await fresh();
      const goFile = join(tmpDir, "go");
      const res = manager.start({
        command: `echo A; while [ ! -f "${goFile}" ]; do sleep 0.05; done; echo B`,
        cwd: tmpDir,
      });
      const taskId = res.ok ? res.taskId : "";

      // poll via get() (does NOT advance the cursor) until "A\n" (2 bytes) is buffered
      await waitFor(() => (manager.get(taskId)?.outputBytes ?? 0) >= 2);
      const first = manager.readOutput(taskId);
      expect(first?.newOutput).toContain("A");
      expect(first?.newOutput).not.toContain("B");

      // release the second write
      await writeFile(goFile, "");
      await waitFor(() => (manager.get(taskId)?.outputBytes ?? 0) >= 4);
      const second = manager.readOutput(taskId);
      expect(second?.newOutput).toContain("B");

      await waitFor(() => manager.get(taskId)?.status === "completed");
      const third = manager.readOutput(taskId);
      expect(third?.newOutput).toBe("");
    },
    20_000,
  );

  // §6#7 — buffer cap: a flooding task truncates; memory stays bounded.
  it(
    "caps the per-task output buffer and flags truncation without growing unbounded",
    async () => {
      await fresh();
      // ~500KB emitted; the manager buffer must stop at BACKGROUND_TASK_BUFFER_MAX_BYTES.
      const res = manager.start({ command: "yes x | head -c 500000", cwd: tmpDir });
      const taskId = res.ok ? res.taskId : "";
      await waitFor(() => {
        const s = manager.get(taskId)?.status;
        return s === "completed" || s === "failed";
      });
      const snap = manager.get(taskId);
      expect(snap?.outputTruncated).toBe(true);
      expect(snap?.outputBytes).toBeLessThanOrEqual(BACKGROUND_TASK_BUFFER_MAX_BYTES);
    },
    20_000,
  );

  // §6#8 — an unknown or already-terminal task is unkillable; only registry ids are reachable.
  it("kill returns false for an unknown id and for an already-terminal task", async () => {
    await fresh();
    expect(manager.kill("task-999")).toBe(false);

    const res = manager.start({ command: "echo done", cwd: tmpDir });
    const taskId = res.ok ? res.taskId : "";
    await waitFor(() => manager.get(taskId)?.status === "completed");
    expect(manager.kill(taskId)).toBe(false); // already terminal
  });

  it("get/readOutput return undefined for an unknown id", async () => {
    await fresh();
    expect(manager.get("task-42")).toBeUndefined();
    expect(manager.readOutput("task-42")).toBeUndefined();
  });

  // §6#9 — concurrency cap is on running tasks; a finished task frees a slot.
  it(
    "enforces the running-task cap and frees a slot when a task ends",
    async () => {
      await fresh();
      const ids: string[] = [];
      for (let i = 0; i < MAX_CONCURRENT_BACKGROUND_TASKS; i += 1) {
        const r = manager.start({ command: "exec sleep 300", cwd: tmpDir });
        expect(r.ok).toBe(true);
        if (r.ok) ids.push(r.taskId);
      }
      expect(manager.list()).toHaveLength(MAX_CONCURRENT_BACKGROUND_TASKS);

      const overflow = manager.start({ command: "exec sleep 300", cwd: tmpDir });
      expect(overflow.ok).toBe(false);
      if (!overflow.ok) {
        expect(overflow.reason).toBe("limit_reached");
        expect(overflow.message.length).toBeGreaterThan(0);
      }

      // free a slot: kill one and wait until it is reaped (running count drops)
      expect(manager.kill(ids[0]!)).toBe(true);
      await waitFor(() => manager.get(ids[0]!)?.status === "killed");

      const afterFree = manager.start({ command: "exec sleep 300", cwd: tmpDir });
      expect(afterFree.ok).toBe(true);
    },
    25_000,
  );

  it("list() reports snapshots in monotonic task-N insertion order", async () => {
    await fresh();
    manager.start({ command: "exec sleep 300", cwd: tmpDir });
    manager.start({ command: "exec sleep 300", cwd: tmpDir });
    const ids = manager.list().map((s) => s.taskId);
    expect(ids).toEqual(["task-1", "task-2"]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGKILL_GRACE_MS } from "../../types/config.js";
import { NodeExecutionAdapter } from "./node-execution.js";

type PersistentExitInfo = { code: number | null; signal: string | null; spawnError?: string };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is reaped (or the deadline), tolerating the OS reap lag. */
async function waitPidDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

describe("NodeExecutionAdapter", () => {
  let tmpDir: string;
  const adapter = new NodeExecutionAdapter();

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("runs a command and captures stdout/exit code", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const result = await adapter.run({ command: "echo hello-world", cwd: tmpDir, timeoutMs: 5000 });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-world");
  });

  it("reports a non-zero exit code as failed", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const result = await adapter.run({ command: "exit 3", cwd: tmpDir, timeoutMs: 5000 });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("caps captured output and sets the truncated flag", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const result = await adapter.run({
      command: "yes x | head -c 1000",
      cwd: tmpDir,
      timeoutMs: 5000,
      maxOutputBytes: 100,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.stdoutTruncated).toBe(true);
  });

  it(
    "times out a long-running command and leaves no orphaned process",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const pidFile = join(tmpDir, "pid.txt");
      // `exec` replaces the shell's own process image with `sleep`, so the
      // recorded pid is the exact long-running process we must confirm dead.
      const result = await adapter.run({
        command: `echo $$ > ${pidFile} && exec sleep 5`,
        cwd: tmpDir,
        timeoutMs: 200,
      });
      expect(result.status).toBe("timed_out");
      expect(result.exitCode).toBeNull();

      const pid = Number((await readFile(pidFile, "utf-8")).trim());
      expect(Number.isNaN(pid)).toBe(false);
      expect(await waitPidDead(pid)).toBe(true);
    },
    10_000,
  );

  it(
    "cancels via abortSignal and leaves no orphaned process",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const pidFile = join(tmpDir, "pid.txt");
      const controller = new AbortController();
      const runPromise = adapter.run({
        command: `echo $$ > ${pidFile} && exec sleep 5`,
        cwd: tmpDir,
        timeoutMs: 10_000,
        abortSignal: controller.signal,
      });

      // give the shell time to spawn and write the pid file before aborting
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      const result = await runPromise;
      expect(result.status).toBe("cancelled");

      const pid = Number((await readFile(pidFile, "utf-8")).trim());
      expect(Number.isNaN(pid)).toBe(false);
      expect(await waitPidDead(pid)).toBe(true);
    },
    10_000,
  );

  it("resolves as cancelled without spawning when abortSignal is already aborted", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.run({
      command: "echo should-not-run",
      cwd: tmpDir,
      timeoutMs: 5000,
      abortSignal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("reports spawn_error for a non-existent working directory", async () => {
    const result = await adapter.run({
      command: "echo hi",
      cwd: join(tmpdir(), "anycode-exec-does-not-exist-xyz"),
      timeoutMs: 5000,
    });
    expect(result.status).toBe("spawn_error");
  });

  it("writes stdin to the child and closes it (EOF)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const result = await adapter.run({
      command: "cat",
      cwd: tmpDir,
      timeoutMs: 5000,
      stdin: "hello\n",
    });
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("hello\n");
  });

  it("delivers stdin larger than ARG_MAX (~2 MB) intact, beyond an env/argv-based channel", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const big = "x".repeat(2 * 1024 * 1024);
    const result = await adapter.run({
      command: "wc -c",
      cwd: tmpDir,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      stdin: big,
    });
    expect(result.status).toBe("completed");
    expect(result.stdout.trim()).toBe(String(big.length));
  });

  it("swallows EPIPE when the child exits without reading a large stdin payload", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const big = "y".repeat(2 * 1024 * 1024);
    const result = await adapter.run({
      command: "sh -c 'exit 0'",
      cwd: tmpDir,
      timeoutMs: 5000,
      stdin: big,
    });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
  });

  it("omitted stdin closes the pipe immediately (current behavior locked)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const result = await adapter.run({ command: "cat", cwd: tmpDir, timeoutMs: 5000 });
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("");
  });

  it("streams live output chunks to onOutput, tagged by stream, before the final result", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
    const chunks: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    const result = await adapter.run({
      command: "echo out-line; echo err-line 1>&2",
      cwd: tmpDir,
      timeoutMs: 5000,
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.status).toBe("completed");
    const joinedStdout = chunks.filter((c) => c.stream === "stdout").map((c) => c.text).join("");
    const joinedStderr = chunks.filter((c) => c.stream === "stderr").map((c) => c.text).join("");
    expect(joinedStdout).toContain("out-line");
    expect(joinedStderr).toContain("err-line");
    // onOutput chunks reconstruct the same captured payload the result carries.
    expect(joinedStdout).toBe(result.stdout);
    expect(joinedStderr).toBe(result.stderr);
  });

  it(
    "cancels via abortSignal with a large stdin write still pending and leaves no orphaned process",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const pidFile = join(tmpDir, "pid.txt");
      const controller = new AbortController();
      // `sleep` never reads stdin, so the multi-MB write sits unread in the
      // pipe buffer (pending) for the whole run — exactly the state abort
      // must tear down cleanly.
      const runPromise = adapter.run({
        command: `echo $$ > ${pidFile} && exec sleep 5`,
        cwd: tmpDir,
        timeoutMs: 10_000,
        stdin: "y".repeat(2 * 1024 * 1024),
        abortSignal: controller.signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      const result = await runPromise;
      expect(result.status).toBe("cancelled");

      const pid = Number((await readFile(pidFile, "utf-8")).trim());
      expect(Number.isNaN(pid)).toBe(false);
      expect(await waitPidDead(pid)).toBe(true);
    },
    10_000,
  );

  describe("runBinary", () => {
    it("runs argv directly and captures stdout/exit code", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const result = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "console.log('hello-argv')"],
        cwd: tmpDir,
        timeoutMs: 5000,
      });
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello-argv");
    });

    it("merges request.env over the inherited environment (slice 4.7 shadow-git isolation)", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const result = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "process.stdout.write(process.env.ANYCODE_CHECKPOINT_VAR ?? '<unset>')"],
        cwd: tmpDir,
        timeoutMs: 5000,
        env: { ANYCODE_CHECKPOINT_VAR: "isolated-value" },
      });
      expect(result.status).toBe("completed");
      expect(result.stdout).toBe("isolated-value");
    });

    it("still inherits process.env for keys the request.env does not override", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      // PATH is inherited; the override only adds a new key, so PATH must survive.
      const result = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "process.stdout.write(String(typeof process.env.PATH === 'string' && process.env.PATH.length > 0))"],
        cwd: tmpDir,
        timeoutMs: 5000,
        env: { ANYCODE_CHECKPOINT_VAR: "x" },
      });
      expect(result.status).toBe("completed");
      expect(result.stdout).toBe("true");
    });

    it(
      "kills a long-running git-like binary on timeout, leaving no orphan (checkpoint spawn discipline)",
      async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
        // Fake `git` that records its pid then execs a long sleep — exactly the
        // shape a hung shadow-git plumbing call would take. It must be reaped by
        // the runBinary timeout (the only spawn path checkpoints/ uses, L5). The
        // 1.5s timeout gives the shebang shell time to write the pid file before
        // the kill; the death check polls to tolerate OS reap lag.
        const fakeGit = join(tmpDir, "git");
        const pidFile = join(tmpDir, "pid.txt");
        await writeFile(fakeGit, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 5\n`, { mode: 0o755 });

        const result = await adapter.runBinary({
          file: fakeGit,
          args: ["add", "-A"],
          cwd: tmpDir,
          timeoutMs: 1500,
        });
        expect(result.status).toBe("timed_out");

        const pid = Number((await readFile(pidFile, "utf-8")).trim());
        expect(Number.isNaN(pid)).toBe(false);
        expect(await waitPidDead(pid)).toBe(true);
      },
      15_000,
    );

    it("passes args verbatim with no shell interpretation (no injection surface)", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const payload = "$(echo pwned); rm -rf /tmp/should-not-run && echo done";
      const result = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "console.log(process.argv[1])", payload],
        cwd: tmpDir,
        timeoutMs: 5000,
      });
      expect(result.status).toBe("completed");
      // Under a shell, `$(echo pwned)` would be substituted and the `;`-separated
      // commands would run independently; argv spawn hands the whole string to
      // the child as one literal argument.
      expect(result.stdout.trim()).toBe(payload);
    });

    it("reports spawn_error for a non-existent binary file", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const result = await adapter.runBinary({
        file: join(tmpDir, "no-such-binary"),
        args: [],
        cwd: tmpDir,
        timeoutMs: 5000,
      });
      expect(result.status).toBe("spawn_error");
    });

    it(
      "times out a long-running argv-spawned command and leaves no orphaned process",
      async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
        const result = await adapter.runBinary({
          file: process.execPath,
          args: ["-e", "console.log(String(process.pid)); setInterval(() => {}, 1000);"],
          cwd: tmpDir,
          timeoutMs: 200,
        });
        expect(result.status).toBe("timed_out");
        expect(result.exitCode).toBeNull();

        const pid = Number(result.stdout.trim());
        expect(Number.isNaN(pid)).toBe(false);
        expect(await waitPidDead(pid)).toBe(true);
      },
      10_000,
    );

    it(
      "cancels via abortSignal and leaves no orphaned process",
      async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
        const controller = new AbortController();
        const runPromise = adapter.runBinary({
          file: process.execPath,
          args: ["-e", "console.log(String(process.pid)); setInterval(() => {}, 1000);"],
          cwd: tmpDir,
          timeoutMs: 10_000,
          abortSignal: controller.signal,
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        controller.abort();
        const result = await runPromise;
        expect(result.status).toBe("cancelled");

        const pid = Number(result.stdout.trim());
        expect(Number.isNaN(pid)).toBe(false);
        expect(await waitPidDead(pid)).toBe(true);
      },
      10_000,
    );

    it("resolves as cancelled without spawning when abortSignal is already aborted", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const controller = new AbortController();
      controller.abort();
      const result = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "console.log('should-not-run')"],
        cwd: tmpDir,
        timeoutMs: 5000,
        abortSignal: controller.signal,
      });
      expect(result.status).toBe("cancelled");
      expect(result.stdout).not.toContain("should-not-run");
    });
  });

  describe("spawnPersistent", () => {
    /** Polls `predicate` (poll-with-deadline; the interval is not a correctness-gating sleep) until true or the deadline. */
    async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return predicate();
    }

    /** Polls until the pid file exists AND carries a non-empty payload (guards a partial write race). */
    async function readNumberWhenReady(path: string, timeoutMs = 5000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const raw = (await readFile(path, "utf-8")).trim();
          if (raw.length > 0) return Number(raw);
        } catch {
          // not written yet
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`pid file ${path} not ready within ${timeoutMs}ms`);
    }

    it(
      "spawns a persistent child, streams raw stdout Buffers, and reports a clean exit exactly once",
      async () => {
        const chunks: Buffer[] = [];
        let exitCalls = 0;
        let exitInfo: PersistentExitInfo | undefined;
        const handle = adapter.spawnPersistent!({
          file: process.execPath,
          args: ["-e", "process.stdout.write('hello-persist'); process.exit(0);"],
          onStdout: (chunk) => chunks.push(chunk),
          onExit: (info) => {
            exitCalls += 1;
            exitInfo = info;
          },
        });
        expect(typeof handle.pid).toBe("number");

        expect(await waitFor(() => exitInfo !== undefined, 5000)).toBe(true);
        // give any (erroneous) second terminal event a chance to fire
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(exitCalls).toBe(1);
        expect(handle.exited).toBe(true);
        expect(exitInfo).toEqual({ code: 0, signal: null });
        expect(chunks.every((chunk) => Buffer.isBuffer(chunk))).toBe(true);
        expect(Buffer.concat(chunks).toString("utf-8")).toContain("hello-persist");
      },
      10_000,
    );

    it(
      "delivers write() payloads to a live child's stdin (bidirectional stdio)",
      async () => {
        const chunks: Buffer[] = [];
        let exitInfo: PersistentExitInfo | undefined;
        const handle = adapter.spawnPersistent!({
          file: process.execPath,
          args: [
            "-e",
            "process.stdin.on('data', (d) => { process.stdout.write(d); if (String(d).includes('quit')) process.exit(0); });",
          ],
          onStdout: (chunk) => chunks.push(chunk),
          onExit: (info) => {
            exitInfo = info;
          },
        });
        handle.write("ping\n");
        expect(await waitFor(() => Buffer.concat(chunks).toString("utf-8").includes("ping"), 5000)).toBe(true);
        handle.write(Buffer.from("quit\n", "utf-8"));
        expect(await waitFor(() => exitInfo !== undefined, 5000)).toBe(true);
        expect(exitInfo?.code).toBe(0);
      },
      10_000,
    );

    it(
      "escalates to SIGKILL when the child ignores SIGTERM (death >= grace after SIGTERM)",
      async () => {
        const chunks: Buffer[] = [];
        let exitInfo: PersistentExitInfo | undefined;
        const handle = adapter.spawnPersistent!({
          // Install a SIGTERM handler (immune to SIGTERM), keep the loop alive,
          // then announce readiness — so we only kill after the handler is armed.
          file: process.execPath,
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
          ],
          onStdout: (chunk) => chunks.push(chunk),
          onExit: (info) => {
            exitInfo = info;
          },
        });
        const pid = handle.pid;
        expect(typeof pid).toBe("number");
        expect(await waitFor(() => Buffer.concat(chunks).toString("utf-8").includes("ready"), 5000)).toBe(true);

        const t0 = Date.now();
        await handle.kill();
        const elapsed = Date.now() - t0;
        expect(await waitPidDead(pid as number, 5000)).toBe(true);
        // Death came from the SIGKILL escalation, not the (ignored) SIGTERM.
        expect(exitInfo?.signal).toBe("SIGKILL");
        expect(elapsed).toBeGreaterThanOrEqual(SIGKILL_GRACE_MS - 100);
      },
      10_000,
    );

    it(
      "reaps a grandchild via the process group (pgid kill reaches the whole tree)",
      async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
        const grandPidFile = join(tmpDir, "grand.pid");
        const script = [
          "const cp = require('node:child_process');",
          "const fs = require('node:fs');",
          // Grandchild in the SAME process group (no detached) — pgid kill must reach it.
          "const g = cp.spawn('sleep', ['300'], { stdio: 'ignore' });",
          `fs.writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const handle = adapter.spawnPersistent!({
          file: process.execPath,
          args: ["-e", script],
          onStdout: () => {},
          onExit: () => {},
        });
        const childPid = handle.pid;
        expect(typeof childPid).toBe("number");
        const grandPid = await readNumberWhenReady(grandPidFile, 5000);
        expect(Number.isNaN(grandPid)).toBe(false);

        await handle.kill();
        expect(await waitPidDead(childPid as number, 5000)).toBe(true);
        expect(await waitPidDead(grandPid, 5000)).toBe(true);
      },
      15_000,
    );

    it(
      "kill() is idempotent, resolves every concurrent caller, and takes the fast SIGTERM path for a compliant child",
      async () => {
        let exitInfo: PersistentExitInfo | undefined;
        const handle = adapter.spawnPersistent!({
          file: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000);"],
          onStdout: () => {},
          onExit: (info) => {
            exitInfo = info;
          },
        });
        const pid = handle.pid;
        expect(typeof pid).toBe("number");
        expect(await waitFor(() => isPidAlive(pid as number), 3000)).toBe(true);

        // Three concurrent kills; all must resolve.
        await Promise.all([handle.kill(), handle.kill(), handle.kill()]);
        expect(await waitPidDead(pid as number, 5000)).toBe(true);
        // Compliant child dies from SIGTERM — no escalation.
        expect(exitInfo?.signal).toBe("SIGTERM");
        // A kill after exit resolves immediately (idempotent terminal state).
        await handle.kill();
        expect(handle.exited).toBe(true);
      },
      10_000,
    );

    it(
      "reports spawnError via onExit for a non-existent binary (ENOENT), never throwing",
      async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
        let exitInfo: PersistentExitInfo | undefined;
        const handle = adapter.spawnPersistent!({
          file: join(tmpDir, "no-such-lsp-binary-xyz"),
          args: ["--stdio"],
          onStdout: () => {},
          onExit: (info) => {
            exitInfo = info;
          },
        });
        expect(await waitFor(() => exitInfo !== undefined, 5000)).toBe(true);
        expect(exitInfo?.spawnError).toBeTruthy();
        expect(handle.exited).toBe(true);
        // A kill on a never-started child resolves immediately.
        await handle.kill();
      },
      10_000,
    );

    it(
      "write() after the child has exited is a no-op and never throws",
      async () => {
        let exitInfo: PersistentExitInfo | undefined;
        const handle = adapter.spawnPersistent!({
          file: process.execPath,
          args: ["-e", "process.exit(0);"],
          onStdout: () => {},
          onExit: (info) => {
            exitInfo = info;
          },
        });
        expect(await waitFor(() => exitInfo !== undefined, 5000)).toBe(true);
        expect(handle.exited).toBe(true);
        expect(() => handle.write("noop-after-exit\n")).not.toThrow();
        expect(() => handle.write(Buffer.from([0x01, 0x02, 0x03]))).not.toThrow();
      },
      10_000,
    );
  });
});

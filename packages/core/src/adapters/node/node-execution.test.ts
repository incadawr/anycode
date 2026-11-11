import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("does not source BASH_ENV supplied by the parent or request", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-bash-env-"));
    const script = join(tmpDir, "startup");
    await writeFile(script, "echo injected");
    const previous = process.env.BASH_ENV;
    process.env.BASH_ENV = script;
    try {
      const result = await adapter.run({ command: "echo clean", cwd: tmpDir, timeoutMs: 5000, env: { BASH_ENV: script } });
      expect(result.stdout.trim()).toBe("clean");
    } finally { if (previous === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = previous; }
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

  // The shell-string spawn runs under /bin/bash when it exists, so bash-only
  // syntax (here: `set -o pipefail`) works; under dash it would fail.
  it.skipIf(process.platform === "win32" || !existsSync("/bin/bash"))(
    "runs shell strings under bash, so `set -o pipefail` takes effect",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const result = await adapter.run({
        command: "set -o pipefail; false | true; echo $?",
        cwd: tmpDir,
        timeoutMs: 5000,
      });
      expect(result.status).toBe("completed");
      expect(result.stdout).toBe("1\n");
    },
  );

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
        expect(pid).toBeGreaterThan(1);
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

  // ── / credentialed proxy vars never reach a non-engine child ──
  // part A (A-4/A-5 at the process boundary): a Bash child sees the
  // session-identity pair that the parent (host) env carries.
  describe("session tool env reaches a Bash child", () => {
    const KEYS = ["ANYCODE_SESSION_ID", "ANYCODE_SESSION_WORKSPACE"] as const;

    it("run and runBinary children inherit ANYCODE_SESSION_ID and ANYCODE_SESSION_WORKSPACE from the parent env", async () => {
      const saved = KEYS.map((k) => [k, process.env[k]] as const);
      try {
        process.env.ANYCODE_SESSION_ID = "sess-bash-child";
        process.env.ANYCODE_SESSION_WORKSPACE = "/work/repo";
        tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
        const shell = await adapter.run({
          command: `"${process.execPath}" -e "process.stdout.write(JSON.stringify([process.env.ANYCODE_SESSION_ID, process.env.ANYCODE_SESSION_WORKSPACE]))"`,
          cwd: tmpDir,
          timeoutMs: 10_000,
        });
        expect(shell.status).toBe("completed");
        expect(JSON.parse(shell.stdout)).toEqual(["sess-bash-child", "/work/repo"]);

        const bin = await adapter.runBinary({
          file: process.execPath,
          args: ["-e", "process.stdout.write(process.env.ANYCODE_SESSION_ID ?? '<unset>')"],
          cwd: tmpDir,
          timeoutMs: 10_000,
        });
        expect(bin.stdout).toBe("sess-bash-child");
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

  describe("child env proxy scrub", () => {
    const CREDENTIALED = "http://user:s3cret@127.0.0.1:9";

    /** Polls until `predicate` holds or the deadline (same shape as the spawnPersistent suite's helper). */
    async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return predicate();
    }

    /** The env every scrub test stubs: both cases credentialed, a clean HTTP_PROXY, an exemption and a carrier. */
    const stubProxyEnv = (): void => {
      vi.stubEnv("HTTPS_PROXY", CREDENTIALED);
      vi.stubEnv("https_proxy", CREDENTIALED);
      vi.stubEnv("HTTP_PROXY", "http://proxy.corp:3128");
      vi.stubEnv("NO_PROXY", "localhost");
      vi.stubEnv("ANYCODE_CLAUDE_PROXY_URL", '{"url":"http://user:s3cret@127.0.0.1:9"}');
    };

    // This suite pins the DROP behaviour in isolation: the relay is neutered
    // (no lazy start, no URL) so a credentialed proxy vanishes rather than
    // being replaced. The relay-rewrite behaviour has its own suite below.
    let restoreRelay: (() => void) | undefined;
    beforeEach(async () => {
      stubProxyEnv();
      const relayModule = await import("./proxy-relay.js");
      const ensureSpy = vi.spyOn(relayModule, "ensureProxyRelay").mockImplementation(() => {});
      const urlSpy = vi.spyOn(relayModule, "proxyRelayUrl").mockReturnValue(undefined);
      restoreRelay = () => {
        ensureSpy.mockRestore();
        urlSpy.mockRestore();
      };
    });
    afterEach(() => {
      restoreRelay?.();
      restoreRelay = undefined;
      vi.unstubAllEnvs();
    });

    /** Shared assertions over a child's reported env (parsed JSON object). */
    function expectScrubbedEnv(childEnv: Record<string, string | undefined>): void {
      expect(JSON.stringify(childEnv)).not.toContain("s3cret");
      expect(childEnv.HTTPS_PROXY).toBeUndefined();
      expect(childEnv.https_proxy).toBeUndefined();
      expect(childEnv.ANYCODE_CLAUDE_PROXY_URL).toBeUndefined();
      expect(childEnv.HTTP_PROXY).toBe("http://proxy.corp:3128");
      expect(childEnv.NO_PROXY).toBe("localhost");
    }

    it("run: a shell child sees no credentialed proxy var, no carrier; clean proxy and NO_PROXY survive", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const result = await adapter.run({
        command: `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"`,
        cwd: tmpDir,
        timeoutMs: 10_000,
      });
      expect(result.status).toBe("completed");
      expectScrubbedEnv(JSON.parse(result.stdout) as Record<string, string | undefined>);
      // The parent's own process.env is untouched by the scrub (D1).
      expect(process.env.HTTPS_PROXY).toBe(CREDENTIALED);
    });

    it.skipIf(process.platform === "win32")(
      "run: a literal env(1) child cannot observe the credential either",
      async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
        const result = await adapter.run({ command: "env", cwd: tmpDir, timeoutMs: 10_000 });
        expect(result.status).toBe("completed");
        expect(result.stdout).not.toContain("s3cret");
        expect(result.stdout).not.toContain("ANYCODE_CLAUDE_PROXY_URL");
        expect(result.stdout).toContain("HTTP_PROXY=http://proxy.corp:3128");
      },
    );

    it("runBinary: an argv child sees the same scrubbed env", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const result = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        cwd: tmpDir,
        timeoutMs: 10_000,
      });
      expect(result.status).toBe("completed");
      expectScrubbedEnv(JSON.parse(result.stdout) as Record<string, string | undefined>);
      expect(process.env.HTTPS_PROXY).toBe(CREDENTIALED);
    });

    it(
      "spawnPersistent: an LSP-shaped child sees the same scrubbed env",
      async () => {
        const chunks: Buffer[] = [];
        let exitInfo: PersistentExitInfo | undefined;
        // Marked + newline-flushed: a bare process.exit(0) right after a
        // multi-KiB write can cut the async pipe mid-JSON (observed at exactly
        // 8192 bytes), and onExit can fire while bytes are still in flight.
        adapter.spawnPersistent!({
          file: process.execPath,
          args: [
            "-e",
            "process.stdout.write(Buffer.concat([Buffer.from('ENV-START'), Buffer.from(JSON.stringify(process.env)), Buffer.from('ENV-END\\n')]));",
          ],
          onStdout: (chunk) => chunks.push(chunk),
          onExit: (info) => {
            exitInfo = info;
          },
        });
        const full = (): string => Buffer.concat(chunks).toString("utf-8");
        expect(await waitFor(() => full().includes("ENV-END"), 10_000)).toBe(true);
        const match = full().match(/ENV-START([\s\S]*)ENV-END/);
        expect(match).not.toBeNull();
        expectScrubbedEnv(JSON.parse(match![1]!) as Record<string, string | undefined>);
        expect(process.env.HTTPS_PROXY).toBe(CREDENTIALED);
      },
      15_000,
    );

    it("request.env: a credentialed overlay proxy is dropped; a credential-less one passes through", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      const result = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "process.stdout.write(process.env.HTTPS_PROXY ?? '<absent>')"],
        cwd: tmpDir,
        timeoutMs: 10_000,
        env: { HTTPS_PROXY: "http://u:p@h:1" },
      });
      expect(result.status).toBe("completed");
      expect(result.stdout).toBe("<absent>");

      const clean = await adapter.runBinary({
        file: process.execPath,
        args: ["-e", "process.stdout.write(process.env.HTTPS_PROXY ?? '<absent>')"],
        cwd: tmpDir,
        timeoutMs: 10_000,
        env: { HTTPS_PROXY: "http://h:1" },
      });
      expect(clean.status).toBe("completed");
      expect(clean.stdout).toBe("http://h:1");
    });

    it("after the spawns, the parent process.env still holds the credentialed value", () => {
      expect(process.env.HTTPS_PROXY).toBe(CREDENTIALED);
      expect(process.env.ANYCODE_CLAUDE_PROXY_URL).toBe('{"url":"http://user:s3cret@127.0.0.1:9"}');
    });
  });

  // ── follow-up: the credential-free loopback relay replaces the
  // dropped vars in real spawns (npm/git/curl keep working, no credential) ──
  describe("child env relay rewrite", () => {
    const CREDENTIALED = "http://user:s3cret@127.0.0.1:9";
    const RELAY_URL = "http://127.0.0.1:47557";

    beforeEach(() => {
      vi.stubEnv("HTTPS_PROXY", CREDENTIALED);
      vi.stubEnv("https_proxy", CREDENTIALED);
      vi.stubEnv("NO_PROXY", "localhost");
      vi.stubEnv("ANYCODE_CLAUDE_PROXY_URL", '{"url":"http://user:s3cret@127.0.0.1:9"}');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /**
     * Spy the relay LOOKUP in (the per-value resolver `buildChildEnv`'s third
     * argument reads — rework: one relay per upstream, so the
     * stub answers the value being swapped, like the real registry would).
     */
    async function stubRelayLookup(url: string = RELAY_URL): Promise<() => void> {
      const relayModule = await import("./proxy-relay.js");
      const spy = vi.spyOn(relayModule, "proxyRelayLookup").mockReturnValue(() => url);
      return () => spy.mockRestore();
    }

    it("rework: a minted relay URL (token as userinfo) reaches the child verbatim", async () => {
      const TOKENED = "http://anycode:AbCdEf1234567890_-XyZ@127.0.0.1:47557";
      const restore = await stubRelayLookup(TOKENED);
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      try {
        const result = await adapter.run({
          command: `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"`,
          cwd: tmpDir,
          timeoutMs: 10_000,
        });
        expect(result.status).toBe("completed");
        const childEnv = JSON.parse(result.stdout) as Record<string, string | undefined>;
        expect(childEnv.HTTPS_PROXY).toBe(TOKENED);
        // Per-var: the upstream password never appears anywhere.
        expect(JSON.stringify(childEnv)).not.toContain("s3cret");
        // The relay URL's own userinfo IS the relay's token (not a credential
        // leak) — the one `@` the DoD permits, in exactly this shape.
        expect(childEnv.HTTPS_PROXY).toContain("anycode:");
      } finally {
        restore();
      }
    });

    it("a spawned shell child receives the relay URL instead of the credentialed proxy, and no credential anywhere", async () => {
      const restore = await stubRelayLookup();
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      try {
        const result = await adapter.run({
          command: `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"`,
          cwd: tmpDir,
          timeoutMs: 10_000,
        });
        expect(result.status).toBe("completed");
        const childEnv = JSON.parse(result.stdout) as Record<string, string | undefined>;
        expect(childEnv.HTTPS_PROXY).toBe(RELAY_URL);
        expect(childEnv.https_proxy).toBe(RELAY_URL);
        expect(childEnv.ANYCODE_CLAUDE_PROXY_URL).toBeUndefined();
        expect(childEnv.NO_PROXY).toBe("localhost");
        expect(JSON.stringify(childEnv)).not.toContain("s3cret");
        expect(JSON.stringify(childEnv)).not.toContain("user:");
        // The parent's own env keeps the credentialed value (engines still need it).
        expect(process.env.HTTPS_PROXY).toBe(CREDENTIALED);
      } finally {
        restore();
      }
    });

    it("runBinary child receives the same relay URL", async () => {
      const restore = await stubRelayLookup();
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-exec-"));
      try {
        const result = await adapter.runBinary({
          file: process.execPath,
          args: ["-e", "process.stdout.write(process.env.HTTPS_PROXY ?? '<absent>')"],
          cwd: tmpDir,
          timeoutMs: 10_000,
        });
        expect(result.status).toBe("completed");
        expect(result.stdout).toBe(RELAY_URL);
      } finally {
        restore();
      }
    });
  });

  describe.skipIf(process.platform === "win32")("backgrounded jobs holding the pipes", () => {
    async function groupHasLiveProcesses(pgid: number): Promise<boolean> {
      if (process.platform !== "linux") {
        const { execFileSync } = await import("node:child_process");
        const ps = execFileSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8" });
        return ps.split("\n").some((line) => {
          const [group, state] = line.trim().split(/\s+/);
          return Number(group) === pgid && !!state && !state.startsWith("Z");
        });
      }
      // PID 1 in containers may leave killed processes as zombies. They are
      // no longer running, so inspect Linux state as well as process group.
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === pgid && fields[0] !== "Z") return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return false;
    }

    async function cleanupGroup(dir: string): Promise<void> {
      let pgid: number;
      try { pgid = Number((await readFile(join(dir, "pgid"), "utf-8")).trim()); } catch { return; }
      if (!Number.isInteger(pgid) || pgid <= 1) throw new Error("invalid process group");
      try { process.kill(-pgid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (!await groupHasLiveProcesses(pgid)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`process group ${pgid} survived cleanup`);
    }

    it("returns when the shell exits and leaves the job running", async () => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-bg-"));
      try {
        const result = await new NodeExecutionAdapter().run({
          command: `echo $$ > pgid; cd ${dir} && { sleep 30 & echo $! > pid; wait; } & sleep 0.3; echo fg-done`,
          cwd: dir, timeoutMs: 10_000, settleOnShellExit: true,
        });
        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("fg-done");
        expect(result.durationMs).toBeLessThan(5_000);
        const pid = Number((await readFile(join(dir, "pid"), "utf-8")).trim());
        expect(pid).toBeGreaterThan(1);
        expect(isPidAlive(pid)).toBe(true);
      } finally {
        try { await cleanupGroup(dir); } finally { await rm(dir, { recursive: true, force: true }); }
      }
    });

    it("drains unredirected output while the host remains alive", async () => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-bg-"));
      try {
        const result = await new NodeExecutionAdapter().run({
          command: `echo $$ > pgid; cd ${dir} && { sleep 1.2; echo late; echo done > wrote; sleep 30; } & sleep 0.2; echo fg`,
          cwd: dir, timeoutMs: 10_000, settleOnShellExit: true,
        });
        expect(result.status).toBe("completed");
        const deadline = Date.now() + 5_000;
        while (!existsSync(join(dir, "wrote")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(existsSync(join(dir, "wrote"))).toBe(true);
      } finally {
        try { await cleanupGroup(dir); } finally { await rm(dir, { recursive: true, force: true }); }
      }
    });

    it("does not time out during the drain grace after shell exit", async () => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-bg-"));
      try {
        const result = await adapter.run({ command: "echo $$ > pgid; sleep 3 & sleep 0.2; echo finished", cwd: dir, timeoutMs: 350, settleOnShellExit: true });
        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("finished");
      } finally {
        try { await cleanupGroup(dir); } finally { await rm(dir, { recursive: true, force: true }); }
      }
    });

    it("escalates after timeout when a descendant ignores SIGTERM", async () => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-bg-"));
      try {
        const result = await adapter.run({ command: `echo $$ > pgid; bash -c 'trap "" TERM; echo ready; while :; do sleep 1; done' & wait`, cwd: dir, timeoutMs: 400, settleOnShellExit: true });
        expect(result.status).toBe("timed_out");
        expect(result.stdout).toContain("ready");
        const pgid = Number((await readFile(join(dir, "pgid"), "utf-8")).trim());
        expect(await groupHasLiveProcesses(pgid)).toBe(false);
      } finally {
        try { await cleanupGroup(dir); } finally { await rm(dir, { recursive: true, force: true }); }
      }
    });

    it.each(["timed_out", "cancelled"] as const)("bounds %s when a detached child holds a pipe", async (status) => {
      const dir = await mkdtemp(join(tmpdir(), "anycode-detached-"));
      const pidFile = join(dir, "pid");
      const controller = new AbortController();
      let deadline: NodeJS.Timeout | undefined;
      try {
        await writeFile(join(dir, "launcher.cjs"), `
          const { spawn } = require("node:child_process");
          const { writeFileSync } = require("node:fs");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
            { detached: true, stdio: ["ignore", 1, 2] });
          writeFileSync("pid", String(child.pid));
          setInterval(() => {}, 1000);
        `);
        const started = Date.now();
        const pending = adapter.run({
          command: `${JSON.stringify(process.execPath)} launcher.cjs`, cwd: dir,
          timeoutMs: status === "timed_out" ? 1000 : 10_000,
          abortSignal: controller.signal, settleOnShellExit: true,
        });
        const readyDeadline = Date.now() + 3000;
        while (!existsSync(pidFile) && Date.now() < readyDeadline) await new Promise((r) => setTimeout(r, 25));
        expect(existsSync(pidFile)).toBe(true);
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        expect(pid).toBeGreaterThan(1);
        expect(isPidAlive(pid)).toBe(true);
        if (status === "cancelled") controller.abort();
        const result = await Promise.race([
          pending,
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("execution did not settle")), 3500); }),
        ]);
        expect(result.status).toBe(status);
        expect(Date.now() - started).toBeLessThan(4500);
        expect(isPidAlive(pid)).toBe(true);
      } finally {
        clearTimeout(deadline);
        controller.abort();
        try {
          if (existsSync(pidFile)) {
            const pid = Number((await readFile(pidFile, "utf8")).trim());
            if (!Number.isInteger(pid) || pid <= 1) throw new Error("invalid detached child pid");
            try { process.kill(pid, "SIGKILL"); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
            const until = Date.now() + 3000;
            while (await groupHasLiveProcesses(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
            expect(await groupHasLiveProcesses(pid)).toBe(false);
          }
        } finally { await rm(dir, { recursive: true, force: true }); }
      }
    }, 10_000);

    it("argv launchers wait for a worker's late output", async () => {
      const result = await adapter.runBinary({ file: "/bin/bash", args: ["-c", "(sleep 0.6; echo late-output) &"], cwd: tmpdir(), timeoutMs: 5000 });
      expect(result.status).toBe("completed");
      expect(result.stdout).toContain("late-output");
      expect(result.stdoutTruncated).toBe(false);
    });

    it("still times out and kills a stuck foreground command", async () => {
      const result = await adapter.run({ command: "echo started; sleep 30", cwd: tmpdir(), timeoutMs: 500, settleOnShellExit: true });
      expect(result.status).toBe("timed_out");
      expect(result.stdout).toContain("started");
    });
  });
});

/**
 * Taskana 4702 Stage 1, implementation C: the external-command ask classifier.
 * Spawn is injected; every test drives a fake child process. Pins the da
 * protocol (exit 0 allow / 1 ask / 2 deny->ask / anything else = error->ask),
 * the no-shell spawn, the minimal environment, the stdin payload, the output
 * cap, the kill-on-timeout, and that the classifier never throws past
 * classifyAsk.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createCommandAskClassifier, parseClassifierCommand } from "./command-classifier.js";
import { classifyAsk, type AskClassifierInput } from "./ask-classifier.js";

const INPUT: AskClassifierInput = {
  toolName: "Bash",
  command: "npm run build && rm -rf dist",
  segments: ["npm run build ", " rm -rf dist"],
  cwd: "/work",
  userContext: [],
};

interface Fake {
  child: ChildProcess;
  stdinChunks: string[];
  stdinEnded: boolean;
  kill: ReturnType<typeof vi.fn>;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitStdout(text: string): void;
  emitError(err: Error): void;
  emitStdinError(err: Error): void;
}

function fakeChild(): Fake {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stdinChunks: string[] = [];
  const fake: Fake = {
    stdinChunks,
    stdinEnded: false,
    kill: vi.fn(() => true),
    child: undefined as unknown as ChildProcess,
    emitExit: (code, signal = null) => emitter.emit("close", code, signal),
    emitStdout: (text) => stdout.emit("data", Buffer.from(text)),
    emitError: (err) => emitter.emit("error", err),
    emitStdinError: (err) => stdin.emit("error", err),
  };
  stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk.toString("utf8")));
  stdin.on("finish", () => {
    fake.stdinEnded = true;
  });
  const child = Object.assign(emitter, { stdin, stdout, stderr: null, kill: fake.kill });
  fake.child = child as unknown as ChildProcess;
  return fake;
}

function spawnReturning(fake: Fake) {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawn = ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    return fake.child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

async function run(fake: Fake, timeoutMs = 5000, signal?: AbortSignal) {
  const { spawn, calls } = spawnReturning(fake);
  const classifier = createCommandAskClassifier({
    argv: ["/usr/local/bin/da", "--json", "--quiet"],
    timeoutMs,
    spawn,
  });
  const pending = classifier.classify(INPUT, { signal });
  // Let the classifier attach its listeners before the fake child reports.
  await new Promise((resolve) => setImmediate(resolve));
  return { classifier, calls, pending };
}

describe("createCommandAskClassifier — da protocol", () => {
  it("exit 0 is allow, with the first stdout line as the reason", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitStdout("read-only build\nextra line\n");
    fake.emitExit(0);
    await expect(pending).resolves.toEqual({ decision: "allow", reason: "read-only build" });
  });

  it("exit 0 with no stdout reason falls back to a fixed reason", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitExit(0);
    await expect(pending).resolves.toEqual({ decision: "allow", reason: "classifier exit 0" });
  });

  it("exit 1 is ask (not an error)", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitStdout("needs a human");
    fake.emitExit(1);
    await expect(pending).resolves.toEqual({ decision: "ask", reason: "needs a human" });
  });

  it("exit 2 (deny) maps to ask, never allow", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitExit(2);
    const verdict = await pending;
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toBe("classifier exit 2 (deny mapped to ask)");
  });

  it.each([3, 137, 127])("exit %i is an error: the classifier throws, so classifyAsk falls back to ask", async (code) => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitExit(code);
    await expect(pending).rejects.toThrow(String(code));
    const wrapped = await classifyAsk({ id: "wrapped", classify: () => pending }, INPUT, {});
    expect(wrapped.verdict.decision).toBe("ask");
    expect(wrapped.error).toContain(String(code));
  });

  it("a signal kill (exit code null) is an error, never allow", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitExit(null, "SIGKILL");
    await expect(pending).rejects.toThrow();
  });

  it("a spawn error is an error", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitError(new Error("ENOENT"));
    await expect(pending).rejects.toThrow("ENOENT");
  });

  it("stdout over 64 KB kills the child and is an error", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitStdout("x".repeat(64 * 1024 + 1));
    await expect(pending).rejects.toThrow(/stdout/);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("the reason is capped to 300 chars", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitStdout("z".repeat(1000));
    fake.emitExit(0);
    const verdict = await pending;
    expect(verdict.reason.length).toBe(300);
  });
});

describe("createCommandAskClassifier — timeout, abort, stdin and spawn discipline", () => {
  it("a timeout kills the child and rejects", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const { spawn } = spawnReturning(fake);
      const classifier = createCommandAskClassifier({ argv: ["da"], timeoutMs: 50, spawn });
      const pending = classifier.classify(INPUT, {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(60);
      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).toMatch(/timed out/);
      expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a caller abort kills the child", async () => {
    const fake = fakeChild();
    const controller = new AbortController();
    const { pending } = await run(fake, 5000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("stdin receives exactly the command line, then ends", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    await new Promise((resolve) => setImmediate(resolve));
    fake.emitExit(0);
    await pending;
    expect(fake.stdinChunks.join("")).toBe(INPUT.command);
  });

  it("spawns argv[0] with the rest as args, shell:false, a minimal env and a temp cwd", async () => {
    const fake = fakeChild();
    const { calls } = await run(fake);
    fake.emitExit(0);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe("/usr/local/bin/da");
    expect(call?.args).toEqual(["--json", "--quiet"]);
    expect(call?.options.shell).toBe(false);
    expect(call?.options.stdio).toEqual(["pipe", "pipe", "ignore"]);
    const env = call?.options.env as Record<string, string | undefined>;
    for (const key of Object.keys(env)) {
      expect(["PATH", "HOME"]).toContain(key);
    }
    expect(String(call?.options.cwd)).toMatch(/.+/);
    expect(call?.options.cwd).not.toBe("/work");
  });

  it("does not leak the parent environment (no secrets in the child env)", async () => {
    process.env.ANYCODE_TEST_SECRET_4702 = "leak-me";
    try {
      const fake = fakeChild();
      const { calls } = await run(fake);
      fake.emitExit(0);
      const env = calls[0]?.options.env as Record<string, string | undefined>;
      expect(JSON.stringify(env)).not.toContain("leak-me");
    } finally {
      delete process.env.ANYCODE_TEST_SECRET_4702;
    }
  });

  it("a stdin error (child exited before reading) is an error, not an unhandled crash", async () => {
    const fake = fakeChild();
    const { pending } = await run(fake);
    fake.emitStdinError(new Error("EPIPE"));
    await expect(pending).rejects.toThrow("EPIPE");
  });

  it("the id is command:<basename of argv[0]>", () => {
    const { spawn } = spawnReturning(fakeChild());
    const classifier = createCommandAskClassifier({ argv: ["/opt/tools/da"], spawn });
    expect(classifier.id).toBe("command:da");
  });

  it("an empty argv cannot build a classifier", () => {
    expect(() => createCommandAskClassifier({ argv: [] })).toThrow();
  });
});

describe("parseClassifierCommand", () => {
  it("splits on whitespace only (no shell, no quoting)", () => {
    expect(parseClassifierCommand("  /usr/bin/da   --json  ")).toEqual(["/usr/bin/da", "--json"]);
  });

  it("returns [] for a blank string", () => {
    expect(parseClassifierCommand("   ")).toEqual([]);
  });
});

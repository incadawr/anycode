import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ClaudeClient,
  ClaudeClientError,
  buildClaudeChildEnv,
  buildClaudeSpawnArgs,
  redactHomePaths,
} from "./claude-client.js";
import { EngineVersionError } from "./protocol.js";

const childPath = fileURLToPath(new URL("./test-child.mjs", import.meta.url));
const fixturesDir = fileURLToPath(new URL("../../../../../../references/claude-code-2.1.212/fixtures/", import.meta.url));

function fixture(name: string): string {
  return join(fixturesDir, name);
}

/**
 * The trust gate, stubbed for every test whose subject is the TRANSPORT (same
 * rationale as codex/app-server-client.test.ts's `TRUSTED`): the binary these
 * tests spawn is the test runner's own `node`, whose on-disk permissions are a
 * property of the machine, not of anything under test.
 */
const TRUSTED = (): null => null;

const pidFiles: string[] = [];
afterAll(() => {
  for (const path of pidFiles) {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function makeClient(args: string[], overrides: Partial<ConstructorParameters<typeof ClaudeClient>[0]> = {}): ClaudeClient {
  return new ClaudeClient({
    binaryPath: process.execPath,
    binaryArgs: [childPath, ...args],
    cwd: process.cwd(),
    sourceEnv: { HOME: "/home/test", PATH: process.env.PATH },
    profileDir: "/home/test/.anycode/claude/profile-default",
    binaryTrust: TRUSTED,
    ...overrides,
  });
}

async function drain<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  for (let i = 0; i < count; i++) {
    const result = await iterator.next();
    if (result.done) throw new Error("notification stream closed unexpectedly");
    out.push(result.value);
  }
  return out;
}

describe("ClaudeClient", () => {
  it("completes the initialize handshake against a live-captured signed-in fixture, never awaiting system/init", async () => {
    const client = makeClient([`--fixture=${fixture("w0-13-authprobe-signedin.jsonl")}`]);
    try {
      await client.start();
      const result = await client.initialize();
      // Custody (contract §5): email/organization must never survive past this call.
      expect(result.account).not.toHaveProperty("email");
      expect(result.account).not.toHaveProperty("organization");
      expect(result.account.subscriptionType).toBe("Claude Max");
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.commands.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("carries a turn through to a terminal result frame", async () => {
    const client = makeClient([`--fixture=${fixture("w0-01-persistence.jsonl")}`]);
    try {
      await client.start();
      await client.initialize();
      client.sendUserMessage("Reply with exactly: TURN-ONE-OK");
      const iterator = client.notifications()[Symbol.asyncIterator]();
      let result: unknown;
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("notification stream closed before a result frame arrived");
        const message = next.value as { type: string };
        if (message.type === "result") {
          result = message;
          break;
        }
      }
      expect((result as { subtype: string }).subtype).toBe("success");
      expect((result as { is_error: boolean }).is_error).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("routes a control_response success and a control_response error to the matching pending control request", async () => {
    const client = makeClient([`--fixture=${fixture("w0-16-setmodel.jsonl")}`]);
    try {
      await client.start();
      await client.initialize();
      await client.getContextUsage();
      await expect(client.controlRequest("set_model", { model: "claude-fable-5[1m]" })).resolves.toBeUndefined();
      await client.getContextUsage();
      await expect(client.controlRequest("set_model", { model: "no-such-model-xyz" })).rejects.toThrow(ClaudeClientError);
    } finally {
      await client.close();
    }
  });

  it("drops the pending inbound can_use_tool handler when the CLI cancels it during an interrupt race, without answering it", async () => {
    let heldResponder: { success: (r?: unknown) => void; error: (m?: string) => void } | undefined;
    let cancelSignal: AbortSignal | undefined;
    let sawCanUseTool = false;
    const canUseToolSeen = new Promise<void>((resolve) => {
      const check = (): void => {
        if (heldResponder) {
          sawCanUseTool = true;
          resolve();
        } else {
          setImmediate(check);
        }
      };
      check();
    });

    const client = makeClient([`--fixture=${fixture("w0-03-interrupt-pending.jsonl")}`], {
      onControlRequest: (request, respond) => {
        if (request.subtype === "can_use_tool") {
          // A real approval bridge parked on a user decision. It settles ONLY
          // when the request's cancellation signal fires — so this promise is
          // simultaneously the "slow handler" the pairing rule must tolerate
          // AND the proof that a withdrawal actually releases the handler
          // rather than merely suppressing its late write. If cancellation is
          // not propagated, this never resolves.
          heldResponder = respond;
          cancelSignal = request.signal;
          return new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        respond.error();
        return undefined;
      },
    });
    try {
      await client.start();
      await client.initialize();
      client.sendUserMessage("trigger a tool call");
      await canUseToolSeen;
      expect(sawCanUseTool).toBe(true);

      const interrupted = client.interrupt();
      await expect(interrupted).resolves.toEqual({ stillQueued: [] });

      // The withdrawal must SETTLE the handler, not just silence it: a bridge
      // parked on a user decision has nothing else to release it, and a leaked
      // handler holds the approval modal open and refuses every later approval
      // in the session.
      expect(cancelSignal?.aborted).toBe(true);

      // Pairing rule (contract §2.2): the CLI's control_cancel_request already
      // withdrew this request. A slow handler settling AFTER that must be a
      // safe no-op, never a stray write to a child that never asked again.
      expect(() => heldResponder?.error("too late")).not.toThrow();

      const iterator = client.notifications()[Symbol.asyncIterator]();
      let result: unknown;
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("notification stream closed before a result frame arrived");
        const message = next.value as { type: string };
        if (message.type === "result") {
          result = message;
          break;
        }
      }
      expect((result as { subtype: string }).subtype).toBe("error_during_execution");
    } finally {
      await client.close();
    }
  });

  it("fails closed on a malformed or oversized NDJSON line", async () => {
    for (const args of [["--malformed"], ["--oversize"]]) {
      const client = makeClient(args, { maxLineBytes: 1_024 });
      try {
        await client.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(client.controlRequest("initialize", {})).rejects.toBeInstanceOf(ClaudeClientError);
      } finally {
        await client.close();
      }
    }
  });

  it("reaps a stubborn detached process group on close (orphan real-PoC)", async () => {
    const pidFile = join(fixturesDir, `..`, `..`, `stubborn-${Date.now()}.pid`);
    pidFiles.push(pidFile);
    const client = makeClient(["--stubborn-group", `--pid-file=${pidFile}`]);
    await client.start();
    await waitForFile(pidFile);
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(grandchildPid)).toBe(true);

    await client.close();
    const end = Date.now() + 1_500;
    while (alive(grandchildPid) && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alive(grandchildPid)).toBe(false);
  }, 15_000);

  it("rejects an unsupported (pre-floor) Claude version at preflight", async () => {
    const client = makeClient(["--version", "--bad-version"]);
    await expect(client.start()).rejects.toThrow(EngineVersionError);
  });

  // ── framing hazards that need precise chunk control (mocked spawn, no real subprocess) ──

  interface FakeStream extends EventEmitter {
    write(chunk: unknown): boolean;
    end(): void;
    pause(): void;
    resume(): void;
  }

  function makeFakeStream(): FakeStream {
    const stream = new EventEmitter() as FakeStream;
    stream.write = () => true;
    stream.end = () => {};
    stream.pause = () => {};
    stream.resume = () => {};
    return stream;
  }

  function makeFramingClient(): { client: ClaudeClient; emit: (chunk: Buffer) => void } {
    let mainStdout: FakeStream | undefined;
    let callIndex = 0;
    const client = new ClaudeClient({
      binaryPath: "/fake/claude",
      cwd: process.cwd(),
      sourceEnv: { HOME: "/home/test", PATH: process.env.PATH },
      profileDir: "/home/test/.anycode/claude/profile-default",
      binaryTrust: TRUSTED,
      spawnImpl: (_command, args) => {
        callIndex++;
        const child = new EventEmitter() as unknown as {
          pid: number;
          stdin: FakeStream;
          stdout: FakeStream;
          stderr: FakeStream;
          kill: () => boolean;
        } & EventEmitter;
        child.pid = 1_000 + callIndex;
        child.stdin = makeFakeStream();
        child.stdout = makeFakeStream();
        child.stderr = makeFakeStream();
        // Simulates a clean, immediate exit on stdin EOF/kill — these framing
        // tests are not exercising teardown timing, so the fake child must
        // resolve `close()`'s `exitedWithin` race immediately rather than
        // burning the real CLAUDE_TEARDOWN_* wall-clock budgets.
        const emitClose = (): void => queueMicrotask(() => child.emit("close", 0, null));
        child.stdin.end = emitClose;
        child.kill = () => {
          emitClose();
          return true;
        };
        if (args.includes("--version")) {
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from("2.1.212 (Claude Code)\n"));
            child.emit("close", 0, null);
          });
        } else {
          mainStdout = child.stdout;
          queueMicrotask(() => child.emit("spawn"));
        }
        return child as unknown as ReturnType<NonNullable<ConstructorParameters<typeof ClaudeClient>[0]["spawnImpl"]>>;
      },
    });
    return {
      client,
      emit: (chunk: Buffer) => mainStdout!.emit("data", chunk),
    };
  }

  it("parses two NDJSON messages delivered in a single stdout chunk", async () => {
    const { client, emit } = makeFramingClient();
    try {
      await client.start();
      const line1 = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0, result: "first" })}\n`;
      const line2 = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0, result: "second" })}\n`;
      emit(Buffer.from(line1 + line2, "utf8"));
      const [first, second] = await drain(client.notifications(), 2);
      expect((first as { result: string }).result).toBe("first");
      expect((second as { result: string }).result).toBe("second");
    } finally {
      await client.close();
    }
  });

  it("reassembles a line split mid multi-byte UTF-8 character across two chunks", async () => {
    const { client, emit } = makeFramingClient();
    try {
      await client.start();
      const text = "héllo 🎉"; // "héllo 🎉" — 2-byte é, 4-byte emoji
      const line = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0, result: text })}\n`;
      const bytes = Buffer.from(line, "utf8");
      const emojiStart = bytes.indexOf(Buffer.from("🎉", "utf8"));
      const splitAt = emojiStart + 2; // inside the emoji's 4-byte sequence
      emit(bytes.subarray(0, splitAt));
      emit(bytes.subarray(splitAt));
      const [message] = await drain(client.notifications(), 1);
      expect((message as { result: string }).result).toBe(text);
    } finally {
      await client.close();
    }
  });
});

describe("buildClaudeSpawnArgs — reasoning-effort flag (TASK.75)", () => {
  it("includes --effort <level> immediately after --model when an effort is chosen", () => {
    const args = buildClaudeSpawnArgs({ model: "sonnet", effort: "high", sessionId: "s-1" });
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    // Sits right after --model, mirroring how the two travel together as a pair.
    expect(args.indexOf("--effort")).toBe(args.indexOf("--model") + 2);
  });

  it("omits --effort entirely when unset — the CLI's own default must never be fabricated as \"medium\"", () => {
    const args = buildClaudeSpawnArgs({ model: "sonnet", sessionId: "s-1" });
    expect(args).not.toContain("--effort");
  });

  it("omits --effort when there is no model either (bare fresh spawn)", () => {
    const args = buildClaudeSpawnArgs({ sessionId: "s-1" });
    expect(args).not.toContain("--effort");
  });
});

describe("buildClaudeChildEnv", () => {
  it("never forwards ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDECODE, and sets CLAUDE_CONFIG_DIR to an explicit override", () => {
    const env = buildClaudeChildEnv(
      {
        HOME: "/home/test",
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sentinel",
        ANTHROPIC_AUTH_TOKEN: "sentinel",
        CLAUDECODE: "1",
      },
      "/home/test/.anycode/claude/profile-default",
      "darwin",
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/test/.anycode/claude/profile-default");
  });

  it("ambient default (owner pivot): no profileDir override -> no CLAUDE_CONFIG_DIR key at all, so the CLI resolves its own ambient ~/.claude", () => {
    const env = buildClaudeChildEnv({ HOME: "/home/test", PATH: "/usr/bin" }, undefined, "darwin");
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });
});

describe("redactHomePaths (custody C2)", () => {
  it("rewrites BOTH the literal and dash-slug home-path encodings", () => {
    const homeDir = "/Users/testuser";
    const input = {
      memoryFiles: [
        { path: "/Users/testuser/.claude/CLAUDE.md", type: "Project", tokens: 0 },
        { path: "~/.claude/projects/-Users-testuser-projects-app/memory/MEMORY.md", type: "AutoMem", tokens: 500 },
      ],
    };
    const redacted = redactHomePaths(input, homeDir) as typeof input;
    expect(redacted.memoryFiles[0]!.path).toBe("[HOME]/.claude/CLAUDE.md");
    expect(redacted.memoryFiles[1]!.path).toBe("~/.claude/projects/[HOME-SLUG]-projects-app/memory/MEMORY.md");
    expect(JSON.stringify(redacted)).not.toContain("testuser");
  });

  it("regresses the isolated get_context_usage state: no AutoMem entry, 0 tokens for the global CLAUDE.md", async () => {
    const client = makeClient([`--fixture=${fixture("w0-17-custody-B-isolated.jsonl")}`]);
    try {
      await client.start();
      await client.initialize();
      const usage = await client.getContextUsage();
      const memoryFiles = usage.memoryFiles as Array<{ path: string; type: string; tokens: number }>;
      expect(memoryFiles).toHaveLength(1);
      expect(memoryFiles[0]!.type).toBe("Project");
      expect(memoryFiles[0]!.tokens).toBe(0);
      expect(memoryFiles.some((entry) => entry.path.includes("MEMORY.md"))).toBe(false);
    } finally {
      await client.close();
    }
  });
});

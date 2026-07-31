import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ENV_CLAUDE_BIN, ENV_CODEX_BIN } from "../shared/engines.js";
import { createEngineChildRunner, type EngineChildSpawn } from "./engine-children.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(pid = 424242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.kill = vi.fn();
  return child;
}

function ndjson(lines: readonly unknown[]): Buffer {
  return Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  options: Parameters<EngineChildSpawn>[2];
}

function fakeSpawner(): { spawn: EngineChildSpawn; child: FakeChild; calls: CapturedSpawn[] } {
  const child = makeFakeChild();
  const calls: CapturedSpawn[] = [];
  const spawn: EngineChildSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return child as unknown as ReturnType<EngineChildSpawn>;
  };
  return { spawn, child, calls };
}

const TEST_PATH = "/test/bin:/test/usr/bin";

function baseDeps(overrides: Partial<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: TEST_PATH,
    HOME: "/home/tester",
    ANYCODE_SUPER_SECRET_TOKEN: "should-never-leak-to-a-child",
    ...overrides,
  };
}

describe("createEngineChildRunner: argv construction", () => {
  it("builds the Claude one-shot argv without --model when spec.model is absent", async () => {
    const { spawn, child, calls } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const outcomePromise = runner(
      { engine: "claude", prompt: "do the thing", agentType: "explore", description: "look around" },
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/opt/bin/claude");
    expect(calls[0]?.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--disable-slash-commands",
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      `Working directory: /work/session\nRun every command and resolve every relative path there. If the task below names a different absolute path, this line wins.\n\ndo the thing`,
    ]);
    expect(calls[0]?.options.cwd).toBe("/work/session");

    child.emit("close", 0);
    await outcomePromise;
  });

  it("inserts --model right before the prompt when spec.model is set", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const outcomePromise = runner(
      { engine: "claude", prompt: "do the thing", agentType: "explore", description: "look around", model: "claude-op-test" },
      {},
    );

    const args = calls[0]?.args ?? [];
    expect(args.slice(-3, -1)).toEqual(["--model", "claude-op-test"]);
    expect(args.at(-1)).toContain("do the thing");

    child.emit("close", 0);
    await outcomePromise;
  });

  it("builds the Codex one-shot argv without --model when spec.model is absent", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CODEX_BIN]: "/opt/bin/codex" }, spawn });

    const outcomePromise = runner(
      { engine: "codex", prompt: "do the thing", agentType: "explore", description: "look around" },
      {},
    );

    expect(calls[0]?.command).toBe("/opt/bin/codex");
    expect(calls[0]?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      "approval_policy=never",
      "--cd",
      "/work/session",
      `Working directory: /work/session\nRun every command and resolve every relative path there. If the task below names a different absolute path, this line wins.\n\ndo the thing`,
    ]);

    child.emit("close", 0);
    await outcomePromise;
  });

  it("inserts --model right before the prompt for Codex when spec.model is set", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CODEX_BIN]: "/opt/bin/codex" }, spawn });

    const outcomePromise = runner(
      { engine: "codex", prompt: "do the thing", agentType: "explore", description: "look around", model: "codex-op-test" },
      {},
    );

    const args = calls[0]?.args ?? [];
    expect(args.slice(-3, -1)).toEqual(["--model", "codex-op-test"]);
    expect(args.at(-1)).toContain("do the thing");

    child.emit("close", 0);
    await outcomePromise;
  });

  it("pins the spawn cwd in the prompt ahead of a conflicting path in the task text", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/worktree", env: { ...baseDeps(), [ENV_CODEX_BIN]: "/opt/bin/codex" }, spawn });

    const outcomePromise = runner(
      {
        engine: "codex",
        // The parent named the WRONG directory in the task text — the live
        // failure this pin exists for.
        prompt: "List .anycode/agents (working directory: /work/repo-root)",
        agentType: "explore",
        description: "look around",
      },
      {},
    );

    const prompt = calls[0]?.args.at(-1) ?? "";
    // The authoritative cwd is stated, precedes the task text, and is the real
    // spawn cwd — not the one the task text claims.
    expect(prompt.startsWith("Working directory: /work/worktree\n")).toBe(true);
    expect(prompt.indexOf("/work/worktree")).toBeLessThan(prompt.indexOf("/work/repo-root"));
    expect(calls[0]?.options.cwd).toBe("/work/worktree");
    expect(calls[0]?.args).toContain("/work/worktree");

    child.emit("close", 0);
    await outcomePromise;
  });

  it("passes the allowlisted child env (PATH kept, ANYCODE_* secret dropped)", async () => {
    const { spawn, calls, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const outcomePromise = runner(
      { engine: "claude", prompt: "hi", agentType: "explore", description: "d" },
      {},
    );

    const capturedEnv = calls[0]?.options.env ?? {};
    expect(capturedEnv.PATH?.startsWith(TEST_PATH)).toBe(true);
    expect(capturedEnv.ANYCODE_SUPER_SECRET_TOKEN).toBeUndefined();

    child.emit("close", 0);
    await outcomePromise;
  });
});

describe("createEngineChildRunner: missing binary", () => {
  it("returns an error outcome without spawning when ANYCODE_CLAUDE_BIN is unset", async () => {
    const { spawn, calls } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: baseDeps(), spawn });

    const outcome = await runner({ engine: "claude", prompt: "hi", agentType: "explore", description: "d" }, {});

    expect(calls).toHaveLength(0);
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toContain(ENV_CLAUDE_BIN);
  });

  it("returns an error outcome without spawning when ANYCODE_CODEX_BIN is unset", async () => {
    const { spawn, calls } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: baseDeps(), spawn });

    const outcome = await runner({ engine: "codex", prompt: "hi", agentType: "explore", description: "d" }, {});

    expect(calls).toHaveLength(0);
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toContain(ENV_CODEX_BIN);
  });
});

describe("createEngineChildRunner: Claude NDJSON parsing", () => {
  it("bridges a tool_use block to onProgress and captures the final text", async () => {
    const { spawn, child } = fakeSpawner();
    const onProgress = vi.fn();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const outcomePromise = runner(
      { engine: "claude", prompt: "run echo", agentType: "explore", description: "d" },
      { onProgress },
    );

    child.stdout.emit(
      "data",
      ndjson([
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "DONE" }] } },
        { type: "result", is_error: false, subtype: "success", result: "DONE", num_turns: 2 },
      ]),
    );
    child.emit("close", 0);

    const outcome = await outcomePromise;

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("DONE");
    expect(outcome.turns).toBe(2);
    expect(outcome.toolCalls).toBe(1);

    const toolCalls = onProgress.mock.calls.map((call) => call[0]).filter((event) => event.kind === "tool");
    expect(toolCalls).toEqual([{ kind: "tool", toolName: "Bash", summary: "echo hi" }]);
  });

  it("maps an is_error result to status error and surfaces a message", async () => {
    const { spawn, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const outcomePromise = runner({ engine: "claude", prompt: "hi", agentType: "explore", description: "d" }, {});

    child.stdout.emit("data", ndjson([{ type: "result", is_error: true, subtype: "error_during_execution" }]));
    child.emit("close", 0);

    const outcome = await outcomePromise;
    expect(outcome.status).toBe("error");
    expect(outcome.finalText.length).toBeGreaterThan(0);
  });

  it("maps error_max_turns to status max_turns", async () => {
    const { spawn, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const outcomePromise = runner({ engine: "claude", prompt: "hi", agentType: "explore", description: "d" }, {});

    child.stdout.emit("data", ndjson([{ type: "result", is_error: true, subtype: "error_max_turns", num_turns: 8 }]));
    child.emit("close", 0);

    const outcome = await outcomePromise;
    expect(outcome.status).toBe("max_turns");
    expect(outcome.turns).toBe(8);
  });

  it("ignores a garbage line in the middle of the stream without crashing the run", async () => {
    const { spawn, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const outcomePromise = runner({ engine: "claude", prompt: "hi", agentType: "explore", description: "d" }, {});

    child.stdout.emit("data", Buffer.from("not json at all\n", "utf8"));
    child.stdout.emit("data", ndjson([{ type: "result", is_error: false, subtype: "success", result: "OK", num_turns: 1 }]));
    child.emit("close", 0);

    const outcome = await outcomePromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("OK");
  });
});

describe("createEngineChildRunner: Codex JSONL parsing", () => {
  it("bridges a non-agent_message item to onProgress and captures the final agent_message text", async () => {
    const { spawn, child } = fakeSpawner();
    const onProgress = vi.fn();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CODEX_BIN]: "/opt/bin/codex" }, spawn });

    const outcomePromise = runner(
      { engine: "codex", prompt: "run echo", agentType: "explore", description: "d" },
      { onProgress },
    );

    child.stdout.emit(
      "data",
      ndjson([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "echo hi", exit_code: 0 } },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "DONE" } },
        { type: "turn.completed", usage: {} },
      ]),
    );
    child.emit("close", 0);

    const outcome = await outcomePromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("DONE");
    expect(outcome.toolCalls).toBe(1);

    const toolCalls = onProgress.mock.calls.map((call) => call[0]).filter((event) => event.kind === "tool");
    expect(toolCalls).toEqual([{ kind: "tool", toolName: "command_execution", summary: "echo hi" }]);
  });

  it("maps turn.failed to status error and surfaces the error message", async () => {
    const { spawn, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CODEX_BIN]: "/opt/bin/codex" }, spawn });

    const outcomePromise = runner({ engine: "codex", prompt: "hi", agentType: "explore", description: "d" }, {});

    child.stdout.emit(
      "data",
      ndjson([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "error", message: "boom (turn-level)" },
        { type: "turn.failed", error: { message: "boom (authoritative)" } },
      ]),
    );
    child.emit("close", 1);

    const outcome = await outcomePromise;
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe("boom (authoritative)");
  });

  it("falls back to a stderr-derived message when the process exits nonzero with no parsed terminal line", async () => {
    const { spawn, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CODEX_BIN]: "/opt/bin/codex" }, spawn });

    const outcomePromise = runner({ engine: "codex", prompt: "hi", agentType: "explore", description: "d" }, {});

    child.stderr.emit("data", Buffer.from("codex: fatal startup error\n", "utf8"));
    child.emit("close", 1);

    const outcome = await outcomePromise;
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toContain("fatal startup error");
  });
});

describe("createEngineChildRunner: cancellation", () => {
  it("kills the child and resolves cancelled when the signal aborts", async () => {
    const { spawn, child } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const controller = new AbortController();
    const outcomePromise = runner(
      { engine: "claude", prompt: "hi", agentType: "explore", description: "d" },
      { signal: controller.signal },
    );

    controller.abort();
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("cancelled");
    // The real process-group kill targets a pid that does not exist on this
    // machine and throws synchronously (ESRCH); killChild's catch falls back
    // to the direct child.kill(), which is the fake's spy.
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("resolves cancelled immediately when the signal is already aborted", async () => {
    const { spawn, calls } = fakeSpawner();
    const runner = createEngineChildRunner({ cwd: "/work/session", env: { ...baseDeps(), [ENV_CLAUDE_BIN]: "/opt/bin/claude" }, spawn });

    const controller = new AbortController();
    controller.abort();

    const outcome = await runner(
      { engine: "claude", prompt: "hi", agentType: "explore", description: "d" },
      { signal: controller.signal },
    );

    expect(outcome.status).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });
});

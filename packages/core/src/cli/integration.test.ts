/**
 * Interactive runCli e2e (design slice-4.1-cut.md §5.2 item 8, task 4.1.5).
 * terminal-broker.test.ts only unit-tests TerminalPermissionBroker in
 * isolation (a scripted TerminalPrompter, no dispatcher); this file drives the
 * REAL loop end-to-end through runCli({ interactive: true }): the real tool
 * registry, the real RuleAwarePermissionEngine + SessionPermissionRules, and
 * the real TerminalPermissionBroker attached via the readline prompter — the
 * only place those four pieces are ever proven to cooperate.
 *
 * Fixtures mirror main.test.ts (ScriptedModelPort + PassThrough input/output)
 * and print.test.ts (never write an answer blindly — wait for the prompt text
 * to actually land in `output` first, exactly like print.test.ts's `vi.waitFor`
 * on `reachedHang`). `loop_end` (agent-loop.ts:467, rendered by
 * cli/render.ts's renderEvent) is emitted exactly once per runTurn call, so
 * "[loop_end:" occurrence counts are used as the turn-boundary barrier between
 * two REPL lines in the "a" test below — no real timers, no guessed delays.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./main.js";
import { SqlitePersistenceAdapter } from "../adapters/node/sqlite-persistence.js";
import { ConversationHistory } from "../context/history.js";
import type { ModelPort, ModelRequest } from "../ports/index.js";
import type { ChatMessage } from "../types/history.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { PermissionMode } from "../types/permissions.js";

/**
 * Replays one fixed event script per call index, falling back to an immediate
 * stop (mirrors main.test.ts). Additive on top of the pre-4.3 version (design
 * slice-4.3-cut.md §5.1): `requests` records every ModelRequest this port has

 * inspect the exact user-message text the model received — the reminder tag
 * rides inside ChatMessage.content, which never reaches stdout, so capturing
 * the request is the only hermetic way to observe it. Every existing
 * call/consumer that never reads `.requests` is unaffected.
 */
class SequencedModelPort implements ModelPort {
  private call = 0;
  readonly requests: ModelRequest[] = [];
  constructor(private readonly scripts: ModelStreamEvent[][]) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const events = this.scripts[this.call] ?? [
      { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent,
    ];
    this.call += 1;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

/** Narrows a ChatMessage to the user variant (string content) for reminder-text inspection. */
function isUserMessage(message: ChatMessage): message is { role: "user"; content: string } {
  return message.role === "user";
}

/**
 * Yields `start`, then blocks on `gate` before replaying `events` — used only by

 * (non-fake) CLI_STATUS_INTERVAL_MS timer needs the model step to sit open for
 * at least one real tick; resolving `gate` only AFTER the test has observed the
 * first ERASE byte (rather than a fixed sleep) keeps the test deterministic
 * without guessing a delay.
 */
class StallingModelPort implements ModelPort {
  constructor(
    private readonly gate: Promise<void>,
    private readonly events: ModelStreamEvent[],
  ) {}

  streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const { gate, events } = this;
    return (async function* () {
      yield { type: "start" };
      await gate;
      for (const event of events) {
        yield event;
      }
    })();
  }
}

/** A promise the test resolves explicitly once it has observed what it's waiting for. */
function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function collectOutput(output: PassThrough): () => string {
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

function makeEnv(dbPath: string): NodeJS.ProcessEnv {
  return {
    ANYCODE_API_KEY: "test-key",
    ANYCODE_MODEL: "test-model",
    ANYCODE_DB_PATH: dbPath,
  } as NodeJS.ProcessEnv;
}

const tempDirs: string[] = [];

/** Fresh workspace dir (Write targets live here) + fresh sqlite db path, isolated per test. */
function setupTempDirs(): { workspace: string; dbPath: string; settingsFilePath: string } {
  const workspace = mkdtempSync(join(tmpdir(), "anycode-cli-e2e-ws-"));
  const dbDir = mkdtempSync(join(tmpdir(), "anycode-cli-e2e-db-"));
  const settingsDir = mkdtempSync(join(tmpdir(), "anycode-cli-e2e-settings-"));
  tempDirs.push(workspace, dbDir, settingsDir);
  return { workspace, dbPath: join(dbDir, "anycode.sqlite"), settingsFilePath: join(settingsDir, "settings.json") };
}

/**
 * Reopens the session persisted at `dbPath` for `workspace` (runCli's own
 * exit path already flushed + closed the write-behind sink and the db, design
 * §2.4/R8, before runCli's promise resolves) and asserts the history integrity
 * invariant (design §2.10, context/history.ts:7-11): every assistant tool_call
 * has exactly one matching tool_result.
 */
async function assertHistoryFullyAnswered(dbPath: string, workspace: string): Promise<void> {
  const persistence = new SqlitePersistenceAdapter(dbPath);
  try {
    const sessions = await persistence.listSessions({ workspace });
    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions[0]!;
    const items = await persistence.loadHistory(session.id);
    const history = new ConversationHistory({ initial: items });
    expect(history.unansweredToolCallIds()).toEqual([]);
  } finally {
    await persistence.close();
  }
}

/**
 * Reopens the session persisted at `dbPath` for `workspace` (mirrors
 * assertHistoryFullyAnswered above) and returns its persisted `mode` — the

 * fired from the loop's onModeChange callback) actually landed. SqlitePersistenceAdapter
 * is backed by node:sqlite's synchronous DatabaseSync (adapters/node/sqlite-persistence.ts),
 * so the fire-and-forget `void persistence.touchSession(...).catch(...)` call inside
 * onModeChange has already completed its synchronous UPDATE by the time the
 * async function returns — there is no write-visibility race to wait out here.
 */
async function readSessionMode(dbPath: string, workspace: string): Promise<PermissionMode> {
  const persistence = new SqlitePersistenceAdapter(dbPath);
  try {
    const sessions = await persistence.listSessions({ workspace });
    expect(sessions.length).toBeGreaterThan(0);
    return sessions[0]!.mode;
  } finally {
    await persistence.close();
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("interactive runCli e2e — TerminalPermissionBroker y/n/a (design slice-4.1-cut.md §5.2 item 8)", () => {
  it("y: the [permission] prompt appears, 'y' allows, the Write executes, the turn completes", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const filePath = join(workspace, "hello.txt");
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: { id: "call-1", name: "Write", input: { file_path: filePath, content: "hello y" } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    input.write("please write a file\n");

    // Synchronize on the ACTUAL prompt text landing in output before answering

    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n/a]:")) {
        throw new Error("[permission] ask has not been shown yet");
      }
    });
    expect(getText()).toContain(`[permission] Write (risk: medium, destructive) — {"file_path":"${filePath}","content":"hello y"}`);
    expect(getText()).toContain("a = always allow Write this session");
    // Not yet created: the ask is still pending an answer.
    expect(existsSync(filePath)).toBe(false);

    input.write("y\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("hello y");
    expect(getText()).not.toContain("(denied)");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("n: 'n' denies — the denied outcome is rendered, the file is never created, the turn still completes", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const filePath = join(workspace, "hello.txt");
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: { id: "call-1", name: "Write", input: { file_path: filePath, content: "hello n" } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "ok" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    input.write("please write a file\n");

    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n/a]:")) {
        throw new Error("[permission] ask has not been shown yet");
      }
    });

    input.write("n\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    expect(existsSync(filePath)).toBe(false);
    expect(getText()).toContain("[tool result] Write (denied): denied by user");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("a: 'a' allows once AND adds a session rule — a second Write in a later turn runs with NO second prompt", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const filePathOne = join(workspace, "one.txt");
    const filePathTwo = join(workspace, "two.txt");
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: { id: "call-1", name: "Write", input: { file_path: filePathOne, content: "first" } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "ok1" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: { id: "call-2", name: "Write", input: { file_path: filePathTwo, content: "second" } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t2", text: "ok2" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    input.write("please write file one\n");

    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n/a]:")) {
        throw new Error("[permission] ask has not been shown yet");
      }
    });
    expect(countOccurrences(getText(), "answer [y/n/a]:")).toBe(1);

    input.write("a\n");

    // First turn's own loop_end is the barrier before the SECOND line: the
    // RuleAware engine's downgrade (design §0.1) is a property of the NEXT
    // dispatch, so the second Write must not be sent until turn 1 has fully
    // closed out (rl.prompt() -> the outer for-await requests the next line).
    await vi.waitFor(() => {
      if (countOccurrences(getText(), "[loop_end: completed, turns=") < 1) {
        throw new Error("turn 1 has not completed yet");
      }
    });
    expect(existsSync(filePathOne)).toBe(true);

    input.write("please write file two\n");

    await vi.waitFor(() => {
      if (countOccurrences(getText(), "[loop_end: completed, turns=") < 2) {
        throw new Error("turn 2 has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    // The rule engine downgraded ask -> allow for the second Write BEFORE the
    // broker was ever consulted (design §3.1/§0.1) — exactly one ask shown,
    // ever, across both turns.
    expect(countOccurrences(getText(), "answer [y/n/a]:")).toBe(1);
    expect(existsSync(filePathOne)).toBe(true);
    expect(existsSync(filePathTwo)).toBe(true);
    expect(readFileSync(filePathOne, "utf8")).toBe("first");
    expect(readFileSync(filePathTwo, "utf8")).toBe("second");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });
});

describe("transcript-v2 e2e — diffs/collapse/reasoning/status (design slice-4.2-cut.md §5.2 para.7-8)", () => {
  it("Edit renders a +/- diff block (not the raw JSON tool_execution_start line), and a non-TTY PassThrough session stays spinner-free", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const filePath = join(workspace, "a.ts");
    writeFileSync(filePath, "const x = 1;\nkeep\n");
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: {
            id: "call-1",
            name: "Edit",
            input: { file_path: filePath, old_string: "const x = 1;", new_string: "const x = 2;" },
          },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    input.write("please fix the file\n");

    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n/a]:")) {
        throw new Error("[permission] ask has not been shown yet");
      }
    });
    input.write("y\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    // The diff block (design §3.1): a "-" line carrying the old fragment and a
    // "+" line carrying the new one — NOT the pre-4.2 raw-JSON
    // tool_execution_start line the same event used to render as.
    expect(text).toContain("- const x = 1;");
    expect(text).toContain("+ const x = 2;");
    expect(text).not.toContain(`[tool] Edit {"file_path"`);
    expect(readFileSync(filePath, "utf8")).toBe("const x = 2;\nkeep\n");


    // a PassThrough), never the `interactive` test-override — so this session,
    // despite interactive:true, must be completely spinner-free (direct test of
    // the gate that keeps every pre-4.2 PassThrough e2e test spinner-free).
    expect(text).not.toContain("\x1b[2K");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("collapses a long tool_result body into head + '(+K more lines)' + tail (design §3.2)", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    // Read/Write/Edit/Bash all serialize a STRUCTURED output object through the
    // dispatcher's default formatModelText (JSON.stringify), which escapes any
    // embedded newline to the two literal characters "\n" — so their modelText
    // never contains a real line break, and collapseOutput's split("\n") always
    // sees exactly one "line" regardless of file size (verified empirically:
    // a 60-line Read comes back as one 577-char JSON line). The Agent tool is
    // the one built-in whose formatResultForModel (tools/agent.ts) returns the
    // raw subagent finalText verbatim — a genuine multi-line string — and
    // subagents run through the SAME shared modelPort as the parent (design
    // phase-3.md §3.1), so this is the one real tool call that can exercise the
    // actual head/tail collapse end-to-end rather than only in render.test.ts's
    // direct unit coverage of collapseOutput.
    const longLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: {
            id: "call-1",
            name: "Agent",
            input: { description: "dump lines", prompt: "dump 60 lines", agent_type: "general-purpose" },
          },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      // The child subagent's own single step, consumed by its nested runTurn
      // call (same shared SequencedModelPort — call index 1, sandwiched inside
      // the parent's call-0 tool dispatch).
      [
        { type: "start" },
        { type: "text_delta", id: "c1", text: longLines },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    // Agent: readOnly:true/needsApproval:false -> allowed automatically (no ask).
    input.write("dump a long file via a subagent\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    // The fixed "[tool result] <name> (<status>): " prefix is never touched by
    // collapse (design §3.2) — only the modelText tail after it is capped.
    expect(text).toContain("[tool result] Agent (success): ");
    // head (10 lines) + marker (K = 60 - 10 - 5 = 45) + tail (5 lines).
    expect(text).toContain("line 1");
    expect(text).toContain("line 10");
    expect(text).toContain("… (+45 more lines)");
    expect(text).toContain("line 56");
    expect(text).toContain("line 60");
    // Anything strictly inside the hidden gap must not survive.
    expect(text).not.toContain("line 11");
    expect(text).not.toContain("line 30");
    expect(text).not.toContain("line 55");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("renders the model's reasoning stream as a dim [reasoning] block by default in interactive mode", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "reasoning_start", id: "r1" },
        { type: "reasoning_delta", id: "r1", text: "thinking about it" },
        { type: "reasoning_end", id: "r1" },
        { type: "text_delta", id: "t1", text: "final answer" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    input.write("hello\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
    expect(getText()).toContain("[reasoning]");
    expect(getText()).toContain("thinking about it");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("--no-reasoning starts a session with the reasoning block suppressed", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "reasoning_start", id: "r1" },
        { type: "reasoning_delta", id: "r1", text: "thinking about it" },
        { type: "reasoning_end", id: "r1" },
        { type: "text_delta", id: "t1", text: "final answer" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: ["--no-reasoning"],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    input.write("hello\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
    expect(getText()).not.toContain("[reasoning]");
    expect(getText()).not.toContain("thinking about it");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("/reasoning toggles the reasoning block off at runtime, taking effect from the next turn onward", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const reasoningStep = (): ModelStreamEvent[] => [
      { type: "start" },
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "thinking about it" },
      { type: "reasoning_end", id: "r1" },
      { type: "text_delta", id: "t1", text: "final answer" },
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    const modelPort = new SequencedModelPort([reasoningStep(), reasoningStep()]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
    });

    input.write("hello\n");
    await vi.waitFor(() => {
      if (countOccurrences(getText(), "[loop_end: completed, turns=") < 1) {
        throw new Error("turn 1 has not completed yet");
      }
    });
    expect(getText()).toContain("[reasoning]");

    input.write("/reasoning\n");
    await vi.waitFor(() => {
      if (!getText().includes("rendering is now off")) {
        throw new Error("/reasoning has not been acknowledged yet");
      }
    });
    // Everything from here on is turn 2's own output — slicing from this mark
    // avoids a false pass from turn 1's already-rendered [reasoning] header
    // still being present in a whole-string toContain check.
    const markAfterToggle = getText().length;

    input.write("hello again\n");
    await vi.waitFor(() => {
      if (countOccurrences(getText(), "[loop_end: completed, turns=") < 2) {
        throw new Error("turn 2 has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
    expect(getText().slice(markAfterToggle)).not.toContain("[reasoning]");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("statusLine:true shows an ERASE+'thinking' spinner during a stall and clears it cleanly before loop_end's own line", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const gate = createGate();
    const modelPort = new StallingModelPort(gate.promise, [
      { type: "text_delta", id: "t1", text: "done" },
      { type: "finish", finishReason: "stop", usage: {} },
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,

      // `output` is a PassThrough with no real isTTY — the only way to exercise
      // the real tick-driven status.ts machinery from a hermetic, non-pty test.
      statusLine: true,
    });

    input.write("hello\n");

    // turn_start -> "thinking" is set immediately, but the redraw only happens
    // on CLI_STATUS_INTERVAL_MS's real tick (design §3.3) — wait for the actual
    // ERASE+frame bytes to land, then release the stall (never a blind fixed
    // sleep; the real timer, not a fake one, is what's under test here).
    await vi.waitFor(
      () => {
        if (!getText().includes("\x1b[2K")) {
          throw new Error("status line has not painted yet");
        }
      },
      { timeout: 2000 },
    );
    expect(getText()).toContain("thinking");
    gate.resolve();

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });


    // BEFORE renderEvent writes the loop_end line, so nothing after that line
    // is a leftover status frame/label.
    const text = getText();
    const tail = text.slice(text.lastIndexOf("[loop_end:"));
    expect(tail).not.toContain("thinking");
    expect(tail.endsWith("\x1b[2K")).toBe(false);

    input.write("/quit\n");
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    await assertHistoryFullyAnswered(dbPath, workspace);
  });
});

describe("plan-mode e2e (design slice-4.3-cut.md §5.2 para.7-9)", () => {
  it("approve: ExitPlanMode's ask shows the full plan; 'y' advances to build; the model's own next Write in the SAME turn gets its OWN ask (mid-turn escalation), not a plan-deny", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const filePath = join(workspace, "CHANGELOG.md");
    const planText =
      "Step 1: read package.json to confirm the current version.\n" +
      "Step 2: bump the version field to 1.2.3.\n" +
      "Step 3: write CHANGELOG.md with the release notes.";
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "ExitPlanMode", input: { plan: planText } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: { id: "call-2", name: "Write", input: { file_path: filePath, content: "release notes" } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
      mode: "plan",
    });

    input.write("bump the version and write the changelog\n");

    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n]:")) {
        throw new Error("[permission] ExitPlanMode ask has not been shown yet");
      }
    });
    const afterFirstAsk = getText();
    expect(afterFirstAsk).toContain("[permission] ExitPlanMode — plan approval requested");
    expect(afterFirstAsk).toContain(planText);
    expect(afterFirstAsk).toContain(
      "y = approve plan (switch to build mode; writes still ask) · n = reject (keep planning)",
    );
    // Render-side proof (design §3.5): the tool_execution_start line stayed
    // name-only, never a JSON dump of the plan — the ask above is the plan's
    // one authoritative on-screen display (the render/ask race, design §0.1).
    expect(afterFirstAsk).not.toContain('[tool] ExitPlanMode {"plan"');
    // Write's own ask has not been reached yet: the model hasn't even been
    // told the plan was approved.
    expect(afterFirstAsk).not.toContain("answer [y/n/a]:");
    expect(existsSync(filePath)).toBe(false);

    input.write("y\n");

    await vi.waitFor(() => {
      if (!getText().includes("[tool result] ExitPlanMode (success)")) {
        throw new Error("ExitPlanMode's own outcome has not landed yet");
      }
    });
    expect(getText()).toContain(
      'Plan approved by the user. Permission mode is now "build" — proceed with the implementation',
    );

    // Mid-turn escalation proof (design §3.1/§2.3): the SAME turn's very next
    // tool call — Write, proposed by the model right after the approved
    // ExitPlanMode tool_result — is now dispatched under build, so it gets its
    // OWN ask. A plan-deny would instead show no prompt at all and go straight
    // to a "(denied)" outcome (as proven by the reject-flow test below).
    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n/a]:")) {
        throw new Error("Write's own ask has not been shown yet");
      }
    });
    expect(getText()).toContain(
      `[permission] Write (risk: medium, destructive) — {"file_path":"${filePath}","content":"release notes"}`,
    );
    expect(existsSync(filePath)).toBe(false);

    input.write("y\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("release notes");
    expect(getText()).not.toContain("(denied)");

    await assertHistoryFullyAnswered(dbPath, workspace);

    // persisted session really did move to build, not just the in-memory config.
    expect(await readSessionMode(dbPath, workspace)).toBe("build");
  });

  it("reject: 'n' denies ExitPlanMode with an instructive reason, mode stays plan, and the model's own next Write is denied by the ENGINE (no second ask) rather than reaching the broker", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const filePath = join(workspace, "should-not-exist.txt");
    const planText = "Step 1: rename the export.\nStep 2: update the callers.";
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "ExitPlanMode", input: { plan: planText } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: { id: "call-2", name: "Write", input: { file_path: filePath, content: "too soon" } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "ok, refining the plan" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
      mode: "plan",
    });

    input.write("rename the export\n");

    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n]:")) {
        throw new Error("[permission] ExitPlanMode ask has not been shown yet");
      }
    });

    input.write("n\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).toContain(
      "[tool result] ExitPlanMode (denied): plan rejected by user — stay in plan mode and refine the plan",
    );
    // Engine-level plan-deny (design §3.1/§0.1): the mode never advanced past
    // "plan" (exitPlan() only mutates on approval, and the handler never even
    // ran here), Write is not readOnly, so the permission engine denies it
    // directly — no broker round-trip, so no second prompt of EITHER shape
    // (plan-approval or generic) ever appears.
    expect(text).not.toContain("answer [y/n/a]:");
    expect(countOccurrences(text, "answer [y/n]:")).toBe(1);
    expect(text).toContain(
      "[tool result] Write (denied): Write: only read-only tools are permitted in plan mode",
    );
    expect(existsSync(filePath)).toBe(false);

    await assertHistoryFullyAnswered(dbPath, workspace);
    expect(await readSessionMode(dbPath, workspace)).toBe("plan");
  });

  it("non-interactive: ExitPlanMode's ask is denied instantly by the DenyPermissionBroker (fail-closed, no hang), and the model's own next Write is denied as a plan-deny too", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const filePath = join(workspace, "should-not-exist.txt");
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "ExitPlanMode", input: { plan: "a plan" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: { id: "call-2", name: "Write", input: { file_path: filePath, content: "too soon" } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "ok" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: false,
      mode: "plan",
    });

    // No vi.waitFor gating here (design §5.1): a non-interactive session never
    // pauses on an ask (DenyPermissionBroker resolves synchronously with no
    // prompter round-trip), so — mirroring main.test.ts's own non-interactive
    // pattern — the whole turn runs to completion once the stream ends.
    input.write("please try to leave plan mode\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).toContain("[loop_end: completed, turns=");
    // Fail-closed, not fail-hung: no interactive prompt of any shape was ever shown.
    expect(text).not.toContain("[permission]");
    expect(text).toContain(
      "[tool result] ExitPlanMode (denied): ExitPlanMode: no interactive permission client configured",
    );
    expect(text).toContain(
      "[tool result] Write (denied): Write: only read-only tools are permitted in plan mode",
    );
    expect(existsSync(filePath)).toBe(false);

    await assertHistoryFullyAnswered(dbPath, workspace);
    expect(await readSessionMode(dbPath, workspace)).toBe("plan");
  });
});

describe("plan-mode reminder e2e (design slice-4.3-cut.md §5.2 para.10)", () => {
  it("a plan-mode turn's request carries <plan-mode-reminder> in the user message; the very next turn (after ExitPlanMode is approved) does not", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "ExitPlanMode", input: { plan: "a plan" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t2", text: "second turn" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
      mode: "plan",
    });

    input.write("please plan it\n");

    await vi.waitFor(() => {
      if (!getText().includes("answer [y/n]:")) {
        throw new Error("[permission] ExitPlanMode ask has not been shown yet");
      }
    });
    input.write("y\n");

    await vi.waitFor(() => {
      if (countOccurrences(getText(), "[loop_end: completed, turns=") < 1) {
        throw new Error("turn 1 has not completed yet");
      }
    });

    input.write("go on\n");

    await vi.waitFor(() => {
      if (countOccurrences(getText(), "[loop_end: completed, turns=") < 2) {
        throw new Error("turn 2 has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    // Turn 1's very first request (the one that produced the ExitPlanMode
    // call) carried the reminder appended to the user prompt (design

    // other way (the system prompt is static and shared with the desktop host).
    const turn1Users = (modelPort.requests[0]?.messages ?? []).filter(isUserMessage);
    const turn1LastUser = turn1Users[turn1Users.length - 1];
    expect(turn1LastUser?.content).toContain("<plan-mode-reminder>");
    expect(turn1LastUser?.content).toContain("please plan it");

    // The LAST request captured (turn 2's only model call) carries turn 2's
    // OWN user message with no reminder at all: config.mode was flipped to
    // "build" by exitPlan() mid-way through turn 1 (design §2.3), and
    // cli/main.ts's REPL reads loopConfig.mode fresh on every line (design


    const lastRequest = modelPort.requests[modelPort.requests.length - 1];
    const lastRequestUsers = (lastRequest?.messages ?? []).filter(isUserMessage);
    const turn2User = lastRequestUsers[lastRequestUsers.length - 1];
    expect(turn2User?.content).toBe("go on");
    expect(turn2User?.content).not.toContain("<plan-mode-reminder>");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("a build-mode turn's request never carries the reminder tag (byte-cleanliness outside plan)", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
      mode: "build",
    });

    input.write("hello\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const users = (modelPort.requests[0]?.messages ?? []).filter(isUserMessage);
    const lastUser = users[users.length - 1];
    expect(lastUser?.content).toBe("hello");
    expect(lastUser?.content).not.toContain("<plan-mode-reminder>");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });
});

describe("safe-command narrowing e2e (design slice-5.1-cut.md §6, R4)", () => {
  it("build-mode: a provably read-only Bash (git status) auto-approves in the live wiring — the turn completes with NO permission prompt", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "Bash", input: { command: "git status" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: true,
      mode: "build",
    });

    // No y/n is ever written: if the SafeCommandPermissionEngine had NOT
    // narrowed ask -> allow in the live main.ts composition, the interactive
    // broker would block on its prompt forever and this waitFor would time out.

    input.write("check the repo status\n");

    await vi.waitFor(() => {
      if (!getText().includes("[loop_end: completed, turns=")) {
        throw new Error("turn has not completed yet");
      }
    });
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    // Bash reports ok:true whenever the command ran to completion (exit code is
    // the command's own concern), so the outcome is "success" even in this
    // non-git temp workspace (dispatcher.ts:255).
    expect(text).toContain("[tool result] Bash (success):");
    // The decisive assertion: the classifier auto-approved inside engine.check
    // BEFORE the broker, so no ask of any shape was ever escalated.
    expect(text).not.toContain("[permission]");
    expect(text).not.toContain("answer [y/n");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });

  it("non-interactive: an unsafe Bash (rm) is NOT auto-approved — it asks and is denied by the DenyPermissionBroker (fail-closed, byte-identical to today)", async () => {
    const { workspace, dbPath, settingsFilePath } = setupTempDirs();
    const sentinel = join(workspace, "keep.txt");
    writeFileSync(sentinel, "survive");
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "Bash", input: { command: "rm -rf keep.txt" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "ok" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      settingsFilePath,
      interactive: false,
      mode: "build",
    });

    // Non-interactive (DenyPermissionBroker) resolves the ask synchronously with
    // no prompter round-trip, so the whole turn runs to completion once the
    // stream ends — no waitFor gating needed (mirrors the plan-mode non-interactive test).
    input.write("delete the file\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).toContain("[loop_end: completed, turns=");
    // The classifier did not touch this ask (rm is not allowlisted), so it
    // escalated and was denied fail-closed — the sentinel file is untouched.
    expect(text).toContain("[tool result] Bash (denied):");
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("survive");

    await assertHistoryFullyAnswered(dbPath, workspace);
  });
});

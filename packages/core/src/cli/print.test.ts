/**
 * --print mode tests (design slice-4.1-cut.md §5.2 item 7): a direct
 * runPrintMode unit suite (scripted fake AgentLoop) for the stdout/stderr
 * split + exit-code matrix (0/1/130) that would otherwise need awkward
 * end-to-end plumbing to force, plus an end-to-end suite through the real

 * the real fail-closed (non-interactive) broker denying an in-flight ask
 * without hanging, and that `-p` never creates a readline interface (the
 * input stream is never written to or ended, yet the run still resolves).
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runPrintMode,
  readPromptFromStdin,
  type PrintModeOptions,
  type PrintStructuredContext,
} from "./print.js";
import { createCliTheme } from "./theme.js";
import { runCli } from "./main.js";
import type { AgentLoop } from "../loop/index.js";
import type { McpManager } from "../mcp/index.js";
import type { SqlitePersistenceAdapter, WriteBehindHistorySink } from "../adapters/node/sqlite-persistence.js";
import type { ModelPort, ModelRequest } from "../ports/index.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";

function collect(stream: PassThrough): () => string {
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

function makeFakeLoop(
  runTurn: (prompt: string, opts?: { signal?: AbortSignal }) => AsyncGenerator<AgentEvent, void, unknown>,
): AgentLoop {
  return { runTurn } as unknown as AgentLoop;
}

interface FakeShutdown {
  mcpManager: McpManager;
  historySink: WriteBehindHistorySink;
  persistence: SqlitePersistenceAdapter;
  dispose: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeShutdown(): FakeShutdown {
  const dispose = vi.fn(async () => undefined);
  const flush = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  return {
    mcpManager: { dispose } as unknown as McpManager,
    historySink: { flush } as unknown as WriteBehindHistorySink,
    persistence: { close } as unknown as SqlitePersistenceAdapter,
    dispose,
    flush,
    close,
  };
}

function baseOpts(
  loop: AgentLoop,
  fakes: FakeShutdown,
  stdout: PassThrough,
  stderr: PassThrough,
  prompt = "hi",
): PrintModeOptions {
  return {
    prompt,
    loop,
    mcpManager: fakes.mcpManager,
    historySink: fakes.historySink,
    persistence: fakes.persistence,
    stdout,
    stderr,
    theme: createCliTheme({ color: false }),
  };
}

describe("runPrintMode — stdout/stderr split + exit codes (design §3.3)", () => {
  it("stdout carries ONLY text_delta text (concatenated, nothing else); stderr carries loop_end; exit 0 on completed", async () => {
    async function* completedTurn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "text_delta", id: "t", text: "Hel" };
      yield { type: "tool_execution_start", toolCallId: "c1", toolName: "Read", input: {} };
      yield { type: "text_delta", id: "t", text: "lo" };
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const getErr = collect(stderr);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(baseOpts(makeFakeLoop(() => completedTurn()), fakes, stdout, stderr));

    expect(code).toBe(0);
    expect(getOut()).toBe("Hello");
    expect(getOut()).not.toContain("[tool]");
    expect(getErr()).toContain("[tool] Read");
    expect(getErr()).toContain("[loop_end: completed, turns=1]");
    expect(getErr()).not.toContain("Hello");
    expect(fakes.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.flush).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });

  it("exit 0 when loop_end.reason is max_turns", async () => {
    async function* maxTurnsTurn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "loop_end", reason: "max_turns", turns: 40 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(baseOpts(makeFakeLoop(() => maxTurnsTurn()), fakes, stdout, stderr));
    expect(code).toBe(0);
  });

  it("exit 1 on a stream-level error event (loop_end reason error)", async () => {
    async function* erroredTurn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "error", error: new Error("stream exploded") };
      yield { type: "loop_end", reason: "error", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getErr = collect(stderr);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(baseOpts(makeFakeLoop(() => erroredTurn()), fakes, stdout, stderr));
    expect(code).toBe(1);
    expect(getErr()).toContain("[error] Error: stream exploded");
    expect(fakes.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.flush).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });

  it("exit 1 when the turn throws outright, and the shared shutdown path still runs", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getErr = collect(stderr);
    const fakes = makeFakeShutdown();
    const throwingLoop = makeFakeLoop(() => {
      throw new Error("boom");
    });

    const code = await runPrintMode(baseOpts(throwingLoop, fakes, stdout, stderr));
    expect(code).toBe(1);
    expect(getErr()).toContain("[fatal] boom");
    expect(fakes.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.flush).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });

  it("SIGINT aborts the turn's signal, exits 130, still runs the shutdown path, and leaves no listener behind", async () => {
    let reachedHang = false;
    async function* hangingTurn(
      _prompt: string,
      opts?: { signal?: AbortSignal },
    ): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "turn_start", turn: 1 };
      reachedHang = true;
      await new Promise<void>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakes = makeFakeShutdown();
    const baselineListeners = process.listenerCount("SIGINT");

    const runPromise = runPrintMode(baseOpts(makeFakeLoop(hangingTurn), fakes, stdout, stderr));

    await vi.waitFor(() => {
      if (!reachedHang) {
        throw new Error("turn has not reached its hang point yet");
      }
    });
    expect(process.listenerCount("SIGINT")).toBe(baselineListeners + 1);

    process.emit("SIGINT");
    const code = await runPromise;

    expect(code).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(baselineListeners);
    expect(fakes.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.flush).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

// stands BEFORE createInterface, so `input` below is never written to or
// ended — the run still resolves, proving stdin is never consumed (design

// diagnostics off the answer-only `output` stream in tests.

class SequencedModelPort implements ModelPort {
  private call = 0;
  constructor(private readonly scripts: ModelStreamEvent[][]) {}

  streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const events = this.scripts[this.call] ?? [{ type: "finish", finishReason: "stop", usage: {} }];
    this.call += 1;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

function collectOutput(output: PassThrough): () => string {
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

// One tmp settings.json path for the whole suite (module-scoped, never written
// to by any test here — the deny-path test below never lets the Write actually
// run) — keeps PersistingSessionPermissionRules's boot-seed read off the
// owner's real ~/.anycode/settings.json (design slice-P7.5-cut.md §3.2).
const testSettingsFilePath = join(tmpdir(), `anycode-print-test-settings-${process.pid}.json`);

// A fresh object per call: runCli scrubs ANYCODE_API_KEY from whatever env
// object it's handed (design slice-2.5-cut.md §4.4 env-hardening), so reusing
// one shared object across tests would make every test after the first fail.
function makeEnv(): NodeJS.ProcessEnv {
  return {
    ANYCODE_API_KEY: "test-key",
    ANYCODE_MODEL: "test-model",
    ANYCODE_DB_PATH: ":memory:",
    ANYCODE_SETTINGS_PATH: testSettingsFilePath,
  } as NodeJS.ProcessEnv;
}

// Captured once at module load, before any test runs, so the afterEach below
// never hardcodes an assumption about the ambient test-runner's own listeners.
const baselineSigintListenersForE2eSuite = process.listenerCount("SIGINT");

describe("print mode end-to-end via runCli (design §2.6 para.6/§3.3/§9-R6/R7)", () => {
  it("-p <prompt>: stdout is strictly the model's answer text; diagnostics land on errorOutput; exit 0; stdin never consumed", async () => {
    const modelPort = new SequencedModelPort([
      [{ type: "start" }, { type: "text_delta", id: "t", text: "4" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const input = new PassThrough(); // never written to, never ended
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getOut = collectOutput(output);
    const getErr = collectOutput(errorOutput);

    const exitCode = await runCli({
      argv: ["--print", "2+2?"],
      env: makeEnv(),
      input,
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(0);
    expect(getOut()).toBe("4");
    expect(getErr()).toContain("[loop_end: completed, turns=1]");
  });

  it("-p (short form) works identically to --print", async () => {
    const modelPort = new SequencedModelPort([
      [{ type: "start" }, { type: "text_delta", id: "t", text: "ok" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    // Explicit errorOutput sink (not the real process.stderr default) so this
    // test's diagnostics stay hermetic like every other case in this suite.
    const errorOutput = new PassThrough();
    const getOut = collectOutput(output);

    const exitCode = await runCli({
      argv: ["-p", "ping"],
      env: makeEnv(),
      input,
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(0);
    expect(getOut()).toBe("ok");
  });

  it("a model stream error inside -p exits 1", async () => {
    const modelPort = new SequencedModelPort([[{ type: "start" }, { type: "error", error: new Error("upstream exploded") }]]);
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getErr = collectOutput(errorOutput);

    const exitCode = await runCli({
      argv: ["--print", "boom"],
      env: makeEnv(),
      input,
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(1);
    expect(getErr()).toContain("[loop_end: error, turns=1]");
  });

  it("an ask triggered inside -p (build mode default) auto-denies without hanging; the tool never actually runs", async () => {
    const filePath = join(tmpdir(), `anycode-print-ask-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "Write", input: { file_path: filePath, content: "hi" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "text_delta", id: "t2", text: "done" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const input = new PassThrough(); // still never written to / ended
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getOut = collectOutput(output);
    const getErr = collectOutput(errorOutput);

    const exitCode = await runCli({
      argv: ["-p", "please write a file"],
      env: makeEnv(),
      input,
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(0);
    expect(getOut()).toBe("done");
    expect(getErr()).toContain("[tool result] Write (denied)");
    expect(existsSync(filePath)).toBe(false);
  });

  afterEach(() => {
    // Defensive: guarantee no test above ever left a SIGINT listener behind
    // (would otherwise silently accumulate across the whole test file).
    expect(process.listenerCount("SIGINT")).toBe(baselineSigintListenersForE2eSuite);
  });
});

// ---------------------------------------------------------------------------
// Structured output: json + stream-json (design slice-4.5-cut.md §2.2).

// assertion below parses JSON and checks FIELDS — never a whole-string snapshot.

function structuredCtx(overrides: Partial<PrintStructuredContext> = {}): PrintStructuredContext {
  return {
    format: "json",
    sessionId: "sess-123",
    model: "test-model",
    mode: "build",
    cwd: "/tmp/work",
    ...overrides,
  };
}

function structuredOpts(
  loop: AgentLoop,
  fakes: FakeShutdown,
  stdout: PassThrough,
  stderr: PassThrough,
  structured: PrintStructuredContext,
  prompt = "hi",
): PrintModeOptions {
  return { ...baseOpts(loop, fakes, stdout, stderr, prompt), structured };
}

/** Splits an NDJSON dump into parsed objects (ignores a trailing blank line). */
function parseLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runPrintMode — json output format (design §2.2)", () => {
  it("emits a single stdout line = the result envelope with every documented field; stderr still renders", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "text_delta", id: "t", text: "Hel" };
      yield { type: "tool_execution_start", toolCallId: "c1", toolName: "Read", input: {} };
      yield { type: "text_delta", id: "t", text: "lo" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const getErr = collect(stderr);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(
      structuredOpts(makeFakeLoop(() => turn()), fakes, stdout, stderr, structuredCtx()),
    );

    expect(code).toBe(0);
    const lines = parseLines(getOut());
    expect(lines).toHaveLength(1);
    const env = lines[0]!;
    expect(env).toMatchObject({
      type: "result",
      subtype: "completed",
      isError: false,
      result: "Hello",
      sessionId: "sess-123",
      model: "test-model",
      mode: "build",
      cwd: "/tmp/work",
      turns: 1,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      denials: [],
    });
    // Full field set present (design §2.2 table — nothing more, nothing less).
    expect(Object.keys(env).sort()).toEqual(
      [
        "cwd",
        "denials",
        "durationMs",
        "isError",
        "mode",
        "model",
        "result",
        "sessionId",
        "subtype",
        "turns",
        "type",
        "usage",
      ].sort(),
    );
    expect(typeof env.durationMs).toBe("number");

    expect(getErr()).toContain("[tool] Read");
    expect(getErr()).toContain("[loop_end: completed, turns=1]");
  });

  it("sums usage across multiple finish events", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "finish", finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } };
      yield { type: "loop_end", reason: "completed", turns: 2 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();

    await runPrintMode(structuredOpts(makeFakeLoop(() => turn()), fakes, stdout, stderr, structuredCtx()));

    const env = parseLines(getOut())[0]!;
    expect(env.usage).toEqual({ inputTokens: 15, outputTokens: 10, totalTokens: 25 });
  });

  it("HAZARD A5: a finish with usage:{} yields an empty usage object (no field materializes)", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "finish", finishReason: "stop", usage: {} };
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();

    await runPrintMode(structuredOpts(makeFakeLoop(() => turn()), fakes, stdout, stderr, structuredCtx()));

    const env = parseLines(getOut())[0]!;
    expect(env.usage).toEqual({});
  });

  it("collects denials (toolCallId + toolName) from denied tool_result outcomes, in encounter order", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield {
        type: "tool_result",
        outcome: { toolCallId: "c1", toolName: "Write", status: "denied", modelText: "denied", durationMs: 0 },
      };
      yield {
        type: "tool_result",
        outcome: { toolCallId: "c2", toolName: "Read", status: "success", modelText: "ok", durationMs: 1 },
      };
      yield {
        type: "tool_result",
        outcome: { toolCallId: "c3", toolName: "Bash", status: "denied", modelText: "denied", durationMs: 0 },
      };
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(
      structuredOpts(makeFakeLoop(() => turn()), fakes, stdout, stderr, structuredCtx()),
    );

    expect(code).toBe(0);
    const env = parseLines(getOut())[0]!;
    expect(env.denials).toEqual([
      { toolCallId: "c1", toolName: "Write" },
      { toolCallId: "c3", toolName: "Bash" },
    ]);
  });

  it("an error event marks isError:true and the loop_end reason drives subtype; exit 1", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "error", error: new Error("stream exploded") };
      yield { type: "loop_end", reason: "error", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(
      structuredOpts(makeFakeLoop(() => turn()), fakes, stdout, stderr, structuredCtx()),
    );

    expect(code).toBe(1);
    const env = parseLines(getOut())[0]!;
    expect(env.subtype).toBe("error");
    expect(env.isError).toBe(true);
  });

  it("a turn that throws before loop_end yields subtype 'error' (catch path); envelope still emitted; exit 1", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();
    const throwingLoop = makeFakeLoop(() => {
      throw new Error("boom");
    });

    const code = await runPrintMode(structuredOpts(throwingLoop, fakes, stdout, stderr, structuredCtx()));

    expect(code).toBe(1);
    const env = parseLines(getOut())[0]!;
    expect(env.subtype).toBe("error");
    expect(env.isError).toBe(true);
    expect(env.turns).toBe(0);
  });

  it("emits the envelope BEFORE the shutdown sequence (dispose sees it on stdout)", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();
    let outAtDispose = "";
    fakes.dispose.mockImplementation(async () => {
      outAtDispose = getOut();
    });

    await runPrintMode(structuredOpts(makeFakeLoop(() => turn()), fakes, stdout, stderr, structuredCtx()));

    // The envelope was already on stdout when dispose ran (design §2.2: envelope
    // AFTER for-await, BEFORE dispose -> flush -> close).
    expect(outAtDispose.length).toBeGreaterThan(0);
    expect((JSON.parse(outAtDispose.trim()) as Record<string, unknown>).type).toBe("result");
  });

  it("SIGINT during a json run yields subtype 'cancelled', exit 130, and still emits the envelope", async () => {
    let reachedHang = false;
    async function* hangingTurn(
      _prompt: string,
      opts?: { signal?: AbortSignal },
    ): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "turn_start", turn: 1 };
      reachedHang = true;
      await new Promise<void>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();
    const baselineListeners = process.listenerCount("SIGINT");

    const runPromise = runPrintMode(
      structuredOpts(makeFakeLoop(hangingTurn), fakes, stdout, stderr, structuredCtx()),
    );

    await vi.waitFor(() => {
      if (!reachedHang) {
        throw new Error("turn has not reached its hang point yet");
      }
    });
    process.emit("SIGINT");
    const code = await runPromise;

    expect(code).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(baselineListeners);
    const env = parseLines(getOut())[0]!;
    expect(env.subtype).toBe("cancelled");
  });
});

describe("runPrintMode — stream-json output format (design §2.2)", () => {
  it("emits NDJSON: init first, every AgentEvent verbatim in yield order, result envelope last", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "turn_start", turn: 1 };
      yield { type: "text_delta", id: "t", text: "Hel" };
      yield { type: "tool_execution_start", toolCallId: "c1", toolName: "Read", input: {} };
      yield { type: "text_delta", id: "t", text: "lo" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(
      structuredOpts(
        makeFakeLoop(() => turn()),
        fakes,
        stdout,
        stderr,
        structuredCtx({ format: "stream-json" }),
      ),
    );

    expect(code).toBe(0);
    const lines = parseLines(getOut());
    // Every line is valid JSON (parseLines would have thrown otherwise).
    expect(lines[0]!).toEqual({
      type: "init",
      sessionId: "sess-123",
      model: "test-model",
      mode: "build",
      cwd: "/tmp/work",
    });
    const last = lines[lines.length - 1]!;
    expect(last.type).toBe("result");
    expect(last.result).toBe("Hello"); // text_delta lines ALSO concatenated into result
    // The middle lines are the AgentEvents, verbatim, in yield order.
    const middleTypes = lines.slice(1, -1).map((l) => l.type);
    expect(middleTypes).toEqual([
      "turn_start",
      "text_delta",
      "tool_execution_start",
      "text_delta",
      "finish",
      "loop_end",
    ]);
    // text_delta lines are present as stream lines (partial streaming).
    const deltas = lines.filter((l) => l.type === "text_delta").map((l) => l.text);
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("projects the error variant to {type:'error',message} (JSON.stringify(Error) would be '{}' — hazard A7)", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "error", error: new Error("boom") };
      yield { type: "loop_end", reason: "error", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(
      structuredOpts(
        makeFakeLoop(() => turn()),
        fakes,
        stdout,
        stderr,
        structuredCtx({ format: "stream-json" }),
      ),
    );

    expect(code).toBe(1);
    const lines = parseLines(getOut());
    const errorLine = lines.find((l) => l.type === "error" && l.message !== undefined);
    expect(errorLine).toEqual({ type: "error", message: "Error: boom" });
    expect(errorLine?.message).not.toBe("{}");
    expect(lines[lines.length - 1]!.type).toBe("result");
    expect(lines[lines.length - 1]!.subtype).toBe("error");
  });

  it("skips an unserializable event (fail-soft) + warns on stderr; the NDJSON stream stays valid", async () => {
    // A circular event breaks JSON.stringify; `turn_start` renders nothing on
    // stderr (render.ts), so only the stream-line stringify path is exercised.
    const badEvent: Record<string, unknown> = { type: "turn_start", turn: 1 };
    badEvent.self = badEvent; // JSON.stringify throws on this
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield badEvent as unknown as AgentEvent;
      yield { type: "text_delta", id: "t", text: "ok" };
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const getErr = collect(stderr);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(
      structuredOpts(
        makeFakeLoop(() => turn()),
        fakes,
        stdout,
        stderr,
        structuredCtx({ format: "stream-json" }),
      ),
    );

    expect(code).toBe(0);
    // Every emitted line still parses — the corrupting event never reached stdout.
    const lines = parseLines(getOut());
    const types = lines.map((l) => l.type);
    expect(types).toEqual(["init", "text_delta", "loop_end", "result"]);
    expect(getErr()).toContain("[warn] stream-json: unserializable turn_start event skipped");
  });
});

describe("readPromptFromStdin (design §2.2)", () => {
  it("reads a single end() chunk verbatim, including a trailing newline", async () => {
    const input = new PassThrough();
    const promise = readPromptFromStdin(input);
    input.end("2+2?\n");
    await expect(promise).resolves.toBe("2+2?\n");
  });

  it("concatenates multiple chunks in order", async () => {
    const input = new PassThrough();
    const promise = readPromptFromStdin(input);
    input.write("hello ");
    input.write("world");
    input.end();
    await expect(promise).resolves.toBe("hello world");
  });

  it("resolves to '' on an empty end", async () => {
    const input = new PassThrough();
    const promise = readPromptFromStdin(input);
    input.end();
    await expect(promise).resolves.toBe("");
  });
});

describe("runPrintMode — text path emits no envelope when structured is absent (design §2.2 L3)", () => {
  it("stdout is the raw answer only; there is no result-envelope JSON line", async () => {
    async function* turn(): AsyncGenerator<AgentEvent, void, unknown> {
      yield { type: "text_delta", id: "t", text: "hi there" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1 } };
      yield { type: "loop_end", reason: "completed", turns: 1 };
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOut = collect(stdout);
    const fakes = makeFakeShutdown();

    const code = await runPrintMode(baseOpts(makeFakeLoop(() => turn()), fakes, stdout, stderr));

    expect(code).toBe(0);
    expect(getOut()).toBe("hi there"); // exactly the answer, no envelope appended
    expect(getOut()).not.toContain('"type":"result"');
  });
});

// ---------------------------------------------------------------------------
// Headless-v1 wiring (design slice-4.5-cut.md §2.3 / §7 e2e): the NEW main.ts
// contract driven end-to-end through the real runCli + dispatcher/loop — stdin
// prompt (scenario 1), the exit-2 usage guards (scenarios 3/4), and the
// structured formats surfaced through the print branch (scenarios 6/7). The DB
// is :memory: (makeEnv) since none of these assert persisted rows; the
// row-matching scenarios (2/5/9) live in main.test.ts where the file-DB helpers
// already exist. `input` is a plain PassThrough (isTTY undefined ⇒ non-TTY).

describe("headless-v1 e2e via runCli (design slice-4.5-cut.md §7, scenarios 1/3/4/6/7)", () => {
  const baselineSigint = process.listenerCount("SIGINT");
  afterEach(() => {
    // No test here should leak a SIGINT listener (print path removes its own).
    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
  });

  it("scenario 1: bare -p reads the prompt from stdin; stdout = the answer; exit 0", async () => {
    const modelPort = new SequencedModelPort([
      [{ type: "start" }, { type: "text_delta", id: "t", text: "4" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getOut = collectOutput(output);

    const runPromise = runCli({
      argv: ["-p"],
      env: makeEnv(),
      input,
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });
    // runCli attaches the readPromptFromStdin listeners synchronously before its
    // first await, so ending the stream now delivers the piped prompt verbatim.
    input.end("2+2?\n");

    expect(await runPromise).toBe(0);
    expect(getOut()).toBe("4");
  });

  it("scenario 3: bare -p with a TTY stdin exits 2 (no prompt could be piped)", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getErr = collectOutput(errorOutput);

    const exitCode = await runCli({
      argv: ["-p"],
      env: makeEnv(),
      input,
      output,
      errorOutput,
      modelPort: new SequencedModelPort([]),
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(2);
    expect(getErr()).toContain("--print needs a prompt");
  });

  it("scenario 4a: an unknown --output-format value exits 2", async () => {
    const errorOutput = new PassThrough();
    const getErr = collectOutput(errorOutput);
    const exitCode = await runCli({
      argv: ["--output-format", "bogus", "-p", "x"],
      env: makeEnv(),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput,
      modelPort: new SequencedModelPort([]),
      cwd: process.cwd(),
    });
    expect(exitCode).toBe(2);
    expect(getErr()).toContain("--output-format must be one of: text, json, stream-json (got: bogus)");
  });

  it("scenario 4b: --output-format without -p exits 2", async () => {
    const errorOutput = new PassThrough();
    const getErr = collectOutput(errorOutput);
    const exitCode = await runCli({
      argv: ["--output-format", "json"],
      env: makeEnv(),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput,
      modelPort: new SequencedModelPort([]),
      cwd: process.cwd(),
    });
    expect(exitCode).toBe(2);
    expect(getErr()).toContain("--output-format requires --print/-p");
  });

  it("scenario 6: -p x --output-format stream-json emits NDJSON through the real loop (init first, result last)", async () => {
    const modelPort = new SequencedModelPort([
      [{ type: "start" }, { type: "text_delta", id: "t", text: "Hello" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getOut = collectOutput(output);

    const exitCode = await runCli({
      argv: ["-p", "greet", "--output-format", "stream-json"],
      env: makeEnv(),
      input: new PassThrough(),
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(0);
    const lines = parseLines(getOut()); // throws if any line is not valid JSON
    expect(lines[0]!.type).toBe("init");
    expect(typeof lines[0]!.sessionId).toBe("string");
    expect(lines[0]!).toMatchObject({ model: "test-model", mode: "build", cwd: process.cwd() });
    const last = lines[lines.length - 1]!;
    expect(last.type).toBe("result");
    expect(last.result).toBe("Hello");
    // The model's partial text is present as a stream line too (partial streaming).
    expect(lines.some((l) => l.type === "text_delta")).toBe(true);
  });

  it("scenario 7: a denied ask in json mode reports denials and still exits 0 (R7)", async () => {
    const filePath = join(tmpdir(), `anycode-4.5-json-ask-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "Write", input: { file_path: filePath, content: "hi" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "text_delta", id: "t2", text: "done" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getOut = collectOutput(output);

    const exitCode = await runCli({
      argv: ["-p", "please write a file", "--output-format", "json"],
      env: makeEnv(),
      input: new PassThrough(),
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(0);
    const lines = parseLines(getOut());
    expect(lines).toHaveLength(1); // json = exactly one envelope line on stdout
    const env = lines[0]!;
    expect(env.type).toBe("result");
    expect(env.isError).toBe(false);
    expect(env.result).toBe("done");
    expect(env.denials).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "Write" })]),
    );
    expect(existsSync(filePath)).toBe(false); // the denied tool never ran
  });
});

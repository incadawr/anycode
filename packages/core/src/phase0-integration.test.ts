/**
 * Phase 0 end-to-end integration: wires the REAL components from every
 * implementation task (0.2 provider translation types, 0.3 tools + node
 * adapters, 0.4 loop + dispatcher, 0.5 permissions + hooks) against a scripted
 * MockModelPort and a real temp directory. Proves the pieces compose: the loop
 * drives tool calls through the dispatch pipeline, the node adapters mutate real
 * files, and the permission gate is honored end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentLoop,
  AllowAllPermissionBroker,
  DenyPermissionBroker,
  InMemoryHookRunner,
  InMemoryTodoStore,
  ModePermissionEngine,
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  NodeHttpAdapter,
  createDefaultToolRegistry,
} from "./index.js";
import type { AgentEvent, ModelStreamEvent } from "./types/index.js";
import type { ModelPort, ModelRequest } from "./ports/index.js";
import type { PermissionMode } from "./types/index.js";

/** Emits one scripted list of stream events per streamText call, in order. */
class ScriptedModelPort implements ModelPort {
  private call = 0;
  constructor(private readonly scripts: ModelStreamEvent[][]) {}

  async *streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const script = this.scripts[this.call] ?? [
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    this.call += 1;
    for (const event of script) yield event;
  }
}

function toolCallTurn(id: string, name: string, input: unknown): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "tool_call", toolCall: { id, name, input } },
    { type: "finish", finishReason: "tool_calls", usage: {} },
  ];
}

function textTurn(text: string): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_start", id: "t1" },
    { type: "text_delta", id: "t1", text },
    { type: "text_end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: {} },
  ];
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function buildLoop(
  cwd: string,
  modelPort: ModelPort,
  mode: PermissionMode,
): AgentLoop {
  const ports = {
    fs: new NodeFileSystemAdapter(),
    exec: new NodeExecutionAdapter(),
    http: new NodeHttpAdapter(),
    todos: new InMemoryTodoStore(),
  };
  return new AgentLoop({
    modelPort,
    registry: createDefaultToolRegistry(),
    hooks: new InMemoryHookRunner(),
    permissionEngine: new ModePermissionEngine(),
    // Deny broker proves that "yolo"/"auto" allow-paths never consult it, while
    // "plan" reaches a hard deny in the engine before the broker matters.
    permissionBroker: mode === "yolo" ? new AllowAllPermissionBroker() : new DenyPermissionBroker(),
    mode,
    ports,
    cwd,
    systemPrompt: "test-identity",
  });
}

describe("phase 0 integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "anycode-int-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads then edits a real file across two model turns (yolo)", async () => {
    const file = join(dir, "greeting.txt");
    await writeFile(file, "hello world\n", "utf8");

    const model = new ScriptedModelPort([
      toolCallTurn("c1", "Read", { file_path: file }),
      toolCallTurn("c2", "Edit", {
        file_path: file,
        old_string: "hello world",
        new_string: "goodbye world",
      }),
      textTurn("Done."),
    ]);

    const loop = buildLoop(dir, model, "yolo");
    const events = await collect(loop.runTurn("edit the greeting"));

    const outcomes = events
      .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
      .map((e) => e.outcome);

    expect(outcomes.map((o) => o.toolName)).toEqual(["Read", "Edit"]);
    expect(outcomes.every((o) => o.status === "success")).toBe(true);

    const loopEnd = events.find(
      (e): e is Extract<AgentEvent, { type: "loop_end" }> => e.type === "loop_end",
    );
    expect(loopEnd?.reason).toBe("completed");

    // The real node adapter mutated the real file.
    expect(await readFile(file, "utf8")).toBe("goodbye world\n");

    // Phase 1: a context_usage event is reported after every finish, and the
    // §2.10 integrity invariant holds — every tool_call is answered.
    expect(events.some((e) => e.type === "context_usage")).toBe(true);
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });

  it("denies a non-read-only edit in plan mode and leaves the file untouched (fail-closed)", async () => {
    const file = join(dir, "protected.txt");
    await writeFile(file, "original\n", "utf8");

    const model = new ScriptedModelPort([
      toolCallTurn("c1", "Edit", {
        file_path: file,
        old_string: "original",
        new_string: "tampered",
      }),
      textTurn("stopping"),
    ]);

    const loop = buildLoop(dir, model, "plan");
    const events = await collect(loop.runTurn("try to edit"));

    const editOutcome = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    )?.outcome;

    expect(editOutcome?.toolName).toBe("Edit");
    expect(editOutcome?.status).toBe("denied");
    // File unchanged — the permission gate blocked the handler before it ran.
    expect(await readFile(file, "utf8")).toBe("original\n");
    // A denied tool call is still a written outcome — nothing dangles.
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });

  it("runs a real Bash command through the pipeline (yolo)", async () => {
    const model = new ScriptedModelPort([
      toolCallTurn("c1", "Bash", { command: "echo integration-ok" }),
      textTurn("done"),
    ]);

    const loop = buildLoop(dir, model, "yolo");
    const events = await collect(loop.runTurn("run echo"));

    const bash = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    )?.outcome;

    expect(bash?.toolName).toBe("Bash");
    expect(bash?.status).toBe("success");
    expect(bash?.modelText).toContain("integration-ok");
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });
});

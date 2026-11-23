import { expect, it, vi } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { ConversationHistory } from "../context/history.js";
import { InMemoryHookRunner } from "../dispatch/hook-runner.js";
import { DenyPermissionBroker, ModePermissionEngine } from "../permissions/index.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";
import { AgentLoop } from "./agent-loop.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function fixture(check: () => Promise<void>, ...scripts: string[]) {
  const append = vi.fn();
  const flushChecked = vi.fn(check);
  const history = new ConversationHistory({ sink: {
    append, replaceAll: vi.fn(), flush: async () => {}, flushChecked,
  } });
  for (let index = 0; index < 4; index++) {
    history.append({ role: "user", content: "old question" });
    history.append({ role: "assistant", content: [{ type: "text", text: "old answer" }] });
  }
  const hooks = new InMemoryHookRunner();
  const childDispatch = vi.spyOn(hooks, "runPreToolUse");
  const fs = new NodeFileSystemAdapter();
  const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
  const steps: ModelStreamEvent[][] = [
    [
      { type: "start" },
      ...scripts.map((code, index): ModelStreamEvent => ({
        type: "tool_call", toolCall: { id: index === 0 ? "parent" : `parent-${index}`, name: "REPL", input: { code } },
      })),
      { type: "finish", finishReason: "tool_calls", usage: {} },
    ],
    [{ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }],
    [
      { type: "text_delta", id: "summary", text: "Earlier conversation." },
      { type: "finish", finishReason: "stop", usage: {} },
    ],
  ];
  const loop = new AgentLoop({
    modelPort: {
      async *streamText() { yield* steps.shift() ?? []; },
    },
    registry: createDefaultToolRegistry({ codeMode: true }),
    hooks,
    permissionEngine: new ModePermissionEngine(),
    permissionBroker: new DenyPermissionBroker(),
    mode: "yolo",
    cwd: process.cwd(),
    ports: { fs, exec: new NodeExecutionAdapter(), http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
    history,
    context: { keepRecentMessages: 4 },
  });
  return { append, history, loop, flushChecked, childDispatch, write };
}

const writes = `
  await call("Write", {file_path:"repl-fixture.txt", content:"one"});
  await call("Write", {file_path:"repl-fixture.txt", content:"two"});
`;

it("flushBeforeChildAndOnlyOnePair", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const { history, loop, append, childDispatch, flushChecked, write } = fixture(() => {
    enter();
    return held;
  }, writes + `throw new Error("after the effects");`);
  const events = collect<AgentEvent>(loop.runTurn("run a script"));
  try {
    await entered;
    expect(history.unansweredToolCallIds()).toEqual(["parent"]);
    expect(append.mock.lastCall?.[0]).toMatchObject([{ message: { role: "assistant", content: [
      { type: "tool_call", toolCallId: "parent", toolName: "REPL" },
    ] } }]);
    expect(childDispatch.mock.calls.map(([input]) => input.toolName)).toEqual(["REPL"]);
    expect(write).not.toHaveBeenCalled();
  } finally {
    release();
  }
  const result = await events;
  expect(write).toHaveBeenCalledTimes(2);
  expect(flushChecked).toHaveBeenCalledOnce();
  expect(result.filter(event => event.type === "repl_call_start")).toHaveLength(2);
  expect(result.filter(event => event.type === "repl_call_end")).toHaveLength(2);
  expect(result.filter(event => event.type === "tool_result")).toMatchObject([
    { outcome: { toolCallId: "parent", status: "error" } },
  ]);

  await collect(loop.compactNow());
  expect(history.items.some(item => item.kind === "compact_summary")).toBe(true);
  expect(history.unansweredToolCallIds()).toEqual([]);
  const pairs = history.toMessages().flatMap(message =>
    (message.role === "assistant" || message.role === "tool")
      ? message.content.filter(part => part.type === "tool_call" || part.type === "tool_result")
      : []);
  expect(pairs).toMatchObject([
    { type: "tool_call", toolCallId: "parent" },
    { type: "tool_result", toolCallId: "parent", presentation: { repl: { calls: [
      { callId: "parent.1", status: "success" }, { callId: "parent.2", status: "success" },
    ] } } },
  ]);
});

it("does not execute children when the parent write fails, even after a catch", async () => {
  const { history, loop, childDispatch, flushChecked, write } = fixture(async () => {
    throw new Error("persistence failed");
  }, `try { ${writes} } catch {} ${writes}`);
  const events = await collect(loop.runTurn("run a script"));
  expect(flushChecked).toHaveBeenCalledOnce();
  expect(childDispatch.mock.calls.map(([input]) => input.toolName)).toEqual(["REPL"]);
  expect(write).not.toHaveBeenCalled();
  expect(history.unansweredToolCallIds()).toEqual([]);
  expect(events.filter(event => event.type === "tool_result")).toMatchObject([
    { outcome: { toolCallId: "parent", status: "error", modelText: expect.stringContaining("could not save") } },
  ]);
});

it("blocks both REPL calls when their shared assistant write fails", async () => {
  const check = vi.fn(async () => {}).mockRejectedValueOnce(new Error("assistant write failed"));
  const { loop, childDispatch, write } = fixture(check, writes, writes);
  const events = await collect(loop.runTurn("run both scripts"));
  expect(check).toHaveBeenCalledOnce();
  expect(childDispatch.mock.calls.map(([input]) => input.toolName)).toEqual(["REPL", "REPL"]);
  expect(write).not.toHaveBeenCalled();
  expect(events.filter(event => event.type === "tool_result")).toMatchObject([
    { outcome: { toolCallId: "parent", status: "error" } },
    { outcome: { toolCallId: "parent-1", status: "error" } },
  ]);
});

import { describe, expect, it } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { todoWriteTool } from "./todo-write.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxWithTodos(todos: InMemoryTodoStore): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/tmp",
    ports: { fs, exec, http: new NodeHttpAdapter(), todos },
  };
}

describe("todoWriteTool", () => {
  it("assigns an id to items that omit one", async () => {
    const store = new InMemoryTodoStore();

    const result = await todoWriteTool.handler(
      { todos: [{ content: "first task", status: "pending" }] },
      ctxWithTodos(store),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.count).toBe(1);
    const item = result.output?.todos[0];
    expect(item?.content).toBe("first task");
    expect(item?.status).toBe("pending");
    expect(typeof item?.id).toBe("string");
    expect(item?.id.length).toBeGreaterThan(0);
  });

  it("keeps a provided id as-is", async () => {
    const store = new InMemoryTodoStore();

    const result = await todoWriteTool.handler(
      { todos: [{ id: "stable-1", content: "keep my id", status: "pending" }] },
      ctxWithTodos(store),
    );

    expect(result.output?.todos).toEqual([{ id: "stable-1", content: "keep my id", status: "pending" }]);
  });

  it("replaces the whole list on each call (no merge)", async () => {
    const store = new InMemoryTodoStore();
    await todoWriteTool.handler(
      { todos: [{ id: "1", content: "a", status: "pending" }, { id: "2", content: "b", status: "pending" }] },
      ctxWithTodos(store),
    );

    const result = await todoWriteTool.handler(
      { todos: [{ id: "3", content: "only", status: "completed" }] },
      ctxWithTodos(store),
    );

    expect(result.output?.count).toBe(1);
    expect(result.output?.todos).toEqual([{ id: "3", content: "only", status: "completed" }]);
    expect(store.read()).toEqual([{ id: "3", content: "only", status: "completed" }]);
  });

  it("persists the write so a later TodoRead-equivalent read sees it", async () => {
    const store = new InMemoryTodoStore();
    await todoWriteTool.handler(
      { todos: [{ id: "1", content: "persisted", status: "in_progress" }] },
      ctxWithTodos(store),
    );

    expect(store.read()).toEqual([{ id: "1", content: "persisted", status: "in_progress" }]);
  });

  it("supports an empty list, clearing the store", async () => {
    const store = new InMemoryTodoStore();
    store.replaceAll([{ id: "1", content: "a", status: "pending" }]);

    const result = await todoWriteTool.handler({ todos: [] }, ctxWithTodos(store));

    expect(result.output?.count).toBe(0);
    expect(store.read()).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { todoReadTool } from "./todo-read.js";

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

describe("todoReadTool", () => {
  it("returns an empty list when nothing was written yet", async () => {
    const store = new InMemoryTodoStore();

    const result = await todoReadTool.handler({}, ctxWithTodos(store));

    expect(result.ok).toBe(true);
    expect(result.output?.todos).toEqual([]);
  });

  it("reflects the store's current contents", async () => {
    const store = new InMemoryTodoStore();
    store.replaceAll([{ id: "1", content: "write tests", status: "in_progress" }]);

    const result = await todoReadTool.handler({}, ctxWithTodos(store));

    expect(result.ok).toBe(true);
    expect(result.output?.todos).toEqual([{ id: "1", content: "write tests", status: "in_progress" }]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { readTool } from "./read.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string): ToolContext {
  return { toolCallId: "t1", abortSignal: new AbortController().signal, cwd, ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() } };
}

describe("readTool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads the full content of a file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3");

    const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.content).toBe("line1\nline2\nline3");
    expect(result.output?.truncated).toBe(false);
    expect(result.output?.totalLines).toBe(3);
  });

  it("applies offset/limit line windowing", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "l1\nl2\nl3\nl4\nl5");

    const result = await readTool.handler({ file_path: filePath, offset: 1, limit: 2 }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.content).toBe("l2\nl3");
    expect(result.output?.truncated).toBe(true);
  });

  it("returns a handler error for a missing file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));

    const result = await readTool.handler({ file_path: join(tmpDir, "missing.txt") }, ctxFor(tmpDir));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

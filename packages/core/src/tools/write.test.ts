import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { writeTool } from "./write.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string): ToolContext {
  return { toolCallId: "t1", abortSignal: new AbortController().signal, cwd, ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() } };
}

describe("writeTool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new file and reports created:true", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-write-"));
    const filePath = join(tmpDir, "new.txt");

    const result = await writeTool.handler({ file_path: filePath, content: "hello" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.created).toBe(true);
    expect(result.output?.bytesWritten).toBe(5);
    expect(await fs.readFile(filePath)).toBe("hello");
  });

  it("overwrites an existing file and reports created:false", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-write-"));
    const filePath = join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "old content");

    const result = await writeTool.handler({ file_path: filePath, content: "new" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.created).toBe(false);
    expect(await fs.readFile(filePath)).toBe("new");
  });

  it("creates parent directories as needed", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-write-"));
    const filePath = join(tmpDir, "a", "b", "c.txt");

    const result = await writeTool.handler({ file_path: filePath, content: "deep" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(await fs.readFile(filePath)).toBe("deep");
  });

  it("counts bytesWritten in UTF-8 bytes, not characters", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-write-"));
    const filePath = join(tmpDir, "emoji.txt");

    const result = await writeTool.handler({ file_path: filePath, content: "a\u{1F600}" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    // 'a' (1 byte) + the grinning-face emoji (4 bytes in UTF-8) = 5 bytes, though 2 UTF-16 code units.
    expect(result.output?.bytesWritten).toBe(5);
  });
});

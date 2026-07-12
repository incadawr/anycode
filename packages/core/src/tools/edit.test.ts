import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { editTool } from "./edit.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string): ToolContext {
  return { toolCallId: "t1", abortSignal: new AbortController().signal, cwd, ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() } };
}

describe("editTool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("replaces a unique match", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-edit-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "hello world");

    const result = await editTool.handler(
      { file_path: filePath, old_string: "world", new_string: "there", replace_all: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.replacements).toBe(1);
    expect(await fs.readFile(filePath)).toBe("hello there");
  });

  it("fails when old_string is not found", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-edit-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "hello world");

    const result = await editTool.handler(
      { file_path: filePath, old_string: "missing", new_string: "x", replace_all: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(await fs.readFile(filePath)).toBe("hello world");
  });

  it("fails when old_string is ambiguous and replace_all is not set", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-edit-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "foo bar foo baz foo");

    const result = await editTool.handler(
      { file_path: filePath, old_string: "foo", new_string: "qux", replace_all: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not unique/i);
    expect(await fs.readFile(filePath)).toBe("foo bar foo baz foo");
  });

  it("replaces every occurrence when replace_all is set", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-edit-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "foo bar foo baz foo");

    const result = await editTool.handler(
      { file_path: filePath, old_string: "foo", new_string: "qux", replace_all: true },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.replacements).toBe(3);
    expect(await fs.readFile(filePath)).toBe("qux bar qux baz qux");
  });

  it("fails when new_string equals old_string", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-edit-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "same same");

    const result = await editTool.handler(
      { file_path: filePath, old_string: "same", new_string: "same", replace_all: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/differ/i);
  });

  it("fails for a missing file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-edit-"));

    const result = await editTool.handler(
      { file_path: join(tmpDir, "missing.txt"), old_string: "a", new_string: "b", replace_all: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(false);
  });
});

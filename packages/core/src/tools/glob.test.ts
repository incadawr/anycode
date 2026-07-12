import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { GLOB_MAX_RESULTS, globTool } from "./glob.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string): ToolContext {
  return { toolCallId: "t1", abortSignal: new AbortController().signal, cwd, ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() } };
}

describe("globTool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupTree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "anycode-glob-"));
    await fs.writeFile(join(dir, "a.ts"), "a");
    await fs.writeFile(join(dir, "b.md"), "b");
    await fs.mkdir(join(dir, "sub"));
    await fs.writeFile(join(dir, "sub", "c.ts"), "c");
    await fs.mkdir(join(dir, "sub", "deeper"));
    await fs.writeFile(join(dir, "sub", "deeper", "d.ts"), "d");
    await fs.mkdir(join(dir, "node_modules"));
    await fs.writeFile(join(dir, "node_modules", "e.ts"), "e");
    await fs.mkdir(join(dir, ".git"));
    await fs.writeFile(join(dir, ".git", "f.ts"), "f");
    await fs.mkdir(join(dir, "dist"));
    await fs.writeFile(join(dir, "dist", "g.ts"), "g");
    return dir;
  }

  it("matches a glob pattern recursively and ignores .git/node_modules/dist", async () => {
    tmpDir = await setupTree();

    const result = await globTool.handler({ pattern: "**/*.ts" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    const files = result.output?.files ?? [];
    expect(files).toContain(join(tmpDir, "a.ts"));
    expect(files).toContain(join(tmpDir, "sub", "c.ts"));
    expect(files).toContain(join(tmpDir, "sub", "deeper", "d.ts"));
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(`${tmpDir}/.git`))).toBe(false);
    expect(files.some((f) => f.includes("/dist/"))).toBe(false);
    expect(result.output?.totalMatched).toBe(3);
    expect(result.output?.truncated).toBe(false);
  });

  it("does not match files outside the pattern's extension", async () => {
    tmpDir = await setupTree();

    const result = await globTool.handler({ pattern: "**/*.ts" }, ctxFor(tmpDir));

    expect(result.output?.files).not.toContain(join(tmpDir, "b.md"));
  });

  it("uses the provided `path` instead of cwd when given", async () => {
    tmpDir = await setupTree();
    const otherCwd = await mkdtemp(join(tmpdir(), "anycode-glob-other-"));

    const result = await globTool.handler({ pattern: "*.ts", path: tmpDir }, ctxFor(otherCwd));

    expect(result.ok).toBe(true);
    expect(result.output?.files).toContain(join(tmpDir, "a.ts"));
    await rm(otherCwd, { recursive: true, force: true });
  });

  it("sorts matches by modification time, most recent first", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-glob-sort-"));
    await fs.writeFile(join(tmpDir, "oldest.ts"), "x");
    await fs.writeFile(join(tmpDir, "middle.ts"), "x");
    await fs.writeFile(join(tmpDir, "newest.ts"), "x");

    const now = Date.now() / 1000;
    await utimes(join(tmpDir, "oldest.ts"), now - 300, now - 300);
    await utimes(join(tmpDir, "middle.ts"), now - 200, now - 200);
    await utimes(join(tmpDir, "newest.ts"), now - 100, now - 100);

    const result = await globTool.handler({ pattern: "*.ts" }, ctxFor(tmpDir));

    expect(result.output?.files).toEqual([
      join(tmpDir, "newest.ts"),
      join(tmpDir, "middle.ts"),
      join(tmpDir, "oldest.ts"),
    ]);
  });

  it("caps results at GLOB_MAX_RESULTS and sets truncated", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-glob-cap-"));
    const count = GLOB_MAX_RESULTS + 5;
    await Promise.all(
      Array.from({ length: count }, (_, i) => fs.writeFile(join(tmpDir, `f${i}.ts`), "x")),
    );

    const result = await globTool.handler({ pattern: "*.ts" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.files.length).toBe(GLOB_MAX_RESULTS);
    expect(result.output?.totalMatched).toBe(count);
    expect(result.output?.truncated).toBe(true);
  }, 30_000);

  it("returns an error for a path that does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-glob-missing-"));

    const result = await globTool.handler(
      { pattern: "*.ts", path: join(tmpDir, "nope") },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(false);
  });

  it("returns an error when path is a file, not a directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-glob-file-"));
    await fs.writeFile(join(tmpDir, "a-file.ts"), "x");

    const result = await globTool.handler(
      { pattern: "*.ts", path: join(tmpDir, "a-file.ts") },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(false);
  });
});

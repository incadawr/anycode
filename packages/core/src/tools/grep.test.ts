import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { grepTool } from "./grep.js";
import { __resetRgPathCacheForTests, resolveRgPath } from "./grep-rg.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string): ToolContext {
  return { toolCallId: "t1", abortSignal: new AbortController().signal, cwd, ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() } };
}

// Resolved once at collection time: populates the shared module-level cache (a
// real ripgrep resolution, exercised by every test above via grepTool's rg
// path) and tells the parity block below whether a binary is actually present
// in this environment (hermetic CI without @vscode/ripgrep's postinstall).
const rgAvailable = (await resolveRgPath()) !== undefined;

describe("grepTool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupTree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "anycode-grep-"));
    await fs.writeFile(join(dir, "a.ts"), "const needle = 1;\nconst other = 2;\n");
    await fs.writeFile(join(dir, "b.ts"), "// no match here\nconst x = 3;\n");
    await fs.writeFile(join(dir, "c.md"), "needle mentioned in markdown\n");
    await fs.mkdir(join(dir, "sub"));
    await fs.writeFile(join(dir, "sub", "d.ts"), "needle again\nNEEDLE upper\n");
    await fs.mkdir(join(dir, "node_modules"));
    await fs.writeFile(join(dir, "node_modules", "e.ts"), "needle in node_modules\n");
    await fs.mkdir(join(dir, ".git"));
    await fs.writeFile(join(dir, ".git", "f.ts"), "needle in git dir\n");
    return dir;
  }

  it("content mode returns matching lines with line numbers, ignoring .git/node_modules", async () => {
    tmpDir = await setupTree();

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "content", "-n": true, head_limit: 0, multiline: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.mode).toBe("content");
    const paths = (result.output?.matches ?? []).map((m) => m.path);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(`${tmpDir}/.git`))).toBe(false);
    expect(paths).toContain(join(tmpDir, "a.ts"));
    expect(paths).toContain(join(tmpDir, "sub", "d.ts"));
    const aMatch = (result.output?.matches ?? []).find((m) => m.path === join(tmpDir, "a.ts"));
    expect(aMatch?.lineNumber).toBe(1);
    expect(aMatch?.line).toContain("needle");
  });

  it("files_with_matches mode returns unique file paths", async () => {
    tmpDir = await setupTree();

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.mode).toBe("files_with_matches");
    expect(result.output?.files).toContain(join(tmpDir, "a.ts"));
    expect(result.output?.files).toContain(join(tmpDir, "c.md"));
    expect(result.output?.files).toContain(join(tmpDir, "sub", "d.ts"));
    expect(result.output?.files?.length).toBe(3); // a.ts, c.md, sub/d.ts (b.ts has no match)
  });

  it("count mode returns per-file match counts", async () => {
    tmpDir = await setupTree();

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "count", "-n": true, head_limit: 0, multiline: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.mode).toBe("count");
    expect(result.output?.counts?.[join(tmpDir, "sub", "d.ts")]).toBe(1); // "NEEDLE upper" is case-sensitive miss
  });

  it("-i makes matching case-insensitive", async () => {
    tmpDir = await setupTree();

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "count", "-i": true, "-n": true, head_limit: 0, multiline: false },
      ctxFor(tmpDir),
    );

    expect(result.output?.counts?.[join(tmpDir, "sub", "d.ts")]).toBe(2); // both "needle" and "NEEDLE"
  });

  it("glob filters candidate files by extension", async () => {
    tmpDir = await setupTree();

    const result = await grepTool.handler(
      {
        pattern: "needle",
        output_mode: "files_with_matches",
        glob: "*.md",
        "-n": true,
        head_limit: 0,
        multiline: false,
      },
      ctxFor(tmpDir),
    );

    expect(result.output?.files).toEqual([join(tmpDir, "c.md")]);
  });

  it("head_limit caps the number of returned entries and sets truncated", async () => {
    tmpDir = await setupTree();

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 1, multiline: false },
      ctxFor(tmpDir),
    );

    expect(result.output?.files?.length).toBe(1);
    expect(result.output?.truncated).toBe(true);
  });

  it("returns an error for an unknown path", async () => {
    tmpDir = await setupTree();

    const result = await grepTool.handler(
      {
        pattern: "needle",
        path: join(tmpDir, "does-not-exist"),
        output_mode: "files_with_matches",
        "-n": true,
        head_limit: 0,
        multiline: false,
      },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(false);
  });

  it("supports multiline patterns spanning line boundaries", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-grep-ml-"));
    await fs.writeFile(join(tmpDir, "m.txt"), "start\nmiddle\nend\n");

    const result = await grepTool.handler(
      { pattern: "start.*end", output_mode: "content", "-n": true, head_limit: 0, multiline: true },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.totalMatches).toBe(1);
  });
});

async function setupParityTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anycode-grep-parity-"));
  await fs.writeFile(join(dir, "a.ts"), "const needle = 1;\nconst other = 2;\n");
  await fs.writeFile(join(dir, "c.md"), "needle mentioned in markdown\n");
  await fs.mkdir(join(dir, "sub"));
  await fs.writeFile(join(dir, "sub", "d.ts"), "needle again\nNEEDLE upper\n");
  await fs.mkdir(join(dir, "node_modules"));
  await fs.writeFile(join(dir, "node_modules", "e.ts"), "needle in node_modules\n");
  return dir;
}

describe("grepTool — ripgrep fallback (hermetic, no binary required)", () => {
  let tmpDir: string;

  afterEach(async () => {
    __resetRgPathCacheForTests();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("falls back to the JS path when the rg resolver fails", async () => {
    // resolveRgPath memoizes on first call, so the failing importer only
    // takes effect once the shared cache is cleared first; this reproduces
    // exactly the "@vscode/ripgrep import throws" scenario grep.ts's internal
    // (argument-less) resolveRgPath() call reads on its next invocation.
    __resetRgPathCacheForTests();
    await resolveRgPath(() => Promise.reject(new Error("no binary in this environment")));

    tmpDir = await setupParityTree();
    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctxFor(tmpDir),
    );

    expect(result.ok).toBe(true);
    expect(result.output?.files?.length).toBe(3); // a.ts, c.md, sub/d.ts — node_modules excluded, JS semantics
    expect((result.output?.files ?? []).some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("falls back to the JS path when ExecutionPort has no runBinary (existing mocks keep working)", async () => {
    tmpDir = await setupParityTree();
    const ctx = ctxFor(tmpDir);
    const execWithoutRunBinary: ToolContext["ports"]["exec"] = { run: (req) => exec.run(req) };
    const ctxNoRunBinary: ToolContext = { ...ctx, ports: { ...ctx.ports, exec: execWithoutRunBinary } };

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctxNoRunBinary,
    );

    expect(result.ok).toBe(true);
    expect(result.output?.files?.length).toBe(3);
  });
});

describe.skipIf(!rgAvailable)("grepTool — rg/JS backend parity", () => {
  let tmpDir: string;

  afterEach(async () => {
    __resetRgPathCacheForTests();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function runViaJs(input: Parameters<typeof grepTool.handler>[0], ctx: ToolContext) {
    // Same memoization caveat as the fallback tests above: clear the cache
    // before forcing a rejection, otherwise an already-cached real path wins.
    __resetRgPathCacheForTests();
    await resolveRgPath(() => Promise.reject(new Error("forced JS path for parity comparison")));
    const result = await grepTool.handler(input, ctx);
    __resetRgPathCacheForTests();
    return result;
  }

  it("content mode: rg and JS backends return the same shape", async () => {
    tmpDir = await setupParityTree();
    const input = { pattern: "needle", output_mode: "content" as const, "-n": true, head_limit: 0, multiline: false };

    const viaRg = await grepTool.handler(input, ctxFor(tmpDir));
    const viaJs = await runViaJs(input, ctxFor(tmpDir));

    expect(viaRg.ok).toBe(true);
    expect(viaJs.ok).toBe(true);
    expect(viaRg.output?.mode).toBe(viaJs.output?.mode);
    expect(viaRg.output?.totalMatches).toBe(viaJs.output?.totalMatches);
    expect(viaRg.output?.truncated).toBe(viaJs.output?.truncated);
    const rgPaths = (viaRg.output?.matches ?? []).map((m) => m.path).sort();
    const jsPaths = (viaJs.output?.matches ?? []).map((m) => m.path).sort();
    expect(rgPaths).toEqual(jsPaths);
  });

  it("files_with_matches mode: rg and JS backends return the same file set", async () => {
    tmpDir = await setupParityTree();
    const input = {
      pattern: "needle",
      output_mode: "files_with_matches" as const,
      "-n": true,
      head_limit: 0,
      multiline: false,
    };

    const viaRg = await grepTool.handler(input, ctxFor(tmpDir));
    const viaJs = await runViaJs(input, ctxFor(tmpDir));

    expect(viaRg.output?.mode).toBe("files_with_matches");
    expect([...(viaRg.output?.files ?? [])].sort()).toEqual([...(viaJs.output?.files ?? [])].sort());
    expect(viaRg.output?.totalMatches).toBe(viaJs.output?.totalMatches);
  });

  it("count mode: rg and JS backends return the same per-file counts", async () => {
    tmpDir = await setupParityTree();
    const input = { pattern: "needle", output_mode: "count" as const, "-i": true, "-n": true, head_limit: 0, multiline: false };

    const viaRg = await grepTool.handler(input, ctxFor(tmpDir));
    const viaJs = await runViaJs(input, ctxFor(tmpDir));

    expect(viaRg.output?.mode).toBe("count");
    expect(viaRg.output?.counts).toEqual(viaJs.output?.counts);
    expect(viaRg.output?.totalMatches).toBe(viaJs.output?.totalMatches);
  });
});

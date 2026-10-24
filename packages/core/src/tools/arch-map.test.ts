import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import type { ArchMapEdge, ArchMapOutput } from "./arch-map.js";
import {
  ARCH_MAP_MODEL_EDGE_LIMIT,
  archMapTool,
  scanImportGraph,
} from "./arch-map.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string): ToolContext {
  return { toolCallId: "t1", abortSignal: new AbortController().signal, cwd, ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() } };
}

describe("ArchMap scanner + tool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined as unknown as string;
  });

  async function setup(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "anycode-archmap-"));
    tmpDir = dir;
    return dir;
  }

  function findEdge(output: ArchMapOutput, from: string, to: string): ArchMapEdge | undefined {
    return output.edges.find((e) => e.from === from && e.to === to);
  }

  it("builds modules and edges from a plain import (1)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "import { b } from \"./b\";\n\nexport const a = 1;");
    await fs.writeFile(join(dir, "b.ts"), "export const b = 2;\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(output.modules.map((m) => m.id)).toEqual(["a", "b"]);
    const aModule = output.modules.find((m) => m.id === "a");
    expect(aModule?.loc).toBe(3); // 3 lines of content
    const edge = findEdge(output, "a", "b");
    expect(edge).toBeDefined();
    expect(edge?.typeOnly).toBe(false);
    expect(edge?.dynamic).toBe(false);
  });

  it("aggregates type-only per pair: AND over all imports between the pair (2)", async () => {
    const dir = await setup();
    await fs.writeFile(
      join(dir, "a.ts"),
      "import type { X } from \"./types\";\nimport { Y } from \"./types\";\n",
    );
    await fs.writeFile(join(dir, "types.ts"), "export type X = 1;\nexport const Y = 2;\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    const edge = findEdge(output, "a", "types");
    expect(edge).toBeDefined();
    expect(edge?.typeOnly).toBe(false); // one value import disqualifies type-only

    // A pair where EVERY import is type-only stays type-only.
    const dir2 = await setup();
    await fs.writeFile(
      join(dir2, "a.ts"),
      "import type { X } from \"./types\";\nimport type { Z } from \"./types\";\n",
    );
    await fs.writeFile(join(dir2, "types.ts"), "export type X = 1;\nexport type Z = 3;\n");
    const output2 = await scanImportGraph(fs, dir2, { maxFiles: 100 });
    expect(findEdge(output2, "a", "types")?.typeOnly).toBe(true);
  });

  it("flags dynamic import() and require() edges (3)", async () => {
    const dir = await setup();
    await fs.writeFile(
      join(dir, "a.ts"),
      "const m = await import(\"./lazy\");\nconst r = require(\"./cjs\");\n",
    );
    await fs.writeFile(join(dir, "lazy.ts"), "export const l = 1;\n");
    await fs.writeFile(join(dir, "cjs.js"), "module.exports = 1;\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    const lazyEdge = findEdge(output, "a", "lazy");
    expect(lazyEdge).toBeDefined();
    expect(lazyEdge?.dynamic).toBe(true);
    expect(lazyEdge?.typeOnly).toBe(false);
    const cjsEdge = findEdge(output, "a", "cjs");
    expect(cjsEdge).toBeDefined();
    expect(cjsEdge?.dynamic).toBe(true);
  });

  it("resolves .js-suffixed TS-emit imports to the .ts source (4)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "import { x } from \"./util.js\";\n");
    await fs.writeFile(join(dir, "util.ts"), "export const x = 1;\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(findEdge(output, "a", "util")).toBeDefined();
    expect(output.unresolved).toEqual([]);
  });

  it("resolves bare directory specs to index files (5)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "import { y } from \"./util\";\n");
    await fs.mkdir(join(dir, "util"));
    await fs.writeFile(join(dir, "util", "index.ts"), "export const y = 1;\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(output.modules.map((m) => m.id)).toEqual(["a", "util/index"]);
    expect(findEdge(output, "a", "util/index")).toBeDefined();
  });

  it("counts external packages, scoped names reduced to @scope/pkg (6)", async () => {
    const dir = await setup();
    await fs.writeFile(
      join(dir, "a.ts"),
      "import { z } from \"zod\";\nimport { p } from \"@scope/pkg/deep\";\n",
    );
    await fs.writeFile(join(dir, "b.ts"), "import { z2 } from \"zod\";\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(output.external).toEqual([
      { name: "zod", count: 2 },
      { name: "@scope/pkg", count: 1 },
    ]);
    expect(output.unresolved).toEqual([]);
  });

  it("skips node builtins: node:fs, fs, fs/promises, path (7)", async () => {
    const dir = await setup();
    await fs.writeFile(
      join(dir, "a.ts"),
      "import * as fs1 from \"node:fs\";\nimport * as fs2 from \"fs\";\nimport * as fs3 from \"fs/promises\";\nimport * as p from \"path\";\n",
    );

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(output.external).toEqual([]);
    expect(output.unresolved).toEqual([]);
    expect(output.edges).toEqual([]);
  });

  it("excludes tests, .d.ts, node_modules, dist, fixtures, test-harness (8)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "x.test.ts"), "import { y } from \"./y\";\n");
    await fs.writeFile(join(dir, "x.spec.tsx"), "import { y } from \"./y\";\n");
    await fs.writeFile(join(dir, "x.d.ts"), "declare const x: number;\n");
    await fs.mkdir(join(dir, "node_modules"));
    await fs.writeFile(join(dir, "node_modules", "dep", "index.ts"), "export {};\n");
    await fs.mkdir(join(dir, "dist"));
    await fs.writeFile(join(dir, "dist", "out.js"), "export {};\n");
    await fs.mkdir(join(dir, "__fixtures__"));
    await fs.writeFile(join(dir, "__fixtures__", "f.ts"), "export {};\n");
    await fs.mkdir(join(dir, "test-harness"));
    await fs.writeFile(join(dir, "test-harness", "h.ts"), "export {};\n");
    await fs.writeFile(join(dir, "y.ts"), "export const y = 1;\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(output.modules.map((m) => m.id)).toEqual(["y"]);
  });

  it("records unresolvable relative specs in unresolved (9)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "import { nope } from \"./nope\";\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(output.unresolved).toEqual([{ from: "a", spec: "./nope" }]);
  });

  it("skips self-imports (10)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "import \"./a\";\nimport { b } from \"./b\";\n");
    await fs.writeFile(join(dir, "b.ts"), "export const b = 1;\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(output.edges).toEqual([{ from: "a", to: "b", typeOnly: false, dynamic: false }]);
  });

  it("truncates at max_files (11)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "export {};\n");
    await fs.writeFile(join(dir, "b.ts"), "export {};\n");
    await fs.writeFile(join(dir, "c.ts"), "export {};\n");

    const output = await scanImportGraph(fs, dir, { maxFiles: 2 });

    expect(output.truncated).toBe(true);
    expect(output.modules).toHaveLength(2);
  });

  it("is deterministic across two scans (12)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "import { b } from \"./b\";\nimport { z } from \"zod\";\nimport { nope } from \"./nope\";\n");
    await fs.writeFile(join(dir, "b.ts"), "export const b = 1;\n");
    await fs.mkdir(join(dir, "sub"));
    await fs.writeFile(join(dir, "sub", "c.ts"), "import { b } from \"../b\";\nimport type { X } from \"../a\";\n");

    const first = await scanImportGraph(fs, dir, { maxFiles: 100 });
    const second = await scanImportGraph(fs, dir, { maxFiles: 100 });

    expect(first).toEqual(second);
  });

  it("formatResultForModel: counts line + edge lines with markers; omission over the limit (13)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "import type { X } from \"./types\";\nimport { z } from \"zod\";\n");
    await fs.writeFile(join(dir, "types.ts"), "export type X = 1;\n");

    const result = await archMapTool.handler({}, ctxFor(dir));
    expect(result.ok).toBe(true);
    const text = archMapTool.formatResultForModel!(result as { ok: true; output: ArchMapOutput });
    expect(text).toContain("Import graph of ");
    expect(text).toContain("2 modules, 1 edges (1 type-only, 0 dynamic)");
    expect(text).toContain("External packages: zod(1).");
    expect(text).toContain("a -t-> types");

    // Dynamic marker line.
    const dir2 = await setup();
    await fs.writeFile(join(dir2, "a.ts"), "const m = await import(\"./lazy\");\n");
    await fs.writeFile(join(dir2, "lazy.ts"), "export {};\n");
    const result2 = await archMapTool.handler({}, ctxFor(dir2));
    const text2 = archMapTool.formatResultForModel!(result2 as { ok: true; output: ArchMapOutput });
    expect(text2).toContain("a -d-> lazy");

    // Over the edge limit: hand-built output with 401 synthetic edges.
    const bigOutput: ArchMapOutput = {
      root: "/proj",
      truncated: false,
      modules: Array.from({ length: 402 }, (_, i) => ({ id: `m${i}`, loc: 1 })),
      edges: Array.from({ length: ARCH_MAP_MODEL_EDGE_LIMIT + 1 }, (_, i) => ({
        from: `m${i}`,
        to: `m${i + 1}`,
        typeOnly: false,
        dynamic: false,
      })),
      external: [],
      unresolved: [],
    };
    const omitted = archMapTool.formatResultForModel!({ ok: true, output: bigOutput });
    expect(omitted).toContain(
      `Edges omitted (${ARCH_MAP_MODEL_EDGE_LIMIT + 1} > ${ARCH_MAP_MODEL_EDGE_LIMIT}) — narrow the scan with path (e.g. a package src directory).`,
    );
    expect(omitted).not.toContain("Edges:");
  });

  it("handler errors: not found / not a directory; default root is ctx.cwd (14)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "file.ts"), "export {};\n");

    const missing = await archMapTool.handler({ path: join(dir, "does-not-exist") }, ctxFor(dir));
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe(`path not found: ${join(dir, "does-not-exist")}`);

    const notDir = await archMapTool.handler({ path: join(dir, "file.ts") }, ctxFor(dir));
    expect(notDir.ok).toBe(false);
    expect(notDir.error).toBe(`path is not a directory: ${join(dir, "file.ts")}`);

    // No path input → scans ctx.cwd.
    await fs.writeFile(join(dir, "only.ts"), "export const only = 1;\n");
    const defaultRoot = await archMapTool.handler({}, ctxFor(dir));
    expect(defaultRoot.ok).toBe(true);
    expect(defaultRoot.output?.modules.map((m) => m.id)).toContain("only");
  });

  it("subdirectory path input: module ids relative to that root (15)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "root.ts"), "export {};\n");
    await fs.mkdir(join(dir, "pkg"));
    await fs.writeFile(join(dir, "pkg", "main.ts"), "import { x } from \"./x\";\n");
    await fs.writeFile(join(dir, "pkg", "x.ts"), "export const x = 1;\n");

    const output = await scanImportGraph(fs, join(dir, "pkg"), { maxFiles: 100 });
    expect(output.modules.map((m) => m.id)).toEqual(["main", "x"]);
    expect(findEdge(output, "main", "x")).toBeDefined();

    // And via the handler with path input.
    const result = await archMapTool.handler({ path: join(dir, "pkg") }, ctxFor(dir));
    expect(result.ok).toBe(true);
    expect(result.output?.modules.map((m) => m.id)).toEqual(["main", "x"]);
  });
  it("stays inside the workspace: relative paths resolve against cwd, escapes are refused (16)", async () => {
    const dir = await setup();
    await fs.mkdir(join(dir, "pkg"));
    await fs.writeFile(join(dir, "pkg", "main.ts"), "import { x } from \"./x\";\n");
    await fs.writeFile(join(dir, "pkg", "x.ts"), "export const x = 1;\n");

    const relative = await archMapTool.handler({ path: "pkg" }, ctxFor(dir));
    expect(relative.ok).toBe(true);
    expect(relative.output?.edges).toEqual([{ from: "main", to: "x", typeOnly: false, dynamic: false }]);

    const up = await archMapTool.handler({ path: ".." }, ctxFor(join(dir, "pkg")));
    expect(up.ok).toBe(false);
    expect(up.error).toBe("path is outside the workspace: ..");
    const abs = await archMapTool.handler({ path: "/" }, ctxFor(dir));
    expect(abs.ok).toBe(false);
  });

  it("never follows symlinks out of the tree (17)", async () => {
    const dir = await setup();
    const outside = await mkdtemp(join(tmpdir(), "anycode-archmap-out-"));
    try {
      await fs.writeFile(join(outside, "secret.ts"), "export const s = 1;\n");
      await fs.writeFile(join(dir, "a.ts"), "export const a = 1;\n");
      await symlink(outside, join(dir, "linked"));
      await symlink(join(outside, "secret.ts"), join(dir, "file-link.ts"));
      const output = await scanImportGraph(fs, dir, { maxFiles: 100 });
      expect(output.modules.map((m) => m.id)).toEqual(["a"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("honours the abort signal (18)", async () => {
    const dir = await setup();
    await fs.writeFile(join(dir, "a.ts"), "export const a = 1;\n");
    const controller = new AbortController();
    controller.abort();
    const result = await archMapTool.handler({}, { ...ctxFor(dir), abortSignal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
  });
});

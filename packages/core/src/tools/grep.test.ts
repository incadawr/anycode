import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { grepTool, selectGrepBackend } from "./grep.js";
import { __resetRgPathCacheForTests, resolveRgPath } from "./grep-rg.js";
import { __resetTgrepPathCacheForTests } from "./grep-tgrep.js";
import type { BinaryExecRequest, ExecResult } from "../ports/execution.js";

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

// ── tgrep backend selection (Taskana 4160) — hermetic, no real binaries ──

function completedResult(stdout: string, exitCode = 0): ExecResult {
  return {
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 5,
  };
}

function spawnErrorResult(): ExecResult {
  return {
    status: "spawn_error",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "not found",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  };
}

function tgrepNdjson(path: string): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: `${path}/from-tgrep.ts` },
      lines: { text: "needle served by tgrep\n" },
      line_number: 7,
      absolute_offset: 0,
      submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
    },
  });
}

/**
 * Hermetic exec port for backend-selection tests:
 * - `--version` on an absolute tgrep candidate → exit 0 (resolveTgrepPath
 *   succeeds) unless tgrepVersionFails is set;
 * - a tgrep search (argv carries `--no-max-filesize`, the tgrep-only flag)
 *   → canned NDJSON, exit 1 (zero matches) when tgrepZeroMatch is set, or
 *   exit-2 when tgrepSearchFails is set;
 * - an rg search (no `--no-max-filesize`) → spawn_error unless rgServes is
 *   set (then NDJSON, or empty when rgZeroMatch) — the expected answer of
 *   the zero-match re-check, whose test also forces the rg resolver to a
 *   stub path.
 */
function tgrepStubCtx(
  cwd: string,
  opts: {
    tgrepVersionFails?: boolean;
    tgrepSearchFails?: boolean;
    tgrepZeroMatch?: boolean;
    rgServes?: boolean;
    rgZeroMatch?: boolean;
  } = {},
): { ctx: ToolContext; runBinary: ReturnType<typeof vi.fn> } {
  const runBinary = vi.fn((req: BinaryExecRequest): Promise<ExecResult> => {
    const args = req.args ?? [];
    if (args.includes("--version")) {
      const file = req.file;
      return Promise.resolve(
        (file.endsWith("/tgrep") || file.endsWith("\\tgrep.exe") || file.endsWith("/tgrep.exe")) && !opts.tgrepVersionFails
          ? completedResult("tgrep 0.1.0")
          : spawnErrorResult(),
      );
    }
    if (args.includes("--no-max-filesize")) {
      if (opts.tgrepSearchFails) return Promise.resolve(completedResult("regex parse error", 2));
      if (opts.tgrepZeroMatch) return Promise.resolve(completedResult("", 1));
      return Promise.resolve(completedResult(tgrepNdjson(cwd)));
    }
    if (opts.rgServes) return Promise.resolve(completedResult(opts.rgZeroMatch ? "" : tgrepNdjson(cwd)));
    return Promise.resolve(spawnErrorResult());
  });
  const ctx: ToolContext = {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd,
    ports: { fs, exec: { run: vi.fn(), runBinary }, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
  };
  return { ctx, runBinary };
}

function tgrepCalls(runBinary: ReturnType<typeof vi.fn>): BinaryExecRequest[] {
  return runBinary.mock.calls.map((c) => c[0] as BinaryExecRequest);
}

describe("selectGrepBackend (pure selector)", () => {
  it("defaults to rg with neither env nor settings", () => {
    expect(selectGrepBackend({})).toBe("rg");
  });

  it("env tgrep selects tgrep; case-insensitive", () => {
    expect(selectGrepBackend({ ANYCODE_GREP_BACKEND: "tgrep" })).toBe("tgrep");
    expect(selectGrepBackend({ ANYCODE_GREP_BACKEND: "TGREP" })).toBe("tgrep");
  });

  it("env wins over settings", () => {
    expect(selectGrepBackend({ ANYCODE_GREP_BACKEND: "rg" }, "tgrep")).toBe("rg");
    expect(selectGrepBackend({ ANYCODE_GREP_BACKEND: "tgrep" }, "rg")).toBe("tgrep");
  });

  it("unknown values mean rg (never route Grep to a missing binary)", () => {
    expect(selectGrepBackend({ ANYCODE_GREP_BACKEND: "BURP" })).toBe("rg");
    expect(selectGrepBackend({}, "auto")).toBe("rg");
    // blank-but-present env is still "env wins" under the ?? ladder — it trims
    // to "" and safely lands on rg (the host never writes a blank value; its
    // fillFromSettings uses envPresent).
    expect(selectGrepBackend({ ANYCODE_GREP_BACKEND: "  " }, "tgrep")).toBe("rg");
  });
});

describe("grepTool — tgrep backend selection (Taskana 4160)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "");
    __resetRgPathCacheForTests();
    __resetTgrepPathCacheForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    __resetRgPathCacheForTests();
    __resetTgrepPathCacheForTests();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupTree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "anycode-grep-tgrep-"));
    await fs.writeFile(join(dir, "a.ts"), "const needle = 1;\n");
    return dir;
  }

  it("unset/rg/BURP selector → no tgrep probe at all; search served without tgrep", async () => {
    const dirs: string[] = [];
    for (const value of [undefined, "rg", "BURP"]) {
      const dir = await setupTree();
      dirs.push(dir);
      if (value === undefined) vi.stubEnv("ANYCODE_GREP_BACKEND", "");
      else vi.stubEnv("ANYCODE_GREP_BACKEND", value);
      const { ctx, runBinary } = tgrepStubCtx(dir);

      const result = await grepTool.handler(
        { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
        ctx,
      );

      expect(result.ok).toBe(true);
      const versionProbes = tgrepCalls(runBinary).filter((r) => r.args.includes("--version"));
      expect(versionProbes).toEqual([]); // the tgrep tier must not even be probed
    }
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("ANYCODE_GREP_BACKEND=tgrep → served by the tgrep stub with --no-max-filesize in argv", async () => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    tmpDir = await setupTree();
    const { ctx, runBinary } = tgrepStubCtx(tmpDir);

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output?.mode).toBe("files_with_matches");
    expect(result.output?.files).toEqual([`${tmpDir}/from-tgrep.ts`]);
    expect(result.output?.totalMatches).toBe(1);

    const searchCall = tgrepCalls(runBinary).find((r) => r.args.includes("--no-max-filesize"));
    expect(searchCall).toBeDefined();
    expect(searchCall?.file.endsWith("/tgrep")).toBe(true); // absolute PATH-resolved candidate, never a bare name
  });

  it("tgrep ZERO matches → re-checked through rg (stale index can't hide a fresh file); rg's answer wins", async () => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    vi.stubEnv("ANYCODE_TGREP_BIN", "/usr/bin/tgrep");
    tmpDir = await setupTree();
    const { ctx, runBinary } = tgrepStubCtx(tmpDir, { tgrepZeroMatch: true, rgServes: true });
    // deterministic rg tier regardless of the host environment: the forced
    // path is what grep.ts spawns, and the stub answers it with the fresh scan
    __resetRgPathCacheForTests();
    await resolveRgPath(() => Promise.resolve({ rgPath: "/usr/bin/rg-stub" }));

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    // tgrep answered zero (stale index missed the file) — rg re-scanned and found it
    expect(result.output?.files).toEqual([`${tmpDir}/from-tgrep.ts`]);
    expect(result.output?.totalMatches).toBe(1);

    const tgrepSearch = tgrepCalls(runBinary).filter((r) => r.args.includes("--no-max-filesize"));
    expect(tgrepSearch.length).toBe(1); // tgrep was asked...
    const rgSearch = tgrepCalls(runBinary).filter(
      (r) => !r.args.includes("--version") && !r.args.includes("--no-max-filesize"),
    );
    expect(rgSearch.length).toBe(1); // ...then re-checked by rg (fresh scan)
    expect(rgSearch[0]?.file).toBe("/usr/bin/rg-stub");
  });

  it("tgrep NON-ZERO matches → returned as-is, rg is never called", async () => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    vi.stubEnv("ANYCODE_TGREP_BIN", "/usr/bin/tgrep");
    tmpDir = await setupTree();
    const { ctx, runBinary } = tgrepStubCtx(tmpDir); // non-zero NDJSON by default
    __resetRgPathCacheForTests();
    await resolveRgPath(() => Promise.resolve({ rgPath: "/usr/bin/rg-stub" }));

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output?.files).toEqual([`${tmpDir}/from-tgrep.ts`]); // tgrep's own answer
    expect(result.output?.totalMatches).toBe(1);

    const nonProbeCalls = tgrepCalls(runBinary).filter((r) => !r.args.includes("--version"));
    expect(nonProbeCalls.length).toBe(1); // exactly one search call...
    expect(nonProbeCalls[0]?.args.includes("--no-max-filesize")).toBe(true); // ...the tgrep one — no rg re-check
  });

  it("tgrep zero matches and the rg re-check also finds nothing → rg's empty answer returned (still ok)", async () => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    vi.stubEnv("ANYCODE_TGREP_BIN", "/usr/bin/tgrep");
    tmpDir = await setupTree();
    // both tiers answer zero: tgrep exit 1 + an rg re-check with empty stdout
    const { ctx, runBinary } = tgrepStubCtx(tmpDir, { tgrepZeroMatch: true, rgServes: true, rgZeroMatch: true });
    __resetRgPathCacheForTests();
    await resolveRgPath(() => Promise.resolve({ rgPath: "/usr/bin/rg-stub" }));

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output?.files).toEqual([]);
    expect(result.output?.totalMatches).toBe(0);
    const rgSearch = tgrepCalls(runBinary).filter(
      (r) => !r.args.includes("--version") && !r.args.includes("--no-max-filesize"),
    );
    expect(rgSearch.length).toBe(1); // the re-check ran and its empty answer was returned
  });

  it("ANYCODE_GREP_BACKEND=tgrep but --version probe fails → silent fallback, result still ok", async () => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    vi.stubEnv("ANYCODE_TGREP_BIN", "/usr/bin/tgrep");
    tmpDir = await setupTree();
    const { ctx, runBinary } = tgrepStubCtx(tmpDir, { tgrepVersionFails: true });

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    const probes = tgrepCalls(runBinary).filter((r) => r.args.includes("--version"));
    expect(probes.length).toBeGreaterThanOrEqual(1); // probe happened
    expect(result.output?.files).toEqual([join(tmpDir, "a.ts")]); // JS tier served it (rg tier hit spawn_error)
  });

  it("ANYCODE_GREP_BACKEND=tgrep and search exit 2 → same silent fallback", async () => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    vi.stubEnv("ANYCODE_TGREP_BIN", "/usr/bin/tgrep");
    tmpDir = await setupTree();
    const { ctx, runBinary } = tgrepStubCtx(tmpDir, { tgrepSearchFails: true });

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    const tgrepSearch = tgrepCalls(runBinary).find((r) => r.args.includes("--no-max-filesize"));
    expect(tgrepSearch).toBeDefined(); // tgrep was attempted
    expect(result.output?.files).toEqual([join(tmpDir, "a.ts")]); // fell through to JS
  });
});

describe("grepTool — tgrep capped stdout falls through the ladder (Taskana 4160 cross-review F1)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    vi.stubEnv("ANYCODE_TGREP_BIN", "/usr/bin/tgrep");
    __resetRgPathCacheForTests();
    __resetTgrepPathCacheForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    __resetRgPathCacheForTests();
    __resetTgrepPathCacheForTests();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("tgrep returns a capped (stdoutTruncated) non-zero stream → NOT final; rg answers with the full count", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-grep-cap-"));
    await fs.writeFile(join(tmpDir, "a.ts"), "needle one\n");
    await fs.writeFile(join(tmpDir, "b.ts"), "needle two\n");
    await resolveRgPath(() => Promise.resolve({ rgPath: "/usr/bin/rg-stub" }));

    const rgEvent = (file: string, n: number): string =>
      JSON.stringify({ type: "match", data: { path: { text: file }, lines: { text: "needle\n" }, line_number: n, absolute_offset: 0, submatches: [] } });
    const runBinary = vi.fn((req: BinaryExecRequest): Promise<ExecResult> => {
      const base = { signal: null, stderr: "", stderrTruncated: false, durationMs: 1 };
      if (req.args.includes("--version")) {
        return Promise.resolve({ ...base, status: "completed", exitCode: 0, stdout: "tgrep 0.1.0", stdoutTruncated: false });
      }
      if (req.args.includes("--no-max-filesize")) {
        // tgrep: non-zero match count but the stream was capped mid-way
        return Promise.resolve({ ...base, status: "completed", exitCode: 0, stdout: rgEvent(join(tmpDir, "a.ts"), 1), stdoutTruncated: true });
      }
      // rg tier: fresh full scan, answers both files
      return Promise.resolve({
        ...base,
        status: "completed",
        exitCode: 0,
        stdout: [rgEvent(join(tmpDir, "a.ts"), 1), rgEvent(join(tmpDir, "b.ts"), 1)].join("\n"),
        stdoutTruncated: false,
      });
    });
    const ctx: ToolContext = {
      toolCallId: "t1",
      abortSignal: new AbortController().signal,
      cwd: tmpDir,
      ports: { fs, exec: { run: vi.fn(), runBinary }, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
    };

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output?.totalMatches).toBe(2); // rg's full answer, not tgrep's trimmed single file
    expect(result.output?.files).toEqual([join(tmpDir, "a.ts"), join(tmpDir, "b.ts")]);
    const rgCalls = runBinary.mock.calls.filter((c) => (c[0] as BinaryExecRequest).file === "/usr/bin/rg-stub");
    expect(rgCalls.length).toBe(1);
  });
});

describe("grepTool — tgrep + rg re-check stay inside the tool budget (Taskana 4160 cross-review F3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.stubEnv("ANYCODE_GREP_BACKEND", "tgrep");
    vi.stubEnv("ANYCODE_TGREP_BIN", "/usr/bin/tgrep");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(0));
    __resetRgPathCacheForTests();
    __resetTgrepPathCacheForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    __resetRgPathCacheForTests();
    __resetTgrepPathCacheForTests();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("a slow zero-match tgrep scan leaves the rg re-check only the remaining budget; tgrep's own spawn is capped", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-grep-budget-"));
    await fs.writeFile(join(tmpDir, "a.ts"), "needle\n");
    await resolveRgPath(() => Promise.resolve({ rgPath: "/usr/bin/rg-stub" }));

    const runBinary = vi.fn((req: BinaryExecRequest): Promise<ExecResult> => {
      const base = { signal: null, stderr: "", stderrTruncated: false, stdoutTruncated: false, durationMs: 1 };
      if (req.args.includes("--version")) {
        return Promise.resolve({ ...base, status: "completed", exitCode: 0, stdout: "tgrep 0.1.0" });
      }
      if (req.args.includes("--no-max-filesize")) {
        // tgrep answers zero matches after a 70 s scan
        vi.setSystemTime(Date.now() + 70_000);
        return Promise.resolve({ ...base, status: "completed", exitCode: 1, stdout: "" });
      }
      return Promise.resolve({ ...base, status: "completed", exitCode: 0, stdout: "" });
    });
    const ctx: ToolContext = {
      toolCallId: "t1",
      abortSignal: new AbortController().signal,
      cwd: tmpDir,
      ports: { fs, exec: { run: vi.fn(), runBinary }, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
    };

    const result = await grepTool.handler(
      { pattern: "needle", output_mode: "files_with_matches", "-n": true, head_limit: 0, multiline: false },
      ctx,
    );
    expect(result.ok).toBe(true);

    const calls = runBinary.mock.calls.map((c) => c[0] as BinaryExecRequest);
    const tgrepSearch = calls.find((r) => r.args.includes("--no-max-filesize"));
    const rgRecheck = calls.find((r) => r.file === "/usr/bin/rg-stub");
    expect(tgrepSearch?.timeoutMs).toBeLessThanOrEqual(DEFAULT_TOOL_TIMEOUT_MS / 2);
    expect(rgRecheck).toBeDefined();
    // tgrep spent 70 s of the 120 s tool budget; rg may only use what is left
    expect(rgRecheck?.timeoutMs).toBeLessThanOrEqual(DEFAULT_TOOL_TIMEOUT_MS - 70_000);
  });
});

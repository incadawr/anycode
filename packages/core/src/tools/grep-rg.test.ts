import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../ports/execution.js";
import type { ToolContext } from "../types/tools.js";
import type { GrepInput } from "./schemas.js";
import {
  __resetRgPathCacheForTests,
  buildRgArgs,
  parseRgJsonEvents,
  resolveRgPath,
  searchWithRipgrep,
} from "./grep-rg.js";

function matchEvent(path: string, lineNumber: number, line: string): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${line}\n` },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
    },
  });
}

function contextEvent(path: string, lineNumber: number, line: string): string {
  return JSON.stringify({
    type: "context",
    data: { path: { text: path }, lines: { text: `${line}\n` }, line_number: lineNumber },
  });
}

function baseInput(overrides: Partial<GrepInput> = {}): GrepInput {
  return {
    pattern: "needle",
    output_mode: "content",
    "-n": true,
    head_limit: 0,
    multiline: false,
    ...overrides,
  };
}

function ctxWithRunBinary(execResult: ExecResult): { ctx: ToolContext; runBinary: ReturnType<typeof vi.fn> } {
  const runBinary = vi.fn().mockResolvedValue(execResult);
  const ctx = {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/repo",
    ports: {
      fs: {} as ToolContext["ports"]["fs"],
      exec: { run: vi.fn(), runBinary },
      http: {} as ToolContext["ports"]["http"],
      todos: {} as ToolContext["ports"]["todos"],
    },
  } as ToolContext;
  return { ctx, runBinary };
}

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

describe("buildRgArgs", () => {
  it("maps content-mode flags: --json, -i, -A/-B/-C, multiline", () => {
    const args = buildRgArgs(
      baseInput({ "-i": true, "-C": 2, multiline: true }),
      "/repo/src",
      true,
    );
    expect(args).toContain("--json");
    expect(args).toContain("-i");
    expect(args).toEqual(expect.arrayContaining(["-U", "--multiline-dotall"]));
    expect(args).toEqual(expect.arrayContaining(["-B", "2", "-A", "2"]));
    expect(args[args.length - 2]).toBe("needle");
    expect(args[args.length - 1]).toBe("/repo/src");
  });

  it("forces node_modules/.git/dist excludes and applies glob only for directory targets", () => {
    const args = buildRgArgs(baseInput({ glob: "*.md" }), "/repo/src", true);
    expect(args).toEqual(expect.arrayContaining(["--glob", "!node_modules", "--glob", "!.git", "--glob", "!dist"]));
    expect(args).toEqual(expect.arrayContaining(["-g", "*.md"]));
  });

  it("skips exclude globs and glob filter for a single-file target", () => {
    const args = buildRgArgs(baseInput({ glob: "*.md" }), "/repo/src/a.ts", false);
    expect(args).not.toContain("--glob");
    expect(args).not.toContain("-g");
  });

  it("omits -A/-B/-C for non-content modes", () => {
    const args = buildRgArgs(baseInput({ output_mode: "count", "-C": 3 }), "/repo", true);
    expect(args).not.toContain("-A");
    expect(args).not.toContain("-B");
  });
});

describe("parseRgJsonEvents", () => {
  it("parses match/context events and strips trailing newline from line text", () => {
    const stdout = [
      matchEvent("/repo/a.ts", 1, "const needle = 1;"),
      contextEvent("/repo/a.ts", 2, "const other = 2;"),
      JSON.stringify({ type: "begin", data: { path: { text: "/repo/a.ts" } } }),
      "",
    ].join("\n");

    const events = parseRgJsonEvents(stdout);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "match", path: "/repo/a.ts", lineNumber: 1, line: "const needle = 1;" });
    expect(events[1]?.type).toBe("context");
  });

  it("skips stray non-JSON lines instead of throwing", () => {
    const stdout = ["not json", matchEvent("/repo/a.ts", 1, "needle")].join("\n");
    expect(() => parseRgJsonEvents(stdout)).not.toThrow();
    expect(parseRgJsonEvents(stdout)).toHaveLength(1);
  });
});

describe("searchWithRipgrep", () => {
  it("maps content mode from --json match events, honoring -n for lineNumber", () => {
    const stdout = [matchEvent("/repo/a.ts", 1, "const needle = 1;"), matchEvent("/repo/sub/d.ts", 3, "needle again")].join("\n");
    const { ctx } = ctxWithRunBinary(completedResult(stdout));

    return searchWithRipgrep(baseInput({ "-n": true, head_limit: 0 }), ctx, "/rg", "/repo", true).then((output) => {
      expect(output.mode).toBe("content");
      expect(output.matches).toHaveLength(2);
      expect(output.matches?.[0]).toEqual({ path: "/repo/a.ts", lineNumber: 1, line: "const needle = 1;" });
      expect(output.totalMatches).toBe(2);
      expect(output.truncated).toBe(false);
    });
  });

  it("omits lineNumber when -n is false", async () => {
    const stdout = matchEvent("/repo/a.ts", 1, "needle");
    const { ctx } = ctxWithRunBinary(completedResult(stdout));

    const output = await searchWithRipgrep(baseInput({ "-n": false, head_limit: 0 }), ctx, "/rg", "/repo", true);
    expect(output.matches?.[0]?.lineNumber).toBeUndefined();
  });

  it("maps files_with_matches mode to a deduped, ordered file list", async () => {
    const stdout = [
      matchEvent("/repo/a.ts", 1, "needle"),
      matchEvent("/repo/a.ts", 5, "needle again"),
      matchEvent("/repo/sub/d.ts", 1, "needle"),
    ].join("\n");
    const { ctx } = ctxWithRunBinary(completedResult(stdout));

    const output = await searchWithRipgrep(baseInput({ output_mode: "files_with_matches", head_limit: 0 }), ctx, "/rg", "/repo", true);
    expect(output.mode).toBe("files_with_matches");
    expect(output.files).toEqual(["/repo/a.ts", "/repo/sub/d.ts"]);
    expect(output.totalMatches).toBe(2); // 2 files, not 3 match lines
    expect(output.truncated).toBe(false);
  });

  it("maps count mode to per-file match-line counts", async () => {
    const stdout = [
      matchEvent("/repo/a.ts", 1, "needle"),
      matchEvent("/repo/a.ts", 5, "needle again"),
      matchEvent("/repo/sub/d.ts", 1, "needle"),
    ].join("\n");
    const { ctx } = ctxWithRunBinary(completedResult(stdout));

    const output = await searchWithRipgrep(baseInput({ output_mode: "count", head_limit: 0 }), ctx, "/rg", "/repo", true);
    expect(output.mode).toBe("count");
    expect(output.counts).toEqual({ "/repo/a.ts": 2, "/repo/sub/d.ts": 1 });
    expect(output.totalMatches).toBe(3);
    expect(output.truncated).toBe(false);
  });

  it("applies head_limit and sets truncated without changing totalMatches", async () => {
    const stdout = [
      matchEvent("/repo/a.ts", 1, "needle"),
      matchEvent("/repo/b.ts", 1, "needle"),
      matchEvent("/repo/c.ts", 1, "needle"),
    ].join("\n");
    const { ctx } = ctxWithRunBinary(completedResult(stdout));

    const output = await searchWithRipgrep(
      baseInput({ output_mode: "files_with_matches", head_limit: 2 }),
      ctx,
      "/rg",
      "/repo",
      true,
    );
    expect(output.files).toHaveLength(2);
    expect(output.truncated).toBe(true);
    expect(output.totalMatches).toBe(3); // untruncated total, matching the JS-path contract
  });

  it("treats exit code 1 (no matches) as a normal empty result, not a failure", async () => {
    const { ctx } = ctxWithRunBinary(completedResult("", 1));
    const output = await searchWithRipgrep(baseInput({ output_mode: "files_with_matches" }), ctx, "/rg", "/repo", true);
    expect(output.files).toEqual([]);
    expect(output.totalMatches).toBe(0);
  });

  it("throws on an unexpected non-zero/non-one exit code so the caller can fall back", async () => {
    const { ctx } = ctxWithRunBinary(completedResult("regex parse error", 2));
    await expect(searchWithRipgrep(baseInput(), ctx, "/rg", "/repo", true)).rejects.toThrow();
  });

  it("throws when the process is cancelled or times out", async () => {
    const { ctx } = ctxWithRunBinary({
      status: "timed_out",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    });
    await expect(searchWithRipgrep(baseInput(), ctx, "/rg", "/repo", true)).rejects.toThrow();
  });

  it("throws when ExecutionPort.runBinary is unavailable", async () => {
    const ctx = {
      toolCallId: "t1",
      abortSignal: new AbortController().signal,
      cwd: "/repo",
      ports: { fs: {}, exec: { run: vi.fn() }, http: {}, todos: {} },
    } as unknown as ToolContext;
    await expect(searchWithRipgrep(baseInput(), ctx, "/rg", "/repo", true)).rejects.toThrow();
  });
});

describe("resolveRgPath", () => {
  afterEach(() => {
    __resetRgPathCacheForTests();
  });

  it("memoizes a successful import across calls", async () => {
    const importer = vi.fn().mockResolvedValue({ rgPath: "/opt/rg" });
    expect(await resolveRgPath(importer)).toBe("/opt/rg");
    expect(await resolveRgPath(importer)).toBe("/opt/rg");
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("caches undefined when the import fails, without retrying", async () => {
    const importer = vi.fn().mockRejectedValue(new Error("module not found"));
    expect(await resolveRgPath(importer)).toBeUndefined();
    expect(await resolveRgPath(importer)).toBeUndefined();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("rewrites an app.asar path to app.asar.unpacked (packaged Electron asar fix)", async () => {
    const importer = vi.fn().mockResolvedValue({
      rgPath: "/Applications/AnyCode.app/Contents/Resources/app.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg",
    });
    expect(await resolveRgPath(importer)).toBe(
      "/Applications/AnyCode.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg",
    );
  });

  it("leaves a path without app.asar byte-identical (inert outside packaged Electron)", async () => {
    const plain = "/Users/dev/anycode/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg";
    const importer = vi.fn().mockResolvedValue({ rgPath: plain });
    expect(await resolveRgPath(importer)).toBe(plain);
  });
});

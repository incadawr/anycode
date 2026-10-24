/**
 * Unit tests for the tgrep Grep tier (Taskana 4160). Fully hermetic: the
 * exec port is a stub recording every runBinary call and answering canned
 * ExecResults — no tgrep binary, no daemon, no rg.
 */
import { describe, expect, it, vi } from "vitest";
import type { BinaryExecRequest, ExecResult } from "../ports/execution.js";
import type { ToolContext } from "../types/tools.js";
import type { GrepInput } from "./schemas.js";
import { resolveTgrepPath, searchWithTgrep } from "./grep-tgrep.js";

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

type StubHandler = (req: BinaryExecRequest) => ExecResult | Promise<ExecResult>;

function ctxWithRunBinary(handler: StubHandler): { ctx: ToolContext; runBinary: ReturnType<typeof vi.fn> } {
  const runBinary = vi.fn(handler);
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

function statusResult(status: ExecResult["status"]): ExecResult {
  return {
    status,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  };
}

const ndjson = [
  matchEvent("/repo/a.ts", 1, "const needle = 1;"),
  contextEvent("/repo/a.ts", 2, "const other = 2;"),
  matchEvent("/repo/sub/d.ts", 3, "needle again"),
].join("\n");

describe("resolveTgrepPath (Taskana 4160)", () => {
  it("returns \"tgrep\" when the PATH probe's --version exits 0", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    await expect(resolveTgrepPath(ctx.ports.exec)).resolves.toBe("tgrep");
    expect(runBinary).toHaveBeenCalledTimes(1);
    expect(runBinary).toHaveBeenCalledWith(expect.objectContaining({ file: "tgrep", args: ["--version"] }));
  });

  it("returns undefined when --version exits 3", async () => {
    const { ctx } = ctxWithRunBinary(() => completedResult("", 3));
    await expect(resolveTgrepPath(ctx.ports.exec)).resolves.toBeUndefined();
  });

  it("returns undefined on spawn_error", async () => {
    const { ctx } = ctxWithRunBinary(() => statusResult("spawn_error"));
    await expect(resolveTgrepPath(ctx.ports.exec)).resolves.toBeUndefined();
  });

  it("returns undefined when runBinary throws", async () => {
    const { ctx } = ctxWithRunBinary(() => {
      throw new Error("exec port exploded");
    });
    await expect(resolveTgrepPath(ctx.ports.exec)).resolves.toBeUndefined();
  });

  it("explicitBin wins over the PATH probe and is validated by --version (fail → undefined)", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    await expect(resolveTgrepPath(ctx.ports.exec, "/opt/tgrep/bin/tgrep")).resolves.toBe("/opt/tgrep/bin/tgrep");
    expect(runBinary).toHaveBeenCalledWith(expect.objectContaining({ file: "/opt/tgrep/bin/tgrep", args: ["--version"] }));

    const { ctx: failCtx, runBinary: failRunBinary } = ctxWithRunBinary(() => completedResult("", 127));
    await expect(resolveTgrepPath(failCtx.ports.exec, "/opt/tgrep/bin/tgrep")).resolves.toBeUndefined();
    expect(failRunBinary).toHaveBeenCalledWith(expect.objectContaining({ file: "/opt/tgrep/bin/tgrep" }));
  });

  it("returns undefined when runBinary is not available on the port", async () => {
    const exec = { run: vi.fn() } as ToolContext["ports"]["exec"];
    await expect(resolveTgrepPath(exec)).resolves.toBeUndefined();
  });
});

describe("searchWithTgrep (Taskana 4160)", () => {
  it("exit 0 with rg-shaped NDJSON → shaped GrepOutput (content mode, path + line numbers, context included)", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult(ndjson));

    const output = await searchWithTgrep(baseInput({ "-n": true }), ctx, "tgrep", "/repo", true);
    expect(output).toBeDefined();
    expect(output?.mode).toBe("content");
    expect(output?.matches).toEqual([
      { path: "/repo/a.ts", lineNumber: 1, line: "const needle = 1;" },
      { path: "/repo/a.ts", lineNumber: 2, line: "const other = 2;" },
      { path: "/repo/sub/d.ts", lineNumber: 3, line: "needle again" },
    ]);
    expect(output?.totalMatches).toBe(2); // context line not counted

    // argv contract: rg flag mapping plus the tgrep-specific cap lift
    const req = runBinary.mock.calls[0]?.[0] as BinaryExecRequest;
    expect(req.file).toBe("tgrep");
    expect(req.args).toContain("--no-max-filesize");
    expect(req.args).toContain("--json");
    expect(req.args).toContain("--no-config");
    expect(req.args).toContain("--");
    expect(req.args).toContain("needle");
    expect(req.args).toContain("/repo");
    // never off-index / bypass flags
    expect(req.args).not.toContain("--no-index");
    expect(req.args).not.toContain("-a");
    expect(req.args).not.toContain("--hidden");
    expect(req.args).not.toContain("--no-ignore");
    expect(req.args).not.toContain("-E");
  });

  it("exit 1 (no matches) → empty output, not an error", async () => {
    const { ctx } = ctxWithRunBinary(() => completedResult("", 1));
    const output = await searchWithTgrep(baseInput({ output_mode: "files_with_matches" }), ctx, "tgrep", "/repo", true);
    expect(output?.mode).toBe("files_with_matches");
    expect(output?.files).toEqual([]);
    expect(output?.totalMatches).toBe(0);
  });

  it("exit 2 (tgrep error: bad regex / daemon refused) → undefined, never a partial result", async () => {
    const { ctx } = ctxWithRunBinary(() => completedResult("regex parse error", 2));
    await expect(searchWithTgrep(baseInput(), ctx, "tgrep", "/repo", true)).resolves.toBeUndefined();
  });

  it("timed_out → undefined", async () => {
    const { ctx } = ctxWithRunBinary(() => statusResult("timed_out"));
    await expect(searchWithTgrep(baseInput(), ctx, "tgrep", "/repo", true)).resolves.toBeUndefined();
  });

  it("cancelled → undefined", async () => {
    const { ctx } = ctxWithRunBinary(() => statusResult("cancelled"));
    await expect(searchWithTgrep(baseInput(), ctx, "tgrep", "/repo", true)).resolves.toBeUndefined();
  });

  it("spawn_error → undefined", async () => {
    const { ctx } = ctxWithRunBinary(() => statusResult("spawn_error"));
    await expect(searchWithTgrep(baseInput(), ctx, "tgrep", "/repo", true)).resolves.toBeUndefined();
  });

  it("runBinary throwing → undefined (never throws past the boundary)", async () => {
    const { ctx } = ctxWithRunBinary(() => {
      throw new Error("port failure");
    });
    await expect(searchWithTgrep(baseInput(), ctx, "tgrep", "/repo", true)).resolves.toBeUndefined();
  });

  it("returns undefined when ExecutionPort.runBinary is unavailable", async () => {
    const ctx = {
      toolCallId: "t1",
      abortSignal: new AbortController().signal,
      cwd: "/repo",
      ports: { fs: {}, exec: { run: vi.fn() }, http: {}, todos: {} },
    } as unknown as ToolContext;
    await expect(searchWithTgrep(baseInput(), ctx, "tgrep", "/repo", true)).resolves.toBeUndefined();
  });
});

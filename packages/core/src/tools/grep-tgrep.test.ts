/**
 * Unit tests for the tgrep Grep tier (Taskana 4160 + follow-up: zero-match
 * re-check, cached/abortable probe, absolute-path resolution). Fully
 * hermetic: the exec port is a stub recording every runBinary call and
 * answering canned ExecResults — no tgrep binary, no daemon, no rg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BinaryExecRequest, ExecResult } from "../ports/execution.js";
import type { ToolContext } from "../types/tools.js";
import type { GrepInput } from "./schemas.js";
import {
  __resetTgrepPathCacheForTests,
  resolveTgrepPath,
  searchWithTgrep,
  tgrepPathCandidates,
} from "./grep-tgrep.js";

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

describe("tgrepPathCandidates (absolute PATH resolution, Taskana 4160 follow-up)", () => {
  it("POSIX: joins tgrep onto every PATH entry with ':' separator", () => {
    expect(tgrepPathCandidates({ PATH: "/usr/local/bin:/usr/bin" }, "darwin")).toEqual([
      "/usr/local/bin/tgrep",
      "/usr/bin/tgrep",
    ]);
  });

  it("Windows: ';' separator and tgrep.exe, joined with win32 semantics", () => {
    expect(tgrepPathCandidates({ PATH: "C:\\tools;D:\\bin" }, "win32")).toEqual([
      "C:\\tools\\tgrep.exe",
      "D:\\bin\\tgrep.exe",
    ]);
  });

  it("ANYCODE_TGREP_BIN is the single candidate, verbatim", () => {
    expect(tgrepPathCandidates({ ANYCODE_TGREP_BIN: "/opt/tgrep/bin/tgrep", PATH: "/usr/bin" }, "darwin")).toEqual([
      "/opt/tgrep/bin/tgrep",
    ]);
  });

  it("empty PATH and no override → no candidates (bare tgrep name is never used)", () => {
    expect(tgrepPathCandidates({}, "darwin")).toEqual([]);
    expect(tgrepPathCandidates({ PATH: "  " }, "win32")).toEqual([]);
  });
});

describe("resolveTgrepPath (Taskana 4160 follow-up: probe, cache, abort, refusal)", () => {
  beforeEach(() => __resetTgrepPathCacheForTests());
  afterEach(() => __resetTgrepPathCacheForTests());

  it("probes the first PATH candidate with --version and returns it on exit 0", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/local/bin:/usr/bin" })).resolves.toBe(
      "/usr/local/bin/tgrep",
    );
    expect(runBinary).toHaveBeenCalledTimes(1);
    expect(runBinary).toHaveBeenCalledWith(
      expect.objectContaining({ file: "/usr/local/bin/tgrep", args: ["--version"], timeoutMs: 5_000 }),
    );
  });

  it("walks PATH entries until one probes ok", async () => {
    const { ctx, runBinary } = ctxWithRunBinary((req) =>
      req.file === "/usr/bin/tgrep" ? completedResult("tgrep 0.1.0") : completedResult("", 1),
    );
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/local/bin:/usr/bin" })).resolves.toBe("/usr/bin/tgrep");
    expect(runBinary).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when --version exits non-zero everywhere", async () => {
    const { ctx } = ctxWithRunBinary(() => completedResult("", 3));
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBeUndefined();
  });

  it("returns undefined on spawn_error", async () => {
    const { ctx } = ctxWithRunBinary(() => statusResult("spawn_error"));
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBeUndefined();
  });

  it("returns undefined when runBinary throws", async () => {
    const { ctx } = ctxWithRunBinary(() => {
      throw new Error("exec port exploded");
    });
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBeUndefined();
  });

  it("explicitBin wins and is validated by --version (fail → undefined)", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    await expect(resolveTgrepPath(ctx.ports.exec, { ANYCODE_TGREP_BIN: "/opt/tgrep/bin/tgrep" })).resolves.toBe(
      "/opt/tgrep/bin/tgrep",
    );
    expect(runBinary).toHaveBeenCalledWith(
      expect.objectContaining({ file: "/opt/tgrep/bin/tgrep", args: ["--version"] }),
    );

    const { ctx: failCtx } = ctxWithRunBinary(() => completedResult("", 127));
    __resetTgrepPathCacheForTests(); // the success above is cached per-path; the failure half needs a fresh probe
    await expect(resolveTgrepPath(failCtx.ports.exec, { ANYCODE_TGREP_BIN: "/opt/tgrep/bin/tgrep" })).resolves.toBeUndefined();
  });

  it("returns undefined when runBinary is not available on the port", async () => {
    const exec = { run: vi.fn() } as ToolContext["ports"]["exec"];
    await expect(resolveTgrepPath(exec, { PATH: "/usr/bin" })).resolves.toBeUndefined();
  });

  it("refuses a non-absolute binary path — never probes it (cwd-hijack guard)", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    // bare name override: candidate exists but is not absolute → refused, no spawn
    await expect(resolveTgrepPath(ctx.ports.exec, { ANYCODE_TGREP_BIN: "tgrep" })).resolves.toBeUndefined();
    // ...and it does NOT leak into a PATH lookup either (single verbatim candidate)
    expect(runBinary).not.toHaveBeenCalled();

    // relative override — same refusal
    await expect(resolveTgrepPath(ctx.ports.exec, { ANYCODE_TGREP_BIN: "./tgrep" })).resolves.toBeUndefined();
    expect(runBinary).not.toHaveBeenCalled();
  });

  it("a RELATIVE PATH entry yields a non-absolute candidate that is skipped without probing", async () => {
    const { ctx, runBinary } = ctxWithRunBinary((req) =>
      req.file === "/abs/tgrep" ? completedResult("tgrep 0.1.0") : completedResult("nope", 1),
    );
    // relative entry first — the joined candidate "./tgrep/tgrep" must never be spawned;
    // the absolute entry behind it serves the probe
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "relative/dir:/abs" }, { platform: "darwin" })).resolves.toBe("/abs/tgrep");
    for (const call of runBinary.mock.calls) {
      const req = call[0] as BinaryExecRequest;
      expect(req.file).not.toContain("relative/dir");
    }
  });

  it("a successful probe is cached per binary path for the process lifetime", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBe("/usr/bin/tgrep");
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBe("/usr/bin/tgrep");
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBe("/usr/bin/tgrep");
    expect(runBinary).toHaveBeenCalledTimes(1); // probes only once
  });

  it("a FAILED probe is not cached — the next call re-probes", async () => {
    let n = 0;
    const { ctx, runBinary } = ctxWithRunBinary(() => (n++ === 0 ? completedResult("", 3) : completedResult("tgrep 0.1.0")));
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBeUndefined();
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBe("/usr/bin/tgrep");
    expect(runBinary).toHaveBeenCalledTimes(2); // re-probed after the failure
  });

  it("the probe receives the call's abort signal", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    const controller = new AbortController();
    await resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" }, { abortSignal: controller.signal });
    expect(runBinary).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: controller.signal }));
  });

  it("an aborted probe resolves undefined and is NOT cached — the next call re-probes", async () => {
    let n = 0;
    const { ctx, runBinary } = ctxWithRunBinary(() => (n++ === 0 ? statusResult("cancelled") : completedResult("tgrep 0.1.0")));
    const controller = new AbortController();
    controller.abort();
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" }, { abortSignal: controller.signal })).resolves.toBeUndefined();
    await expect(resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" })).resolves.toBe("/usr/bin/tgrep");
    expect(runBinary).toHaveBeenCalledTimes(2);
  });

  it("the probe honours its own short timeout budget, not the tool timeout", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => completedResult("tgrep 0.1.0"));
    await resolveTgrepPath(ctx.ports.exec, { PATH: "/usr/bin" });
    const req = runBinary.mock.calls[0]?.[0] as BinaryExecRequest;
    expect(req.timeoutMs).toBe(5_000);
    expect(req.timeoutMs).not.toBe(120_000);
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

  it("exit 1 (no matches) → EMPTY output (the rg re-check happens one level up, in grep.ts)", async () => {
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

describe("searchWithTgrep — capped stdout is never a final answer (Taskana 4160 cross-review F1)", () => {
  it("exit 0 but stdoutTruncated → undefined, even with non-empty NDJSON (a trimmed answer must not be returned)", async () => {
    const { ctx } = ctxWithRunBinary(() => ({ ...completedResult(ndjson), stdoutTruncated: true }));
    await expect(searchWithTgrep(baseInput({ output_mode: "count" }), ctx, "tgrep", "/repo", true)).resolves.toBeUndefined();
  });
});

describe("searchWithTgrep — repeated search timeouts stop the tier (Taskana 4160 cross-review F2)", () => {
  beforeEach(() => __resetTgrepPathCacheForTests());
  afterEach(() => __resetTgrepPathCacheForTests());

  it("after two consecutive search timeouts the binary is not spawned again (no 2-minute tax per Grep call)", async () => {
    const { ctx, runBinary } = ctxWithRunBinary(() => statusResult("timed_out"));
    await expect(searchWithTgrep(baseInput(), ctx, "/usr/bin/tgrep", "/repo", true)).resolves.toBeUndefined();
    await expect(searchWithTgrep(baseInput(), ctx, "/usr/bin/tgrep", "/repo", true)).resolves.toBeUndefined();
    expect(runBinary).toHaveBeenCalledTimes(2);

    await expect(searchWithTgrep(baseInput(), ctx, "/usr/bin/tgrep", "/repo", true)).resolves.toBeUndefined();
    expect(runBinary).toHaveBeenCalledTimes(2); // suspended: the third call never spawns tgrep
  });

  it("a completed search between timeouts resets the count (isolated timeouts do not suspend the tier)", async () => {
    let n = 0;
    const { ctx, runBinary } = ctxWithRunBinary(() => (n++ % 2 === 0 ? statusResult("timed_out") : completedResult(ndjson)));
    await searchWithTgrep(baseInput(), ctx, "/usr/bin/tgrep", "/repo", true); // timeout
    await expect(searchWithTgrep(baseInput(), ctx, "/usr/bin/tgrep", "/repo", true)).resolves.toBeDefined(); // success
    await searchWithTgrep(baseInput(), ctx, "/usr/bin/tgrep", "/repo", true); // timeout again, count restarted
    await searchWithTgrep(baseInput(), ctx, "/usr/bin/tgrep", "/repo", true); // success
    expect(runBinary).toHaveBeenCalledTimes(4); // nothing suspended
  });
});

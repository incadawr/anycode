/**
 * hook-config: loadHookConfigs (merge user < project, both run; malformed
 * JSON/schema -> descriptive error, no registration) and createCommandHook
 * (stdin payload + metadata env delivery, stdout-JSON parse,
 * non-zero-exit-PreToolUse = deny, fail-open observers, timeout wiring) over
 * a fake FileSystemPort/ExecutionPort.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOOK_STDOUT_CAP_BYTES,
  createCommandHook,
  loadHookConfigs,
  type CommandHookDeclaration,
} from "./hook-config.js";
import { DEFAULT_HOOK_TIMEOUT_MS } from "../types/config.js";
import type { ExecRequest, ExecResult, ExecutionPort, FileSystemPort } from "../ports/index.js";
import type {
  HookRegistration,
  PostToolUseHook,
  PostToolUseHookInput,
  PreToolUseHook,
  PreToolUseHookInput,
  StopHook,
  StopHookInput,
  SubagentStopHook,
  SubagentStopHookInput,
  UserPromptSubmitHook,
  UserPromptSubmitHookInput,
} from "../types/hooks.js";
import type { ToolCallOutcome } from "../types/tools.js";

const CWD = "/proj";

// ---------------------------------------------------------------------------
// Fakes

function makeFs(files: Record<string, string>): FileSystemPort {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => path in files,
    mkdir: async () => {},
    readdir: async () => [],
  };
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  };
}

function makeExec(
  respond: ExecResult | ((request: ExecRequest) => ExecResult),
): { port: ExecutionPort; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  const port: ExecutionPort = {
    run: async (request) => {
      calls.push(request);
      return typeof respond === "function" ? respond(request) : respond;
    },
  };
  return { port, calls };
}

// Typed extractors: createCommandHook returns the HookRegistration union.
function preHookOf(reg: HookRegistration): PreToolUseHook {
  return reg.hook as PreToolUseHook;
}
function postHookOf(reg: HookRegistration): PostToolUseHook {
  return reg.hook as PostToolUseHook;
}
function upsHookOf(reg: HookRegistration): UserPromptSubmitHook {
  return reg.hook as UserPromptSubmitHook;
}
function stopHookOf(reg: HookRegistration): StopHook {
  return reg.hook as StopHook;
}
function subagentStopHookOf(reg: HookRegistration): SubagentStopHook {
  return reg.hook as SubagentStopHook;
}

function preInput(toolName = "Write"): PreToolUseHookInput {
  return { toolCallId: "call-1", toolName, input: { path: "a.txt" } };
}
function postInput(toolName = "Bash"): PostToolUseHookInput {
  const outcome: ToolCallOutcome = {
    toolCallId: "call-1",
    toolName,
    status: "success",
    modelText: "ok",
    durationMs: 1,
  };
  return { toolCallId: "call-1", toolName, input: {}, outcome };
}
function upsInput(prompt = "hello"): UserPromptSubmitHookInput {
  return { prompt };
}
function stopInput(): StopHookInput {
  return { reason: "completed", turns: 2 };
}
function subagentStopInput(agentType = "explore"): SubagentStopHookInput {
  return { agentType, description: "task", status: "completed", turns: 2, toolCalls: 3, durationMs: 42 };
}

const freshSignal = (): AbortSignal => new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// loadHookConfigs

describe("loadHookConfigs", () => {
  it("returns nothing when neither config file exists", async () => {
    const decls = await loadHookConfigs(makeFs({}), CWD, "/home/u");
    expect(decls).toEqual([]);
  });

  it("loads and flattens the project config, tagging each entry with its event", async () => {
    const fs = makeFs({
      "/proj/.anycode/config.json": JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Write|Edit", command: "guard", timeoutMs: 5000 }],
          PostToolUse: [{ matcher: "Bash", command: "audit" }],
        },
      }),
    });
    const decls = await loadHookConfigs(fs, CWD, "/home/u");
    expect(decls).toEqual([
      { event: "PreToolUse", matcher: "Write|Edit", command: "guard", timeoutMs: 5000 },
      { event: "PostToolUse", matcher: "Bash", command: "audit" },
    ]);
  });

  it("merges user and project configs with user entries first, both executing", async () => {
    const fs = makeFs({
      "/home/u/.anycode/config.json": JSON.stringify({
        hooks: { PreToolUse: [{ command: "user-guard" }] },
      }),
      "/proj/.anycode/config.json": JSON.stringify({
        hooks: { PreToolUse: [{ command: "project-guard" }] },
      }),
    });
    const decls = await loadHookConfigs(fs, CWD, "/home/u");
    expect(decls.map((d) => d.command)).toEqual(["user-guard", "project-guard"]);
  });

  it("does not double-load when workspace and homedir resolve to the same path", async () => {
    const fs = makeFs({
      "/home/u/.anycode/config.json": JSON.stringify({
        hooks: { Stop: [{ command: "once" }] },
      }),
    });
    const decls = await loadHookConfigs(fs, "/home/u", "/home/u");
    expect(decls).toEqual([{ event: "Stop", command: "once" }]);
  });

  it("tolerates a trailing separator on the base directory", async () => {
    const fs = makeFs({
      "/proj/.anycode/config.json": JSON.stringify({ hooks: { Stop: [{ command: "s" }] } }),
    });
    const decls = await loadHookConfigs(fs, "/proj/", "/home/u/");
    expect(decls).toEqual([{ event: "Stop", command: "s" }]);
  });

  it("rejects with a descriptive error naming the file on malformed JSON", async () => {
    const fs = makeFs({ "/proj/.anycode/config.json": "{ not json" });
    await expect(loadHookConfigs(fs, CWD, "/home/u")).rejects.toThrow(
      /Invalid JSON in hook config \/proj\/\.anycode\/config\.json/,
    );
  });

  it("rejects with a descriptive error on a schema violation (missing command)", async () => {
    const fs = makeFs({
      "/proj/.anycode/config.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "X" }] } }),
    });
    await expect(loadHookConfigs(fs, CWD, "/home/u")).rejects.toThrow(
      /Invalid hook config \/proj\/\.anycode\/config\.json/,
    );
  });

  it("rejects an unknown event key (schema enum)", async () => {
    const fs = makeFs({
      "/proj/.anycode/config.json": JSON.stringify({ hooks: { Bogus: [{ command: "x" }] } }),
    });
    await expect(loadHookConfigs(fs, CWD, "/home/u")).rejects.toThrow(/Invalid hook config/);
  });

  it("treats a config with no hooks section as empty", async () => {
    const fs = makeFs({ "/proj/.anycode/config.json": JSON.stringify({}) });
    expect(await loadHookConfigs(fs, CWD, "/home/u")).toEqual([]);
  });

  it("flattens a SubagentStop declaration (accepted by the schema enum)", async () => {
    const fs = makeFs({
      "/proj/.anycode/config.json": JSON.stringify({
        hooks: { SubagentStop: [{ matcher: "explore", command: "notify" }] },
      }),
    });
    const decls = await loadHookConfigs(fs, CWD, "/home/u");
    expect(decls).toEqual([{ event: "SubagentStop", matcher: "explore", command: "notify" }]);
  });
});

// ---------------------------------------------------------------------------
// createCommandHook — registration shape

describe("createCommandHook — registration", () => {
  it("compiles the matcher string into a RegExp for PreToolUse", () => {
    const { port } = makeExec(execResult());
    const decl: CommandHookDeclaration = { event: "PreToolUse", matcher: "Write|Edit", command: "g" };
    const reg = createCommandHook(port, decl, CWD);
    expect(reg.event).toBe("PreToolUse");
    expect((reg as { matcher?: RegExp }).matcher).toBeInstanceOf(RegExp);
    expect((reg as { matcher?: RegExp }).matcher?.test("Write")).toBe(true);
    expect((reg as { matcher?: RegExp }).matcher?.test("Read")).toBe(false);
  });

  it("leaves the matcher undefined when none is declared", () => {
    const { port } = makeExec(execResult());
    const reg = createCommandHook(port, { event: "PostToolUse", command: "g" }, CWD);
    expect((reg as { matcher?: RegExp }).matcher).toBeUndefined();
  });

  it("registers a Stop hook without a matcher field", () => {
    const { port } = makeExec(execResult());
    const reg = createCommandHook(port, { event: "Stop", command: "g" }, CWD);
    expect(reg.event).toBe("Stop");
  });

  it("throws on an invalid matcher regex", () => {
    const { port } = makeExec(execResult());
    expect(() => createCommandHook(port, { event: "PreToolUse", matcher: "(", command: "g" }, CWD)).toThrow(
      /Invalid hook matcher/,
    );
  });
});

// ---------------------------------------------------------------------------
// createCommandHook — execution protocol

describe("createCommandHook — execution protocol", () => {
  it("passes the JSON payload and env vars, caps stdout, forwards the signal", async () => {
    const { port, calls } = makeExec(execResult());
    const decl: CommandHookDeclaration = {
      event: "PreToolUse",
      command: "node guard.mjs",
      timeoutMs: 5000,
    };
    const signal = freshSignal();
    await preHookOf(createCommandHook(port, decl, CWD))(preInput("Write"), signal);

    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.command).toBe("node guard.mjs");
    expect(req.cwd).toBe(CWD);
    expect(req.timeoutMs).toBe(5000);
    expect(req.maxOutputBytes).toBe(HOOK_STDOUT_CAP_BYTES);
    expect(req.abortSignal).toBe(signal);

    expect(req.env?.ANYCODE_HOOK_EVENT).toBe("PreToolUse");
    expect(req.env?.ANYCODE_TOOL_NAME).toBe("Write");
    expect(req.env?.ANYCODE_PROJECT_DIR).toBe(CWD);
    expect(req.env?.ANYCODE_HOOK_PAYLOAD).toBeUndefined();
    const payload = JSON.parse(req.stdin!);
    expect(payload).toEqual({
      event: "PreToolUse",
      toolCallId: "call-1",
      toolName: "Write",
      input: { path: "a.txt" },
    });
  });

  it("defaults the exec timeout to DEFAULT_HOOK_TIMEOUT_MS when unset", async () => {
    const { port, calls } = makeExec(execResult());
    await preHookOf(createCommandHook(port, { event: "PreToolUse", command: "g" }, CWD))(
      preInput(),
      freshSignal(),
    );
    expect(calls[0]!.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// createCommandHook — PreToolUse decision mapping

describe("createCommandHook — PreToolUse decisions", () => {
  it("parses stdout JSON into a permission decision on a clean exit", async () => {
    const { port } = makeExec(
      execResult({ stdout: JSON.stringify({ permissionDecision: "deny", reason: "policy" }) }),
    );
    const result = await preHookOf(createCommandHook(port, { event: "PreToolUse", command: "g" }, CWD))(
      preInput(),
      freshSignal(),
    );
    expect(result).toEqual({ permissionDecision: "deny", reason: "policy" });
  });

  it("passes updatedInput through", async () => {
    const { port } = makeExec(
      execResult({ stdout: JSON.stringify({ updatedInput: { path: "safe.txt" } }) }),
    );
    const result = await preHookOf(createCommandHook(port, { event: "PreToolUse", command: "g" }, CWD))(
      preInput(),
      freshSignal(),
    );
    expect(result).toEqual({ updatedInput: { path: "safe.txt" } });
  });

  it("denies (fail-closed) on a non-zero exit code", async () => {
    const { port } = makeExec(execResult({ status: "failed", exitCode: 2, stderr: "blocked" }));
    const result = await preHookOf(createCommandHook(port, { event: "PreToolUse", command: "g" }, CWD))(
      preInput(),
      freshSignal(),
    );
    expect(result?.permissionDecision).toBe("deny");
    expect(result?.reason).toMatch(/exit code 2/);
    expect(result?.reason).toMatch(/blocked/);
  });

  it("denies (fail-closed) when the command times out", async () => {
    const { port } = makeExec(execResult({ status: "timed_out", exitCode: null }));
    const result = await preHookOf(createCommandHook(port, { event: "PreToolUse", command: "g" }, CWD))(
      preInput(),
      freshSignal(),
    );
    expect(result?.permissionDecision).toBe("deny");
    expect(result?.reason).toMatch(/timed_out/);
  });

  it("returns no opinion on a clean exit with empty stdout", async () => {
    const { port } = makeExec(execResult({ stdout: "  \n" }));
    const result = await preHookOf(createCommandHook(port, { event: "PreToolUse", command: "g" }, CWD))(
      preInput(),
      freshSignal(),
    );
    expect(result).toBeUndefined();
  });

  it("warns and returns no opinion on a clean exit with non-JSON stdout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { port } = makeExec(execResult({ stdout: "not json at all" }));
    const result = await preHookOf(createCommandHook(port, { event: "PreToolUse", command: "g" }, CWD))(
      preInput(),
      freshSignal(),
    );
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createCommandHook — observers & UserPromptSubmit (fail-open)

describe("createCommandHook — observers and UserPromptSubmit", () => {
  it("returns void for a clean PostToolUse observer and includes the outcome in the payload", async () => {
    const { port, calls } = makeExec(execResult());
    const hook = postHookOf(createCommandHook(port, { event: "PostToolUse", command: "g" }, CWD));
    await expect(hook(postInput("Bash"), freshSignal())).resolves.toBeUndefined();
    const payload = JSON.parse(calls[0]!.stdin!);
    expect(payload.event).toBe("PostToolUse");
    expect(payload.outcome.status).toBe("success");
  });

  it("is fail-open: a failing observer warns but still resolves void", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { port } = makeExec(execResult({ status: "failed", exitCode: 1, stderr: "oops" }));
    const hook = postHookOf(
      createCommandHook(port, { event: "PostToolUseFailure", command: "g" }, CWD),
    );
    await expect(hook(postInput("Bash"), freshSignal())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/PostToolUseFailure command hook/);
  });

  it("sets an empty ANYCODE_TOOL_NAME for events without a tool", async () => {
    const { port, calls } = makeExec(execResult());
    await stopHookOf(createCommandHook(port, { event: "Stop", command: "g" }, CWD))(
      stopInput(),
      freshSignal(),
    );
    expect(calls[0]!.env?.ANYCODE_TOOL_NAME).toBe("");
    const payload = JSON.parse(calls[0]!.stdin!);
    expect(payload).toEqual({ event: "Stop", reason: "completed", turns: 2 });
  });

  it("delivers agentType as ANYCODE_TOOL_NAME and the full input on stdin for SubagentStop", async () => {
    const { port, calls } = makeExec(execResult());
    const reg = createCommandHook(port, { event: "SubagentStop", command: "g" }, CWD);
    expect(reg.event).toBe("SubagentStop");
    await subagentStopHookOf(reg)(subagentStopInput("explore"), freshSignal());
    expect(calls[0]!.env?.ANYCODE_HOOK_EVENT).toBe("SubagentStop");
    expect(calls[0]!.env?.ANYCODE_TOOL_NAME).toBe("explore");
    const payload = JSON.parse(calls[0]!.stdin!);
    expect(payload).toEqual({
      event: "SubagentStop",
      agentType: "explore",
      description: "task",
      status: "completed",
      turns: 2,
      toolCalls: 3,
      durationMs: 42,
    });
  });

  it("compiles a matcher tested against agentType for SubagentStop", () => {
    const { port } = makeExec(execResult());
    const reg = createCommandHook(
      port,
      { event: "SubagentStop", matcher: "explore", command: "g" },
      CWD,
    );
    expect((reg as { matcher?: RegExp }).matcher?.test("explore")).toBe(true);
    expect((reg as { matcher?: RegExp }).matcher?.test("general-purpose")).toBe(false);
  });

  it("is fail-open: a failing SubagentStop observer warns but still resolves void", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { port } = makeExec(execResult({ status: "failed", exitCode: 1, stderr: "oops" }));
    const hook = subagentStopHookOf(
      createCommandHook(port, { event: "SubagentStop", command: "g" }, CWD),
    );
    await expect(hook(subagentStopInput(), freshSignal())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/SubagentStop command hook/);
  });

  it("returns trimmed stdout as additionalContext for UserPromptSubmit", async () => {
    const { port } = makeExec(execResult({ stdout: "  extra context  \n" }));
    const result = await upsHookOf(
      createCommandHook(port, { event: "UserPromptSubmit", command: "g" }, CWD),
    )(upsInput(), freshSignal());
    expect(result).toEqual({ additionalContext: "extra context" });
  });

  it("is fail-open for UserPromptSubmit: a failing command yields no context", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { port } = makeExec(execResult({ status: "failed", exitCode: 3 }));
    const result = await upsHookOf(
      createCommandHook(port, { event: "UserPromptSubmit", command: "g" }, CWD),
    )(upsInput(), freshSignal());
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

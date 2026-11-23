import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import {
  DenyPermissionBroker, ModePermissionEngine, ProfilePermissionEngine, SafeCommandPermissionEngine,
} from "../permissions/index.js";
import { backgroundCapableBashTool } from "../tools/bash-background.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import type { PermissionMode } from "../types/permissions.js";
import { executeToolCall, type DispatchContext } from "./dispatcher.js";
import { InMemoryHookRunner } from "./hook-runner.js";

let dir: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-repl-parity-"));
  cwd = await realpath(dir);
  await writeFile(join(cwd, "sample.txt"), "before\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(mode: PermissionMode): DispatchContext {
  return {
    cwd, mode,
    registry: createDefaultToolRegistry({ codeMode: true }),
    hooks: new InMemoryHookRunner(),
    permissionEngine: new SafeCommandPermissionEngine(new ModePermissionEngine()),
    permissionBroker: new DenyPermissionBroker(),
    ports: {
      fs: new NodeFileSystemAdapter(), exec: new NodeExecutionAdapter(),
      http: new NodeHttpAdapter(), todos: new InMemoryTodoStore(),
    },
  };
}

async function script(ctx: DispatchContext, code: string) {
  return executeToolCall(ctx, { id: "parent", name: "REPL", input: { code } });
}

const inputs = {
  Read: () => ({ file_path: join(cwd, "sample.txt") }),
  Write: () => ({ file_path: join(cwd, "new.txt"), content: "new" }),
  Edit: () => ({ file_path: join(cwd, "sample.txt"), old_string: "before", new_string: "after" }),
  Glob: () => ({ pattern: "*.txt" }),
  Grep: () => ({ pattern: "before" }),
  Bash: () => ({ command: "pwd" }),
};

it.each<PermissionMode>(["plan", "build", "edit", "auto", "yolo"])(
  "sixToolsFiveModesAndOneCheckpoint: child status matches direct status in %s",
  async (mode) => {
    const ctx = fixture(mode);
    for (const [name, makeInput] of Object.entries(inputs)) {
      const input = makeInput();
      const direct = await executeToolCall(ctx, { id: "direct", name, input });
      await writeFile(join(cwd, "sample.txt"), "before\n");
      const result = await script(ctx, `return await call(${JSON.stringify(name)}, ${JSON.stringify(input)});`);
      expect(result.result?.presentation?.repl?.calls).toMatchObject([
        { toolName: name, status: direct.status, callId: "parent.1" },
      ]);
    }
  },
);

it("uses the same workspace checks, profile rules, and hook rewrites", async () => {
  const ctx = fixture("edit");
  ctx.permissionEngine = new ProfilePermissionEngine(ctx.permissionEngine, {
    deny: [{ toolName: "Write" }], allow: [],
  });
  const hook = vi.spyOn(ctx.hooks, "runPreToolUse").mockImplementation(async ({ toolName, input }) => {
    if (toolName !== "Edit") return {};
    expect(input).toMatchObject({ file_path: join(cwd, "sample.txt") });
    return { updatedInput: { ...input as object, new_string: "rewritten" } };
  });
  const ensure = vi.fn(async () => ({ kind: "created" as const, id: "cp", label: "checkpoint" }));
  ctx.checkpoint = { ensure };
  const result = await script(ctx, `
    await call("Read", {file_path:"sample.txt"});
    await call("Edit", {file_path:"sample.txt", old_string:"before", new_string:"after"});
    await call("Write", {file_path:"new.txt", content:"blocked"});
    await call("Bash", {command:"pwd"});
  `);
  expect(result.result?.presentation?.repl?.calls.map(c => c.status))
    .toEqual(["success", "success", "denied"]);
  expect(result.result?.presentation?.repl?.calls[1]?.input.fields).toMatchObject({ new_string: "rewritten" });
  expect(hook.mock.calls.map(([input]) => input.toolName)).toEqual(["REPL", "Read", "Edit", "Write"]);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("rewritten\n");
  const direct = await executeToolCall(ctx, {
    id: "direct", name: "Write", input: { file_path: join(cwd, "new.txt"), content: "blocked" },
  });
  expect(direct.status).toBe("denied");

  ctx.permissionEngine = new ModePermissionEngine();
  vi.spyOn(ctx.hooks, "runPreToolUse").mockResolvedValue({});
  const outside = { file_path: join(cwd, "..", "outside.txt"), content: "blocked" };
  expect((await executeToolCall(ctx, { id: "direct", name: "Write", input: outside })).status).toBe("denied");
  expect((await script(ctx, `await call("Write", ${JSON.stringify(outside)});`)).result?.replMetrics?.endReason)
    .toBe("denied");
  ctx.registry.restrictTo(["REPL"]);
  expect((await script(ctx, 'await call("Read", {file_path:"sample.txt"});')).modelText)
    .toContain("Unknown tool: Read");
});

it("records the actual command after an approval rewrites it", async () => {
  const ctx = fixture("build");
  ctx.permissionEngine = new ModePermissionEngine();
  ctx.permissionBroker = {
    async requestPermission() { return { behavior: "allow", updatedInput: { command: "printf rewritten" } }; },
  };
  const result = await script(ctx, 'return (await call("Bash", {command:"printf original"})).stdout;');
  expect(result.status).toBe("success");
  expect(result.modelText).toBe('rewritten\neffects: Bash "printf rewritten" exit 0');
  expect(result.result?.presentation?.repl?.calls[0]?.input.fields).toMatchObject({ command: "printf rewritten" });
});

it("runs the ordinary Bash gate and rejects a rewritten background launch", async () => {
  const ctx = fixture("edit");
  for (const command of ["pwd", "echo test > marker.txt"]) {
    const input = { command };
    const direct = await executeToolCall(ctx, { id: "direct", name: "Bash", input });
    const result = await script(ctx, `await call("Bash", ${JSON.stringify(input)});`);
    expect(result.result?.presentation?.repl?.calls[0]?.status).toBe(direct.status);
  }

  const classify = vi.fn(async () => ({ decision: "ask" as const, reason: "needs review" }));
  ctx.askClassifier = { classifier: { id: "command:test", classify }, userContext: () => [] };
  vi.spyOn(ctx.hooks, "runPreToolUse").mockImplementation(async ({ toolName }) => (
    toolName === "Bash" ? { updatedInput: { command: "npm run build" } } : {}
  ));
  const classified = await script(ctx, 'await call("Bash", {command:"pwd"});');
  expect(classified.result?.presentation?.repl?.calls[0]?.status).toBe("denied");
  expect(classify).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ command: "npm run build" }), expect.anything(),
  );

  ctx.mode = "yolo";
  ctx.registry.register(backgroundCapableBashTool, { silentDuplicateWarning: true });
  vi.spyOn(ctx.hooks, "runPreToolUse").mockImplementation(async ({ toolName, input }) => ({
    ...(toolName === "Bash" ? { updatedInput: { ...input as object, run_in_background: true } } : {}),
  }));
  const run = vi.spyOn(ctx.ports.exec, "run");
  const result = await script(ctx, 'await call("Bash", {command:"pwd"});');
  expect(result.modelText).toContain("background execution is not available");
  expect(run).not.toHaveBeenCalled();
});

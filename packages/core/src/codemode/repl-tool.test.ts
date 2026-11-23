import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { expect, it, vi } from "vitest";
import { executeToolCall, type DispatchContext } from "../dispatch/dispatcher.js";
import { InMemoryHookRunner } from "../dispatch/hook-runner.js";
import { DenyPermissionBroker, ModePermissionEngine } from "../permissions/index.js";
import { editTool } from "../tools/edit.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCallOutcome, ToolContext } from "../types/tools.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { effectPath, replTool } from "./repl-tool.js";

// Short absolute path (with a space): the card truncates long paths, so a deep checkout must not change expectations.
const cwd = resolve("/code mode ws");

function context(dispatchNested?: ToolContext["dispatchNested"]): ToolContext {
  return {
    toolCallId: "repl", cwd, dispatchNested, abortSignal: new AbortController().signal,
    // The bridge delegates all host I/O.
    ports: {} as ToolContext["ports"],
  };
}

function success(call: { id: string; name: string }, output: unknown): ToolCallOutcome {
  return { toolCallId: call.id, toolName: call.name, status: "success", result: { ok: true, output }, modelText: "formatted", durationMs: 1 };
}

it("sixNamesFifoAndCatch", async () => {
  const dispatch = vi.fn<NonNullable<ToolContext["dispatchNested"]>>(async (call) => {
    if (call.name === "Read") {
      return { ...success(call, undefined), status: "error", modelText: "read failed" };
    }
    return success(call, call.name === "Bash" ? { exitCode: 1 } : {});
  });
  const result = await replTool.handler({ code: `
    let error;
    try { await call("Read", {file_path: "a file.txt"}); }
    catch (e) { error = [e.tool, e.status, e.message].join(":"); }
    const outcomes = await Promise.all([
      call("Write", {file_path: "./a file.txt", content: "new"}),
      call("Edit", {file_path: "a file.txt", old_string: "old", new_string: "new"}),
      call("Glob", {pattern: "*", path: "."}),
      call("Grep", {pattern: "text", path: "."}),
      call("Bash", {command: "exit 1"}),
    ]);
    return error + ":" + outcomes.at(-1).exitCode;
  ` }, context(dispatch));
  expect(result).toMatchObject({
    ok: true, output: { text: expect.stringMatching(/^Read:error:read failed:1/) },
    replMetrics: { nestedCalls: 6, nestedByTool: { Read: 1, Write: 1, Edit: 1, Glob: 1, Grep: 1, Bash: 1 } },
  });
  expect(dispatch.mock.calls.map(([call]) => [call.id, call.name])).toEqual(
    ["Read", "Write", "Edit", "Glob", "Grep", "Bash"].map((tool, index) => [`repl.${index + 1}`, tool]),
  );
  expect(dispatch.mock.calls.slice(0, 3).map(([call]) => call.input))
    .toEqual([
      { file_path: resolve(cwd, "a file.txt") },
      { file_path: resolve(cwd, "a file.txt"), content: "new" },
      { file_path: resolve(cwd, "a file.txt"), old_string: "old", new_string: "new" },
    ]);
  expect(dispatch.mock.calls[3]?.[0].input).toEqual({ pattern: "*", path: "." });
});

it("rejects unavailable calls before dispatch and does not return rewritten images", async () => {
  const dispatch = vi.fn<NonNullable<ToolContext["dispatchNested"]>>(async (call) => ({
    ...success(call, { contents: "private" }),
    result: {
      ok: true,
      output: { contents: "private" },
      images: [{ mediaType: "image/png", data: "private" }],
    },
  }));
  const result = await replTool.handler({ code: `
    const messages = [];
    for (const [tool, args] of [
      ["Other", {}],
      ["Bash", { command: "echo test", run_in_background: true }],
      ["Read", { file_path: "photo.PNG" }],
      ["Read", { file_path: "rewritten" }],
    ]) {
      try { await call(tool, args); }
      catch (e) { messages.push(e.message); }
    }
    return messages.join("\\n");
  ` }, context(dispatch));
  expect(result.output?.text).toBe([
    "Unknown tool: Other",
    "background Bash is not available from a script",
    "image files are not readable from a script",
    "image files are not readable from a script",
  ].join("\n"));
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    id: "repl.1", name: "Read", input: { file_path: resolve(cwd, "rewritten") },
  });
  expect(await replTool.handler({ code: "return 42;" }, context())).toMatchObject({
    ok: false, error: "error: Code Mode runtime unavailable, use the regular tools",
  });
});

it("ends admission on denial and allows at most 64 calls", async () => {
  const deny = vi.fn<NonNullable<ToolContext["dispatchNested"]>>(async (call) => ({
    ...success(call, undefined), status: "denied", modelText: "permission denied",
  }));
  expect(await replTool.handler({ code: `
    try {
      await Promise.all([call("Read", {}), call("Edit", {})]);
    } catch {
      await call("Write", {});
    }
  ` }, context(deny))).toMatchObject({ ok: false, replMetrics: { endReason: "denied", nestedCalls: 1 } });
  expect(deny).toHaveBeenCalledTimes(1);

  const allow = vi.fn<NonNullable<ToolContext["dispatchNested"]>>(async call => success(call, {}));
  expect(await replTool.handler({ code: `
    for (let i = 0; i < 65; i++) await call("Read", {});
  ` }, context(allow))).toMatchObject({ ok: false, replMetrics: { endReason: "limit", nestedCalls: 64 } });
  expect(allow).toHaveBeenCalledTimes(64);
});

it("modelTextAndBoundedCard", async () => {
  const dispatch: NonNullable<ToolContext["dispatchNested"]> = async call => {
    if (call.name === "Grep") return { ...success(call, {}), modelText: "INTERNAL_SEARCH_RESULT" };
    if (call.name === "Bash") return success(call, { exitCode: 1 });
    const input = call.input as { old_string: string };
    if (input.old_string === "missing") {
      return {
        ...success(call, undefined), status: "error",
        modelText: "Edit failed: old_string not found",
      };
    }
    return success(call, { replacements: 1 });
  };
  const ctx = context(dispatch);
  const emit = vi.fn();
  ctx.emit = emit;
  const run = (code: string) => replTool.handler({ code }, ctx);
  const ok = await run(`await call("Grep", {});
await call("Edit", {file_path:"src/retry.ts", old_string:"3", new_string:"5"});
await call("Bash", {command:"npm test -- retry"});
console.log("failure expected");
return {exitCode: 1};`);
  expect(replTool.formatResultForModel!(ok)).toBe(
    '{\n  "exitCode": 1\n}\nconsole:\nfailure expected\neffects: Edit src/retry.ts (1); Bash "npm test -- retry" exit 1',
  );
  expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
    "repl_call_start", "repl_call_end", "repl_call_start", "repl_call_end",
    "repl_call_start", "repl_call_end",
  ]);
  const failed = await run(`await call("Grep", {});
await call("Edit", {file_path:"src/retry.ts", old_string:"3", new_string:"5"});
await call("Edit", {old_string:"missing"});`);
  expect(failed.error).toBe([
    'error: Edit failed: old_string not found at line 3: await call("Edit", {old_string:"missing"});',
    "calls:",
    " 1 Grep ok",
    ` 2 Edit ${JSON.stringify(resolve(cwd, "src/retry.ts"))} ok`,
    " 3 Edit error   ← threw",
    "effects: Edit src/retry.ts (1)",
  ].join("\n"));
  expect((await run("\`\`\`js\nconsole.log('a');\nlet x = ;\n\`\`\`")).error)
    .toContain("at line 2, column 9: let x = ;\nno calls ran; fix and resend");
  expect((await run("const x =")).error)
    .toContain("at line 1, column 10: const x =\nno calls ran; fix and resend");
  expect((await run("\`\`\`js\r\ncall('Write', {});\r\nreturn (\r\n\`\`\`")).error)
    .toContain("at line 2, column 9: return (\nno calls ran; fix and resend");
  expect((await run("missing()")).error).toContain("available: call, cwd, console.log");
  expect((await run("return 42n")).output?.text).toBe("42 (result was not JSON-serializable)");
  expect((await run("let x = {}; x.self = x; return x;")).output?.text)
    .toBe("[object Object] (result was not JSON-serializable)");
  expect((await run("")).output?.text).toBe("(script returned nothing — use return)");
  expect((await run("call('Read', {}); return 'done';")).output?.text)
    .toBe("done\nnote: 1 calls were not awaited");
  expect((await run("call('Read', {});\nthrow new Error('root failure');")).error)
    .toBe("error: root failure at line 2: throw new Error('root failure');\ncalls:\n 1 Read ok\neffects: none\nnote: 1 calls were not awaited");
  expect((await run("console.log('🙂'.repeat(3000))")).output?.text)
    .toBe("console:\n" + "🙂".repeat(2048));

  const oversized = await run(String.raw`await call("Edit", {
    file_path: "a.txt", old_string: '🙂\n"'.repeat(10000), new_string: "z".repeat(40000)
  });`);
  const child = oversized.presentation?.repl?.calls[0];
  expect(child?.input.truncated).toBe(true);
  expect(child?.input.fields.old_string).toContain("🙂");
  expect(child?.input.fields.new_string).toContain("z");
  expect(Buffer.byteLength(JSON.stringify(child?.input))).toBeLessThanOrEqual(32 * 1024);
});

it("spills the parent text and keeps effects and bounded child previews", async () => {
  const registry = new ToolRegistry();
  registry.register(replTool);
  const childText = "🦉".repeat(10_000);
  registry.register({
    ...editTool,
    handler: async () => ({ ok: true, output: { replacements: 1 }, error: childText }),
    formatResultForModel: () => childText,
  });
  const ctx: DispatchContext = {
    registry, hooks: new InMemoryHookRunner(), permissionEngine: new ModePermissionEngine(),
    permissionBroker: new DenyPermissionBroker(), mode: "yolo", cwd, ports: context().ports,
  };
  const call = {
    id: "repl", name: "REPL",
    input: { code: 'await call("Edit", {file_path:"a.txt",old_string:"a",new_string:"b"}); return "☃".repeat(20000);' },
  };
  const inline = await executeToolCall(ctx, call);
  expect(Buffer.byteLength(inline.modelText)).toBeLessThanOrEqual(32 * 1024);
  expect(inline.modelText).toContain("tool output truncated");
  const writeToolResultArtifact = vi.fn(async () => ({ path: "/artifact", bytes: 60_000 }));
  ctx.artifacts = {
    sessionId: "session",
    store: { writeToolResultArtifact, removeSession: async () => {}, sweepExpired: async () => ({ removed: [] }) },
  };
  const spilled = await executeToolCall(ctx, call);
  expect(writeToolResultArtifact).toHaveBeenCalledTimes(1);
  expect(spilled.modelText).toContain("effects: Edit a.txt (1)");
  const preview = spilled.result?.presentation?.repl?.calls[0]?.outputPreview;
  expect(preview).toBe("🦉".repeat(512));
  expect(spilled.modelText).not.toContain("🦉");
});

it("keeps the applied Edit visible when the guest throws the runtime-unavailable wording", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codemode-effects-"));
  writeFileSync(join(dir, "a.txt"), "old");
  const registry = new ToolRegistry();
  registry.register(replTool);
  registry.register(editTool);
  const ctx: DispatchContext = {
    registry, hooks: new InMemoryHookRunner(), permissionEngine: new ModePermissionEngine(),
    permissionBroker: new DenyPermissionBroker(), mode: "yolo", cwd: dir, ports: {
      fs: new NodeFileSystemAdapter(), exec: new NodeExecutionAdapter(), http: new NodeHttpAdapter(), todos: new InMemoryTodoStore(),
    } as ToolContext["ports"],
  };
  const { RUNTIME_UNAVAILABLE } = await import("./runtime.js");
  const guestThrow = await executeToolCall(ctx, {
    id: "repl", name: "REPL",
    input: { code: `await call("Edit", {file_path:"a.txt",old_string:"old",new_string:"new"}); throw new Error(${JSON.stringify(RUNTIME_UNAVAILABLE)});` },
  });
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new");
  expect(guestThrow.modelText).toMatch(new RegExp(`^error: ${RUNTIME_UNAVAILABLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} at line 1`));
  expect(guestThrow.modelText).toContain("effects: Edit a.txt (1)");
  expect(guestThrow.modelText).not.toBe(RUNTIME_UNAVAILABLE);
});

it.each([
  ["POSIX", posix, "/work", "/work/src/a.txt", "src/a.txt"],
  ["Windows", win32, "C:\\work", "C:\\work\\src\\a.txt", "src/a.txt"],
  ["Windows other drive", win32, "C:\\work", "D:\\data\\a.txt", "D:/data/a.txt"],
])("formats effect paths with forward slashes on %s", (_name, api, cwdPath, file, expected) => {
  expect(effectPath(cwdPath, file, api)).toBe(expected);
});

it("bounds multi-byte input previews on a UTF-8 boundary and matches the live event", async () => {
  const emitted: Array<{ type: string; input?: unknown; callId?: string }> = [];
  const dispatch = vi.fn<NonNullable<ToolContext["dispatchNested"]>>(async call => success(call, {}));
  const ctx = { ...context(dispatch), emit: (event: { type: string; input?: unknown; callId?: string }) => { emitted.push(event); } };
  const result = await replTool.handler({ code: `
    await call("Write", {file_path: "a.txt", content: "🦉".repeat(20000)});
    return "ok";
  ` }, ctx as ToolContext);
  const persisted = result.presentation?.repl?.calls[0];
  expect(persisted).toBeDefined();
  const content = (persisted!.input.fields as Record<string, unknown>).content as string;
  expect(content).not.toContain("\uFFFD");
  expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(32 * 1024);
  expect(Array.from(content).every(char => char === "🦉")).toBe(true);
  expect(persisted!.input.truncated).toBe(true);
  const live = emitted.find(event => event.type === "repl_call_start");
  expect((live?.input as { fields: unknown }).fields).toEqual(persisted!.input.fields);
});

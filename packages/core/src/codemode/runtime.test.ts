import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";

it("singlefileExecutes42", async () => {
  const { Scope, newQuickJSWASMModuleFromVariant } = await import(
    "quickjs-emscripten-core"
  );
  const module = await newQuickJSWASMModuleFromVariant(
    import("@jitl/quickjs-singlefile-mjs-release-sync"),
  );
  using scope = new Scope();
  const runtime = scope.manage(module.newRuntime());
  const vm = scope.manage(runtime.newContext());
  const evaluation = scope.manage(vm.evalCode("6 * 7"));
  expect(vm.getNumber(vm.unwrapResult(evaluation))).toBe(42);
});

it("freshRuntimeAndSyntaxLocation", async () => {
  const { runCodeMode } = await import("./runtime.js");
  expect(await runCodeMode("globalThis.secret = 9; return cwd;", "/example")).toMatchObject({
    endReason: "ok", value: "/example",
  });
  expect(await runCodeMode(`
    const guest = ({}).constructor.constructor("return globalThis")();
    return [typeof guest.secret, typeof guest.process, typeof guest.require,
      typeof guest.fs, typeof guest.fetch, typeof guest.setTimeout].join(",");
  `, "/example")).toMatchObject({
    endReason: "ok", value: "undefined,undefined,undefined,undefined,undefined,undefined",
  });
  expect(await runCodeMode("```js\nconsole.log('effect');\nlet x = ;\n```", "/example"))
    .toMatchObject({ endReason: "syntax", console: "", error: { line: 2, column: 9 } });
  expect(await runCodeMode("console.log('one', 2);\nthrow new Error('boom');", "/example"))
    .toMatchObject({ endReason: "uncaught", console: "one 2", error: { line: 2, message: "boom" } });
  expect((await runCodeMode("}) + (async () => {", "/example")).endReason).toBe("syntax");
  expect((await runCodeMode("import fs from 'node:fs';", "/example")).endReason).toBe("syntax");
  expect(await runCodeMode("await import('node:fs');", "/example")).toMatchObject({
    endReason: "uncaught", error: { name: "ReferenceError" },
  });
  expect((await runCodeMode("return 'é';".repeat(4000), "/example")).endReason).toBe("limit");
});

it("reports unavailable when the lazy import fails", async () => {
  vi.resetModules();
  vi.doMock("@jitl/quickjs-singlefile-mjs-release-sync", () => {
    throw new Error("missing runtime");
  });
  try {
    const { runInQuickJS } = await import("./runtime.js");
    expect(await runInQuickJS("return 42;", "/example")).toMatchObject({
      endReason: "uncaught",
      activeJsMs: 0,
      unavailable: true,
      error: { message: "error: Code Mode runtime unavailable, use the regular tools" },
    });
  } finally {
    vi.doUnmock("@jitl/quickjs-singlefile-mjs-release-sync");
    vi.resetModules();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("asyncDrainAndTerminalLatch", async () => {
  const { runCodeMode } = await import("./runtime.js");
  const dispatch = vi.fn(async (_tool: string, input: unknown) => ({
    status: "ok" as const, output: { input },
  }));
  expect(await runCodeMode(`
    const a = await call("Read", { n: 1 });
    const [b, c] = await Promise.all([
      call("Read", { n: a.input.n + 1 }),
      call("Read", { n: 3 }),
    ]);
    call("Write", { n: c.input.n + 1 });
    call("Write", { n: 5 });
    return b.input.n + c.input.n;
  `, "/example", { dispatch })).toMatchObject({
    endReason: "ok", value: "5", unawaitedCalls: 2,
  });
  expect(dispatch.mock.calls).toEqual([
    ["Read", { n: 1 }], ["Read", { n: 2 }], ["Read", { n: 3 }],
    ["Write", { n: 4 }], ["Write", { n: 5 }],
  ]);
  dispatch.mockClear();
  expect(await runCodeMode("call('Write', {});\nlet x = ;", "/example", { dispatch }))
    .toMatchObject({ endReason: "syntax" });
  expect(dispatch).not.toHaveBeenCalled();

  expect(await runCodeMode("await new Promise(() => {});", "/example")).toMatchObject({
    endReason: "stalled", error: { message: "script is waiting on a promise that never resolves" },
  });

  const deny = vi.fn(async () => ({ status: "denied" as const, message: "blocked" }));
  expect(await runCodeMode(`
    try {
      await Promise.all([call("Read", {}), call("Write", {})]);
    } catch {
      await call("Bash", {});
    }
  `, "/example", { dispatch: deny })).toMatchObject({
    endReason: "denied", error: { message: "blocked" },
  });
  expect(deny.mock.calls).toHaveLength(1);

  const fail = vi.fn(async () => ({ status: "timed_out" as const, message: "tool expired" }));
  expect(await runCodeMode(`
    try { await call("Bash", {}); }
    catch (error) { return [error.tool, error.status, error.message].join(":"); }
  `, "/example", { dispatch: fail })).toMatchObject({
    endReason: "ok", value: "Bash:timed_out:tool expired",
  });

  const controller = new AbortController();
  const started = deferred<void>();
  const lateReply = deferred<{ status: "ok"; output: string }>();
  const waiting = vi.fn(() => {
    started.resolve();
    return lateReply.promise;
  });
  const running = runCodeMode(`
    const first = call("Read", {});
    call("Write", {});
    await first;
  `, "/example", { dispatch: waiting, signal: controller.signal });
  await started.promise;
  controller.abort();
  expect(await running).toMatchObject({ endReason: "cancelled" });
  lateReply.resolve({ status: "ok", output: "too late" });
  expect(await runCodeMode("return 42;", "/example")).toMatchObject({ value: "42" });
  expect(waiting.mock.calls).toHaveLength(1);

  expect(await runCodeMode(`
    for (let n = 0; n < 65; n++) await call("Read", { n });
  `, "/example", { dispatch })).toMatchObject({
    endReason: "limit", error: { message: "script exceeded the limit of 64 calls" },
  });
  expect(dispatch.mock.calls).toHaveLength(64);
});

it("interrupts a guest microtask loop", async () => {
  const { runCodeMode } = await import("./runtime.js");
  expect(await runCodeMode("while (true) await Promise.resolve();", "/example"))
    .toMatchObject({ endReason: "limit" });
});

it("drains the admitted FIFO after a root rejection without resuming guest code", async () => {
  const { runCodeMode } = await import("./runtime.js");
  const script = `
    call("Read", { n: 1 }).then(() => call("Bash", {}));
    call("Write", { n: 2 });
    throw new Error("root failure");
  `;
  const begun = deferred<void>();
  const read = deferred<{ status: "ok"; output: number }>();
  const dispatch = vi.fn(async (tool: string, _input: unknown) => {
    if (tool === "Read") {
      begun.resolve();
      return read.promise;
    }
    return { status: "ok" as const, output: 2 };
  });
  const running = runCodeMode(script, "/example", { dispatch });
  await begun.promise;
  expect(dispatch.mock.calls).toEqual([["Read", { n: 1 }]]);
  read.resolve({ status: "ok", output: 1 });
  expect(await running).toMatchObject({
    endReason: "uncaught", error: { message: "root failure" }, unawaitedCalls: 2,
  });
  expect(dispatch.mock.calls).toEqual([["Read", { n: 1 }], ["Write", { n: 2 }]]);

  const deny = vi.fn(async () => ({ status: "denied" as const, message: "blocked" }));
  expect(await runCodeMode(script, "/example", { dispatch: deny })).toMatchObject({
    endReason: "denied", error: { message: "blocked" },
  });
  expect(deny).toHaveBeenCalledTimes(1);
});

it("closes admission when the root returns, before late continuations can call", async () => {
  const { runCodeMode } = await import("./runtime.js");
  const dispatch = vi.fn(async (tool: string, input: unknown) => ({
    status: "ok" as const, output: { tool, input },
  }));
  expect(await runCodeMode(`
    call("Read", { n: 1 }).then(() => call("Bash", { late: true }));
    call("Write", { n: 2 });
    return "done";
  `, "/example", { dispatch })).toMatchObject({
    endReason: "ok", value: "done", unawaitedCalls: 2,
  });
  expect(dispatch.mock.calls).toEqual([["Read", { n: 1 }], ["Write", { n: 2 }]]);
});

it.each([
  ["new ArrayBuffer(1024 ** 3);", "64 MiB heap"],
  ["const recurse = () => recurse(); recurse();", "1 MiB stack"],
])("treats a caught native resource failure as terminal (%s)", async (exhaust, limit) => {
  const { runCodeMode } = await import("./runtime.js");
  const dispatch = vi.fn(async () => ({ status: "ok" as const, output: 42 }));
  expect(await runCodeMode(`
    call("Read", {});
    try { ${exhaust} }
    catch { await call("Write", {}); return 42; }
  `, "/example", { dispatch })).toMatchObject({
    endReason: "limit", error: { message: `script exceeded the ${limit} limit` },
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(await runCodeMode(`
    await Promise.resolve();
    try { ${exhaust} } catch { return 42; }
  `, "/example")).toMatchObject({ endReason: "limit" });
  expect(await runCodeMode("return 42;", "/example")).toMatchObject({ endReason: "ok", value: "42" });
});

it("reports a thrown null as an ordinary uncaught error, not a resource limit", async () => {
  const { runCodeMode } = await import("./runtime.js");
  expect(await runCodeMode("throw null;", "/example")).toMatchObject({
    endReason: "uncaught", error: { message: "null" },
  });
  expect(await runCodeMode("new ArrayBuffer(1024 ** 3);", "/example")).toMatchObject({
    endReason: "limit", error: { message: "script exceeded the 64 MiB heap limit" },
  });
});

it("does not mistake a guest error with native wording for a resource failure", async () => {
  const { runCodeMode } = await import("./runtime.js");
  expect(await runCodeMode('throw new InternalError("out of memory");', "/example")).toMatchObject({
    endReason: "uncaught", error: { message: "out of memory" },
  });
});

it("joins a stopped or exhausted worker before reporting the result", async () => {
  const { runCodeMode } = await import("./runtime.js");
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const controller = new AbortController();
    const stopped = await runCodeMode('await call("Read", {});', "/example", {
      signal: controller.signal,
      dispatch: () => {
        controller.abort();
        return new Promise(() => {});
      },
    });
    const stoppedWorker = messages.mock.contexts[0] as Worker;
    expect(stopped.endReason).toBe("cancelled");
    expect(stoppedWorker.threadId).toBe(-1);

    messages.mockClear();
    const limit = await runCodeMode("new ArrayBuffer(1024 ** 3);", "/example");
    const exhaustedWorker = messages.mock.contexts[0] as Worker;
    expect(limit.endReason).toBe("limit");
    expect(exhaustedWorker).not.toBe(stoppedWorker);
    expect(exhaustedWorker.threadId).toBe(-1);
    expect(await runCodeMode("return 42;", "/example")).toMatchObject({ endReason: "ok", value: "42" });
  } finally {
    messages.mockRestore();
  }
});

it("round trips embedded NUL bytes across the guest boundary", async () => {
  const { runCodeMode } = await import("./runtime.js");
  const dispatch = vi.fn(async () => ({ status: "error" as const, message: "left\0right" }));
  const result = await runCodeMode(String.raw`
    console.log("log\0line");
    try {
      await call("Read\0suffix", { name: "file\0name" });
    } catch (error) {
      return error.tool + ":" + error.message;
    }
  `, "/example", { dispatch });
  expect(dispatch.mock.calls).toEqual([["Read\0suffix", { name: "file\0name" }]]);
  expect(result).toMatchObject({
    endReason: "ok", value: "Read\0suffix:left\0right", console: "log\0line",
  });
});

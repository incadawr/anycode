import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { QuickJSDeferredPromise, QuickJSHandle, Scope } from "quickjs-emscripten-core";

const SOURCE_BYTES = 32 * 1024;
const HEAP_BYTES = 64 * 1024 * 1024;
const STACK_BYTES = 1024 * 1024;
const CONSOLE_BYTES = 8 * 1024;
const ACTIVE_JS_MS = 2_000;
const ACTIVE_JS_NS = 2_000_000_000n;
const MAX_CALLS = 64;

export const RUNTIME_UNAVAILABLE = "error: Code Mode runtime unavailable, use the regular tools";

type RuntimeModule = Awaited<ReturnType<typeof createRuntimeModule>>;
let runtimeModule: Promise<RuntimeModule> | undefined;

const SINGLEFILE_WASM_BYTES = 503_134;
const SINGLEFILE_WASM_SHA256 = "105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232";
const LIMIT_EXPORT = "codeModeResourceLimit";
const HEAP_LIMIT = "script exceeded the 64 MiB heap limit";
const STACK_LIMIT = "script exceeded the 1 MiB stack limit";

function readLeb(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = bytes[offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, offset];
  }
}

function writeLeb(value: number, signed = false): number[] {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  if (signed && value >= 0x40) bytes.push(value | 0x80, 0);
  else bytes.push(value);
  return bytes;
}

function withResourceLimitLatch(bytes: Uint8Array): Buffer<ArrayBuffer> {
  if (createHash("sha256").update(bytes).digest("hex") !== SINGLEFILE_WASM_SHA256) {
    throw new Error("Unexpected QuickJS singlefile WASM for Code Mode resource tracking");
  }

  // In the pinned release-sync binary, functions 27, 52 and 54 are the
  // optimized variants of JS_ThrowInternalError. Each takes a format pointer
  // as its second argument. The three literal pointers below are the native
  // OOM, regexp OOM and stack overflow diagnostics in its data section.
  const importedFunctions = 19;
  const throwInternalError = new Set([27, 52, 54]);
  const limitGlobal = 1; // appended after the existing stack-pointer global
  const noteLimit = (pointer: number, reason: number) => [
    0x20, 1, 0x41, ...writeLeb(pointer, true), 0x46, // local.get 1; i32.const pointer; i32.eq
    0x04, 0x40, 0x41, reason, 0x24, limitGlobal, 0x0b, // if; i32.const reason; global.set; end
  ];
  const markLimit = Buffer.from([
    0x23, limitGlobal, 0x45, 0x04, 0x40, // if the latch is still zero
    ...noteLimit(3697, 1), ...noteLimit(10711, 1), ...noteLimit(4474, 2),
    0x0b,
  ]);
  const exportName = Buffer.from(LIMIT_EXPORT);
  const extraGlobal = Buffer.from([0x7f, 1, 0x41, 0, 0x0b]); // mutable i32 = 0
  const extraExport = Buffer.from([...writeLeb(exportName.length), ...exportName, 3, limitGlobal]);
  const sections: Uint8Array[] = [bytes.subarray(0, 8)];

  for (let offset = 8; offset < bytes.length;) {
    const id = bytes[offset++]!;
    const [size, start] = readLeb(bytes, offset);
    offset = start + size;
    let content = bytes.subarray(start, offset);
    if (id === 6 || id === 7) { // global and export sections are vectors
      const [count, entries] = readLeb(content, 0);
      content = Buffer.concat([Buffer.from(writeLeb(count + 1)), content.subarray(entries), id === 6 ? extraGlobal : extraExport]);
    } else if (id === 10) { // code section, insert after each function's local declarations
      const [count, firstBody] = readLeb(content, 0);
      const bodies: Uint8Array[] = [content.subarray(0, firstBody)];
      let cursor = firstBody;
      for (let index = 0; index < count; index++) {
        const [length, body] = readLeb(content, cursor);
        if (throwInternalError.has(index + importedFunctions)) {
          const [localGroups, firstLocal] = readLeb(content, body);
          let instructions = firstLocal;
          for (let local = 0; local < localGroups; local++) instructions = readLeb(content, instructions)[1] + 1;
          bodies.push(Buffer.from(writeLeb(length + markLimit.length)),
            content.subarray(body, instructions), markLimit, content.subarray(instructions, body + length));
        } else {
          bodies.push(content.subarray(cursor, body + length));
        }
        cursor = body + length;
      }
      content = Buffer.concat(bodies);
    }
    sections.push(Buffer.from([id, ...writeLeb(content.length)]), content);
  }
  return Buffer.concat(sections);
}

async function createRuntimeModule() {
  const { Scope, newQuickJSWASMModuleFromVariant } = await import("quickjs-emscripten-core");
  const { default: variant } = await import("@jitl/quickjs-singlefile-mjs-release-sync");
  // The singlefile loader doesn't expose its embedded bytes. Intercept its
  // one instantiation in this dedicated worker and restore the host function
  // before compiling. No other module is changed and no external WASM is read.
  const { WebAssembly: wasm } = globalThis as unknown as { WebAssembly: {
    instantiate: (source: unknown, imports?: unknown, options?: unknown) => Promise<unknown>;
    Global: abstract new (...args: never[]) => { value: number };
  } };
  const instantiate = wasm.instantiate;
  let resourceLimit: { value: number } | undefined;
  wasm.instantiate = async (source, imports, options) => {
    if (!(source instanceof Uint8Array) || source.length !== SINGLEFILE_WASM_BYTES) return instantiate(source, imports, options);
    wasm.instantiate = instantiate;
    const loaded = await instantiate(withResourceLimitLatch(source), imports, options) as { instance: { exports: Record<string, unknown> } };
    const latch = loaded.instance.exports[LIMIT_EXPORT];
    if (!(latch instanceof wasm.Global)) throw new Error("QuickJS resource limit latch is missing");
    resourceLimit = latch;
    return loaded;
  };
  try {
    const module = await newQuickJSWASMModuleFromVariant(variant);
    if (!resourceLimit) throw new Error("QuickJS resource limit latch is missing");
    return { Scope, module, resourceLimit };
  } finally {
    wasm.instantiate = instantiate;
  }
}

export function loadCodeModeRuntime(): Promise<RuntimeModule> {
  return runtimeModule ??= createRuntimeModule();
}

export interface ScriptError {
  message: string;
  name?: string;
  line?: number;
  column?: number;
  callId?: string;
}

type TerminalReason = "denied" | "cancelled" | "limit";
export type ScriptEndReason = "ok" | "syntax" | "uncaught" | "stalled" | TerminalReason;

export type ScriptReply =
  | { status: "ok"; output: unknown }
  | { status: "error" | "invalid_input" | "timed_out" | "denied" | "cancelled"; message: string; callId?: string };

export interface ScriptOptions {
  signal?: AbortSignal;
  dispatch?: (tool: string, input: unknown) => Promise<ScriptReply>;
}

interface PendingCall {
  tool: string;
  input: unknown;
  scope: Scope;
  deferred: QuickJSDeferredPromise;
  error: QuickJSHandle;
}

export interface ScriptResult {
  endReason: ScriptEndReason;
  activeJsMs: number;
  console: string;
  source: string;
  value?: string;
  unawaitedCalls: number;
  error?: ScriptError;
  // Set only when the engine could not load, so no guest code ran.
  unavailable?: true;
}

function unfence(source: string): string {
  return /^\s*```js[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(source)?.[1] ?? source;
}

function consoleTail(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  let start = Math.max(0, bytes.length - CONSOLE_BYTES);
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.toString("utf8", start);
}

// The helper captures the guest built-ins before user code can replace them.
const GUEST_HELPERS = `(() => {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const Failure = Error;
  const defineProperties = Object.defineProperties;
  const asString = String;
  const AsyncFunction = (async () => {}).constructor;
  const functionSource = Function.prototype.toString;
  const apply = Reflect.apply;
  const Syntax = SyntaxError;
  const callIds = new WeakMap();
  const getCallId = WeakMap.prototype.get.bind(callIds);
  const setCallId = WeakMap.prototype.set.bind(callIds);
  return {
    compile(encoded) {
      const body = parse(encoded);
      const script = AsyncFunction(body);
      // QuickJS builds the constructor from a source string. Require the result
      // to span the entire body before installing any host functions.
      if (typeof script !== "function" ||
          apply(functionSource, script, []) !== "async function anonymous(\\n) {\\n" + body + "\\n}") {
        throw new Syntax("expected the body of an async function");
      }
      return script;
    },
    call: invoke => (tool, input) => invoke(
      typeof tool === "string" ? stringify(tool) : undefined, stringify(input), new Failure()
    ),
    parse,
    callError(error, encoded) {
      const { tool, status, message, callId } = parse(encoded);
      if (callId !== undefined) setCallId(error, callId);
      return defineProperties(error, {
        tool: { value: tool, enumerable: true, writable: true, configurable: true },
        status: { value: status, enumerable: true, writable: true, configurable: true },
        message: { value: message, writable: true, configurable: true },
      });
    },
    console: emit => ({ log: (...args) => emit(stringify(args.map(asString).join(" "))) }),
    format(value) {
      if (value === undefined) return undefined;
      if (typeof value === "string") return stringify(value);
      try {
        const json = stringify(value, null, 2);
        if (json !== undefined) return stringify(json);
      } catch {}
      return stringify(asString(value) + " (result was not JSON-serializable)");
    },
    describe(error) {
      try {
        return {
          message: stringify(asString(error?.message ?? error)),
          name: typeof error?.name === "string" ? stringify(error.name) : undefined,
          callId: stringify(getCallId(error)),
          stack: typeof error?.stack === "string" ? stringify(error.stack) : undefined,
        };
      } catch {
        return { message: stringify("script threw an unreadable error"), name: undefined, stack: undefined };
      }
    },
  };
})()`;

async function waitForReply(
  call: PendingCall, { dispatch, signal }: ScriptOptions,
): Promise<ScriptReply | undefined> {
  if (signal?.aborted) return undefined;
  if (!dispatch) return { status: "error", message: "dispatch is unavailable" };
  if (!signal) return dispatch(call.tool, call.input);

  let onAbort!: () => void;
  const stopped = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // The dispatch promise only carries host data. A late reply never touches the VM.
    return await Promise.race([stopped, dispatch(call.tool, call.input)]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function runInQuickJS(
  sourceCode: string, cwd: string, options: ScriptOptions = {}, deadline?: BigInt64Array,
): Promise<ScriptResult> {
  const source = unfence(sourceCode);
  let output = "";
  let activeJsMs = 0;
  let sliceStarted: number | undefined;
  let unawaitedCalls = 0;
  const admitted: PendingCall[] = [];
  let callCount = 0;
  let admissionOpen = true;
  let terminal: { reason: TerminalReason; message: string } | undefined;
  const signal = options.signal;

  function close(reason: TerminalReason, message: string): void {
    terminal ??= { reason, message };
  }

  function stopped(): ScriptResult | undefined {
    if (signal?.aborted) close("cancelled", "script cancelled");
    if (overBudget()) close("limit", "script exceeded the 2 s active JavaScript limit");
    return terminal && result(terminal.reason, { message: terminal.message });
  }

  const overBudget = () => activeJsMs + (
    sliceStarted === undefined ? 0 : performance.now() - sliceStarted
  ) >= ACTIVE_JS_MS;
  function result(endReason: ScriptEndReason, error?: ScriptError, value?: string): ScriptResult {
    return { endReason, error, value, unawaitedCalls, activeJsMs, console: output, source };
  }
  if (Buffer.byteLength(sourceCode) > SOURCE_BYTES) {
    return result("limit", { message: "script exceeds the 32 KiB source limit" });
  }

  const beforeLoad = stopped();
  if (beforeLoad) return beforeLoad;
  const binding = await loadCodeModeRuntime().catch(() => undefined);
  const afterLoad = stopped();
  if (afterLoad) return afterLoad;
  if (!binding) return { ...result("uncaught", { message: RUNTIME_UNAVAILABLE }), unavailable: true };

  const { Scope, module, resourceLimit } = binding;
  using scope = new Scope();
  const runtime = scope.manage(module.newRuntime());
  runtime.setMemoryLimit(HEAP_BYTES);
  runtime.setMaxStackSize(STACK_BYTES);
  const vm = scope.manage(runtime.newContext());
  function noteNativeLimit(): void {
    if (resourceLimit.value === 1) close("limit", HEAP_LIMIT);
    else if (resourceLimit.value === 2) close("limit", STACK_LIMIT);
  }
  runtime.setInterruptHandler(() => {
    noteNativeLimit();
    return terminal !== undefined || signal?.aborted === true || overBudget();
  });

  function guest<T>(work: () => T): T {
    resourceLimit.value = 0;
    sliceStarted = performance.now();
    if (deadline) {
      const remainingNs = BigInt(Math.max(0, Math.floor((ACTIVE_JS_MS - activeJsMs) * 1e6)));
      Atomics.store(deadline, 0, process.hrtime.bigint() + remainingNs);
    }
    try {
      return work();
    } finally {
      noteNativeLimit();
      activeJsMs += performance.now() - sliceStarted;
      sliceStarted = undefined;
      if (deadline) {
        Atomics.store(deadline, 1, BigInt(Math.floor(activeJsMs * 1e6)));
        Atomics.store(deadline, 0, 0n);
      }
    }
  }

  const helpers = guest(() => vm.unwrapResult(scope.manage(vm.evalCode(GUEST_HELPERS))));
  const describe = scope.manage(vm.getProp(helpers, "describe"));
  // Binding strings use NUL-terminated UTF-8. JSON quoting preserves the
  // entire string, including in tool names used to select a handler.
  const decodeString = (value: QuickJSHandle): string => JSON.parse(vm.getString(value)) as string;
  function failure(error: QuickJSHandle, endReason: "syntax" | "uncaught"): ScriptResult {
    admissionOpen = false;
    const before = stopped();
    if (before) return before;
    const diagnostic = guest(() => {
      using described = vm.callFunction(describe, vm.undefined, error);
      if (described.error) return { message: "script threw an unreadable error" };
      using message = vm.getProp(described.value, "message");
      using name = vm.getProp(described.value, "name");
      using stack = vm.getProp(described.value, "stack");
      using callId = vm.getProp(described.value, "callId");
      return {
        message: decodeString(message),
        name: vm.typeof(name) === "string" ? decodeString(name) : undefined,
        callId: vm.typeof(callId) === "string" ? decodeString(callId) : undefined,
        stack: vm.typeof(stack) === "string" ? decodeString(stack) : undefined,
      };
    });
    const after = stopped();
    if (after) return after;
    const location = /<input>:(\d+)(?::(\d+))?/.exec(diagnostic.stack ?? "");
    const lines = source.split(/\r\n|[\r\n\u2028\u2029]/);
    const bodyLine = location ? Number(location[1]) - 2 : 0;
    let line = bodyLine >= 1 && bodyLine <= lines.length ? bodyLine : undefined;
    let column = location?.[2] === undefined ? undefined : Number(location[2]);
    if (endReason === "syntax") {
      if (bodyLine > lines.length) {
        // QuickJS points at the synthetic closing brace for incomplete input.
        line = lines.length;
        column = Array.from(lines[line - 1]!).length + 1;
      }
      line ??= 1;
      column ??= 1;
    }
    return result(endReason, {
      message: diagnostic.message,
      name: diagnostic.name,
      callId: diagnostic.callId,
      line,
      column,
    });
  }

  // AsyncFunction parses only a body and contributes two lines to QuickJS locations.
  using compiled = guest(() => {
    using compile = vm.getProp(helpers, "compile");
    using body = vm.newString(JSON.stringify(source));
    return vm.callFunction(compile, vm.undefined, body);
  });
  const afterCompile = stopped();
  if (afterCompile) return afterCompile;
  if (compiled.error) return failure(compiled.error, "syntax");

  guest(() => {
    using directory = vm.newString(cwd);
    using emit = vm.newFunction("log", (text) => {
      output = consoleTail(output + (output ? "\n" : "") + decodeString(text));
    });
    using makeConsole = vm.getProp(helpers, "console");
    using guestConsole = vm.callFunction(makeConsole, vm.undefined, emit);
    vm.setProp(vm.global, "cwd", directory);
    vm.setProp(vm.global, "console", vm.unwrapResult(guestConsole));

    using invoke = vm.newFunction("invoke", (name, serialized, error) => {
      noteNativeLimit();
      if (!admissionOpen || terminal || signal?.aborted || overBudget()) return vm.undefined;
      if (++callCount > MAX_CALLS) {
        close("limit", "script exceeded the limit of 64 calls");
        return vm.undefined;
      }
      if (vm.typeof(name) !== "string") {
        return { error: vm.newError("call requires a tool name string") };
      }
      const tool = decodeString(name);
      const input = vm.typeof(serialized) === "undefined"
        ? undefined : JSON.parse(vm.getString(serialized)) as unknown;
      const callScope = scope.manage(new Scope());
      const deferred = callScope.manage(vm.newPromise());
      admitted.push({ tool, input, scope: callScope, deferred, error: callScope.manage(error.dup()) });
      return deferred.handle.dup();
    });
    using makeCall = vm.getProp(helpers, "call");
    using guestCall = vm.callFunction(makeCall, vm.undefined, invoke);
    vm.setProp(vm.global, "call", vm.unwrapResult(guestCall));
  });

  using parse = vm.getProp(helpers, "parse");
  using callError = vm.getProp(helpers, "callError");
  function settle(call: PendingCall, reply: ScriptReply) {
    using callScope = call.scope;
    using failureHandle = guest(() => {
      if (reply.status === "ok") {
        const encoded = JSON.stringify(reply.output);
        if (encoded === undefined) {
          call.deferred.resolve();
          return;
        }
        using json = vm.newString(encoded);
        using decoded = vm.callFunction(parse, vm.undefined, json);
        if (decoded.error) return decoded.error.dup();
        call.deferred.resolve(decoded.value);
      } else {
        using detail = vm.newString(JSON.stringify({ tool: call.tool, status: reply.status, message: reply.message, callId: reply.callId }));
        using error = vm.callFunction(callError, vm.undefined, call.error, detail);
        if (error.error) return error.error.dup();
        call.deferred.reject(error.value);
      }
    });
    return failureHandle ? failure(failureHandle, "uncaught") : undefined;
  }

  using executed = guest(() => vm.callFunction(compiled.value, vm.undefined));
  const afterExecution = stopped();
  if (afterExecution) return afterExecution;
  if (executed.error) return failure(executed.error, "uncaught");
  let returned: QuickJSHandle | undefined;
  let uncaught: ScriptResult | undefined;
  while (true) {
    const interruption = stopped();
    if (interruption) return interruption;
    if (returned === undefined && uncaught === undefined) {
      const state = guest(() => vm.getPromiseState(executed.value));
      if (state.type === "rejected") {
        unawaitedCalls = admitted.length;
        using error = state.error;
        uncaught = failure(error, "uncaught");
        if (uncaught.endReason !== "uncaught") return uncaught;
      }
      if (state.type === "fulfilled") {
        // Calls admitted up to the root's return still dispatch in FIFO order.
        // Later continuations run as jobs after this point and must not reach the host.
        returned = scope.manage(state.value);
        admissionOpen = false;
        unawaitedCalls = admitted.length;
      }
    }

    // Observe settlement between jobs to count the exact unfinished FIFO length.
    if (uncaught === undefined && runtime.hasPendingJob()) {
      using jobs = guest(() => runtime.executePendingJobs(1));
      if (jobs.error) return failure(jobs.error, "uncaught");
      continue;
    }

    const call = admitted.shift();
    if (!call) break;
    let reply: ScriptReply | undefined;
    try {
      reply = await waitForReply(call, options);
    } catch (error) {
      return stopped() ?? result("uncaught", {
        message: error instanceof Error ? error.message : "nested dispatch failed",
      });
    }
    if (!reply || signal?.aborted) close("cancelled", "script cancelled");
    else if (reply.status === "denied" || reply.status === "cancelled") close(reply.status, reply.message);
    const afterReply = stopped();
    if (afterReply) return afterReply;
    if (uncaught !== undefined) {
      // Drain only the FIFO already admitted at rejection. The root cannot
      // resume, and settling replies would run detached guest continuations.
      call.scope.dispose();
      continue;
    }
    if (reply) {
      try {
        const error = settle(call, reply);
        if (error) return error;
      } catch {
        return result("uncaught", { message: "nested tool output could not be transferred to the script" });
      }
    }
  }

  admissionOpen = false;
  if (uncaught !== undefined) return uncaught;
  if (returned === undefined) {
    return result("stalled", { message: "script is waiting on a promise that never resolves" });
  }
  using format = vm.getProp(helpers, "format");
  using serialized = guest(() => vm.callFunction(format, vm.undefined, returned));
  const afterFormatting = stopped();
  if (afterFormatting) return afterFormatting;
  if (serialized.error) return failure(serialized.error, "uncaught");
  const formatted = guest(() => (
    vm.typeof(serialized.value) === "undefined" ? undefined : decodeString(serialized.value)
  ));
  return stopped() ?? result("ok", undefined, formatted);
}

export type WorkerCommand =
  | { type: "run"; source: string; cwd: string }
  | { type: "reply"; reply: ScriptReply }
  | { type: "dispatch_failed"; message: string }
  | { type: "abort" };

export type WorkerEvent =
  | { type: "ready" }
  | { type: "dispatch"; tool: string; input: unknown }
  | { type: "result"; result: ScriptResult }
  | { type: "failed" };

interface RuntimeWorker {
  worker: Worker;
  deadline: BigInt64Array;
}

let idleWorker: RuntimeWorker | undefined;
const MAX_ACTIVE_WORKERS = 3;
let activeWorkers = 0;
const workerWaiters: Array<() => void> = [];

async function acquireWorkerSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (activeWorkers >= MAX_ACTIVE_WORKERS) {
    await new Promise<void>((resolve, reject) => {
      const grant = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const index = workerWaiters.indexOf(grant);
        if (index >= 0) workerWaiters.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      workerWaiters.push(grant);
      signal?.addEventListener("abort", abort, { once: true });
    });
  } else {
    activeWorkers++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = workerWaiters.shift();
    if (next) next();
    else activeWorkers--;
  };
}

async function acquireWorker(signal?: AbortSignal): Promise<RuntimeWorker> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (idleWorker) {
    const worker = idleWorker;
    idleWorker = undefined;
    worker.worker.ref();
    return worker;
  }

  const source = import.meta.url.endsWith(".ts");
  const directory = new URL(".", import.meta.url);
  // Electron shares this module in chunks beside the standalone worker entry.
  if (!source) directory.pathname = directory.pathname.replace(/\/chunks\/$/, "/");
  const url = new URL(source ? "runtime-worker.ts" : "runtime-worker.js", directory);
  // Node 22's type stripping does not support the 'using' syntax in this
  // module. The development entry uses the same tsx loader as the core CLI.
  const entry = source ? new URL("data:text/javascript," + encodeURIComponent(`
    import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
    await tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(url.href)});
  `)) : url;
  // Leave room for native WASM frames above QuickJS's 1 MiB guest limit.
  const deadline = new BigInt64Array(new SharedArrayBuffer(2 * BigInt64Array.BYTES_PER_ELEMENT));
  const worker = new Worker(entry, {
    execArgv: [], resourceLimits: { stackSizeMb: 8 }, workerData: deadline,
  });
  const runtime = { worker, deadline };
  worker.on("error", () => {
    if (runtime === idleWorker) idleWorker = undefined;
  });
  worker.on("exit", () => {
    if (runtime === idleWorker) idleWorker = undefined;
  });
  return new Promise((resolve, reject) => {
    const onAbort = () => { void worker.terminate(); };
    const onExit = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Code Mode worker failed to start"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("exit", onExit);
    worker.once("message", (event: WorkerEvent) => {
      worker.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (event.type === "ready") resolve(runtime);
      else {
        void worker.terminate().then(() => reject(new Error("Code Mode worker failed to initialize")));
      }
    });
  });
}

function releaseWorker(runtime: RuntimeWorker): void {
  if (idleWorker) {
    void runtime.worker.terminate();
  } else {
    idleWorker = runtime;
    runtime.worker.unref();
  }
}

// Used by the stress probe to exclude module and worker startup from elapsed time.
export async function warmCodeModeWorker(): Promise<void> {
  const release = await acquireWorkerSlot();
  try { releaseWorker(await acquireWorker()); } finally { release(); }
}

export async function runCodeMode(
  source: string, cwd: string, { signal, dispatch }: ScriptOptions = {},
): Promise<ScriptResult> {
  function failed(
    endReason: "cancelled" | "uncaught" | "limit", message: string, activeJsMs = 0,
  ): ScriptResult {
    return {
      endReason, source: unfence(source), error: { message }, console: "", unawaitedCalls: 0,
      activeJsMs,
    };
  }
  if (signal?.aborted) return failed("cancelled", "script cancelled");
  let releaseSlot: () => void;
  try {
    releaseSlot = await acquireWorkerSlot(signal);
  } catch {
    return failed("cancelled", "script cancelled");
  }
  let runtime: RuntimeWorker;
  try {
    runtime = await acquireWorker(signal);
  } catch {
    releaseSlot();
    if (signal?.aborted) return failed("cancelled", "script cancelled");
    return { ...failed("uncaught", RUNTIME_UNAVAILABLE), unavailable: true };
  }
  if (signal?.aborted) {
    await runtime.worker.terminate();
    releaseSlot();
    return failed("cancelled", "script cancelled");
  }

  const { worker, deadline } = runtime;
  return new Promise((resolve) => {
    let finished = false;
    let waiting = false;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    function readActiveMs(): number {
      const currentDeadline = Atomics.load(deadline, 0);
      if (currentDeadline === 0n) return Number(Atomics.load(deadline, 1)) / 1e6;
      return Math.max(0, Number(ACTIVE_JS_NS + process.hrtime.bigint() - currentDeadline) / 1e6);
    }
    function watchActive() {
      waiting = false;
      watchdog ??= setInterval(() => {
        const currentDeadline = Atomics.load(deadline, 0);
        if (currentDeadline !== 0n && process.hrtime.bigint() >= currentDeadline) {
          finish(failed("limit", "script exceeded the 2 s active JavaScript limit", readActiveMs()), false);
        }
      }, 20);
    }
    function send(command: WorkerCommand): void {
      if (finished) return;
      if (command.type !== "abort") watchActive();
      worker.postMessage(command);
    }
    function finish(result: ScriptResult, reusable: boolean): void {
      finished = true;
      clearInterval(watchdog);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (reusable) {
        releaseWorker(runtime);
        releaseSlot();
        resolve(result);
      } else {
        // The caller observes a terminal result only after its worker has exited.
        void worker.terminate().then(() => { releaseSlot(); resolve(result); });
      }
    }
    function onExit(): void {
      finish(failed("uncaught", "Code Mode worker exited during script execution"), false);
    }
    function onAbort(): void {
      if (waiting) send({ type: "abort" });
      else finish(failed("cancelled", "script cancelled", readActiveMs()), false);
    }
    async function dispatchCall(tool: string, input: unknown): Promise<void> {
      try {
        if (signal?.aborted) {
          send({ type: "abort" });
          return;
        }
        const reply = dispatch
          ? await dispatch(tool, input)
          : { status: "error" as const, message: "dispatch is unavailable" };
        send({ type: "reply", reply });
      } catch (error) {
        send({
          type: "dispatch_failed",
          message: error instanceof Error ? error.message : "nested dispatch failed",
        });
      }
    }
    function onMessage(event: WorkerEvent): void {
      if (event.type === "dispatch") {
        waiting = true;
        clearInterval(watchdog);
        watchdog = undefined;
        void dispatchCall(event.tool, event.input);
      }
      if (event.type === "result") {
        const { endReason } = event.result;
        finish(event.result, endReason !== "cancelled" && endReason !== "limit");
      }
      if (event.type === "failed") {
        finish(failed("uncaught", "Code Mode worker failed during script execution"), false);
      }
    }
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    Atomics.store(deadline, 1, 0n);
    send({ type: "run", source, cwd });
  });
}

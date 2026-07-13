/**
 * Bounded "codex doctor" one-shot probe (TASK.41, cut §2(g)/§3.8): spawn ->
 * version preflight -> initialize -> account/read -> model/list (paginated)
 * -> bounded close. Answers "is a working, in-range, signed-in Codex CLI
 * reachable at this binary path" for the Settings onboarding card, before
 * Codex is ever offered as a usable Agent.
 *
 * OWN MINIMAL JSON-RPC CLIENT, deliberately not a reuse of host/engines/codex/
 * app-server-client.ts: a host->main import is architecturally forbidden
 * (cut §2(g), "межслойный импорт host→main запрещён" — the host and main
 * processes have different lifecycle/bundle boundaries). Duplicating ~150
 * lines here is a conscious tradeoff documented at the single spot that makes
 * it dangerous: teardown. `shared/codex-timeouts.ts` is the shared contract
 * that keeps this client's close() sequence byte-identical in INTENT to the
 * host engine's — a past probe hung for 339s on exactly this kind of
 * divergence (see that module's own header). Every constant this file uses
 * for spawn/RPC/teardown timing is imported from there, never hand-rolled.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  CODEX_DOCTOR_MODEL_LIST_PAGE_TIMEOUT_MS,
  CODEX_DOCTOR_RPC_TIMEOUT_MS,
  CODEX_DOCTOR_WATCHDOG_MS,
  CODEX_MODEL_LIST_MAX_PAGES,
  CODEX_TEARDOWN_SIGKILL_WAIT_MS,
  CODEX_TEARDOWN_SIGTERM_WAIT_MS,
  CODEX_TEARDOWN_STDIN_EOF_WAIT_MS,
  CODEX_VERSION_PREFLIGHT_TIMEOUT_MS,
} from "../shared/codex-timeouts.js";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import type { EngineModelChoice } from "../shared/protocol.js";

/**
 * Mirrors `SUPPORTED_CODEX_VERSION`/`parseCodexVersion`/`isSupportedCodexVersion`
 * in host/engines/codex/protocol.ts. Duplicated for the same host->main
 * layering reason as the client below — kept in sync by contract (the drift
 * gate, host/engines/codex/contract/contract-drift.test.ts, pins the wire
 * shape both sides read; this is just the tiny parse/range check, not wire).
 */
const SUPPORTED_CODEX_VERSION = ">=0.144.0 <0.145.0";

interface ParsedCodexVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseCodexVersion(output: string): ParsedCodexVersion | null {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)\s*$/.exec(output.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Range check for `SUPPORTED_CODEX_VERSION` above (0.144.x — see that constant's doc comment). */
function isSupportedCodexVersion(version: ParsedCodexVersion): boolean {
  return version.major === 0 && version.minor === 144;
}

/**
 * Explicit child env allowlist — mirrors `buildCodexChildEnv` in
 * host/engines/codex/app-server-client.ts (duplicated for the same host->main
 * reason as the rest of this file). Never spreads the doctor's own
 * `process.env` wholesale: no ambient ANYCODE_* secret can leak into the
 * spawned Codex child this way.
 */
export function buildDoctorChildEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const posixKeys = [
    "HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  ];
  const winKeys = [
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH", "PATHEXT",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "USERNAME", "PROGRAMDATA",
  ];
  const passThrough = [
    "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...(platform === "win32" ? winKeys : posixKeys), ...passThrough]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const MAX_LINE_BYTES = 5 * 1024 * 1024;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexRpcNotification {
  method: string;
  params?: unknown;
}

/** Resolves once `ms` elapses; used by both the RPC watchdog and the teardown stage races below. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `true` if `exited` settles before the timeout, `false` otherwise. Always clears its own timer. */
function raceExitOrTimeout(exited: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The minimal JSON-RPC line client itself. Exported so main/codex-login.ts
 * (the native login flow, TASK.41 п.3) can reuse the exact same spawn/
 * request/notify/close machinery — one teardown implementation for every
 * main-side Codex child, not two independently drifting ones.
 */
export class CodexRpcClient {
  private child: ChildProcess | null = null;
  private readonly decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private terminalError: Error | null = null;
  private closing = false;
  private readonly notificationHandlers: Array<(notification: CodexRpcNotification) => void> = [];

  constructor(private readonly spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Spawns `codex app-server --stdio` (or `codex --version` via a caller-supplied args override) as its own detached process-group leader on POSIX. */
  spawn(binaryPath: string, env: NodeJS.ProcessEnv, args: readonly string[] = ["app-server", "--stdio"]): void {
    if (this.child !== null) {
      throw new Error("codex rpc client already spawned");
    }
    const child = this.spawnImpl(binaryPath, args, {
      env,
      shell: false,
      windowsHide: true,
      // Own process-group leader on POSIX (pid === pgid) so close() below can
      // signal the WHOLE group, not just the direct child — the exact shape
      // that reaps a grandchild the app-server itself may have spawned.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.once("error", (error) => this.fail(new Error(`codex doctor spawn error: ${error.message}`)));
    child.once("close", () => {
      if (!this.closing) this.fail(new Error("codex process exited unexpectedly"));
    });
  }

  onNotification(handler: (notification: CodexRpcNotification) => void): void {
    this.notificationHandlers.push(handler);
  }

  request<T>(method: string, params: unknown, opts: { timeoutMs: number }): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.child === null) return Promise.reject(new Error("codex rpc client is not spawned"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex doctor request timed out: ${method}`));
      }, opts.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private write(payload: Record<string, unknown>): void {
    if (this.child?.stdin === null || this.child?.stdin === undefined || this.terminalError) {
      throw this.terminalError ?? new Error("codex rpc client stdin unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line === "") continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.fail(new Error(`codex process emitted a JSON-RPC line exceeding ${MAX_LINE_BYTES} bytes`));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // Tolerant: skip a malformed line rather than terminating the whole
        // run over one bad frame (the wire tolerates unknown fields; it does
        // not tolerate strict-reject on unparseable noise either).
        continue;
      }
      this.dispatch(message);
      if (this.terminalError) return;
    }
    if (Buffer.byteLength(this.lineBuffer, "utf8") > MAX_LINE_BYTES) {
      this.fail(new Error(`codex process emitted a JSON-RPC line exceeding ${MAX_LINE_BYTES} bytes`));
    }
  }

  private dispatch(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const message = value as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return; // a stale response after our own timeout is harmless.
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const error = message.error as { message?: unknown };
        pending.reject(new Error(typeof error?.message === "string" ? error.message : "codex request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of this.notificationHandlers) {
        handler({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
      }
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Bounded, idempotent teardown of the process group this client spawned
   * (shared/codex-timeouts.ts recipe, EXACTLY): stdin-EOF wait -> group
   * SIGTERM -> group SIGKILL, each stage racing the child's own `close`
   * event. Safe to call when `spawn()` was never invoked (no-op) and safe to
   * call more than once concurrently (the `closing` latch makes every call
   * after the first a no-op).
   */
  async close(): Promise<void> {
    const child = this.child;
    if (child === null || this.closing) return;
    this.closing = true;
    const pid = child.pid;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));

    try {
      child.stdin?.end();
    } catch {
      // direct child may have already exited.
    }
    if (await raceExitOrTimeout(exited, CODEX_TEARDOWN_STDIN_EOF_WAIT_MS)) {
      this.fail(new Error("codex rpc client closed"));
      return;
    }

    this.signalGroup(pid, "SIGTERM");
    if (await raceExitOrTimeout(exited, CODEX_TEARDOWN_SIGTERM_WAIT_MS)) {
      this.fail(new Error("codex rpc client closed"));
      return;
    }

    this.signalGroup(pid, "SIGKILL");
    await raceExitOrTimeout(exited, CODEX_TEARDOWN_SIGKILL_WAIT_MS);
    this.fail(new Error("codex rpc client closed"));
  }

  private signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal); // negative pid == the whole process group we became the leader of at spawn.
        return;
      } catch {
        // The group can already be gone; direct-child kill below is the narrow fallback.
      }
    }
    try {
      this.child?.kill(signal);
    } catch {
      // best effort only; the bounded races above remain responsible for returning.
    }
  }
}

// ── version preflight (own short-lived spawn, mirrors AppServerClient.preflightVersion) ──

interface PreflightResult {
  version?: string;
  error?: string;
}

function preflightVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
  timeoutMs: number,
): Promise<PreflightResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawnImpl(binaryPath, ["--version"], { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const settle = (result: PreflightResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
      settle({ error: `Codex version check timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => settle({ error: `Codex version check failed: ${error.message}` }));
    child.once("close", (code) => {
      if (code !== 0) {
        settle({ error: `Codex version check exited with code ${code ?? "null"}` });
        return;
      }
      settle({ version: stdout });
    });
  });
}

// ── result projection (tolerant of unknown wire fields — never strict-reject) ──

/** CUSTODY: only `type`/`planType` are read — `email` is never touched, logged, or returned (cut §2(g)). */
function projectAccount(raw: unknown): { type: string; plan: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  const planType = (raw as { planType?: unknown }).planType;
  return { type, plan: typeof planType === "string" ? planType : "" };
}

function projectModel(raw: unknown): EngineModelChoice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== "string" || id === "") return null;
  const displayName = (raw as { displayName?: unknown }).displayName;
  const supportedEfforts = (raw as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts;
  const efforts = Array.isArray(supportedEfforts)
    ? supportedEfforts
        .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { reasoningEffort?: unknown }).reasoningEffort : undefined))
        .filter((effort): effort is string => typeof effort === "string")
    : [];
  return {
    id,
    ...(typeof displayName === "string" && displayName !== "" ? { label: displayName } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
  };
}

async function collectModels(
  client: CodexRpcClient,
  opts: { pageTimeoutMs: number; maxPages: number },
): Promise<EngineModelChoice[]> {
  const models: EngineModelChoice[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < opts.maxPages; page++) {
    const params: Record<string, unknown> = cursor !== undefined ? { cursor } : {};
    const result = await client.request<{ data?: unknown; nextCursor?: unknown }>("model/list", params, {
      timeoutMs: opts.pageTimeoutMs,
    });
    const data = Array.isArray(result.data) ? result.data : [];
    for (const raw of data) {
      const choice = projectModel(raw);
      if (choice !== null) models.push(choice);
    }
    const next = result.nextCursor;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }
  return models;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface RunCodexDoctorOptions {
  /** Overall watchdog (default `CODEX_DOCTOR_WATCHDOG_MS`) — bounds every RPC phase, NOT the teardown that follows in `finally`. */
  timeoutMs?: number;
  /** Source env the child's allowlisted env is built from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** DI seam for tests (fake/adversarial children). */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  versionTimeoutMs?: number;
  rpcTimeoutMs?: number;
  modelPageTimeoutMs?: number;
  maxModelPages?: number;
}

/**
 * Runs one bounded doctor pass against `binaryPath`. Never throws — every
 * failure mode (timeout, spawn error, malformed wire, unsupported version,
 * signed-out) resolves to a `CodexDoctorReport`, never a rejected promise, so
 * a caller never needs a try/catch to render a Settings card. The spawned
 * child (if any) is ALWAYS closed via `CodexRpcClient.close()` before this
 * function returns, on every path including the watchdog timeout.
 */
export async function runCodexDoctor(binaryPath: string, options: RunCodexDoctorOptions = {}): Promise<CodexDoctorReport> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;
  const childEnv = buildDoctorChildEnv(options.env ?? process.env, platform);
  const watchdogMs = options.timeoutMs ?? CODEX_DOCTOR_WATCHDOG_MS;
  const versionTimeoutMs = options.versionTimeoutMs ?? CODEX_VERSION_PREFLIGHT_TIMEOUT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? CODEX_DOCTOR_RPC_TIMEOUT_MS;
  const modelPageTimeoutMs = options.modelPageTimeoutMs ?? CODEX_DOCTOR_MODEL_LIST_PAGE_TIMEOUT_MS;
  const maxModelPages = options.maxModelPages ?? CODEX_MODEL_LIST_MAX_PAGES;

  const client = new CodexRpcClient(spawnImpl);

  const steps = async (): Promise<CodexDoctorReport> => {
    const preflight = await preflightVersion(binaryPath, childEnv, spawnImpl, versionTimeoutMs);
    if (preflight.error !== undefined) {
      return { status: "error", error: preflight.error };
    }
    const parsed = parseCodexVersion(preflight.version ?? "");
    if (parsed === null) {
      return { status: "error", error: `Unrecognized Codex version output: ${(preflight.version ?? "").trim() || "(empty)"}` };
    }
    const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (!isSupportedCodexVersion(parsed)) {
      return { status: "update_required", version };
    }

    client.spawn(binaryPath, childEnv);
    await client.request(
      "initialize",
      { clientInfo: { name: "anycode-codex-doctor", title: "AnyCode Codex Doctor", version: "0.0.0" }, capabilities: { experimentalApi: false } },
      { timeoutMs: rpcTimeoutMs },
    );
    client.notify("initialized");
    const accountResult = await client.request<{ account?: unknown }>("account/read", {}, { timeoutMs: rpcTimeoutMs });
    const account = projectAccount(accountResult.account);
    if (account === null) {
      return { status: "signed_out", version };
    }
    const models = await collectModels(client, { pageTimeoutMs: modelPageTimeoutMs, maxPages: maxModelPages });
    return { status: "ready", version, account, models };
  };

  try {
    return await withTimeout(steps(), watchdogMs, `codex doctor exceeded its ${watchdogMs}ms watchdog`);
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close();
  }
}

/** Constant re-exported so callers (and tests) can format a supported-range message without importing host/**. */
export { SUPPORTED_CODEX_VERSION };

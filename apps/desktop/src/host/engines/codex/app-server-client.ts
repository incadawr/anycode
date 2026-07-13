/**
 * Isolated Codex app-server transport. It is not registered with the product
 * yet: W0 leaves process-tree/orphan support blocked, so this client owns only
 * its direct child and makes no group-reaping claim.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SIGKILL_GRACE_MS } from "@anycode/core";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineProcessRegistrationMessage } from "../../../shared/engines.js";
import { ENGINE_PROCESS_REGISTRATION_TYPE } from "../../../shared/engines.js";
import {
  EngineVersionError,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcServerRequest,
  UNHANDLED_SERVER_REQUEST_ERROR,
  isSupportedCodexVersion,
  parseCodexVersion,
} from "./protocol.js";

export const CODEX_VERSION_TIMEOUT_MS = 3_000;
export const CODEX_MAX_LINE_BYTES = 10 * 1024 * 1024;
export const CODEX_MAX_PENDING_REQUESTS = 64;
export const CODEX_NOTIFICATION_HIGH_WATER = 512;
export const CODEX_NOTIFICATION_LOW_WATER = 128;
const STDERR_TAIL_BYTES = 128 * 1024;

export interface ServerRequestResponder {
  result(value: unknown): void;
  error(error?: JsonRpcError): void;
}

export interface AppServerClientOptions {
  /** Absolute path to the reviewed user-installed binary. */
  binaryPath: string;
  cwd: string;
  /** Source only; buildCodexChildEnv selects an explicit allowlist. */
  sourceEnv: NodeJS.ProcessEnv;
  /** Test-only launcher prefix; production keeps it empty. */
  binaryArgs?: readonly string[];
  bootstrap?: EngineBootstrap;
  /** May await a future UI approval; safe denial happens only after it settles. */
  onServerRequest?: (request: JsonRpcServerRequest, respond: ServerRequestResponder) => void | Promise<void>;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  versionTimeoutMs?: number;
  maxLineBytes?: number;
  maxPendingRequests?: number;
  notificationHighWater?: number;
  notificationLowWater?: number;
  /** Main-owned generation proof; only POSIX dedicated groups are reportable. */
  processOwnership?: {
    hostPid: number;
    generation: number;
    report(message: EngineProcessRegistrationMessage): void;
  };
}

export class AppServerClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerClientError";
  }
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** Explicit child env custody: no ambient spread, especially no ANYCODE_* secrets. */
export function buildCodexChildEnv(source: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv {
  const posix = [
    "HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  ];
  const win = [
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH", "PATHEXT",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "USERNAME", "PROGRAMDATA",
  ];
  const passThrough = [
    "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...(platform === "win32" ? win : posix), ...passThrough]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

class NotificationQueue implements AsyncIterable<JsonRpcNotification> {
  private readonly values: JsonRpcNotification[] = [];
  private waiter: ((result: IteratorResult<JsonRpcNotification>) => void) | undefined;
  private closed = false;

  constructor(
    private readonly onHighWater: () => void,
    private readonly onLowWater: () => void,
    private readonly highWater: number,
    private readonly lowWater: number,
  ) {}

  push(value: JsonRpcNotification): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
    if (this.values.length > this.highWater) this.onHighWater();
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonRpcNotification> {
    return {
      next: (): Promise<IteratorResult<JsonRpcNotification>> => {
        const value = this.values.shift();
        if (value !== undefined) {
          if (this.values.length < this.lowWater) this.onLowWater();
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

export class AppServerClient {
  private readonly spawnImpl: NonNullable<AppServerClientOptions["spawnImpl"]>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, Pending>();
  private readonly maxLineBytes: number;
  private readonly maxPendingRequests: number;
  private readonly queue: NotificationQueue;
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private lineBuffer = "";
  private stderr = "";
  private closing = false;
  private terminalError: Error | null = null;
  private stdoutPaused = false;

  constructor(private readonly options: AppServerClientOptions) {
    this.spawnImpl = options.spawnImpl ?? ((command, args, opts) => spawn(command, args, opts));
    this.env = buildCodexChildEnv(options.sourceEnv);
    this.maxLineBytes = options.maxLineBytes ?? CODEX_MAX_LINE_BYTES;
    this.maxPendingRequests = options.maxPendingRequests ?? CODEX_MAX_PENDING_REQUESTS;
    const highWater = options.notificationHighWater ?? CODEX_NOTIFICATION_HIGH_WATER;
    const lowWater = options.notificationLowWater ?? CODEX_NOTIFICATION_LOW_WATER;
    if (lowWater >= highWater) throw new AppServerClientError("notification low-water must be below high-water");
    this.queue = new NotificationQueue(
      () => this.pauseStdout(),
      () => this.resumeStdout(),
      highWater,
      lowWater,
    );
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  notifications(): AsyncIterable<JsonRpcNotification> {
    return this.queue;
  }

  /** Preflight + spawn only. Caller sends initialize after the bootstrap owns disposal. */
  async start(): Promise<void> {
    if (this.child !== null) throw new AppServerClientError("app-server client already started");
    if (!isAbsolute(this.options.binaryPath)) {
      throw new EngineVersionError("Codex binary path must be absolute");
    }
    await this.preflightVersion();
    const child = this.spawnImpl(this.options.binaryPath, [...(this.options.binaryArgs ?? []), "app-server", "--stdio"], this.spawnOptions(true));
    this.child = child;
    // Adopt immediately after spawn, before any JSON-RPC initialize/account/thread work.
    this.options.bootstrap?.adopt(() => this.close());
    this.bindChild(child);
    await this.awaitSpawn(child);
    this.reportOwnedProcess(child);
  }

  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.child === null) return Promise.reject(new AppServerClientError("app-server client is not started"));
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new AppServerClientError(`app-server pending request limit (${this.maxPendingRequests}) exceeded`));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = opts?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new AppServerClientError(`app-server request timed out: ${method}`));
          }, opts.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new AppServerClientError(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Bounded teardown of the POSIX group we created; Windows remains direct-child only. */
  async close(): Promise<void> {
    const child = this.child;
    if (child === null || this.closing) return;
    this.closing = true;
    try {
      child.stdin?.end();
    } catch {
      // direct child may have already exited.
    }
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      this.signalOwnedProcess(child, "SIGTERM");
    } catch {
      // best effort only; close still waits bounded below.
    }
    const killTimer = setTimeout(() => {
      try {
        this.signalOwnedProcess(child, "SIGKILL");
      } catch {}
    }, SIGKILL_GRACE_MS);
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, SIGKILL_GRACE_MS + 100))]);
    clearTimeout(killTimer);
    this.failTerminal(new AppServerClientError("app-server client closed"));
  }

  private spawnOptions(dedicatedProcessGroup = false): SpawnOptions {
    return {
      cwd: this.options.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      // C2: POSIX child becomes a dedicated session/process-group leader. W0
      // showed a non-detached harness shares its caller PGID, so that shape is
      // never reported to main as reaper-owned. Windows remains deliberately
      // direct-child-only until equivalent tree evidence exists.
      detached: dedicatedProcessGroup && process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    };
  }

  private async preflightVersion(): Promise<void> {
    const child = this.spawnImpl(this.options.binaryPath, [...(this.options.binaryArgs ?? []), "--version"], this.spawnOptions());
    const timeoutMs = this.options.versionTimeoutMs ?? CODEX_VERSION_TIMEOUT_MS;
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        settle(() => reject(new EngineVersionError(`Codex version preflight timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => settle(() => reject(new EngineVersionError(`Codex version preflight failed: ${error.message}`))));
      child.once("close", (code) => {
        if (code !== 0) {
          settle(() => reject(new EngineVersionError(`Codex version preflight exited ${code}: ${stderr.slice(-500)}`)));
          return;
        }
        settle(() => resolve(stdout));
      });
    });
    const version = parseCodexVersion(output);
    if (version === null || !isSupportedCodexVersion(version)) {
      throw new EngineVersionError(`Unsupported Codex version: ${output.trim() || "unparseable"} (supported >=0.144.0 <0.145.0)`);
    }
  }

  private bindChild(child: ChildProcess): void {
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
    child.once("error", (error) => this.failTerminal(new AppServerClientError(`app-server spawn error: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (!this.closing) this.failTerminal(new AppServerClientError(`app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  private awaitSpawn(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.terminalError) {
        reject(this.terminalError);
        return;
      }
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line === "") continue;
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this.failTerminal(new AppServerClientError(`app-server JSON-RPC line exceeds ${this.maxLineBytes} bytes`));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failTerminal(new AppServerClientError("app-server emitted malformed JSON-RPC"));
        return;
      }
      this.dispatch(message);
      if (this.terminalError) return;
    }
    if (Buffer.byteLength(this.lineBuffer, "utf8") > this.maxLineBytes) {
      this.failTerminal(new AppServerClientError(`app-server JSON-RPC line exceeds ${this.maxLineBytes} bytes`));
    }
  }

  private dispatch(value: unknown): void {
    if (value === null || typeof value !== "object") {
      this.failTerminal(new AppServerClientError("app-server emitted a non-object JSON-RPC frame"));
      return;
    }
    const message = value as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      this.onServerRequest({ id: message.id, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return; // stale response after a timeout is harmless.
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const error = message.error as { message?: unknown };
        pending.reject(new AppServerClientError(`app-server request failed: ${typeof error.message === "string" ? error.message : "unknown error"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.queue.push({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
      return;
    }
    this.failTerminal(new AppServerClientError("app-server emitted an invalid JSON-RPC frame"));
  }

  private onServerRequest(request: JsonRpcServerRequest): void {
    let settled = false;
    const respond: ServerRequestResponder = {
      result: (result) => {
        if (settled) return;
        settled = true;
        this.write({ id: request.id, result });
      },
      error: (error = UNHANDLED_SERVER_REQUEST_ERROR) => {
        if (settled) return;
        settled = true;
        this.write({ id: request.id, error });
      },
    };
    if (this.options.onServerRequest === undefined) {
      respond.error();
      return;
    }
    Promise.resolve()
      .then(() => this.options.onServerRequest!(request, respond))
      // A handler may await a UI decision. Only once that promise settles can
      // an unsettled request be denied safely.
      .then(() => {
        if (!settled) respond.error();
      })
      .catch(() => respond.error());
  }

  private write(payload: Record<string, unknown>): void {
    if (this.child?.stdin === null || this.child?.stdin === undefined || this.terminalError) {
      throw this.terminalError ?? new AppServerClientError("app-server stdin is unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private pauseStdout(): void {
    if (!this.stdoutPaused) {
      this.child?.stdout?.pause();
      this.stdoutPaused = true;
    }
  }

  private resumeStdout(): void {
    if (this.stdoutPaused) {
      this.child?.stdout?.resume();
      this.stdoutPaused = false;
    }
  }

  private appendStderr(text: string): void {
    this.stderr = `${this.stderr}${text}`;
    if (Buffer.byteLength(this.stderr, "utf8") > STDERR_TAIL_BYTES) {
      this.stderr = Buffer.from(this.stderr, "utf8").subarray(-STDERR_TAIL_BYTES).toString("utf8");
    }
  }

  private reportOwnedProcess(child: ChildProcess): void {
    const ownership = this.options.processOwnership;
    const pid = child.pid;
    if (ownership === undefined || pid === undefined || process.platform === "win32") return;
    ownership.report({
      type: ENGINE_PROCESS_REGISTRATION_TYPE,
      hostPid: ownership.hostPid,
      generation: ownership.generation,
      enginePid: pid,
      pgid: pid,
    });
  }

  private signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The group can already be gone; direct child is the narrow fallback.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // best effort only; bounded close remains responsible for returning.
    }
  }

  private failTerminal(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.queue.close();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

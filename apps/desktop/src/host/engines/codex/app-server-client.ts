/**
 * Isolated Codex app-server transport. It is not registered with the product
 * yet: W0 leaves process-tree/orphan support blocked, so this client owns only
 * its direct child and makes no group-reaping claim.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineProcessRegistrationMessage } from "../../../shared/engines.js";
import { ENGINE_PROCESS_REGISTRATION_TYPE } from "../../../shared/engines.js";
import { checkCodexBinaryTrust, type CodexPathStat } from "../../../shared/codex-binary-trust.js";
import {
  CODEX_TEARDOWN_SIGKILL_WAIT_MS,
  CODEX_TEARDOWN_SIGTERM_WAIT_MS,
  CODEX_TEARDOWN_STDIN_EOF_WAIT_MS,
  CODEX_VERSION_PREFLIGHT_TIMEOUT_MS,
} from "../../../shared/codex-timeouts.js";
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
  /** DI seam for the spawn-time trust gate; production re-reads the real filesystem (`checkCodexBinaryTrustOnDisk`). */
  binaryTrust?: (binaryPath: string) => string | null;
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

function toPathStat(path: string, stat: { isFile(): boolean; isDirectory(): boolean; mode: number; uid: number; gid: number }): CodexPathStat {
  return { path, isFile: stat.isFile(), isDirectory: stat.isDirectory(), mode: stat.mode, uid: stat.uid, gid: stat.gid };
}

/**
 * Every directory that can be used to swap the binary out from under us: the
 * FULL ancestor chain (up to the filesystem root) of the resolved file's
 * directory, plus — when the candidate path is a symlink — the same chain
 * for the directory holding that symlink. A single-level check misses a
 * writable GRANDPARENT that can rename or replace an otherwise-safe
 * immediate directory (W5.5-review High), so every ancestor up to `/` is
 * walked, not just the leaf. Deduplicated: a shared ancestor (the common
 * case) is only statted and judged once. Duplicated from main/codex-binary.ts
 * on purpose — see this file's trust-reader comment below.
 */
function ancestorDirectories(resolvedFile: string, originalPath: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const walk = (start: string): void => {
    let current = start;
    for (;;) {
      if (!seen.has(current)) {
        seen.add(current);
        ordered.push(current);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  walk(dirname(resolvedFile));
  if (resolvedFile !== originalPath) walk(dirname(originalPath));
  return ordered;
}

/**
 * The host's OWN filesystem read for the SHARED trust policy
 * (shared/codex-binary-trust.ts). A host->main import is architecturally
 * forbidden (cut §2(g)), so main/codex-binary.ts holds a sibling reader: the
 * `stat` plumbing is duplicated across that boundary on purpose — the POLICY,
 * the part whose divergence would actually be dangerous, is not.
 *
 * Called immediately before EACH `spawn()` this client makes (see
 * `assertTrusted`), NOT only once at discovery or once per `start()`: a path
 * validated once and executed later — even moments later, across a
 * `--version` round-trip — is precisely the TOCTOU the policy narrows. It
 * narrows and does not close it (see the policy module's header).
 */
export function checkCodexBinaryTrustOnDisk(binaryPath: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return null;
  try {
    const resolved = realpathSync(binaryPath);
    // A symlink lets an attacker swap the LINK instead of the target, so the
    // link's own ancestor chain is part of the trusted set too.
    const directories = ancestorDirectories(resolved, binaryPath).map((dir) => toPathStat(dir, statSync(dir)));
    return checkCodexBinaryTrust({
      file: toPathStat(resolved, statSync(resolved)),
      directories,
      uid: process.getuid?.() ?? -1,
      egid: process.getegid?.() ?? -1,
      platform,
    });
  } catch {
    return "Codex binary path does not exist";
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
  private readonly observers = new Set<(notification: JsonRpcNotification) => void>();
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private lineBuffer = "";
  private stderr = "";
  private closing = false;
  /** The one in-flight teardown; every later `close()` awaits this same promise. */
  private closePromise: Promise<void> | null = null;
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

  /**
   * Synchronous tap on the notification stream, in wire order, invoked at
   * dispatch time — i.e. BEFORE the pull-based `notifications()` consumer can
   * observe the same line. A server request (an approval) dispatched in the
   * same stdout chunk as the `item/started` that describes it would otherwise
   * race the consumer; this is the ordering guarantee the approval-correlation
   * index depends on. Observers are diagnostic-only: one that throws is
   * isolated and can never break the transport.
   */
  observeNotifications(observe: (notification: JsonRpcNotification) => void): () => void {
    this.observers.add(observe);
    return () => {
      this.observers.delete(observe);
    };
  }

  /** Preflight + spawn only. Caller sends initialize after the bootstrap owns disposal. */
  async start(): Promise<void> {
    if (this.child !== null) throw new AppServerClientError("app-server client already started");
    if (!isAbsolute(this.options.binaryPath)) {
      throw new EngineVersionError("Codex binary path must be absolute");
    }
    await this.preflightVersion();
    // Re-validated HERE, immediately before THIS spawn — not merely once
    // before preflight (W5.5-review Medium). A binary that passed both
    // discovery and the `--version` preflight can still be swapped in the
    // interval between that preflight and this long-lived spawn; checking
    // once before preflight and executing unchecked afterward leaves exactly
    // that interval open. See `assertTrusted`.
    this.assertTrusted();
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

  /**
   * Bounded teardown of the POSIX group we created (Windows stays direct-child
   * only), in the exact three-stage recipe frozen in shared/codex-timeouts.ts:
   * stdin EOF -> SIGTERM -> SIGKILL, each stage exiting early the moment the
   * child actually closes. main's onboarding doctor runs the SAME recipe from
   * the SAME constants: two independently-drifting teardown state machines is
   * precisely how the probe harness once stranded a child for >300s.
   *
   * Idempotent AND awaitable: a second call while one is in flight returns the
   * SAME in-flight teardown promise rather than resolving early. Callers that
   * must not outlive the child (app quit, host shutdown) therefore always await
   * the real teardown, never a no-op — and the child still never sees a second
   * signal storm.
   */
  close(): Promise<void> {
    if (this.child === null) return Promise.resolve();
    this.closePromise ??= this.teardown(this.child);
    return this.closePromise;
  }

  private async teardown(child: ChildProcess): Promise<void> {
    this.closing = true;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      try {
        child.stdin?.end();
      } catch {
        // direct child may have already exited.
      }
      if (await this.exitedWithin(closed, CODEX_TEARDOWN_STDIN_EOF_WAIT_MS)) return;
      this.signalOwnedProcess(child, "SIGTERM");
      if (await this.exitedWithin(closed, CODEX_TEARDOWN_SIGTERM_WAIT_MS)) return;
      this.signalOwnedProcess(child, "SIGKILL");
      await this.exitedWithin(closed, CODEX_TEARDOWN_SIGKILL_WAIT_MS);
    } finally {
      // The stage races above all key off the DIRECT CHILD's `close` event —
      // but a child exiting does not mean its GROUP is empty. A grandchild that
      // ignores SIGTERM outlives a parent that honours it, and every early
      // return above would then leave that grandchild running with nothing left
      // to reap it. The group is therefore swept once more, unconditionally.
      this.sweepOwnedGroup(child);
      this.failTerminal(new AppServerClientError("app-server client closed"));
    }
  }

  /**
   * SIGKILLs any process still alive in the group we created. `kill(-pgid, 0)`
   * is a pure existence probe: a group with no members raises ESRCH, which is
   * the success case. Anything still answering it after `close()` is by
   * definition an orphan of a client that no longer exists.
   */
  private sweepOwnedGroup(child: ChildProcess): void {
    const pid = child.pid;
    if (process.platform === "win32" || pid === undefined) return;
    try {
      process.kill(-pid, 0);
    } catch {
      return; // empty group — nothing survived.
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Raced us to exit; either way the group is gone.
    }
  }

  /** Resolves true if the child closed inside the stage budget, false on stage timeout. */
  private exitedWithin(closed: Promise<void>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void closed.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * The spawn-time trust gate, re-run immediately before EACH individual
   * `spawn()` this client makes (preflight's and the long-lived app-server's)
   * rather than once for the pair (W5.5-review Medium). A check that ran
   * once and then covered two spawns separated by a `--version` round-trip
   * leaves the SECOND spawn executing whatever the FIRST check found,
   * however long ago that was — precisely the TOCTOU shared/codex-binary-
   * trust.ts exists to narrow.
   */
  private assertTrusted(): void {
    const untrusted = (this.options.binaryTrust ?? checkCodexBinaryTrustOnDisk)(this.options.binaryPath);
    if (untrusted !== null) {
      throw new EngineVersionError(untrusted);
    }
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

  /**
   * The version preflight owns a process GROUP of its own, exactly like the
   * long-lived app-server child does (W2-review High). A `--version` that is
   * really a wrapper script can fork a grandchild and hang; killing only the
   * direct wrapper on timeout strands that grandchild permanently, because this
   * spawn happens BEFORE the client exists and nothing else will ever reap it.
   *
   * The group is reaped on EVERY settle path, not just the timeout: a wrapper
   * that exits 0 having left a background helper behind is just as much of an
   * orphan, and once preflight has answered we have no further use for anything
   * it started. An already-empty group raises ESRCH, which is the success case.
   */
  private async preflightVersion(): Promise<void> {
    // Re-validated HERE, immediately before the preflight's OWN spawn — see
    // `assertTrusted`.
    this.assertTrusted();
    const child = this.spawnImpl(this.options.binaryPath, [...(this.options.binaryArgs ?? []), "--version"], this.spawnOptions(true));
    const timeoutMs = this.options.versionTimeoutMs ?? CODEX_VERSION_PREFLIGHT_TIMEOUT_MS;
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signalOwnedProcess(child, "SIGKILL");
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new EngineVersionError(`Codex version preflight timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      // Same unhandled-stream-error hazard as the long-lived child's stdio
      // (bindStdioErrors): a pipe error here must not escalate into a process
      // kill. The outcome is decided by `close`/`error`/the timeout below, so a
      // broken pipe needs no action beyond not being fatal.
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
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

  /**
   * A broken pipe is a TRANSPORT failure, never a process-killing throw
   * (W2-review High). A still-running Codex that closes fd 0 makes the next
   * `.write()` raise an asynchronous EPIPE on the stdin socket; an `error`
   * event with no listener is escalated by Node into an unhandled exception
   * that terminates the OWNING process (here: the whole host). Every stdio
   * stream therefore carries a listener that routes the failure into the same
   * bounded terminal path as any other transport death: pending RPCs reject,
   * the child is torn down, the process lives.
   */
  private bindStdioErrors(child: ChildProcess): void {
    const onStreamError = (stream: "stdin" | "stdout" | "stderr") => (error: Error): void => {
      // A pipe breaking DURING our own bounded teardown is the expected
      // consequence of ending stdin, not a new failure to act on.
      if (this.closing) return;
      this.failTerminal(new AppServerClientError(`app-server ${stream} failed: ${error.message}`));
      void this.close();
    };
    child.stdin?.on("error", onStreamError("stdin"));
    child.stdout?.on("error", onStreamError("stdout"));
    child.stderr?.on("error", onStreamError("stderr"));
  }

  private bindChild(child: ChildProcess): void {
    this.bindStdioErrors(child);
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
      const notification: JsonRpcNotification = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      };
      for (const observe of this.observers) {
        try {
          observe(notification);
        } catch {
          // An observer is a side-channel; it can never fail the transport.
        }
      }
      this.queue.push(notification);
      return;
    }
    this.failTerminal(new AppServerClientError("app-server emitted an invalid JSON-RPC frame"));
  }

  private onServerRequest(request: JsonRpcServerRequest): void {
    let settled = false;
    // A dead transport must not turn a settled decision into an unhandled
    // rejection: the answer is simply undeliverable, and the request is marked
    // settled regardless so no second answer is ever attempted.
    const answer = (payload: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      try {
        this.write(payload);
      } catch {
        // stdin is gone; the request dies with the child.
      }
    };
    const respond: ServerRequestResponder = {
      result: (result) => answer({ id: request.id, result }),
      error: (error = UNHANDLED_SERVER_REQUEST_ERROR) => answer({ id: request.id, error }),
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

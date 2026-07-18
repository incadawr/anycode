/**
 * Isolated `claude` CLI transport (SLICE-CC B2/B3, cut §1.3): spawn, NDJSON
 * framing, `initialize` handshake, bidirectional control-protocol routing,
 * bounded teardown, process-group ownership. Deliberately transport-only — no
 * event-to-AgentEvent translation, no approval UI, no resume (CC-C/CC-D).
 *
 * Structurally mirrors host/engines/codex/app-server-client.ts (line-buffer,
 * backpressure, teardown, ownership, per-spawn trust re-check) but speaks an
 * entirely different wire: NDJSON control-envelopes instead of JSON-RPC, with
 * TWO independent correlation channels instead of one id space — our own
 * control_request/control_response pending map, and an id-less turn-message
 * notification queue (contract §1/§2).
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineProcessRegistrationMessage } from "../../../shared/engines.js";
import { ENGINE_PROCESS_REGISTRATION_TYPE } from "../../../shared/engines.js";
import { checkCodexBinaryTrust, type CodexPathStat } from "../../../shared/codex-binary-trust.js";
import {
  CLAUDE_CONTROL_REQUEST_TIMEOUT_MS,
  CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS,
  CLAUDE_TEARDOWN_SIGKILL_WAIT_MS,
  CLAUDE_TEARDOWN_SIGTERM_WAIT_MS,
  CLAUDE_TEARDOWN_STDIN_EOF_WAIT_MS,
  CLAUDE_VERSION_PREFLIGHT_TIMEOUT_MS,
} from "../../../shared/claude-timeouts.js";
import {
  EngineVersionError,
  GATED_CAPABILITY,
  buildControlRequest,
  hasGatedCapability,
  isClaudeStreamMessageType,
  isClaudeSystemInitMessage,
  isSupportedClaudeVersion,
  parseClaudeVersion,
  unhandledControlError,
  type ClaudeControlCancelRequestEnvelope,
  type ClaudeControlRequestEnvelope,
  type ClaudeControlResponseEnvelope,
  type ClaudeStreamMessage,
  type PermissionModeFlag,
} from "./protocol.js";

export const CLAUDE_MAX_LINE_BYTES = 10 * 1024 * 1024;
export const CLAUDE_NOTIFICATION_HIGH_WATER = 512;
export const CLAUDE_NOTIFICATION_LOW_WATER = 128;
const STDERR_TAIL_BYTES = 128 * 1024;

export class ClaudeClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeClientError";
  }
}

// ── spawn argv (cut §1.3) ──

export interface ClaudeSpawnArgsOptions {
  permissionModeFlag: PermissionModeFlag;
  model?: string;
  sessionId?: string;
  resume?: string;
}

/**
 * The exact argv contract §1.3 pins, including the two flags W0 proved are
 * mandatory-but-hidden: `--permission-prompt-tool stdio` (without it headless
 * `-p` silently auto-denies every tool permission — probe #2) and
 * `--disable-slash-commands` (without it the CLI's own built-in slash-command
 * and skill catalog leaks into `system/init`/`initialize.commands[]` — probe
 * #6). `--mcp-config` is deliberately omitted: probe #6 proved
 * `--strict-mcp-config` alone yields `mcp_servers: []`.
 */
export function buildClaudeSpawnArgs(options: ClaudeSpawnArgsOptions): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "stdio",
    "--disable-slash-commands",
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
    "--permission-mode",
    options.permissionModeFlag,
  ];
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.sessionId !== undefined) args.push("--session-id", options.sessionId);
  else if (options.resume !== undefined) args.push("--resume", options.resume);
  return args;
}

/**
 * Explicit child env custody (cut §0.2 invariant 2, C1): `CLAUDE_CONFIG_DIR`
 * is a REQUIRED parameter, never optional and never ambient — every spawn
 * gets a dedicated AnyCode profile, never the default `~/.claude` (R1/
 * VERIFY-1: this one mechanism closes both credential custody AND the
 * CLAUDE.md/AutoMem content leak). `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
 * (silently override the subscription) and `CLAUDECODE` (breaks a nested
 * claude-under-claude-code launch) are never forwarded — the allowlist simply
 * never names them.
 */
export function buildClaudeChildEnv(source: NodeJS.ProcessEnv, profileDir: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const posix = [
    "HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  ];
  const win = [
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH", "PATHEXT",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "USERNAME", "PROGRAMDATA",
  ];
  const passThrough = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...(platform === "win32" ? win : posix), ...passThrough]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = profileDir;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.CLAUDE_CODE_ENTRYPOINT = "anycode";
  return env;
}

// ── custody: memoryFiles[].path redaction (contract §5, C2) ──
// `get_context_usage.memoryFiles[]` carries the REAL home path as a 0-token
// placeholder even under full CLAUDE_CONFIG_DIR isolation (BY DESIGN CLI, R-W0-6)
// — in two encodings: literal (`/Users/<user>`) and a dash-slug (`-Users-<user>`,
// how Claude Code names per-project state dirs). A redactor catching only one
// form silently passes the other (exactly how R-W0-8 evaded its own scan).

function dashSlug(homeDir: string): string {
  return homeDir.replace(/\//g, "-");
}

/** Rewrites both home-path encodings to `[HOME]`/`[HOME-SLUG]`, in string values AND object keys, recursively. */
export function redactHomePaths<T>(value: T, homeDir: string): T {
  if (homeDir.trim() === "") return value;
  const slug = dashSlug(homeDir);
  const rewrite = (input: string): string => input.split(homeDir).join("[HOME]").split(slug).join("[HOME-SLUG]");
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rewrite(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        out[rewrite(key)] = walk(val);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

// ── binary trust (spawn-time TOCTOU gate) ──
// Duplicated from host/engines/codex/app-server-client.ts's own duplicate of
// main/claude-binary.ts's reader (same rationale, third occurrence): a
// host->main import is architecturally forbidden, so each layer re-implements
// the filesystem read over the SAME engine-agnostic shared/codex-binary-trust.ts
// policy (cut §1.2: "политика движко-агностична; переименование = запрещённый
// рефакторинг общего файла").

function toPathStat(path: string, stat: { isFile(): boolean; isDirectory(): boolean; mode: number; uid: number; gid: number }): CodexPathStat {
  return { path, isFile: stat.isFile(), isDirectory: stat.isDirectory(), mode: stat.mode, uid: stat.uid, gid: stat.gid };
}

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

export function checkClaudeBinaryTrustOnDisk(binaryPath: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return null;
  try {
    const resolved = realpathSync(binaryPath);
    const directories = ancestorDirectories(resolved, binaryPath).map((dir) => toPathStat(dir, statSync(dir)));
    return checkCodexBinaryTrust({
      file: toPathStat(resolved, statSync(resolved)),
      directories,
      uid: process.getuid?.() ?? -1,
      egid: process.getegid?.() ?? -1,
      platform,
    });
  } catch {
    return "Claude binary path does not exist";
  }
}

// ── client ──

type PendingControlRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export interface ControlRequestResponder {
  success(response?: unknown): void;
  error(message?: string): void;
}

export interface InboundControlRequest {
  requestId: string;
  subtype: string;
  request: Record<string, unknown>;
}

export interface ClaudeClientOptions {
  binaryPath: string;
  cwd: string;
  sourceEnv: NodeJS.ProcessEnv;
  /** REQUIRED (cut invariant C1) — every spawn is isolated to this profile, never the ambient default. */
  profileDir: string;
  /** CLI flag value (`manual` for the wire's `default`); defaults to `manual`. */
  permissionModeFlag?: PermissionModeFlag;
  model?: string;
  sessionId?: string;
  resume?: string;
  binaryArgs?: readonly string[];
  bootstrap?: EngineBootstrap;
  /**
   * Handler for CLI->host control_request subtypes (`can_use_tool`,
   * `hook_callback`, `mcp_message`). Absent (or a handler that never settles)
   * means fail-closed: the cut's CC-B scope is transport-only, no approvals UI
   * (§1.3 "router отвечает fail-closed заглушкой") — CC-C wires a real handler.
   */
  onControlRequest?: (request: InboundControlRequest, respond: ControlRequestResponder) => void | Promise<void>;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  binaryTrust?: (binaryPath: string) => string | null;
  versionTimeoutMs?: number;
  initTimeoutMs?: number;
  controlRequestTimeoutMs?: number;
  maxLineBytes?: number;
  notificationHighWater?: number;
  notificationLowWater?: number;
  processOwnership?: {
    hostPid: number;
    generation: number;
    report(message: EngineProcessRegistrationMessage): void;
  };
}

export interface ClaudeAccountInfo {
  tokenSource?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

export interface ClaudeInitializeResult {
  commands: unknown[];
  models: unknown[];
  /** Custody-redacted at this parse layer (cut §0.2 invariant 2) — email/organization are NEVER retained past this call. */
  account: ClaudeAccountInfo;
}

class NotificationQueue implements AsyncIterable<ClaudeStreamMessage> {
  private readonly values: ClaudeStreamMessage[] = [];
  private waiter: ((result: IteratorResult<ClaudeStreamMessage>) => void) | undefined;
  private closed = false;

  constructor(
    private readonly onHighWater: () => void,
    private readonly onLowWater: () => void,
    private readonly highWater: number,
    private readonly lowWater: number,
  ) {}

  push(value: ClaudeStreamMessage): void {
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

  [Symbol.asyncIterator](): AsyncIterator<ClaudeStreamMessage> {
    return {
      next: (): Promise<IteratorResult<ClaudeStreamMessage>> => {
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

export class ClaudeClient {
  private readonly spawnImpl: NonNullable<ClaudeClientOptions["spawnImpl"]>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly decoder = new StringDecoder("utf8");
  /** Our own outbound control_request(s), keyed by the request_id WE generated. */
  private readonly pending = new Map<string, PendingControlRequest>();
  /** CLI-initiated inbound control_request(s) awaiting our answer, keyed by the CLI's request_id (contract §2.2 pairing rule). */
  private readonly pendingInbound = new Map<string, { settled: boolean }>();
  private readonly maxLineBytes: number;
  private readonly initTimeoutMs: number;
  private readonly controlRequestTimeoutMs: number;
  private readonly queue: NotificationQueue;
  private readonly observers = new Set<(notification: ClaudeStreamMessage) => void>();
  private child: ChildProcess | null = null;
  private lineBuffer = "";
  private stderr = "";
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private terminalError: Error | null = null;
  private stdoutPaused = false;
  private sawFirstSystemInit = false;

  constructor(private readonly options: ClaudeClientOptions) {
    this.spawnImpl = options.spawnImpl ?? ((command, args, opts) => spawn(command, args, opts));
    this.env = buildClaudeChildEnv(options.sourceEnv, options.profileDir, process.platform);
    this.homeDir = options.sourceEnv.HOME ?? options.sourceEnv.USERPROFILE ?? "";
    this.maxLineBytes = options.maxLineBytes ?? CLAUDE_MAX_LINE_BYTES;
    this.initTimeoutMs = options.initTimeoutMs ?? CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS;
    this.controlRequestTimeoutMs = options.controlRequestTimeoutMs ?? CLAUDE_CONTROL_REQUEST_TIMEOUT_MS;
    const highWater = options.notificationHighWater ?? CLAUDE_NOTIFICATION_HIGH_WATER;
    const lowWater = options.notificationLowWater ?? CLAUDE_NOTIFICATION_LOW_WATER;
    if (lowWater >= highWater) throw new ClaudeClientError("notification low-water must be below high-water");
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

  notifications(): AsyncIterable<ClaudeStreamMessage> {
    return this.queue;
  }

  /** Synchronous tap on the turn-message stream, in wire order — diagnostic-only, never breaks the transport. */
  observeNotifications(observe: (notification: ClaudeStreamMessage) => void): () => void {
    this.observers.add(observe);
    return () => {
      this.observers.delete(observe);
    };
  }

  /** Preflight + spawn only. Caller sends `initialize` after the bootstrap owns disposal. */
  async start(): Promise<void> {
    if (this.child !== null) throw new ClaudeClientError("claude client already started");
    if (!isAbsolute(this.options.binaryPath)) {
      throw new EngineVersionError("Claude binary path must be absolute");
    }
    await this.preflightVersion();
    // Re-validated HERE, immediately before THIS spawn — the preflight's own
    // trust check is stale by a whole `--version` round trip (TOCTOU).
    this.assertTrusted();
    const args = buildClaudeSpawnArgs({
      permissionModeFlag: this.options.permissionModeFlag ?? "manual",
      model: this.options.model,
      sessionId: this.options.sessionId,
      resume: this.options.resume,
    });
    const child = this.spawnImpl(this.options.binaryPath, [...(this.options.binaryArgs ?? []), ...args], this.spawnOptions(true));
    this.child = child;
    this.options.bootstrap?.adopt(() => this.close());
    this.bindChild(child);
    await this.awaitSpawn(child);
    this.reportOwnedProcess(child);
  }

  /**
   * The `initialize` handshake (contract §1.3): send `control_request
   * {subtype:"initialize"}`, wait ONLY for the matching `control_response`.
   * `system/init` is NEVER awaited here — it is turn-scoped, emitted only
   * after the first user message (probe #1) — handshake-only runs contain
   * zero `system` frames at all.
   */
  async initialize(): Promise<ClaudeInitializeResult> {
    const raw = await this.controlRequest<Record<string, unknown>>("initialize", {}, { timeoutMs: this.initTimeoutMs });
    const account = (raw.account ?? {}) as Record<string, unknown>;
    return {
      commands: Array.isArray(raw.commands) ? raw.commands : [],
      models: Array.isArray(raw.models) ? raw.models : [],
      account: {
        tokenSource: typeof account.tokenSource === "string" ? account.tokenSource : undefined,
        subscriptionType: typeof account.subscriptionType === "string" ? account.subscriptionType : undefined,
        apiProvider: typeof account.apiProvider === "string" ? account.apiProvider : undefined,
      },
    };
  }

  /** `get_context_usage`, custody-redacted (contract §5, C2) before it ever leaves this method. */
  async getContextUsage(): Promise<Record<string, unknown>> {
    const raw = await this.controlRequest<Record<string, unknown>>("get_context_usage", {});
    return redactHomePaths(raw, this.homeDir);
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const response = await this.controlRequest<{ still_queued?: string[] }>("interrupt", {});
    return { stillQueued: response.still_queued ?? [] };
  }

  /** Generic outbound control request (contract §2.1): `set_model`, `set_permission_mode`, `apply_flag_settings`, `get_usage`, or any future subtype. */
  controlRequest<T>(subtype: string, request?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.child === null) return Promise.reject(new ClaudeClientError("claude client is not started"));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? this.controlRequestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ClaudeClientError(`claude control request timed out: ${subtype}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write(buildControlRequest(requestId, subtype, request));
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new ClaudeClientError(String(error)));
      }
    });
  }

  /** A turn-scoped user message (no id — flows into the notification stream like any other turn frame). */
  sendUserMessage(content: string | unknown[]): void {
    this.write({ type: "user", message: { role: "user", content } });
  }

  /**
   * Bounded teardown of the POSIX group we created (Windows: direct-child
   * only), the exact three-stage recipe in shared/claude-timeouts.ts: stdin
   * EOF -> SIGTERM -> SIGKILL, each stage exiting early the moment the child
   * actually closes. Idempotent AND awaitable.
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
      if (await this.exitedWithin(closed, CLAUDE_TEARDOWN_STDIN_EOF_WAIT_MS)) return;
      this.signalOwnedProcess(child, "SIGTERM");
      if (await this.exitedWithin(closed, CLAUDE_TEARDOWN_SIGTERM_WAIT_MS)) return;
      this.signalOwnedProcess(child, "SIGKILL");
      await this.exitedWithin(closed, CLAUDE_TEARDOWN_SIGKILL_WAIT_MS);
    } finally {
      // A grandchild that ignores SIGTERM outlives a parent that honours it;
      // the group is swept once more, unconditionally, regardless of which
      // stage above returned.
      this.sweepOwnedGroup(child);
      this.failTerminal(new ClaudeClientError("claude client closed"));
    }
  }

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

  private exitedWithin(closed: Promise<void>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void closed.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private assertTrusted(): void {
    const untrusted = (this.options.binaryTrust ?? checkClaudeBinaryTrustOnDisk)(this.options.binaryPath);
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
      detached: dedicatedProcessGroup && process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    };
  }

  /**
   * The version preflight owns its own process GROUP, reaped on EVERY settle
   * path (mirrors app-server-client.ts's `preflightVersion` — a wrapper script
   * that forks a grandchild and hangs must not strand it).
   */
  private async preflightVersion(): Promise<void> {
    this.assertTrusted();
    const child = this.spawnImpl(this.options.binaryPath, [...(this.options.binaryArgs ?? []), "--version"], this.spawnOptions(true));
    const timeoutMs = this.options.versionTimeoutMs ?? CLAUDE_VERSION_PREFLIGHT_TIMEOUT_MS;
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
        settle(() => reject(new EngineVersionError(`Claude version preflight timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => settle(() => reject(new EngineVersionError(`Claude version preflight failed: ${error.message}`))));
      child.once("close", (code) => {
        if (code !== 0) {
          settle(() => reject(new EngineVersionError(`Claude version preflight exited ${code}: ${stderr.slice(-500)}`)));
          return;
        }
        settle(() => resolve(stdout));
      });
    });
    const version = parseClaudeVersion(output);
    if (version === null || !isSupportedClaudeVersion(version)) {
      throw new EngineVersionError(`Unsupported Claude version: ${output.trim() || "unparseable"} (supported ${">=2.1.212"})`);
    }
  }

  private bindStdioErrors(child: ChildProcess): void {
    const onStreamError = (stream: "stdin" | "stdout" | "stderr") => (error: Error): void => {
      if (this.closing) return;
      this.failTerminal(new ClaudeClientError(`claude ${stream} failed: ${error.message}`));
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
    child.once("error", (error) => this.failTerminal(new ClaudeClientError(`claude spawn error: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (!this.closing) this.failTerminal(new ClaudeClientError(`claude exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`));
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
        this.failTerminal(new ClaudeClientError(`claude NDJSON line exceeds ${this.maxLineBytes} bytes`));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failTerminal(new ClaudeClientError("claude emitted malformed NDJSON"));
        return;
      }
      this.dispatch(message);
      if (this.terminalError) return;
    }
    if (Buffer.byteLength(this.lineBuffer, "utf8") > this.maxLineBytes) {
      this.failTerminal(new ClaudeClientError(`claude NDJSON line exceeds ${this.maxLineBytes} bytes`));
    }
  }

  private dispatch(value: unknown): void {
    if (value === null || typeof value !== "object") {
      this.failTerminal(new ClaudeClientError("claude emitted a non-object NDJSON frame"));
      return;
    }
    const message = value as { type?: unknown };
    if (typeof message.type !== "string") {
      this.failTerminal(new ClaudeClientError("claude emitted a frame with no type"));
      return;
    }
    switch (message.type) {
      case "control_response":
        this.onControlResponseEnvelope(value as ClaudeControlResponseEnvelope);
        return;
      case "control_request":
        this.onControlRequestEnvelope(value as ClaudeControlRequestEnvelope);
        return;
      case "control_cancel_request":
        this.onControlCancelRequest(value as ClaudeControlCancelRequestEnvelope);
        return;
      default:
        if (isClaudeStreamMessageType(message.type)) {
          this.pushNotification(value as ClaudeStreamMessage);
          return;
        }
        this.failTerminal(new ClaudeClientError(`claude emitted an unrecognized frame type: ${message.type}`));
    }
  }

  /** Our own outbound control_request correlation (host -> CLI -> us). */
  private onControlResponseEnvelope(envelope: ClaudeControlResponseEnvelope): void {
    const requestId = envelope.response.request_id;
    const pending = this.pending.get(requestId);
    if (pending === undefined) return; // stale response after a timeout, or an answer to our own inbound reply — harmless.
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (envelope.response.subtype === "error") {
      pending.reject(new ClaudeClientError(`claude control request failed: ${envelope.response.error}`));
    } else {
      pending.resolve(envelope.response.response);
    }
  }

  /**
   * CLI-initiated control_request (contract §2.2): `can_use_tool`,
   * `hook_callback`, `mcp_message`, or an unrecognized future subtype. Fail-
   * closed by default — CC-B builds no approvals UI (§1.3 scope). The
   * "unhandled-subtype rule" is normative: the CLI blocks the turn on this
   * request until it gets a response OR a cancel, so silence is never safe.
   */
  private onControlRequestEnvelope(envelope: ClaudeControlRequestEnvelope): void {
    const requestId = envelope.request_id;
    const state = { settled: false };
    this.pendingInbound.set(requestId, state);
    const responder: ControlRequestResponder = {
      success: (response) => this.answerInbound(requestId, state, {
        type: "control_response",
        response: { subtype: "success", request_id: requestId, ...(response === undefined ? {} : { response }) },
      }),
      error: (message) => this.answerInbound(requestId, state, unhandledControlError(requestId, message)),
    };
    if (this.options.onControlRequest === undefined) {
      responder.error();
      return;
    }
    Promise.resolve()
      .then(() => this.options.onControlRequest!({ requestId, subtype: envelope.request.subtype, request: envelope.request }, responder))
      .then(() => {
        if (!state.settled) responder.error();
      })
      .catch(() => responder.error());
  }

  /**
   * Pairing rule (contract §2.2, normative): every CLI->host control_request
   * ends in exactly one of our control_response OR this cancel — never both.
   * Dropping the bookkeeping here means a LATER `responder.success()`/`.error()`
   * call from a slow approval handler becomes a safe no-op in `answerInbound`,
   * never a stray write (live-observed hazard: interrupt-during-approval,
   * `w0-03-interrupt-pending.jsonl`).
   */
  private onControlCancelRequest(envelope: ClaudeControlCancelRequestEnvelope): void {
    this.pendingInbound.delete(envelope.request_id);
  }

  private answerInbound(requestId: string, state: { settled: boolean }, envelope: ClaudeControlResponseEnvelope): void {
    if (state.settled) return;
    state.settled = true;
    const wasCancelled = !this.pendingInbound.has(requestId);
    this.pendingInbound.delete(requestId);
    if (wasCancelled) return; // never answer a cancelled request (pairing rule).
    try {
      this.write(envelope);
    } catch {
      // stdin is gone; the request dies with the child.
    }
  }

  /**
   * The first observed `system/init` (turn-scoped, never at handshake —
   * probe #1) is the version-independent capability gate (contract §3): its
   * absence fails closed rather than silently degrading interrupt semantics.
   */
  private pushNotification(message: ClaudeStreamMessage): void {
    if (!this.sawFirstSystemInit && message.type === "system" && isClaudeSystemInitMessage(message)) {
      this.sawFirstSystemInit = true;
      if (!hasGatedCapability(message.capabilities)) {
        this.failTerminal(new EngineVersionError(`claude system/init is missing required capability "${GATED_CAPABILITY}"`));
        return;
      }
    }
    for (const observe of this.observers) {
      try {
        observe(message);
      } catch {
        // An observer is a side-channel; it can never fail the transport.
      }
    }
    this.queue.push(message);
  }

  private write(payload: unknown): void {
    if (this.child?.stdin === null || this.child?.stdin === undefined || this.terminalError) {
      throw this.terminalError ?? new ClaudeClientError("claude stdin is unavailable");
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

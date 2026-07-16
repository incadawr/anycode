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
import { checkCodexBinaryPathTrust } from "./codex-binary.js";
import { registerCodexChild } from "./codex-children.js";
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
import type { CodexAccount, CodexDoctorReport } from "../shared/codex-doctor.js";
import type { CodexQuotaCredits, CodexQuotaWindow, CodexRateLimits } from "../shared/codex-quota.js";
import type { EngineModelChoice } from "../shared/protocol.js";
import {
  activeCodexVersionPolicy,
  codexVersionVerdict,
  manifestSupportedRange,
  type CodexVersionPolicy,
} from "./codex-manifest.js";
import {
  applyCodexProfileEnv,
  assertCodexProfileHome,
  type CodexProfileGuardResult,
  type ResolvedCodexProfile,
} from "./codex-profiles.js";

/**
 * Version support is judged against the MANIFEST policy (main/codex-manifest.ts,
 * cut §7.1/TASK.53) — the old hardcoded `SUPPORTED_CODEX_VERSION` mirror is
 * gone from main. host/engines/codex/protocol.ts keeps its own constant as a
 * pinned drift-gate fact about the WIRE contract; that is a different thing
 * from support policy and stays out of this file's business.
 */
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

/**
 * SIGKILLs anything still alive in a process group we created. `kill(-pgid, 0)`
 * is a pure existence probe: an empty group raises ESRCH, which is the success
 * case. Anything still answering it after a bounded teardown is by definition an
 * orphan — a grandchild that ignored the SIGTERM its parent honoured.
 */
function sweepGroup(pid: number | undefined): void {
  if (pid === undefined || process.platform === "win32") return;
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
  /** The one in-flight teardown; every later `close()` awaits this same promise (quit must await the REAL teardown). */
  private closePromise: Promise<void> | null = null;
  /** Removes this child from the app-lifecycle registry once it is fully torn down. */
  private unregister: (() => void) | null = null;
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
      // signal the WHOLE group, not just the direct child — the shape that
      // reaps a grandchild the app-server spawned INTO this group. A grandchild
      // that calls setsid() to leave the group is unreachable this way (a
      // known, inherent residual of group reaping — see main/codex-children.ts).
      // The flip side is that this child does NOT die with main, which is why the
      // registration below hands it to the app lifecycle (main/codex-children.ts).
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.unregister = registerCodexChild({ pid: () => this.child?.pid, close: () => this.close() });
    this.bindStdioErrors(child);
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.once("error", (error) => this.fail(new Error(`codex doctor spawn error: ${error.message}`)));
    child.once("close", () => {
      if (!this.closing) this.fail(new Error("codex process exited unexpectedly"));
    });
  }

  /**
   * A broken pipe is a TRANSPORT failure, never a process-killing throw
   * (W2-review High). A still-running Codex that closes fd 0 makes the next
   * `.write()` raise an asynchronous EPIPE on the stdin socket; an `error`
   * event with no listener is escalated by Node into an unhandled exception
   * that terminates the OWNING process — and this client runs INSIDE THE MAIN
   * PROCESS, so that is the whole app. The failure is routed into the same
   * bounded terminal path as any other transport death instead.
   */
  private bindStdioErrors(child: ChildProcess): void {
    const onStreamError = (stream: "stdin" | "stdout" | "stderr") => (error: Error): void => {
      // A pipe breaking DURING our own bounded teardown is expected, not news.
      if (this.closing) return;
      this.fail(new Error(`codex ${stream} failed: ${error.message}`));
      void this.close();
    };
    child.stdin?.on("error", onStreamError("stdin"));
    child.stdout?.on("error", onStreamError("stdout"));
    child.stderr?.on("error", onStreamError("stderr"));
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
   * event. Safe to call when `spawn()` was never invoked (no-op).
   *
   * Idempotent AND awaitable: a concurrent second call returns the SAME
   * in-flight teardown promise rather than resolving early — app quit awaits
   * this, and an early no-op resolve would let Electron exit while the detached
   * group was still alive (the very orphan this whole lane exists to kill).
   */
  close(): Promise<void> {
    if (this.child === null) return Promise.resolve();
    this.closePromise ??= this.teardown(this.child);
    return this.closePromise;
  }

  private async teardown(child: ChildProcess): Promise<void> {
    this.closing = true;
    const pid = child.pid;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));

    try {
      try {
        child.stdin?.end();
      } catch {
        // direct child may have already exited.
      }
      if (await raceExitOrTimeout(exited, CODEX_TEARDOWN_STDIN_EOF_WAIT_MS)) return;

      this.signalGroup(pid, "SIGTERM");
      if (await raceExitOrTimeout(exited, CODEX_TEARDOWN_SIGTERM_WAIT_MS)) return;

      this.signalGroup(pid, "SIGKILL");
      await raceExitOrTimeout(exited, CODEX_TEARDOWN_SIGKILL_WAIT_MS);
    } finally {
      // The stage races above all key off the DIRECT CHILD's `close` event —
      // but a child exiting does not mean its GROUP is empty. A grandchild that
      // ignores SIGTERM outlives a parent that honours it, and every early
      // return above would then leave that grandchild running with nothing left
      // to reap it. The group is therefore swept once more, unconditionally.
      sweepGroup(pid);
      this.fail(new Error("codex rpc client closed"));
      this.unregister?.();
      this.unregister = null;
    }
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

/** SIGKILLs the preflight child's whole process GROUP; an already-empty group raises ESRCH, which is the success case. */
function killPreflightGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The group is gone already; the direct kill below is the narrow fallback.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // best effort
  }
}

/**
 * The version preflight owns a process GROUP of its own, exactly like the
 * long-lived app-server child (W2-review High). A `--version` that is really a
 * wrapper script can fork a grandchild and hang; killing only the direct
 * wrapper on timeout strands that grandchild permanently, because preflight
 * runs BEFORE any client exists and nothing else will ever reap it.
 *
 * The group is reaped on EVERY settle path (not just the timeout): a wrapper
 * that exits 0 having left a helper behind is just as orphaned, and once
 * preflight has answered, nothing it started is of any further use. The child
 * is registered with the app lifecycle for the duration, so a quit landing
 * inside this 3s window reaps it too.
 */
function preflightVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
  timeoutMs: number,
): Promise<PreflightResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawnImpl(binaryPath, ["--version"], {
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const unregister = registerCodexChild({
      pid: () => child.pid,
      close: async () => {
        killPreflightGroup(child);
      },
    });
    const settle = (result: PreflightResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killPreflightGroup(child);
      unregister();
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ error: `Codex version check timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    // An unhandled `error` on a child stdio stream terminates the owning
    // process (see CodexRpcClient.bindStdioErrors); the outcome here is decided
    // by `close`/`error`/the timeout, so a broken pipe just must not be fatal.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
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

/**
 * Projects the wire `Account` union (codex-profiles cut §1.1/§3.1) tolerantly
 * — an unknown future variant degrades to `{type}` instead of failing the
 * decoder (still enough for automat row 5: "account !== null ⇒ ready").
 *
 * CUSTODY (cut §4.4, OG-4 — the old "email is never returned" invariant was
 * DELIBERATELY reversed): `email` now crosses into main memory and the
 * renderer projection. It must still NEVER reach settings.json, telemetry,
 * a file log, or an error string — those custodians are asserted in
 * codex-ipc.test.ts / codex-doctor.test.ts.
 */
function projectCodexAccount(raw: unknown): CodexAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "chatgpt") {
    const email = (raw as { email?: unknown }).email;
    const planType = (raw as { planType?: unknown }).planType;
    return { type, email: typeof email === "string" ? email : null, plan: typeof planType === "string" ? planType : "" };
  }
  if (type === "amazonBedrock") {
    const credentialSource = (raw as { credentialSource?: unknown }).credentialSource;
    return { type, ...(typeof credentialSource === "string" ? { credentialSource } : {}) };
  }
  return { type };
}

// ── rate-limit projection (cut §6.1 pull side; tolerant, advisory-only) ──

function projectQuotaWindow(raw: unknown): CodexQuotaWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usedPercent = (raw as { usedPercent?: unknown }).usedPercent;
  if (typeof usedPercent !== "number") return null;
  const window: CodexQuotaWindow = { usedPercent };
  const windowDurationMins = (raw as { windowDurationMins?: unknown }).windowDurationMins;
  if (typeof windowDurationMins === "number" || windowDurationMins === null) window.windowDurationMins = windowDurationMins;
  const resetsAt = (raw as { resetsAt?: unknown }).resetsAt;
  if (typeof resetsAt === "number" || resetsAt === null) window.resetsAt = resetsAt;
  return window;
}

function projectQuotaCredits(raw: unknown): CodexQuotaCredits | null {
  if (typeof raw !== "object" || raw === null) return null;
  const hasCredits = (raw as { hasCredits?: unknown }).hasCredits;
  const unlimited = (raw as { unlimited?: unknown }).unlimited;
  if (typeof hasCredits !== "boolean" || typeof unlimited !== "boolean") return null;
  const balance = (raw as { balance?: unknown }).balance;
  return { hasCredits, unlimited, ...(typeof balance === "string" || balance === null ? { balance } : {}) };
}

/** One `RateLimitSnapshot` (top level or a byLimitId bucket). Unknown fields — incl. `rateLimitResetCredits` (amended §A3.4) — are silently dropped. */
function projectQuotaSnapshot(raw: unknown, observedAt: string): Omit<CodexRateLimits, "byLimitId"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const snapshot: Omit<CodexRateLimits, "byLimitId"> = { observedAt };
  const primary = projectQuotaWindow(source.primary);
  if (primary !== null || source.primary === null) snapshot.primary = primary;
  const secondary = projectQuotaWindow(source.secondary);
  if (secondary !== null || source.secondary === null) snapshot.secondary = secondary;
  const credits = projectQuotaCredits(source.credits);
  if (credits !== null || source.credits === null) snapshot.credits = credits;
  if (typeof source.planType === "string" || source.planType === null) snapshot.planType = source.planType as string | null;
  if (typeof source.limitName === "string" || source.limitName === null) snapshot.limitName = source.limitName as string | null;
  return snapshot;
}

/**
 * Projects a `GetAccountRateLimitsResponse` into the frozen shared type
 * (`byLimitId` preferred at read time, top level kept as the backward-compat
 * mirror — amended §A3.3). Exported for tests. Returns undefined when the
 * response carries nothing recognizable.
 */
export function projectCodexRateLimits(raw: unknown, observedAt: string): CodexRateLimits | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as { rateLimits?: unknown; rateLimitsByLimitId?: unknown };
  const base = projectQuotaSnapshot(source.rateLimits, observedAt);
  let byLimitId: Record<string, Omit<CodexRateLimits, "byLimitId">> | undefined;
  if (typeof source.rateLimitsByLimitId === "object" && source.rateLimitsByLimitId !== null) {
    for (const [limitId, bucket] of Object.entries(source.rateLimitsByLimitId as Record<string, unknown>)) {
      const projected = projectQuotaSnapshot(bucket, observedAt);
      if (projected !== null) {
        byLimitId ??= {};
        byLimitId[limitId] = projected;
      }
    }
  }
  if (base === null && byLimitId === undefined) return undefined;
  return { ...(base ?? { observedAt }), ...(byLimitId !== undefined ? { byLimitId } : {}) };
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
  /**
   * Aborts the run (app quit): the in-flight phase gives up and the `finally`
   * below tears the child down — bounded — before this promise settles. The
   * caller awaiting it therefore cannot outlive the child.
   */
  signal?: AbortSignal;
  /** DI seam for the spawn-time trust gate; production re-reads the real filesystem (`checkCodexBinaryPathTrust`). */
  trust?: (binaryPath: string) => string | null;
  versionTimeoutMs?: number;
  rpcTimeoutMs?: number;
  modelPageTimeoutMs?: number;
  maxModelPages?: number;
  /**
   * The profile this doctor pass runs AGAINST (codex-profiles cut §4.2:
   * readiness is a function of (binary, profile)). Absent or system: the env
   * is inherited untouched — byte-for-byte the pre-profiles behavior. A
   * profile with a home OVERWRITES any ambient CODEX_HOME in the child env
   * (§2.6.2) and stamps `profileId` onto the report.
   */
  profile?: ResolvedCodexProfile;
  /**
   * DI seam for the pre-spawn home/auth-link guard (§2.5 + amended §A1.2);
   * production re-asserts the real filesystem (`assertCodexProfileHome`).
   * Re-run before EVERY spawn, same TOCTOU narrative as the binary trust gate.
   */
  profileGuard?: (profile: ResolvedCodexProfile) => CodexProfileGuardResult;
  /**
   * Version-support policy the verdict is judged against (cut §7.1/§7.4).
   * Defaults to the module-level active policy (bundled manifest + persisted
   * risk acceptances, kept current by main/index.ts and codex-install.ts) —
   * the seam that reaches the doctor without widening the frozen codex-ipc
   * deps surface. Explicit here for tests.
   */
  versionPolicy?: CodexVersionPolicy;
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
  // Profile injection happens AFTER the allowlist: the profile home replaces —
  // never merely joins — whatever CODEX_HOME the ambient env passed through
  // (cut §2.6.2). System/no-profile leaves the allowlisted env untouched.
  const profile = options.profile;
  const childEnv = applyCodexProfileEnv(buildDoctorChildEnv(options.env ?? process.env, platform), profile);
  const profileGuard = options.profileGuard ?? ((target: ResolvedCodexProfile) => assertCodexProfileHome(target, { platform }));
  const profileId = profile !== undefined && profile.codexHome !== undefined ? profile.id : undefined;
  const watchdogMs = options.timeoutMs ?? CODEX_DOCTOR_WATCHDOG_MS;
  const versionTimeoutMs = options.versionTimeoutMs ?? CODEX_VERSION_PREFLIGHT_TIMEOUT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? CODEX_DOCTOR_RPC_TIMEOUT_MS;
  const modelPageTimeoutMs = options.modelPageTimeoutMs ?? CODEX_DOCTOR_MODEL_LIST_PAGE_TIMEOUT_MS;
  const maxModelPages = options.maxModelPages ?? CODEX_MODEL_LIST_MAX_PAGES;

  const client = new CodexRpcClient(spawnImpl);
  const versionPolicy = options.versionPolicy ?? activeCodexVersionPolicy();
  const trust = options.trust ?? ((path: string) => checkCodexBinaryPathTrust(path, undefined, platform));
  /** RE-READ at every gate, never captured: an `AbortSignal` flips under a run in progress — that is its entire purpose, and a narrowed snapshot of it would be a lie. */
  const quitRequested = (): boolean => options.signal?.aborted === true;

  const steps = async (): Promise<CodexDoctorReport> => {
    // ENTRANCE GATE (W3.5-review Critical): the abort below only races a run
    // that has already started, and the preflight spawn on the next line is the
    // doctor's FIRST child. A doctor entered with an already-aborted signal
    // (quit ran while its caller was parked on a pre-spawn `await`) must spawn
    // nothing at all — that child is detached and is born behind the teardown.
    if (quitRequested()) {
      return { status: "error", error: "codex doctor aborted" };
    }
    // Re-validated at SPAWN time, not merely at discovery (W2-review Medium):
    // the binary discovery approved can be swapped in the interval before it is
    // executed. This narrows the TOCTOU window to the irreducible
    // check->execve gap; it does not close it. Hence "before EVERY spawn", not
    // once per run: this one guards the preflight child immediately below, and
    // the app-server spawn further down re-reads the filesystem for itself.
    const untrusted = trust(binaryPath);
    if (untrusted !== null) {
      return { status: "error", error: untrusted };
    }
    // Home/auth-link guard for the profile the run executes AGAINST (cut §2.5
    // + amended §A1.2): before the FIRST spawn, exactly like the binary trust
    // gate above — a refusing home means status error and no child at all.
    if (profile !== undefined) {
      const homeGuard = profileGuard(profile);
      if (!homeGuard.ok) {
        return { status: "error", error: homeGuard.reason };
      }
    }
    const preflight = await preflightVersion(binaryPath, childEnv, spawnImpl, versionTimeoutMs);
    if (preflight.error !== undefined) {
      return { status: "error", error: preflight.error };
    }
    const parsed = parseCodexVersion(preflight.version ?? "");
    if (parsed === null) {
      return { status: "error", error: `Unrecognized Codex version output: ${(preflight.version ?? "").trim() || "(empty)"}` };
    }
    const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    // Manifest verdict (cut §4.2 row 3): outside every supported range AND not
    // risk-accepted (§7.4) — and ALWAYS when below the compiled floor, which
    // no manifest and no acceptance can override.
    if (!codexVersionVerdict(version, versionPolicy).allowed) {
      return { status: "update_required", version };
    }

    // An abort that landed during the (bounded) preflight must not go on to
    // spawn a child the caller has already stopped waiting for — that child
    // would be born orphaned, after the teardown below has already run.
    if (quitRequested()) {
      return { status: "error", error: "codex doctor aborted" };
    }
    // The trust check that guards THIS spawn (W3.5-review Medium). The one above
    // guarded the preflight and is now stale by a whole `--version` round trip:
    // a binary swapped in that interval would otherwise be executed — as a
    // long-lived app-server — on the strength of a stat that no longer describes
    // it. Every spawn site re-reads the filesystem for itself; the irreducible
    // stat->execve window is the residual (shared/codex-binary-trust.ts header).
    const untrustedAtSpawn = trust(binaryPath);
    if (untrustedAtSpawn !== null) {
      return { status: "error", error: untrustedAtSpawn };
    }
    // The home guard that covers THIS spawn (same re-read discipline as the
    // binary trust line above): the one before the preflight is a whole
    // `--version` round trip stale by now.
    if (profile !== undefined) {
      const homeGuardAtSpawn = profileGuard(profile);
      if (!homeGuardAtSpawn.ok) {
        return { status: "error", error: homeGuardAtSpawn.reason };
      }
    }
    client.spawn(binaryPath, childEnv);
    await client.request(
      "initialize",
      { clientInfo: { name: "anycode-codex-doctor", title: "AnyCode Codex Doctor", version: "0.0.0" }, capabilities: { experimentalApi: false } },
      { timeoutMs: rpcTimeoutMs },
    );
    client.notify("initialized");
    // `account/read` REQUIRES `params: {}` on the wire (amended §A3.7 —
    // schema-mandated, live-verified); the rateLimits read below goes with NO
    // params key at all. Deliberately not unified.
    const accountResult = await client.request<{ account?: unknown; requiresOpenaiAuth?: unknown }>("account/read", {}, { timeoutMs: rpcTimeoutMs });
    const account = projectCodexAccount(accountResult.account);
    const requiresOpenaiAuth = typeof accountResult.requiresOpenaiAuth === "boolean" ? accountResult.requiresOpenaiAuth : undefined;
    // Status automat rows 5-8 (cut §4.2): ANY account variant ⇒ ready (row 5);
    // null + requiresOpenaiAuth:false ⇒ ready (row 7 — the api-key/bedrock
    // config.toml setup a null-account check used to false-negative); null +
    // true (row 6) or ABSENT (row 8, fail-closed) ⇒ signed_out.
    if (account === null && requiresOpenaiAuth !== false) {
      return { status: "signed_out", version, ...(requiresOpenaiAuth !== undefined ? { requiresOpenaiAuth } : {}) };
    }
    const models = await collectModels(client, { pageTimeoutMs: modelPageTimeoutMs, maxPages: maxModelPages });
    // Quotas are ADVISORY (cut §6.1 pull side): visible in Settings without a
    // single session, but a failing read never degrades a ready verdict.
    let rateLimits: CodexRateLimits | undefined;
    try {
      const rateLimitsResult = await client.request<unknown>("account/rateLimits/read", undefined, { timeoutMs: rpcTimeoutMs });
      rateLimits = projectCodexRateLimits(rateLimitsResult, new Date().toISOString());
    } catch {
      // Tolerated: an older server without the method, or a transient failure.
    }
    return {
      status: "ready",
      version,
      account,
      models,
      ...(requiresOpenaiAuth !== undefined ? { requiresOpenaiAuth } : {}),
      ...(rateLimits !== undefined ? { rateLimits } : {}),
    };
  };

  // The abort (app quit) races the whole run. Whichever side wins, the `finally`
  // below tears the child down — bounded — BEFORE this function's promise
  // settles, so a caller that awaits it can never outlive the child it started.
  // Both racers get a no-op catch: the loser settles later, unobserved, and an
  // unhandled rejection in the main process is not an acceptable way to find out.
  const run = withTimeout(steps(), watchdogMs, `codex doctor exceeded its ${watchdogMs}ms watchdog`);
  run.catch(() => {});
  const aborted = new Promise<never>((_resolve, reject) => {
    const signal = options.signal;
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(new Error("codex doctor aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("codex doctor aborted")), { once: true });
  });
  aborted.catch(() => {});

  // `profileId` is stamped at the single exit point so EVERY path — ready,
  // signed_out, error, watchdog, abort — names the profile it diagnosed
  // (shared/codex-doctor.ts: absence means system). `supportedRange` rides
  // along on every report that carries a version — i.e. exactly the reports
  // whose verdict was judged against the manifest — so the renderer displays
  // the range from the report, never from a hardcoded string (cut §7.1).
  const stamp = (report: CodexDoctorReport): CodexDoctorReport => ({
    ...report,
    ...(profileId !== undefined ? { profileId } : {}),
    ...(report.version !== undefined ? { supportedRange: manifestSupportedRange(versionPolicy.manifest) } : {}),
  });
  try {
    return stamp(await Promise.race([run, aborted]));
  } catch (error) {
    return stamp({ status: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    await client.close();
  }
}

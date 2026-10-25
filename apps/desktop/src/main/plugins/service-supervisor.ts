/**
 * Plugin background-service supervisor (Taskana 4750a, main process).
 *
 * A plugin may declare long-lived `services` in its manifest. This module owns
 * their lifecycle: it starts an ELIGIBLE service (enabled, consented to its
 * exact definition, and — for project-tier plugins — in a trusted folder),
 * stops it when it stops being eligible or disappears, restarts crashes with
 * exponential backoff behind a crash-loop breaker, kills the whole process
 * tree on stop, and keeps a bounded plain-text log per service.
 *
 * It is PURE over an injected deps bag (`spawn`, `listCandidates`, timers,
 * clock) so the policy is unit-testable with fake timers and a fake spawn. The
 * real child-process adapter lives in `service-process.ts`.
 *
 * Secrets: the supervisor never reads the Sessions-API discovery file. It only
 * passes its PATH (`ANYCODE_SESSIONS_DISCOVERY`) into the child env; the token
 * and URL stay in that file, so they cannot reach the env block, argv, logs or
 * the IPC snapshot.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { expandServiceSecrets, type PluginTier } from "@anycode/core/plugins-admin";

// ── constants (exported for tests and the design record) ──

/** First automatic restart delay; doubles per consecutive failure. */
export const SERVICE_BACKOFF_BASE_MS = 1_000;
/** Upper bound for the restart delay. */
export const SERVICE_BACKOFF_MAX_MS = 60_000;
/** A run that lasted at least this long before dying resets the consecutive-failure count. */
export const SERVICE_STABLE_RUN_MS = 60_000;
/** Crash-loop breaker: this many failures inside the window stop automatic restarts. */
export const SERVICE_CRASH_LOOP_FAILURES = 5;
export const SERVICE_CRASH_LOOP_WINDOW_MS = 120_000;
/** Grace between SIGTERM and SIGKILL of a tree (the real adapter escalates). */
export const SERVICE_KILL_GRACE_MS = 3_000;
/** Hard deadline for a stop (per process, and for stopAll as a whole). */
export const SERVICE_STOP_ALL_DEADLINE_MS = 5_000;
export const SERVICE_LOG_MAX_LINES = 200;
export const SERVICE_LOG_MAX_BYTES = 64 * 1024;
export const SERVICE_LOG_LINE_MAX_CHARS = 2_000;

/** Environment keys copied from the app into every service (allow-list; everything else is dropped). */
export const SERVICE_BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "SYSTEMROOT",
  "COMSPEC",
] as const;

/** Env var that points a service at the Sessions-API discovery file (path only). */
export const SESSIONS_DISCOVERY_ENV = "ANYCODE_SESSIONS_DISCOVERY";

/** Restart delay for the n-th consecutive failure (n = failures BEFORE this one, starting at 0). */
export function serviceBackoffDelay(priorFailures: number): number {
  return Math.min(SERVICE_BACKOFF_BASE_MS * 2 ** priorFailures, SERVICE_BACKOFF_MAX_MS);
}

// ── public types ──

/** One declared service of one plugin, resolved for this tick by the caller. */
export interface ServiceCandidate {
  plugin: string;
  tier: PluginTier;
  /** Absolute plugin root (the child's cwd; relative commands resolve against it). */
  root: string;
  service: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  /** Plugin enabled (managed `enabled` / not in state.disabled). */
  enabled: boolean;
  /** The current servicesHash has a consent grant. */
  consented: boolean;
  /** Workspace trust for project-tier plugins (non-project tiers ignore it). */
  trusted: boolean;
  /**
   * Taskana 4751 part 0: values of the `${secret:NAME}` references in `service.env`,
   * resolved by the candidate source. Goes only into the child env; never logged or viewed.
   */
  secretValues?: Readonly<Record<string, string>>;
  /** Referenced secret NAMES that are not set. Any entry blocks the service (`missing_secret`). */
  missingSecrets?: readonly string[];
}

export interface ServiceSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  shell: false;
  windowsHide: true;
  stdio: ["ignore", "pipe", "pipe"];
  /** POSIX: own process group, so the whole tree can be signalled. */
  detached: boolean;
}

/** A running child, as the supervisor sees it (the real adapter wraps node:child_process). */
export interface ServiceProcess {
  pid?: number;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  onError(cb: (error: Error) => void): void;
  /** `tree=true` signals the whole process group (POSIX) / tree (win32). Never throws. */
  kill(tree: boolean): void;
}

export type ServiceBlockedReason = "no_consent" | "untrusted" | "disabled" | "bad_command" | "missing_secret";

export type ServiceState = "stopped" | "starting" | "running" | "backoff" | "crash_loop" | "blocked";

export interface ServiceView {
  plugin: string;
  name: string;
  state: ServiceState;
  reason?: ServiceBlockedReason;
  pid?: number;
  restarts: number;
  restartInSec?: number;
  lastExit?: string;
  /** Secret NAMES a `missing_secret` block is waiting for (names only). */
  missingSecrets?: string[];
}

export interface ServiceSupervisorDeps {
  listCandidates(): Promise<ServiceCandidate[]>;
  spawn(spec: ServiceSpawnSpec): ServiceProcess;
  /** Absolute path of the Sessions-API discovery file while the API runs; undefined otherwise. */
  discoveryFile(): string | undefined;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Inherited environment (the app's); only the allow-list is copied. Defaults to none. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Platform for the detached/kill policy. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  logger?: { warn(message: string, ...args: unknown[]): void };
  /** Called after every state or log change (the pane polls; this is for future push). */
  onChange?(): void;
}

export interface ServiceSupervisor {
  /** Diffs desired (candidates) against running; serialised and idempotent. */
  reconcile(): Promise<void>;
  /** Quit: stops every service and resolves when they exit or after the hard deadline. Never throws. */
  stopAll(): Promise<void>;
  /** Manual restart: clears backoff and crash loop, then starts the service if it is eligible. */
  restart(plugin: string, name: string): Promise<void>;
  snapshot(): ServiceView[];
  logs(plugin: string, name: string): string[];
}

// ── log ring ──

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

class LogRing {
  private lines: string[] = [];
  private bytes = 0;

  push(raw: string): void {
    const clean = raw.replace(ANSI_RE, "").slice(0, SERVICE_LOG_LINE_MAX_CHARS);
    this.lines.push(clean);
    this.bytes += Buffer.byteLength(clean, "utf8") + 1;
    while (this.lines.length > SERVICE_LOG_MAX_LINES || this.bytes > SERVICE_LOG_MAX_BYTES) {
      const dropped = this.lines.shift();
      if (dropped === undefined) break;
      this.bytes -= Buffer.byteLength(dropped, "utf8") + 1;
    }
  }

  snapshot(): string[] {
    return [...this.lines];
  }
}

/** Splits a chunked stream into whole lines, buffering the trailing partial line. */
class LineSplitter {
  private partial = "";

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: string): void {
    const text = this.partial + chunk;
    const parts = text.split("\n");
    this.partial = parts.pop() ?? "";
    for (const part of parts) {
      this.onLine(part.replace(/\r$/, ""));
    }
  }

  flush(): void {
    if (this.partial.length > 0) {
      this.onLine(this.partial);
      this.partial = "";
    }
  }
}

// ── internals ──

interface Entry {
  key: string;
  plugin: string;
  name: string;
  candidate?: ServiceCandidate;
  state: ServiceState;
  reason?: ServiceBlockedReason;
  proc?: ServiceProcess;
  /** Incremented per spawn; callbacks of an older process are ignored. */
  gen: number;
  pid?: number;
  fingerprint?: string;
  /** The current process was stopped by the supervisor (not a crash). */
  intentional: boolean;
  startedAt?: number;
  /** Consecutive failures (reset by a stable run or a manual restart). */
  failures: number;
  /** Timestamps of recent failures, pruned to the breaker window. */
  failureTimes: number[];
  backoffUntil?: number;
  backoffTimer?: unknown;
  restarts: number;
  lastExit?: string;
  missingSecrets?: string[];
  log: LogRing;
  exitWaiters: (() => void)[];
  stdoutSplit: LineSplitter;
  stderrSplit: LineSplitter;
}

function keyOf(plugin: string, name: string): string {
  return `${plugin}/${name}`;
}

function eligibilityReason(c: ServiceCandidate): ServiceBlockedReason | undefined {
  if (!c.enabled) return "disabled";
  if (!c.consented) return "no_consent";
  if (c.tier === "project" && !c.trusted) return "untrusted";
  if ((c.missingSecrets ?? []).length > 0) return "missing_secret";
  return undefined;
}

/** Resolves the spawn command; undefined when a `./` path escapes the plugin root. */
function resolveCommand(root: string, command: string): string | undefined {
  if (command.startsWith("./")) {
    const full = resolve(root, command);
    const fromRoot = relative(root, full);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      return undefined;
    }
    return full;
  }
  return command;
}

/**
 * Builds the child env: base allow-list + manifest env (with `${secret:NAME}`
 * expanded from the candidate's resolved values) + AnyCode vars. Inherited
 * ANYCODE_* never pass.
 */
export function buildServiceEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  candidate: ServiceCandidate,
  discoveryPath: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SERVICE_BASE_ENV_KEYS) {
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(candidate.service.env)) {
    env[key] = expandServiceSecrets(value, candidate.secretValues ?? {});
  }
  env.ANYCODE_PLUGIN_NAME = candidate.plugin;
  env.ANYCODE_PLUGIN_DIR = candidate.root;
  env.ANYCODE_SERVICE_NAME = candidate.service.name;
  if (discoveryPath !== undefined) {
    env[SESSIONS_DISCOVERY_ENV] = discoveryPath;
  }
  return env;
}

function fingerprintOf(c: ServiceCandidate, discoveryPath: string | undefined): string {
  return JSON.stringify([
    c.root,
    c.service.command,
    c.service.args,
    Object.entries(c.service.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    discoveryPath ?? null,
  ]);
}

export function createServiceSupervisor(deps: ServiceSupervisorDeps): ServiceSupervisor {
  const entries = new Map<string, Entry>();
  const platform = deps.platform ?? process.platform;
  const inheritedEnv = deps.env ?? {};
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const notify = () => {
    try {
      deps.onChange?.();
    } catch {
      // a broken listener must not disturb supervision
    }
  };

  const enqueue = <T>(task: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  function entryFor(plugin: string, name: string): Entry {
    const key = keyOf(plugin, name);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        key,
        plugin,
        name,
        state: "stopped",
        gen: 0,
        intentional: false,
        failures: 0,
        failureTimes: [],
        restarts: 0,
        log: new LogRing(),
        exitWaiters: [],
        stdoutSplit: new LineSplitter((line) => entry!.log.push(line)),
        stderrSplit: new LineSplitter((line) => entry!.log.push(`[err] ${line}`)),
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function supLog(entry: Entry, message: string): void {
    entry.log.push(`[sup] ${message}`);
  }

  function clearBackoff(entry: Entry): void {
    if (entry.backoffTimer !== undefined) {
      deps.clearTimer(entry.backoffTimer);
      entry.backoffTimer = undefined;
    }
    entry.backoffUntil = undefined;
  }

  function setBlocked(entry: Entry, reason: ServiceBlockedReason, missingSecrets?: readonly string[]): void {
    clearBackoff(entry);
    entry.state = "blocked";
    entry.reason = reason;
    entry.missingSecrets = reason === "missing_secret" ? [...(missingSecrets ?? [])] : undefined;
    // A blocked service has no breaker state: the next eligibility starts fresh.
    entry.failures = 0;
    entry.failureTimes = [];
    notify();
  }

  function handleFailure(entry: Entry, gen: number, reason: string): void {
    if (gen !== entry.gen) return;
    const now = deps.now();
    entry.failureTimes = entry.failureTimes.filter((t) => now - t < SERVICE_CRASH_LOOP_WINDOW_MS);
    entry.failureTimes.push(now);
    const delay = serviceBackoffDelay(entry.failures);
    entry.failures += 1;
    if (entry.failureTimes.length >= SERVICE_CRASH_LOOP_FAILURES) {
      entry.state = "crash_loop";
      entry.reason = undefined;
      supLog(entry, "crash loop: automatic restarts stopped (use Restart)");
      if (deps.logger) deps.logger.warn(`service ${entry.key} entered crash loop (${reason})`);
      notify();
      return;
    }
    entry.state = "backoff";
    entry.backoffUntil = now + delay;
    supLog(entry, `restart in ${Math.round(delay / 1000)}s`);
    entry.backoffTimer = deps.setTimer(() => {
      entry.backoffTimer = undefined;
      entry.backoffUntil = undefined;
      void enqueue(() => {
        if (closed || entry.state !== "backoff" || entry.candidate === undefined) return;
        startProcess(entry, entry.candidate, deps.discoveryFile());
        notify();
      });
    }, delay);
    notify();
  }

  function startProcess(
    entry: Entry,
    candidate: ServiceCandidate,
    discoveryPath: string | undefined,
    manual = false,
  ): void {
    clearBackoff(entry);
    if ((candidate.missingSecrets ?? []).length > 0) {
      // Defence in depth: reconcile never starts a candidate with unresolved refs.
      setBlocked(entry, "missing_secret", candidate.missingSecrets);
      supLog(entry, "not started: a referenced secret is not set");
      return;
    }
    const command = resolveCommand(candidate.root, candidate.service.command);
    if (command === undefined) {
      entry.state = "blocked";
      entry.reason = "bad_command";
      supLog(entry, "refused: command escapes the plugin folder");
      notify();
      return;
    }
    const gen = ++entry.gen;
    const hadProcess = entry.pid !== undefined || entry.lastExit !== undefined;
    entry.state = "starting";
    entry.reason = undefined;
    entry.intentional = false;
    entry.stdoutSplit = new LineSplitter((line) => entry.log.push(line));
    entry.stderrSplit = new LineSplitter((line) => entry.log.push(`[err] ${line}`));
    let proc: ServiceProcess;
    try {
      proc = deps.spawn({
        command,
        args: [...candidate.service.args],
        cwd: candidate.root,
        env: buildServiceEnv(inheritedEnv, candidate, discoveryPath),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
      });
    } catch (error) {
      entry.proc = undefined;
      entry.pid = undefined;
      supLog(entry, `spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      handleFailure(entry, gen, "spawn");
      return;
    }
    entry.proc = proc;
    entry.pid = proc.pid;
    entry.fingerprint = fingerprintOf(candidate, discoveryPath);
    entry.startedAt = deps.now();
    entry.state = "running";
    // `restarts` counts automatic restarts since the last manual start.
    if (hadProcess && !manual) entry.restarts += 1;
    supLog(entry, `started pid ${proc.pid ?? "?"}`);

    proc.onStdout((chunk) => {
      if (gen === entry.gen) entry.stdoutSplit.feed(chunk);
    });
    proc.onStderr((chunk) => {
      if (gen === entry.gen) entry.stderrSplit.feed(chunk);
    });
    proc.onError((error) => {
      if (gen !== entry.gen) return;
      supLog(entry, `error: ${error.message}`);
      finishProcess(entry, gen, null, "error", true);
    });
    proc.onExit((code, signal) => {
      finishProcess(entry, gen, code, signal, false);
    });
    notify();
  }

  function finishProcess(entry: Entry, gen: number, code: number | null, signal: string | null, errored: boolean): void {
    if (gen !== entry.gen || entry.proc === undefined) return;
    entry.stdoutSplit.flush();
    entry.stderrSplit.flush();
    entry.proc = undefined;
    entry.pid = undefined;
    const summary = signal !== null && signal !== undefined ? `signal ${signal}` : `code ${code ?? "null"}`;
    entry.lastExit = summary;
    supLog(entry, `exited ${summary}`);
    const waiters = entry.exitWaiters.splice(0);
    for (const resolveWaiter of waiters) resolveWaiter();
    if (entry.intentional) {
      notify();
      return;
    }
    // A run that lasted long enough is a healthy run: it resets the failure streak.
    if (entry.startedAt !== undefined && deps.now() - entry.startedAt >= SERVICE_STABLE_RUN_MS) {
      entry.failures = 0;
      entry.failureTimes = [];
    }
    handleFailure(entry, gen, errored ? "spawn error" : `exit ${summary}`);
  }

  /** Stops a running process and waits for its exit, or the hard deadline. */
  async function stopEntry(entry: Entry): Promise<void> {
    if (entry.proc === undefined) return;
    entry.intentional = true;
    const proc = entry.proc;
    const exited = new Promise<void>((resolveExit) => {
      entry.exitWaiters.push(resolveExit);
    });
    let deadlineHandle: unknown;
    const deadline = new Promise<void>((resolveDeadline) => {
      deadlineHandle = deps.setTimer(() => resolveDeadline(), SERVICE_STOP_ALL_DEADLINE_MS);
    });
    try {
      proc.kill(true);
    } catch {
      // kill never throws by contract; a broken adapter must not wedge the stop
    }
    await Promise.race([exited, deadline]);
    deps.clearTimer(deadlineHandle);
    if (entry.proc === proc) {
      // Deadline passed with the process still alive: abandon the handle so the
      // supervisor does not block forever; the adapter's SIGKILL escalation owns it.
      supLog(entry, "stop deadline passed; process abandoned");
      entry.proc = undefined;
      entry.pid = undefined;
    }
    entry.intentional = false;
  }

  async function removeEntry(entry: Entry): Promise<void> {
    clearBackoff(entry);
    await stopEntry(entry);
    entries.delete(entry.key);
    notify();
  }

  async function reconcileNow(): Promise<void> {
    if (closed) return;
    let candidates: ServiceCandidate[];
    try {
      candidates = await deps.listCandidates();
    } catch (error) {
      deps.logger?.warn("service reconcile: could not list candidates", error);
      return;
    }
    if (closed) return; // quit began while the candidate scan was in flight
    const discoveryPath = deps.discoveryFile();
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const entry = entryFor(candidate.plugin, candidate.service.name);
      seen.add(entry.key);
      entry.candidate = candidate;
      const reason = eligibilityReason(candidate);
      if (reason !== undefined) {
        await stopEntry(entry);
        setBlocked(entry, reason, candidate.missingSecrets);
        continue;
      }
      const fp = fingerprintOf(candidate, discoveryPath);
      if (entry.proc !== undefined) {
        if (entry.fingerprint !== fp) {
          // Definition, consent-scope or discovery path changed: one restart with the new spec.
          await stopEntry(entry);
          startProcess(entry, candidate, discoveryPath);
          notify();
        }
        continue;
      }
      if (entry.state === "backoff") {
        if (entry.fingerprint !== fp) {
          clearBackoff(entry);
          startProcess(entry, candidate, discoveryPath);
          notify();
        }
        continue;
      }
      if (entry.state === "crash_loop") {
        // The breaker holds until the definition changes (a consent change arrives as blocked -> eligible).
        if (entry.fingerprint !== fp) {
          entry.failures = 0;
          entry.failureTimes = [];
          startProcess(entry, candidate, discoveryPath);
          notify();
        }
        continue;
      }
      startProcess(entry, candidate, discoveryPath);
      notify();
    }
    for (const entry of [...entries.values()]) {
      if (!seen.has(entry.key)) {
        await removeEntry(entry);
      }
    }
  }

  return {
    reconcile: () => enqueue(() => reconcileNow()),

    async stopAll(): Promise<void> {
      try {
        closed = true;
        const running = [...entries.values()].filter((entry) => {
          clearBackoff(entry);
          return entry.proc !== undefined;
        });
        const stops = Promise.all(running.map((entry) => stopEntry(entry)));
        let deadlineHandle: unknown;
        const deadline = new Promise<void>((resolveDeadline) => {
          deadlineHandle = deps.setTimer(() => resolveDeadline(), SERVICE_STOP_ALL_DEADLINE_MS);
        });
        await Promise.race([stops, deadline]);
        deps.clearTimer(deadlineHandle);
        for (const entry of entries.values()) {
          if (entry.state === "running" || entry.state === "starting" || entry.state === "backoff") {
            entry.state = "stopped";
          }
        }
        notify();
      } catch (error) {
        deps.logger?.warn("service stopAll failed", error);
      }
    },

    restart(plugin: string, name: string): Promise<void> {
      return enqueue(async () => {
        const entry = entries.get(keyOf(plugin, name));
        if (entry === undefined || entry.candidate === undefined || closed) return;
        clearBackoff(entry);
        entry.failures = 0;
        entry.failureTimes = [];
        entry.restarts = 0;
        await stopEntry(entry);
        const candidate = entry.candidate;
        const reason = eligibilityReason(candidate);
        if (reason !== undefined) {
          setBlocked(entry, reason, candidate.missingSecrets);
          return;
        }
        startProcess(entry, candidate, deps.discoveryFile(), true);
        notify();
      });
    },

    snapshot(): ServiceView[] {
      const now = deps.now();
      return [...entries.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((entry) => ({
          plugin: entry.plugin,
          name: entry.name,
          state: entry.state,
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
          ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
          restarts: entry.restarts,
          ...(entry.backoffUntil !== undefined ? { restartInSec: Math.max(0, Math.ceil((entry.backoffUntil - now) / 1000)) } : {}),
          ...(entry.lastExit !== undefined ? { lastExit: entry.lastExit } : {}),
          ...(entry.reason === "missing_secret" && entry.missingSecrets !== undefined
            ? { missingSecrets: [...entry.missingSecrets] }
            : {}),
        }));
    },

    logs(plugin: string, name: string): string[] {
      return entries.get(keyOf(plugin, name))?.log.snapshot() ?? [];
    },
  };
}

/**
 * Bounded "claude doctor" one-shot probe (SLICE-CC A3, cut §1.2 mirror of
 * main/codex-doctor.ts): trust-gate -> `--version` preflight (floor gate
 * `>=2.1.212`, R5-proved zero structural drift 212->214) -> auth-probe -> report.
 *
 * Auth-probe = EXACTLY the $0 control-handshake technique proved by W0 probe
 * #13 (`references/claude-code-2.1.212/fixtures/w0-13-authprobe-signed{in,out}.jsonl`):
 * a single `control_request{subtype:"initialize"}` over stream-json NDJSON,
 * with `CLAUDE_CONFIG_DIR=<profile>`, NO user turn EVER sent, EOF immediately
 * after the `control_response` (~300-800ms live). Sending a "cheap prompt"
 * turn instead is a documented $0.16 antipattern (W0 probe #13,
 * `w0-13-authprobe-cheap.jsonl`) — this file must never construct a
 * `type:"user"` message.
 *
 * OWN MINIMAL NDJSON/control-protocol CLIENT, deliberately not shared with the
 * future host/engines/claude/claude-client.ts (CC-B): a host->main import is
 * architecturally forbidden (mirrors main/codex-doctor.ts's own header,
 * itself mirroring shared/codex-timeouts.ts's reasoning).
 *
 * CUSTODY (cut §0.2 invariant 2): the `initialize` response's `account` object
 * (email/organization/subscriptionType — live, un-gated by `--setting-sources`,
 * W0 probe #2) is read ONLY long enough to compute the ready/signed_out
 * discriminator below and is then discarded — `ClaudeDoctorReport`
 * (shared/claude-doctor.ts) never carries it, and this file never logs it.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { checkClaudeBinaryPathTrust } from "./claude-binary.js";
import type { ClaudeDoctorReport } from "../shared/claude-doctor.js";

// ── version floor gate (cut §0.2 invariant 4 / §0.3-9: a floor, never an
// exact pin — R5 measured zero structural drift on initialize/get_usage/
// get_context_usage between 2.1.212 and 2.1.214) ──

const CLAUDE_MIN_VERSION = { major: 2, minor: 1, patch: 212 } as const;

interface ParsedClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** `claude --version` prints "<major>.<minor>.<patch> (Claude Code)" (verified live on the system binary, 2.1.214) — tolerant to a trailing-suffix drift, strict on the leading semver. */
export function parseClaudeVersion(output: string): ParsedClaudeVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersion(a: ParsedClaudeVersion, b: ParsedClaudeVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Floor only — no ceiling. */
export function meetsClaudeVersionFloor(version: ParsedClaudeVersion): boolean {
  return compareVersion(version, CLAUDE_MIN_VERSION) >= 0;
}

// ── doctor-scoped timeouts (local, NOT shared/claude-timeouts.ts — that
// module is CC-B's, for the long-lived engine client's teardown recipe; this
// bounded one-shot probe owns its own small, conservative constants) ──

const VERSION_PREFLIGHT_TIMEOUT_MS = 3_000;
/** Live ack lands in ~300-800ms (w0-13-authprobe-signedin.jsonl); generous bound. */
const INIT_HANDSHAKE_TIMEOUT_MS = 5_000;
/** No tool ever runs during a handshake-only probe, so there is no background-bash drain to wait out (unlike CC-B's long-lived engine teardown). */
const TEARDOWN_STDIN_EOF_WAIT_MS = 1_000;
const TEARDOWN_SIGTERM_WAIT_MS = 1_000;
const TEARDOWN_SIGKILL_WAIT_MS = 1_000;

const MAX_LINE_BYTES = 5 * 1024 * 1024;

/**
 * Spawn argv proven live by W0 probes #2/#7/#13 (fixtures
 * `w0-13-authprobe-signed{in,out}.jsonl`, `w0-07-verify1-configdir-probe.jsonl`):
 * `--permission-prompt-tool stdio` is required for the control channel to be
 * live at all (probe #2 — without it headless `-p` silently auto-denies and
 * never routes anything to us, though the `initialize` handshake itself is
 * independent of the permission bridge); `--setting-sources project,local
 * --strict-mcp-config` is the isolation baseline every W0 capture used.
 * `--permission-mode default` is the EXACT flag value the harness passed for
 * these captures — the doctor never exercises permission mode (no tool call
 * ever happens on a handshake-only run), so this reproduces the proven
 * invocation byte-for-byte rather than substituting an untested value.
 */
const AUTH_PROBE_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--setting-sources",
  "project,local",
  "--strict-mcp-config",
  "--permission-prompt-tool",
  "stdio",
  "--permission-mode",
  "default",
];

/**
 * Explicit child env allowlist (mirrors main/codex-doctor.ts's
 * `buildDoctorChildEnv`, duplicated for the same host->main-independence
 * reason — see this file's header). Never spreads the doctor's own
 * `process.env` wholesale: no ambient ANYCODE_/ANTHROPIC secret leaks into
 * the spawned Claude child this way. Hygiene vars mirror the CC-B spawn
 * recipe (cut §1.3) since they cost nothing and are harmless on a
 * handshake-only probe; `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (silently
 * override the subscription) and the ambient `CLAUDECODE` (breaks a nested
 * claude-under-claude-code launch — our own dev run inherits it) are excluded
 * by the allowlist, never forwarded.
 */
export function buildClaudeDoctorChildEnv(
  source: NodeJS.ProcessEnv,
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const posixKeys = [
    "HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  ];
  const winKeys = [
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH", "PATHEXT",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "USERNAME", "PROGRAMDATA",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of platform === "win32" ? winKeys : posixKeys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  // Custody (cut §0.2 invariant 2, C1): every spawn goes with a DEDICATED
  // CLAUDE_CONFIG_DIR, never the ambient default `~/.claude` implicitly — this
  // is the ONE mechanism that closes both credential AND CLAUDE.md/AutoMem
  // custody (R1/VERIFY-1, W0-FINDINGS §"R1"). Callers that want to diagnose
  // the real default profile pass its path explicitly (never omit this var).
  env.CLAUDE_CONFIG_DIR = profileDir;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.CLAUDE_CODE_ENTRYPOINT = "anycode";
  return env;
}

// ── result projection (custody-cleared: never retains account/email) ──

/**
 * `true` when the `initialize` response's `account` reflects a signed-in
 * profile (W0 probe #13 discriminator: `account.tokenSource !== "none"`,
 * equivalently `account.subscriptionType !== undefined`). Reads ONLY
 * `tokenSource`/`subscriptionType` — never retains `email`/`organization`.
 */
function isClaudeSignedIn(account: unknown): boolean {
  if (typeof account !== "object" || account === null) return false;
  const tokenSource = (account as { tokenSource?: unknown }).tokenSource;
  const subscriptionType = (account as { subscriptionType?: unknown }).subscriptionType;
  if (typeof tokenSource === "string") return tokenSource !== "none";
  return subscriptionType !== undefined;
}

// ── bounded process-group helpers (mirror main/codex-doctor.ts's) ──

function raceExitOrTimeout(exited: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** `kill(-pgid, 0)` is a pure existence probe: an empty group raises ESRCH, the success case. */
function sweepGroup(pid: number | undefined): void {
  if (pid === undefined || process.platform === "win32") return;
  try {
    process.kill(-pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // raced us to exit
  }
}

function signalGroupOrChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // group already gone; narrow fallback below
    }
  }
  try {
    child.kill(signal);
  } catch {
    // best effort only
  }
}

interface PreflightResult {
  version?: string;
  error?: string;
}

/**
 * `--version` preflight: its own short-lived process GROUP, reaped on every
 * settle path (mirrors main/codex-doctor.ts's `preflightVersion`) — a wrapper
 * script that forks a grandchild and hangs must not strand it.
 */
function preflightVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
  timeoutMs: number,
  cancellation?: DoctorCancellation,
): Promise<PreflightResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let disarm: () => void = () => {};
    const child = spawnImpl(binaryPath, ["--version"], {
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settle = (result: PreflightResult): void => {
      if (settled) return;
      settled = true;
      disarm();
      clearTimeout(timer);
      // The group dies before this promise resolves, on EVERY path including
      // cancellation — that is the property the outer watchdog now depends on.
      signalGroupOrChild(child, "SIGKILL");
      resolve(result);
    };
    disarm = cancellation?.arm(() => settle({ error: "claude doctor aborted" })) ?? (() => {});
    const timer = setTimeout(() => {
      settle({ error: `Claude version check timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => settle({ error: `Claude version check failed: ${error.message}` }));
    child.once("close", (code) => {
      if (code !== 0) {
        settle({ error: `Claude version check exited with code ${code ?? "null"}` });
        return;
      }
      settle({ version: stdout });
    });
  });
}

type HandshakeResult = { ok: true; account: unknown } | { ok: false; error: string };

/**
 * The auth-probe itself: spawn -> ONE `control_request{subtype:"initialize"}`
 * -> wait for the matching `control_response` -> bounded teardown, EOF right
 * after (never a user turn — W0 probe #13's proven $0 recipe). The child's
 * process GROUP is torn down before this function resolves, on every path.
 */
async function runInitializeHandshake(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
  timeoutMs: number,
  cancellation?: DoctorCancellation,
): Promise<HandshakeResult> {
  const child = spawnImpl(binaryPath, AUTH_PROBE_ARGS, {
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const requestId = randomUUID();
  const decoder = new StringDecoder("utf8");
  let lineBuffer = "";

  const result = await new Promise<HandshakeResult>((resolve) => {
    let settled = false;
    let disarm: () => void = () => {};
    const settle = (value: HandshakeResult): void => {
      if (settled) return;
      settled = true;
      disarm();
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, error: `Claude auth-probe timed out after ${timeoutMs}ms waiting for control_response` });
    }, timeoutMs);
    // Cancellation settles this promise early, but the bounded teardown below
    // it still runs to completion before the function returns — the child is
    // never left behind for an app exit to orphan.
    disarm = cancellation?.arm(() => settle({ ok: false, error: "claude doctor aborted" })) ?? (() => {});

    child.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += decoder.write(chunk);
      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line === "") continue;
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          settle({ ok: false, error: `Claude process emitted a line exceeding ${MAX_LINE_BYTES} bytes` });
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // tolerant: skip a malformed line rather than failing the whole probe
        }
        if (typeof message !== "object" || message === null) continue;
        const envelope = message as {
          type?: unknown;
          response?: { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown };
        };
        if (envelope.type === "control_response" && envelope.response?.request_id === requestId) {
          if (envelope.response.subtype === "success") {
            const account = (envelope.response.response as { account?: unknown } | undefined)?.account;
            settle({ ok: true, account });
          } else {
            const errorText = typeof envelope.response.error === "string" ? envelope.response.error : "unknown control error";
            settle({ ok: false, error: `Claude control-protocol initialize failed: ${errorText}` });
          }
          return;
        }
        // Any other message is ignored — this probe answers exactly one
        // question over the control channel and never sends a user turn
        // regardless of what else the CLI happens to emit.
      }
    });
    child.stdout?.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.once("error", (error) => settle({ ok: false, error: `Claude auth-probe spawn error: ${error.message}` }));
    child.once("close", () => {
      settle({ ok: false, error: "Claude process exited before completing the initialize handshake" });
    });

    try {
      child.stdin?.write(
        `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`,
      );
    } catch (error) {
      settle({
        ok: false,
        error: `Claude auth-probe failed to write initialize request: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  // Bounded, EOF-first teardown (cut §1.2 test-hazard (a)): EOF right after
  // the control_response — no session file is ever created because no turn
  // ever ran.
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    child.stdin?.end();
  } catch {
    // may have already exited
  }
  if (!(await raceExitOrTimeout(exited, TEARDOWN_STDIN_EOF_WAIT_MS))) {
    signalGroupOrChild(child, "SIGTERM");
    if (!(await raceExitOrTimeout(exited, TEARDOWN_SIGTERM_WAIT_MS))) {
      signalGroupOrChild(child, "SIGKILL");
      await raceExitOrTimeout(exited, TEARDOWN_SIGKILL_WAIT_MS);
    }
  }
  sweepGroup(pid);

  return result;
}

/**
 * Relays the outer watchdog/abort INTO whichever phase is currently running.
 *
 * Racing the phase chain to a return instead (`Promise.race([steps, aborted])`)
 * is what this replaces, and it was unsound: the race resolves while the phase
 * is still holding a live, detached `claude` child, so the caller believes the
 * doctor settled and an immediate app exit abandons the teardown promise —
 * leaving the process group orphaned. Cancelling through this instead lets the
 * active phase settle EARLY but still through its own bounded EOF/TERM/KILL
 * chain, so `runClaudeDoctor` never returns while a child is alive.
 */
class DoctorCancellation {
  private active: (() => void) | null = null;
  private tripped = false;

  get cancelled(): boolean {
    return this.tripped;
  }

  /**
   * Registers the running phase's early-settle. Returns its disarm, which the
   * phase MUST call once it settles for any reason. An already-tripped
   * cancellation settles the phase immediately.
   */
  arm(cancel: () => void): () => void {
    if (this.tripped) {
      cancel();
      return () => {};
    }
    this.active = cancel;
    return () => {
      if (this.active === cancel) this.active = null;
    };
  }

  trip(): void {
    if (this.tripped) return;
    this.tripped = true;
    const cancel = this.active;
    this.active = null;
    cancel?.();
  }
}

export interface RunClaudeDoctorOptions {
  /** Overall watchdog; defaults to the sum of every phase below plus headroom. */
  timeoutMs?: number;
  /** Source env the child's allowlisted env is built from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** DI seam for tests (fake/adversarial children). */
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Aborts the run (app quit): the in-flight phase gives up; its own bounded teardown still runs before it settles. */
  signal?: AbortSignal;
  /** DI seam for the spawn-time trust gate; production re-reads the real filesystem (`checkClaudeBinaryPathTrust`). */
  trust?: (binaryPath: string) => string | null;
  /**
   * Absolute `CLAUDE_CONFIG_DIR` this run diagnoses (cut §0.3-7: the doctor
   * probes the profile it is TOLD to, never assumes `~/.claude` implicitly).
   * Required — callers pass `main/claude-binary.ts`'s
   * `defaultClaudeProfileDir()` result, or an isolated temp dir to prove the
   * `signed_out` discriminator.
   */
  profileDir: string;
  versionTimeoutMs?: number;
  initTimeoutMs?: number;
}

/**
 * Runs one bounded doctor pass against `binaryPath`, diagnosing
 * `options.profileDir`. Never throws — every failure mode (timeout, spawn
 * error, malformed wire, unsupported version, signed-out) resolves to a
 * `ClaudeDoctorReport`. The spawned child (if any) is ALWAYS torn down
 * (bounded) before this function returns.
 */
export async function runClaudeDoctor(binaryPath: string, options: RunClaudeDoctorOptions): Promise<ClaudeDoctorReport> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;
  const trust = options.trust ?? ((path: string) => checkClaudeBinaryPathTrust(path, undefined, platform));
  const versionTimeoutMs = options.versionTimeoutMs ?? VERSION_PREFLIGHT_TIMEOUT_MS;
  const initTimeoutMs = options.initTimeoutMs ?? INIT_HANDSHAKE_TIMEOUT_MS;
  const watchdogMs =
    options.timeoutMs ??
    versionTimeoutMs + initTimeoutMs + TEARDOWN_STDIN_EOF_WAIT_MS + TEARDOWN_SIGTERM_WAIT_MS + TEARDOWN_SIGKILL_WAIT_MS + 2_000;
  const childEnv = buildClaudeDoctorChildEnv(options.env ?? process.env, options.profileDir, platform);
  const cancellation = new DoctorCancellation();
  const quitRequested = (): boolean => options.signal?.aborted === true || cancellation.cancelled;

  const steps = async (): Promise<ClaudeDoctorReport> => {
    if (quitRequested()) {
      return { status: "error", error: "claude doctor aborted" };
    }
    const untrusted = trust(binaryPath);
    if (untrusted !== null) {
      return { status: "error", error: untrusted };
    }
    const preflight = await preflightVersion(binaryPath, childEnv, spawnImpl, versionTimeoutMs, cancellation);
    if (preflight.error !== undefined) {
      return { status: "error", error: preflight.error };
    }
    const parsed = parseClaudeVersion(preflight.version ?? "");
    if (parsed === null) {
      return { status: "error", error: `Unrecognized Claude version output: ${(preflight.version ?? "").trim() || "(empty)"}` };
    }
    const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (!meetsClaudeVersionFloor(parsed)) {
      return { status: "update_required", version };
    }

    if (quitRequested()) {
      return { status: "error", error: "claude doctor aborted" };
    }
    // Re-validated immediately before this spawn (TOCTOU narrowing, mirrors
    // main/codex-doctor.ts) — the preflight's own trust check is now stale by
    // a whole `--version` round trip.
    const untrustedAtSpawn = trust(binaryPath);
    if (untrustedAtSpawn !== null) {
      return { status: "error", error: untrustedAtSpawn };
    }

    const handshake = await runInitializeHandshake(binaryPath, childEnv, spawnImpl, initTimeoutMs, cancellation);
    if (!handshake.ok) {
      return { status: "error", version, error: handshake.error };
    }
    // Custody: `handshake.account` is read exactly once, right here, to
    // decide signed-in vs signed-out — never stored, never logged, and never
    // reaches the returned report (cut §0.2 invariant 2).
    return { status: isClaudeSignedIn(handshake.account) ? "ready" : "signed_out", version };
  };

  // The watchdog and the abort signal both CANCEL rather than race: whichever
  // fires trips the active phase, and we then AWAIT the phase chain so its
  // bounded teardown (EOF -> SIGTERM -> SIGKILL -> group sweep) has completed
  // before this function returns. Returning early instead would hand the caller
  // a settled doctor while a detached `claude` child was still alive, and an
  // immediate app exit would abandon the teardown promise and orphan the group.
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    cancellation.trip();
  }, watchdogMs);
  const onAbort = (): void => cancellation.trip();
  const signal = options.signal;
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) cancellation.trip();

  try {
    const report = await steps();
    if (!cancellation.cancelled) return report;
    return {
      status: "error",
      error: watchdogFired ? `claude doctor exceeded its ${watchdogMs}ms watchdog` : "claude doctor aborted",
    };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", onAbort);
  }
}

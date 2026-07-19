/**
 * Native Claude subscription login (SLICE-CC-LOGIN, TASK.66, cut §1/§4):
 * writes a tiny, custody-clean `.command` script into `os.tmpdir()` and hands
 * it to `openPath` (main injects `shell.openPath`, tests inject a spy) — the
 * REAL terminal that opens is not our child, we never spawn anything here.
 * Readiness is observed by polling the caller-supplied `probe` (main wires
 * this to the existing bounded claude-doctor via claude-ipc.ts's exclusive
 * controller — see that file's own header), never by a second codepath that
 * reads Claude account state.
 *
 * P0 probe verdict (working-docs/build/evidence/cc-login-P0.md): the cut's
 * assumed `claude /login` CLI arg-form does not exist (`/login` is a
 * REPL-only slash-command); the live-evidenced, CLI-documented command is
 * `claude auth login` (default `--claudeai`, prints "Opening browser to sign
 * in", falls back to a printed OAuth URL, waits at a paste-code prompt) —
 * `buildClaudeLoginScript`'s `"login-arg"` mode execs that instead. `"plain"`
 * (bare `exec "<binary>"`, no argv) is kept as the cut's own soft-degradation
 * seam, now purely forward-compat rather than today's uncertainty.
 *
 * CUSTODY (cut §2, hard invariants): this module never spawns a child with a
 * pipe — the terminal window is not ours to read from. It never parses,
 * logs, or returns anything token-shaped; the outcome carries only
 * `ok`/`reason`. The script file it writes contains nothing but three
 * `unset`s, an OPTIONAL env export of an explicit isolated-profile override
 * (owner pivot: omitted by default — ambient `~/.claude` is the product
 * default, so the script signs into the SAME profile the user's own terminal
 * already uses), and an `exec` of an already-trust-checked binary path — zero
 * secrets, `0700`, unlinked on every exit path (success, cancel, timeout,
 * failed, unsupported once a file was ever written).
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkClaudeBinaryPathTrust } from "./claude-binary.js";
import { resolveClaudeConfigDir } from "../shared/claude-config-dir.js";

/**
 * Generous, HUMAN-interaction bound (open the browser, sign in, paste a code
 * back if prompted) — mirrors codex-login.ts's own `CODEX_LOGIN_TIMEOUT_MS`
 * reasoning: this is its own independently bounded wait, not the doctor's
 * watchdog arithmetic.
 */
export const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Cut §4: how often the caller's `probe` (an exclusive doctor recheck) is polled while the terminal/browser flow is in the user's hands. */
export const CLAUDE_LOGIN_POLL_INTERVAL_MS = 10_000;

export type ClaudeLoginMode = "login-arg" | "plain";

export type ClaudeLoginOutcome =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "timeout" | "failed" | "unsupported" };

/** Filesystem seam for the script file — real `node:fs` in production, a spy/fake in tests (mirrors main/codex-profiles.ts's `CodexProfileFs` DI shape). */
export interface ClaudeLoginFs {
  mkdir(path: string, options: { recursive: boolean; mode: number }): void;
  writeFile(path: string, data: string, options: { mode: number }): void;
  unlink(path: string): void;
}

const nodeLoginFs: ClaudeLoginFs = {
  mkdir(path, options) {
    mkdirSync(path, options);
  },
  writeFile(path, data, options) {
    writeFileSync(path, data, options);
  },
  unlink(path) {
    unlinkSync(path);
  },
};

export interface RunClaudeLoginOptions {
  /**
   * Isolated-profile override (owner pivot: OPTIONAL). Omitted (the product
   * default) signs into the user's own ambient `~/.claude` — no dir is
   * mkdir'd and the script carries no `CLAUDE_CONFIG_DIR` export. An explicit
   * path keeps the isolated-profile capability available; it is mkdir'd
   * `0700` before the script is written, never assumed to pre-exist.
   */
  profileDir?: string;
  /** Opens the script in a real terminal (main injects `shell.openPath`; Electron's contract: resolves to `""` on success, a non-empty error string on failure). Tests inject a spy. */
  openPath: (path: string) => Promise<string> | string;
  /** Polled every `pollIntervalMs`; resolves `true` once the signed-in account is confirmed ready. The caller owns what "ready" means (main wires this to an exclusive claude-doctor recheck) — this module has no opinion on account state. */
  probe: () => Promise<boolean>;
  /** Resolves the in-flight wait early with `{ok:false, reason:"cancelled"}`; zero side effects if already aborted on entry. */
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fsImpl?: ClaudeLoginFs;
  /** DI seam for the spawn-time trust gate; production re-reads the real filesystem (`checkClaudeBinaryPathTrust`). */
  trust?: (binaryPath: string) => string | null;
  platform?: NodeJS.Platform;
  /** Cut §1 swap-seam: which argv `buildClaudeLoginScript` emits. Defaults to the P0-confirmed `"login-arg"`. */
  loginMode?: ClaudeLoginMode;
  /** Test seam for the script file's parent directory; production defaults to `os.tmpdir()`. */
  tmpDir?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POSIX single-quote escaping — safe even if a path happens to contain a space or a quote; every value here is already trust-checked or main's own fixed profile dir, never untrusted renderer input. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script contract: three `unset`s (an ambient `ANTHROPIC_API_KEY`/
 * `ANTHROPIC_AUTH_TOKEN` would silently override the subscription;
 * `CLAUDECODE` would break a nested claude-under-claude-code launch), an
 * OPTIONAL `export CLAUDE_CONFIG_DIR=` (owner pivot: omitted by default, so
 * the terminal's own `claude auth login` signs into the user's ambient
 * `~/.claude` — the isolated-profile export only appears for an explicit
 * override), and one `exec` of the trust-checked binary. Zero secrets ever
 * appear in this string — nothing here is derived from account/token state,
 * only from the (main-supplied) binary path and profile directory.
 */
export function buildClaudeLoginScript(binaryPath: string, profileDir?: string, mode: ClaudeLoginMode = "login-arg"): string {
  const execLine = mode === "login-arg" ? `exec ${shellQuote(binaryPath)} auth login` : `exec ${shellQuote(binaryPath)}`;
  const resolvedConfigDir = resolveClaudeConfigDir(profileDir);
  return [
    "#!/bin/sh",
    "unset ANTHROPIC_API_KEY",
    "unset ANTHROPIC_AUTH_TOKEN",
    "unset CLAUDECODE",
    ...(resolvedConfigDir !== undefined ? [`export CLAUDE_CONFIG_DIR=${shellQuote(resolvedConfigDir)}`] : []),
    execLine,
    "",
  ].join("\n");
}

/** Wrapped in a function (rather than inlined `signal?.aborted === true`) so TS's control-flow narrowing never treats a stale pre-await read as still valid post-await — `aborted` can flip between the two checks in `pollUntilReady` below. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Resolves `"cancelled"` the moment `signal` aborts (immediately, if already aborted); never resolves otherwise — a `Promise.race` partner, not a standalone await. */
function abortedPromise(signal: AbortSignal | undefined): Promise<"cancelled"> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resolve("cancelled");
      return;
    }
    signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });
}

/**
 * Polls `probe` every `pollIntervalMs` until it reports ready, the bound
 * `timeoutMs` elapses, or `signal` aborts — whichever comes first. Checks
 * `signal.aborted` synchronously before every `probe()` call (not just inside
 * the race) so a cancel landing between polls never fires one more wasted
 * recheck.
 */
async function pollUntilReady(
  probe: () => Promise<boolean>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ClaudeLoginOutcome> {
  const deadline = Date.now() + timeoutMs;
  const cancelled = abortedPromise(signal);
  for (;;) {
    if (isAborted(signal)) return { ok: false, reason: "cancelled" };
    if (Date.now() >= deadline) return { ok: false, reason: "timeout" };
    const probeOutcome = await Promise.race([probe().then((ready): "ready" | "not-ready" => (ready ? "ready" : "not-ready")), cancelled]);
    if (probeOutcome === "cancelled") return { ok: false, reason: "cancelled" };
    if (probeOutcome === "ready") return { ok: true };
    if (isAborted(signal)) return { ok: false, reason: "cancelled" };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: "timeout" };
    const waitOutcome = await Promise.race([delay(Math.min(pollIntervalMs, remaining)).then((): "waited" => "waited"), cancelled]);
    if (waitOutcome === "cancelled") return { ok: false, reason: "cancelled" };
  }
}

/**
 * Runs one bounded login attempt: trust-gate the binary, write the script,
 * hand it to `openPath`, then poll for readiness. Spawns nothing — the
 * terminal `openPath` opens is not this process's child, so there is no
 * teardown recipe to run (unlike codex-login.ts's `CodexRpcClient.close()`);
 * the ONLY resource this function owns is the script file, unlinked in a
 * `finally` on every exit path once it has been written.
 */
export async function runClaudeLogin(binaryPath: string, options: RunClaudeLoginOptions): Promise<ClaudeLoginOutcome> {
  // ENTRANCE GATE (mirrors codex-login.ts's W3.5-review lesson): a login
  // entered with an already-aborted signal must produce NO file and NO
  // terminal window at all, not one a `finally` unlinks a moment later.
  if (options.signal?.aborted === true) {
    return { ok: false, reason: "cancelled" };
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: false, reason: "unsupported" };
  }
  const fs = options.fsImpl ?? nodeLoginFs;
  const trust = options.trust ?? ((path: string) => checkClaudeBinaryPathTrust(path, undefined, platform));
  const timeoutMs = options.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? CLAUDE_LOGIN_POLL_INTERVAL_MS;
  const loginMode = options.loginMode ?? "login-arg";
  const scriptDir = options.tmpDir ?? tmpdir();

  if (trust(binaryPath) !== null) {
    return { ok: false, reason: "failed" };
  }

  let scriptPath: string | null = null;
  try {
    // Ambient by default (owner pivot): no override, no directory to create —
    // the terminal's own `claude auth login` writes into `~/.claude` itself.
    const resolvedConfigDir = resolveClaudeConfigDir(options.profileDir);
    if (resolvedConfigDir !== undefined) fs.mkdir(resolvedConfigDir, { recursive: true, mode: 0o700 });
    scriptPath = join(scriptDir, `anycode-claude-login-${randomUUID()}.command`);
    fs.writeFile(scriptPath, buildClaudeLoginScript(binaryPath, options.profileDir, loginMode), { mode: 0o700 });

    const openResult = await options.openPath(scriptPath);
    if (openResult !== "") {
      return { ok: false, reason: "failed" };
    }

    return await pollUntilReady(options.probe, options.signal, timeoutMs, pollIntervalMs);
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    if (scriptPath !== null) {
      try {
        fs.unlink(scriptPath);
      } catch {
        // best effort — the script is throwaway; a raced-away tmp file is not a custody issue.
      }
    }
  }
}

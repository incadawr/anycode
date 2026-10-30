/**
 * GitHub #3 follow-up: the Claude CLI's `system/init` names a failed MCP
 * server but never says WHY (no spawn error, no exit code, no stderr), so a
 * status row could previously only point at `claude mcp list`. This module
 * runs the server's own launch command once, with the same environment the
 * engine child gets (the login-shell PATH plus the spec's resolved env), and
 * turns the outcome into a short, secret-redacted cause:
 *
 *  - the launcher could not be spawned at all (ENOENT / EACCES / …);
 *  - the launcher exited (code or signal) before the probe timeout — a
 *    well-behaved MCP stdio server waits on stdin and never exits on its own;
 *  - the launcher was still alive at the timeout — NOT a failure: the command
 *    runs, so Claude's own refusal lives elsewhere and no cause is reported.
 *
 * The probe never completes the MCP handshake and never forwards the child's
 * stdin — it is a diagnostic, not a second server instance. Stderr is kept to
 * a short tail (few last lines, bounded chars) and redacted against the
 * spec's resolved secret values PLUS the values of sensitive-named variables
 * in the merged environment the child actually received (the probe child
 * inherits the full host env, and a crashing wrapper can dump unrelated
 * credentials the spec never mentioned) before it can reach a status row.
 * A still-alive launcher is shut down with a SIGTERM and a short grace
 * period before SIGKILL, so a launcher mid-write is not hard-killed.
 */
import { spawn } from "node:child_process";
import type { McpStdioServerSpec } from "@anycode/core";
import { redactSecrets, sensitiveEnvValues } from "@anycode/core";

/** A well-behaved stdio server waits on stdin indefinitely; the probe only outlives crashers. */
export const MCP_SPAWN_PROBE_TIMEOUT_MS = 10_000;
/** Grace period for our own SIGTERM before the probe escalates to SIGKILL. */
export const MCP_SPAWN_PROBE_KILL_GRACE_MS = 500;
/** Hard cap on buffered stderr, so a chatty crasher cannot grow the buffer. */
const STDERR_BUFFER_CAP = 64 * 1024;
/** How much of that tail may reach a status row. */
const STDERR_TAIL_CHARS = 600;
const STDERR_TAIL_LINES = 8;

/** The definitive failure shapes the probe can report (`timeout` is success). */
export type McpSpawnProbeFailure =
  | { kind: "spawn-error"; message: string }
  | { kind: "exit"; code: number | null; signal: string | null };

export interface McpSpawnProbeOutcome {
  /** False only with definitive evidence the launch command itself fails. */
  ok: boolean;
  /** Redacted, single-line cause for a status row; absent when ok. */
  detail?: string;
}

/** Keeps the last `STDERR_TAIL_LINES` lines within `STDERR_TAIL_CHARS`. Pure — unit-tested. */
export function stderrTail(text: string): string {
  const collapsed = text.replace(/\r/g, "").split("\n").filter((line) => line.trim().length > 0);
  const lines = collapsed.slice(-STDERR_TAIL_LINES);
  let out = lines.join("\n");
  if (out.length > STDERR_TAIL_CHARS) out = out.slice(out.length - STDERR_TAIL_CHARS);
  return out.trim();
}

/**
 * Formats a probe failure for a status row. Pure — unit-tested. The tail is
 * redacted HERE, the last point where raw child output exists: first against
 * the spec's resolved secrets, then against the values of sensitive-named
 * variables in the merged env the probe child received.
 */
export function formatMcpSpawnProbeFailure(
  failure: McpSpawnProbeFailure,
  rawStderrTail: string,
  secretValues: readonly string[],
  mergedEnv: Record<string, string> = {},
): string {
  const tail = stderrTail(redactSecrets(rawStderrTail, [...secretValues, ...sensitiveEnvValues(mergedEnv)]));
  const suffix = tail.length > 0 ? `; stderr:\n${tail}` : "";
  if (failure.kind === "spawn-error") {
    return `probe could not run the server command: ${failure.message}${suffix}`;
  }
  if (failure.signal !== null) {
    return `probe: server command was terminated by signal ${failure.signal} before responding${suffix}`;
  }
  return `probe: server command exited with code ${failure.code} before responding${suffix}`;
}

/**
 * Runs the spec's launch command once with the engine child's environment and
 * reports why it dies (when it dies). Never throws — any internal failure is
 * an `ok: true` without a detail, because a broken probe must not manufacture
 * a fake cause for a server Claude may have started fine.
 */
export async function probeMcpServerSpawn(
  spec: McpStdioServerSpec,
  options: { loginPath?: string; timeoutMs?: number } = {},
): Promise<McpSpawnProbeOutcome> {
  try {
    return await new Promise<McpSpawnProbeOutcome>((resolve) => {
      const mergedEnv: Record<string, string> = {
        ...process.env,
        ...(options.loginPath !== undefined ? { PATH: options.loginPath } : {}),
        ...spec.env,
      };
      const child = spawn(spec.command, spec.args, {
        env: mergedEnv,
        stdio: ["pipe", "ignore", "pipe"], // stdin pipe: we never write, a healthy server just waits
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      const finish = (outcome: McpSpawnProbeOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Graceful first: a launcher may be mid-write (sqlite, file sink), so
        // give it a SIGTERM and a short grace before the unavoidable SIGKILL.
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
          }, MCP_SPAWN_PROBE_KILL_GRACE_MS);
        }
        child.removeAllListeners();
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        // Still alive: the launcher runs; Claude's refusal has another cause.
        finish({ ok: true });
      }, options.timeoutMs ?? MCP_SPAWN_PROBE_TIMEOUT_MS);
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < STDERR_BUFFER_CAP) stderr += chunk.toString("utf8").slice(0, STDERR_BUFFER_CAP);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish({ ok: false, detail: formatMcpSpawnProbeFailure({ kind: "spawn-error", message: error.message }, stderr, spec.secretValues ?? [], mergedEnv) });
      });
      child.on("exit", (code, signal) => {
        // our own finish() SIGTERM/SIGKILL racing the event; anything else is the server's own death
        if (settled && (signal === "SIGKILL" || signal === "SIGTERM")) return;
        finish({ ok: false, detail: formatMcpSpawnProbeFailure({ kind: "exit", code, signal }, stderr, spec.secretValues ?? [], mergedEnv) });
      });
    });
  } catch {
    return { ok: true };
  }
}

export interface McpSpawnProbeScheduler {
  /**
   * Runs the probe for `spec` if this name was not probed yet this boot and
   * no probe for it is in flight; otherwise a no-op. `onOutcome` is invoked
   * exactly once for a probe that actually ran — with the probe's outcome, or
   * `{ ok: true }` when the probe itself failed internally (a broken probe
   * must not manufacture a fake cause).
   */
  probe(spec: McpStdioServerSpec, onOutcome: (outcome: McpSpawnProbeOutcome) => void): void;
}

/**
 * The every-init MCP probe scheduler: init re-fires on EVERY turn, so a
 * naive per-init "already probed" set would re-spawn a persistently failed
 * server's launch command (with its side effects) turn after turn, and
 * overlapping inits would race a second probe for the same name while one is
 * still in flight. This factory owns the once-per-boot done-set and the
 * in-flight-set at boot scope and drives the injected probe through them.
 */
export function createMcpSpawnProbeScheduler(
  runProbe: (spec: McpStdioServerSpec) => Promise<McpSpawnProbeOutcome>,
): McpSpawnProbeScheduler {
  const probedNames = new Set<string>();
  const inFlight = new Set<string>();
  return {
    probe(spec, onOutcome) {
      if (probedNames.has(spec.name) || inFlight.has(spec.name)) return;
      probedNames.add(spec.name);
      inFlight.add(spec.name);
      void runProbe(spec)
        .catch(() => ({ ok: true }) as McpSpawnProbeOutcome)
        .then((outcome) => {
          inFlight.delete(spec.name);
          onOutcome(outcome);
        });
    },
  };
}

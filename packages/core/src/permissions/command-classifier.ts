/**
 * Taskana 4702 Stage 1, implementation C: an external command as the ask-zone
 * classifier. Protocol (the `da` shape, card decision 5):
 *   - the command line is written to the child's stdin, then stdin is closed;
 *   - exit 0  -> allow, reason = first stdout line (or "classifier exit 0");
 *   - exit 1  -> ask,   reason = first stdout line (or "classifier exit 1");
 *   - exit 2  -> ask,   deny is mapped to ask, never allow;
 *   - anything else (other code, signal kill, timeout, spawn error, stdout over
 *     64 KB, stdin error) -> throws, so classifyAsk records an error and asks.
 *
 * The child is spawned with `shell: false`, a minimal environment (PATH and
 * HOME only) and a temp working directory, so it gets no tools, no workspace
 * and no secrets from AnyCode's process. The configured command is split on
 * whitespace only (no quoting); that is documented on `parseClassifierCommand`.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import {
  ASK_CLASSIFIER_DEFAULT_TIMEOUT_MS,
  capReason,
  type AskClassifier,
  type AskClassifierInput,
  type AskClassifierVerdict,
} from "./ask-classifier.js";

/** Maximum stdout bytes read from the classifier before it is killed (card decision 5). */
export const COMMAND_CLASSIFIER_MAX_STDOUT_BYTES = 64 * 1024;

export type CommandSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface CommandClassifierOptions {
  /** argv[0] is the executable, the rest are fixed arguments. Never shell-interpreted. */
  argv: readonly string[];
  timeoutMs?: number;
  /** Test seam; production uses node:child_process spawn. */
  spawn?: CommandSpawn;
}

/**
 * Splits the configured command string into argv. Whitespace only: no shell
 * and no quoting. A path containing spaces cannot be expressed here, which is
 * the intended trade for never invoking a shell.
 */
export function parseClassifierCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

function firstLine(stdout: string): string {
  const line = stdout.split(/\r?\n/, 1)[0] ?? "";
  return capReason(line.trim());
}

/** Builds the minimal environment: PATH and HOME only, nothing inherited. */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
}

export function createCommandAskClassifier(options: CommandClassifierOptions): AskClassifier {
  const [executable, ...fixedArgs] = options.argv;
  if (executable === undefined || executable.length === 0) {
    throw new Error("command classifier needs a non-empty argv");
  }
  const timeoutMs = options.timeoutMs ?? ASK_CLASSIFIER_DEFAULT_TIMEOUT_MS;
  const spawnFn: CommandSpawn = options.spawn ?? nodeSpawn;

  return {
    id: `command:${basename(executable)}`,
    classify(input: AskClassifierInput, opts: { signal?: AbortSignal }): Promise<AskClassifierVerdict> {
      return new Promise<AskClassifierVerdict>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stdout = "";
        let stdoutBytes = 0;
        let onAbort: (() => void) | undefined;

        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
        };
        const finish = (outcome: { verdict: AskClassifierVerdict } | { error: Error }): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.verdict);
        };
        const fail = (message: string, child: ChildProcess): void => {
          child.kill("SIGKILL");
          finish({ error: new Error(message) });
        };

        let child: ChildProcess;
        try {
          child = spawnFn(executable, fixedArgs, {
            shell: false,
            stdio: ["pipe", "pipe", "ignore"],
            env: minimalEnv(),
            cwd: tmpdir(),
          });
        } catch (error) {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
          return;
        }

        if (opts.signal?.aborted === true) {
          fail("classifier aborted by the caller", child);
          return;
        }
        onAbort = (): void => fail("classifier aborted by the caller", child);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => fail(`classifier timed out after ${timeoutMs}ms`, child), timeoutMs);

        child.on("error", (error: Error) => finish({ error }));
        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (code === 0) {
            finish({ verdict: { decision: "allow", reason: firstLine(stdout) || "classifier exit 0" } });
          } else if (code === 1) {
            finish({ verdict: { decision: "ask", reason: firstLine(stdout) || "classifier exit 1" } });
          } else if (code === 2) {
            finish({ verdict: { decision: "ask", reason: firstLine(stdout) || "classifier exit 2 (deny mapped to ask)" } });
          } else {
            finish({
              error: new Error(
                code === null ? `classifier killed by signal ${signal ?? "unknown"}` : `classifier exit ${code}`,
              ),
            });
          }
        });

        child.stdout?.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
          stdoutBytes += bytes;
          if (stdoutBytes > COMMAND_CLASSIFIER_MAX_STDOUT_BYTES) {
            fail("classifier stdout exceeded 64 KB", child);
            return;
          }
          stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });

        // A child that exits before reading its stdin raises EPIPE here; an
        // unhandled stream error would crash the host, so it is an error verdict.
        child.stdin?.on("error", (error: Error) => fail(`classifier stdin: ${error.message}`, child));
        child.stdin?.end(input.command);
      });
    },
  };
}

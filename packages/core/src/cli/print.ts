/**


 * assembled loop + shutdown handles + streams + theme, so this file never has
 * to duplicate any wiring (env, MCP, extensions, persistence) — it drives
 * exactly one `loop.runTurn` and reuses the SAME dispose -> flush -> close
 * exit path as the REPL. No module outside cli/ imports from here.
 *
 * Output split (design §3.3): stdout carries ONLY `text_delta` text (the
 * model's answer, byte-for-byte, nothing else); every other AgentEvent
 * (banners the turn itself produces, tool calls/results, retries, usage,
 * compaction, subagent/workflow progress, errors, loop_end) is rendered to
 * stderr through the SAME `renderEvent` the REPL uses, so the two paths never
 * drift on formatting. Slash commands are NOT interpreted here — the prompt

 *
 * Exit codes: 0 when loop_end.reason is "completed" or "max_turns"; 1 on a
 * stream-level `error` event, a loop_end reason of "error", or the turn
 * throwing outright; 130 on SIGINT (the first Ctrl+C aborts the turn signal —
 * the same abort-cascade the interactive broker/dispatcher already honour —
 * then this function still runs the clean exit path before returning).
 *
 * Structured output (design slice-4.5-cut.md §2.2): when a `structured` context
 * is supplied, the answer stream is wrapped instead of streamed raw. `json`
 * stays silent on stdout until a single final result-envelope line; `stream-json`
 * emits an NDJSON stream (init line -> every AgentEvent verbatim -> the same
 * result envelope, always last). stderr is IDENTICAL across all three formats

 * path byte-for-byte.
 */

import type { SqlitePersistenceAdapter, WriteBehindHistorySink } from "../adapters/node/sqlite-persistence.js";
import type { AgentLoop } from "../loop/index.js";
import type { McpManager } from "../mcp/index.js";
import type { AgentEvent } from "../types/events.js";
import type { ImageAttachment } from "../types/images.js";
import type { PermissionMode } from "../types/permissions.js";
import { renderEvent } from "./render.js";
import type { CliTheme } from "./theme.js";

/** The three `-p` output formats (design slice-4.5-cut.md §2.2). */
export type PrintOutputFormat = "text" | "json" | "stream-json";
export const PRINT_OUTPUT_FORMATS: readonly PrintOutputFormat[] = ["text", "json", "stream-json"];

/**
 * Structured-output context for `-p` (design §2.2). Its absence in
 * PrintModeOptions selects the text path (byte-for-byte identical to print-v0);
 * its presence selects `json` (single envelope line) or `stream-json` (NDJSON).
 * The four identity fields are threaded straight from runCli's wiring.
 */
export interface PrintStructuredContext {
  format: "json" | "stream-json";
  sessionId: string;
  model: string;
  mode: PermissionMode;
  cwd: string;
}

export interface PrintModeOptions {
  /* */
  prompt: string;
  loop: AgentLoop;
  mcpManager: McpManager;
  historySink: WriteBehindHistorySink;
  persistence: SqlitePersistenceAdapter;
  /** text_delta content only (design §3.3). */
  stdout: NodeJS.WritableStream;
  /** Banners / warn / tool / usage / progress diagnostics (design §3.3). */
  stderr: NodeJS.WritableStream;
  theme: CliTheme;
  /**
   * Structured output selector (design §2.2). Absent ⇒ text path, byte-for-byte
   * identical to print-v0. Present ⇒ json / stream-json envelope + NDJSON.
   */
  structured?: PrintStructuredContext;
  /**
   * Images attached to THIS one-shot prompt via `--image` (design
   * slice-6.2-cut.md §2-D4): already loaded/validated by runCli before this is
   * called. Absent/empty ⇒ the runTurn call carries no `attachments` key at
   * all, keeping print-v0 byte-for-byte identical (L7).
   */
  attachments?: ImageAttachment[];
}

/**
 * Reads a prompt from a stdin stream (design §2.2): utf8, verbatim (no trim
 * mutation), all chunks concatenated, resolves on `end` (empty end ⇒ ""). Event
 * based (`data`/`end`) — never creates a readline (design §6-L9). Hermetic:
 * works with a PassThrough that is written to then `end()`ed.
 */
export function readPromptFromStdin(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    input.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    input.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    input.on("error", reject);
  });
}

/**
 * stream-json projection of the redacted error descriptor (TASK.33 W7b-FIX #2).
 * Numbers + whitelisted strings only; fails closed to a constant when `safe` is
 * absent so a legacy/foreign producer can never leak the raw error text.
 */
function projectStreamError(
  safe: { code: string; message: string; statusCode?: number } | undefined,
): { type: "error"; message: string; code?: string; statusCode?: number } {
  if (safe === undefined) {
    return { type: "error", message: "request failed" };
  }
  return {
    type: "error",
    message: safe.message,
    code: safe.code,
    ...(safe.statusCode !== undefined ? { statusCode: safe.statusCode } : {}),
  };
}

/**
 * Drives one non-interactive turn and shuts down through the shared exit path.

 * is always non-interactive (design §3.1: `interactive` is forced false before
 * this is even called), so any "ask" the turn triggers resolves through
 * whatever non-interactive broker runCli selected — this function has no
 * broker-specific logic of its own, it only renders whatever tool_result

 */
export async function runPrintMode(opts: PrintModeOptions): Promise<number> {
  const { prompt, loop, mcpManager, historySink, persistence, stdout, stderr, theme, structured, attachments } = opts;

  const writeErr = (text: string): void => {
    stderr.write(text);
  };

  // stream-json NDJSON emitter (design §2.2): each AgentEvent as one JSON line.
  // The `error` variant is projected from the redacted `safe` descriptor (never
  // String(event.error), which can carry a raw response body / auth header —
  // TASK.33 W7b-FIX #2), fail-closed to a constant when `safe` is absent. Each
  // stringify is guarded so an unserializable event is skipped (fail-soft)
  // rather than corrupting the stream.
  const emitStreamLine = (event: AgentEvent): void => {
    let line: string;
    try {
      line =
        event.type === "error"
          ? JSON.stringify(projectStreamError(event.safe))
          : JSON.stringify(event);
    } catch {
      writeErr(`[warn] stream-json: unserializable ${event.type} event skipped\n`);
      return;
    }
    stdout.write(line + "\n");
  };

  // SIGINT (design §3.3): first Ctrl+C aborts the turn's signal — the same
  // abort-cascade path the interactive broker/dispatcher already honour
  // (design §0.1) — then this function still runs the clean exit path below
  // before returning 130. `once` + an explicit removeListener in `finally`
  // keeps this from leaking a listener onto `process` across calls/tests.
  const controller = new AbortController();
  let sigintFired = false;
  const handleSigint = (): void => {
    sigintFired = true;
    controller.abort();
  };
  process.once("SIGINT", handleSigint);

  let sawErrorEvent = false;
  let loopEndReason: string | undefined;

  // Result-envelope accumulators (design §2.2). Populated only when a structured
  // format is requested — the text path never touches them, keeping its bytes
  // identical. `usage` fields materialize only if some finish carried them.
  let resultText = "";
  let turns = 0;
  let usageInput: number | undefined;
  let usageOutput: number | undefined;
  let usageTotal: number | undefined;
  const denials: Array<{ toolCallId: string; toolName: string }> = [];

  const streamJson = structured?.format === "stream-json";
  if (structured?.format === "stream-json") {
    // First NDJSON line: init with the four identity fields (design §2.2).
    stdout.write(
      JSON.stringify({
        type: "init",
        sessionId: structured.sessionId,
        model: structured.model,
        mode: structured.mode,
        cwd: structured.cwd,
      }) + "\n",
    );
  }

  const startTime = Date.now();

  try {
    for await (const event of loop.runTurn(prompt, {
      signal: controller.signal,
      ...(attachments?.length ? { attachments } : {}),
    })) {
      if (streamJson) {
        // Every AgentEvent verbatim, in yield order (design §2.2).
        emitStreamLine(event);
      }
      if (event.type === "text_delta") {
        if (structured) {
          // Design §2.2: result == the same text the text path writes to stdout;
          // in structured modes the raw text is NOT written to stdout directly.
          resultText += event.text;
        } else {
          // Design §3.3: stdout carries ONLY the model's answer text.
          stdout.write(event.text);
        }
      } else {
        renderEvent(event, writeErr, theme);
      }
      if (event.type === "error") {
        sawErrorEvent = true;
      } else if (event.type === "loop_end") {
        loopEndReason = event.reason;
        turns = event.turns;
      } else if (structured && event.type === "finish") {
        const usage = event.usage;
        if (usage.inputTokens !== undefined) usageInput = (usageInput ?? 0) + usage.inputTokens;
        if (usage.outputTokens !== undefined) usageOutput = (usageOutput ?? 0) + usage.outputTokens;
        if (usage.totalTokens !== undefined) usageTotal = (usageTotal ?? 0) + usage.totalTokens;
      } else if (structured && event.type === "tool_result" && event.outcome.status === "denied") {
        denials.push({ toolCallId: event.outcome.toolCallId, toolName: event.outcome.toolName });
      }
    }
  } catch (error) {
    writeErr(`\n[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
    sawErrorEvent = true;
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }

  // Result envelope (design §2.2): one JSON line on stdout, no theme.paint (L6),
  // AFTER the turn completes and BEFORE the shutdown sequence, on EVERY path
  // (success / error / fatal catch / SIGINT). For `json` it is the single stdout
  // line; for `stream-json` it is always the final NDJSON line. Absent
  // `structured` ⇒ text path — no envelope, stdout stays byte-for-byte print-v0.
  if (structured) {
    const durationMs = Date.now() - startTime;
    let subtype: "completed" | "max_turns" | "cancelled" | "error";
    if (sigintFired) {
      subtype = "cancelled";
    } else if (
      loopEndReason === "completed" ||
      loopEndReason === "max_turns" ||
      loopEndReason === "cancelled" ||
      loopEndReason === "error"
    ) {
      subtype = loopEndReason;
    } else {
      // No loop_end reached — the turn threw before it (catch path, design §2.2).
      subtype = "error";
    }
    const usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    if (usageInput !== undefined) usage.inputTokens = usageInput;
    if (usageOutput !== undefined) usage.outputTokens = usageOutput;
    if (usageTotal !== undefined) usage.totalTokens = usageTotal;
    const envelope = {
      type: "result" as const,
      subtype,
      isError: sawErrorEvent || subtype === "error",
      result: resultText,
      sessionId: structured.sessionId,
      model: structured.model,
      mode: structured.mode,
      cwd: structured.cwd,
      turns,
      durationMs,
      usage,
      denials,
    };
    stdout.write(JSON.stringify(envelope) + "\n");
  }


  // REPL runs, so a one-shot print session never orphans an MCP child or
  // loses its write-behind DB tail — regardless of how the turn above ended.
  await mcpManager.dispose();
  await historySink.flush();
  await persistence.close();

  if (sigintFired) {
    return 130;
  }
  if (sawErrorEvent || loopEndReason === "error") {
    return 1;
  }
  return 0;
}

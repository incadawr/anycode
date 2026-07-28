/**
 * One-shot foreign-CLI subagent runner (design: packages/core/src/ports/
 * subagent.ts `EngineChildSpec` / `SubagentRunnerOptions.runEngineChild`).
 *
 * A subagent whose md-profile declares `engine: "codex" | "claude"` (the
 * runner's `persona.engine !== undefined` branch) bypasses the in-process
 * child AgentLoop entirely and runs on the REAL Claude Code or Codex CLI
 * instead, exactly once, in place of an Agent-tool child. This module owns
 * that one-shot spawn: build argv, spawn, parse the CLI's own NDJSON/JSONL
 * event stream defensively, resolve a SubagentOutcome. No control protocol, no
 * approval bridge, no engine registry, no event-translator — deliberately a
 * SMALLER surface than host/engines/claude/** and host/engines/codex/**,
 * which run the full interactive session. A single switch on the two known
 * engine ids (`adapterFor`) picks the argv/env/line-parser triple; spawn,
 * line-buffering, abort/kill and output-capping are shared.
 *
 * PERMISSION POSTURE. A one-shot child has no UI to route an approval
 * through, so it cannot ask; the choice is therefore between a child that
 * cannot act and a child that acts unsupervised. Both CLIs are launched in
 * the narrowest non-interactive mode that still lets the child do project
 * work — confined to the session workspace, NOT the machine:
 *   - Claude:  `--permission-mode acceptEdits` (file edits auto-accepted;
 *              anything outside that still needs an approval it cannot get,
 *              so it is refused rather than silently performed).
 *   - Codex:   `--sandbox workspace-write -c approval_policy=never`
 *              (writes confined to `--cd`, network off, no approval stalls).
 * Whatever the child does run is gated ONLY by that CLI's own process, never
 * by AnyCode's permission engine/broker — an engine subagent is a foreign
 * agent, not a supervised child loop. `--disable-slash-commands
 * --setting-sources project,local --strict-mcp-config` (mirrored from
 * claude-client.ts's own spawn args) keep the child's init from pulling in
 * the ambient skill/plugin catalog a subagent never needed.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { SUBAGENT_OUTPUT_MAX_BYTES, type SubagentOutcome, type SubagentRunOptions } from "@anycode/core";
import { ENV_CLAUDE_BIN, ENV_CODEX_BIN } from "../shared/engines.js";
import { buildClaudeChildEnv } from "./engines/claude/claude-client.js";
import { buildCodexChildEnv } from "./engines/codex/app-server-client.js";

/**
 * Structural mirror of packages/core/src/ports/subagent.ts's frozen
 * `EngineChildSpec`. Not imported by name: that interface is not (yet)
 * re-exported through the package's public barrel (ports/index.ts), and
 * TypeScript's structural typing makes an identical local shape interchangeable
 * with it at the `withSubagents({ runEngineChild })` call site in host/index.ts.
 */
export interface EngineChildSpec {
  engine: "codex" | "claude";
  /** Ready one-shot child prompt: the persona body + the caller's request. */
  prompt: string;
  agentType: string;
  description: string;
  /** Model for the CLI's own flag; absent — the engine takes its own default. */
  model?: string;
}

/** Narrow injectable spawn seam so tests never launch a real CLI. */
export type EngineChildSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
    windowsHide: boolean;
    detached: boolean;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ChildProcess;

export interface EngineChildRunnerDeps {
  /** Session workspace both CLIs are rooted at (spawn cwd + Codex's own `--cd`). */
  cwd: string;
  /** Source environment: read for ENV_CLAUDE_BIN/ENV_CODEX_BIN and the child's allowlisted env. */
  env: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to node:child_process's spawn. */
  spawn?: EngineChildSpawn;
}

/** Bound on the accumulated stderr tail kept for an error outcome (not the subagent OUTPUT cap — see SUBAGENT_OUTPUT_MAX_BYTES below). */
const STDERR_TAIL_MAX_CHARS = 4_000;
/** Grace window between SIGTERM and a follow-up SIGKILL on cancellation. */
const CHILD_TERMINATE_GRACE_MS = 3_000;
/** Per-tool-call activity subject cap (mirrors packages/core's SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS). */
const SUMMARY_MAX_CHARS = 160;

/** Builds the `runEngineChild` callback wired into `withSubagents` (host/index.ts). */
export function createEngineChildRunner(
  deps: EngineChildRunnerDeps,
): (spec: EngineChildSpec, opts: SubagentRunOptions) => Promise<SubagentOutcome> {
  return (spec, opts) => runEngineChild(deps, spec, opts);
}

interface ChildState {
  turns: number;
  toolCalls: number;
  finalText: string;
  /** Set once a terminal marker line is parsed (Claude `result`, Codex `turn.completed`/`turn.failed`). */
  terminalStatus?: SubagentOutcome["status"];
  /** Authoritative failure message from a terminal-error line; preferred over the raw stderr tail. */
  errorText?: string;
}

interface EngineAdapter {
  label: string;
  binEnvVar: string;
  buildArgs(spec: EngineChildSpec, cwd: string): string[];
  buildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  handleLine(line: Record<string, unknown>, state: ChildState, onProgress: SubagentRunOptions["onProgress"]): void;
}

/** The one switch on the two known engine ids (module header §"single switch"). */
function adapterFor(engine: EngineChildSpec["engine"]): EngineAdapter {
  switch (engine) {
    case "claude":
      return {
        label: "Claude Code",
        binEnvVar: ENV_CLAUDE_BIN,
        buildArgs: (spec) => [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "acceptEdits",
          "--disable-slash-commands",
          "--setting-sources",
          "project,local",
          "--strict-mcp-config",
          ...(spec.model !== undefined ? ["--model", spec.model] : []),
          spec.prompt,
        ],
        buildEnv: (source) => buildClaudeChildEnv(source, undefined),
        handleLine: handleClaudeLine,
      };
    case "codex":
      return {
        label: "Codex",
        binEnvVar: ENV_CODEX_BIN,
        buildArgs: (spec, cwd) => [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "-c",
          "approval_policy=never",
          "--cd",
          cwd,
          ...(spec.model !== undefined ? ["--model", spec.model] : []),
          spec.prompt,
        ],
        buildEnv: (source) => buildCodexChildEnv(source),
        handleLine: handleCodexLine,
      };
  }
}

// ── Claude: `claude -p --output-format stream-json` line handling ──
// Deliberately NOT passing --include-partial-messages/--input-format
// stream-json: the base "assistant" message already carries each block
// (tool_use / text) COMPLETE, so there is nothing to accumulate across deltas
// (verified live: an assistant message's `content[]` tool_use/text blocks are
// whole, not partial, without that flag).

function handleClaudeLine(
  line: Record<string, unknown>,
  state: ChildState,
  onProgress: SubagentRunOptions["onProgress"],
): void {
  if (line.type === "assistant") {
    state.turns += 1;
    const content = record(line.message)?.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = record(raw);
        if (block === undefined) continue;
        if (block.type === "tool_use") {
          state.toolCalls += 1;
          const toolName = str(block.name) ?? "tool";
          onProgress?.({ kind: "tool", toolName, summary: summarizeClaudeTool(toolName, record(block.input)) });
        } else if (block.type === "text") {
          const text = str(block.text);
          if (text !== undefined) state.finalText = text;
        }
      }
    }
    onProgress?.({ kind: "progress", turns: state.turns, toolCalls: state.toolCalls });
    return;
  }
  if (line.type === "result") {
    const isError = line.is_error === true;
    state.terminalStatus = isError ? (line.subtype === "error_max_turns" ? "max_turns" : "error") : "completed";
    const result = str(line.result);
    if (result !== undefined && result.length > 0) state.finalText = result;
    if (isError) state.errorText = `Claude Code exited with "${str(line.subtype) ?? "error"}".`;
    if (typeof line.num_turns === "number") state.turns = line.num_turns;
    return;
  }
  // "system" / "user" / "rate_limit_event" and any future/unrecognized type:
  // silently ignored — a garbage or unknown line must never abort the run.
}

/** Known built-in Claude tool names only; anything else (incl. TodoWrite) falls back to "" like packages/core's summarizeChildToolCall. */
function summarizeClaudeTool(name: string, input: Record<string, unknown> | undefined): string {
  if (input === undefined) return "";
  switch (name) {
    case "Bash":
      return summarize(str(input.command) ?? "");
    case "Read":
    case "Write":
    case "Edit":
      return summarize(str(input.file_path) ?? "");
    case "Grep":
    case "Glob":
      return summarize(str(input.pattern) ?? "");
    default:
      return "";
  }
}

// ── Codex: `codex exec --json` line handling ──
// Live shapes (codex-cli 0.145.0): {"type":"thread.started",...},
// {"type":"turn.started"}, {"type":"item.started"|"item.completed","item":{...}},
// {"type":"turn.completed","usage":{...}}, {"type":"turn.failed","error":{...}},
// {"type":"error","message":...}. `item.type` is "agent_message" for the
// final reply text, "error" for an item-level failure, anything else
// (command_execution, etc.) is a tool/action call.

function handleCodexLine(
  line: Record<string, unknown>,
  state: ChildState,
  onProgress: SubagentRunOptions["onProgress"],
): void {
  switch (line.type) {
    case "item.completed": {
      const item = record(line.item);
      if (item === undefined) return;
      const itemType = str(item.type) ?? "item";
      if (itemType === "agent_message") {
        const text = str(item.text);
        if (text !== undefined) state.finalText = text;
        return;
      }
      if (itemType === "error") {
        state.errorText = str(item.message) ?? "Codex reported an item error.";
        return;
      }
      state.toolCalls += 1;
      const subject = str(item.command) ?? str(item.path) ?? "";
      onProgress?.({ kind: "tool", toolName: itemType, summary: summarize(subject) });
      onProgress?.({ kind: "progress", turns: state.turns, toolCalls: state.toolCalls });
      return;
    }
    case "turn.started":
      state.turns += 1;
      onProgress?.({ kind: "progress", turns: state.turns, toolCalls: state.toolCalls });
      return;
    case "turn.completed":
      state.terminalStatus = "completed";
      return;
    case "turn.failed":
      state.terminalStatus = "error";
      state.errorText = str(record(line.error)?.message) ?? "Codex turn failed.";
      return;
    case "error":
      // Turn-level error line that (per live evidence) precedes turn.failed;
      // kept only as a fallback if turn.failed never arrives.
      if (state.errorText === undefined) state.errorText = str(line.message) ?? "Codex reported an error.";
      return;
    default:
      // "thread.started" and any future/unknown type: ignored.
      return;
  }
}

// ── shared plumbing ──

async function runEngineChild(
  deps: EngineChildRunnerDeps,
  spec: EngineChildSpec,
  opts: SubagentRunOptions,
): Promise<SubagentOutcome> {
  const startedAt = Date.now();
  const { signal, onProgress } = opts;
  if (signal?.aborted) return cancelledOutcome(startedAt);

  const adapter = adapterFor(spec.engine);
  const binaryPath = deps.env[adapter.binEnvVar];
  if (binaryPath === undefined || binaryPath.length === 0) {
    return errorOutcome(
      `${adapter.label} CLI is not available in this host (${adapter.binEnvVar} is unset) — cannot run agent type "${spec.agentType}" on the "${spec.engine}" engine.`,
      startedAt,
    );
  }

  const args = adapter.buildArgs(spec, deps.cwd);
  const childEnv = adapter.buildEnv(deps.env);
  const spawnImpl: EngineChildSpawn = deps.spawn ?? ((command, spawnArgs, options) => nodeSpawn(command, spawnArgs, options));

  return new Promise<SubagentOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: SubagentOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(binaryPath, args, {
        cwd: deps.cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle(errorOutcome(`Failed to start ${adapter.label} CLI: ${errorMessage(error)}`, startedAt));
      return;
    }

    const onAbort = (): void => {
      killChild(child, "SIGTERM");
      const killTimer = setTimeout(() => killChild(child, "SIGKILL"), CHILD_TERMINATE_GRACE_MS);
      killTimer.unref?.();
      settle(cancelledOutcome(startedAt));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const state: ChildState = { turns: 0, toolCalls: 0, finalText: "" };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutRemainder = "";
    let stderrTail = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutRemainder += stdoutDecoder.write(chunk);
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseJsonLine(line);
        if (parsed !== undefined) adapter.handleLine(parsed, state, onProgress);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${stderrDecoder.write(chunk)}`.slice(-STDERR_TAIL_MAX_CHARS);
    });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      settle(errorOutcome(`${adapter.label} CLI failed to launch: ${errorMessage(error)}`, startedAt));
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      const finalChunk = stdoutRemainder + stdoutDecoder.end();
      if (finalChunk.trim().length > 0) {
        const parsed = parseJsonLine(finalChunk);
        if (parsed !== undefined) adapter.handleLine(parsed, state, onProgress);
      }
      if (state.terminalStatus !== undefined) {
        if (state.terminalStatus === "error" && state.finalText.length === 0) {
          state.finalText = state.errorText ?? (stderrTail.trim() || `${adapter.label} CLI reported an error.`);
        }
        settle(cappedOutcome(state, state.terminalStatus, startedAt));
        return;
      }
      if (code === 0) {
        settle(cappedOutcome(state, "completed", startedAt));
        return;
      }
      state.finalText = state.errorText ?? (stderrTail.trim() || `${adapter.label} CLI exited with code ${String(code)}.`);
      settle(cappedOutcome(state, "error", startedAt));
    });
  });
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Process group already gone; fall through to a direct child kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort only — the close handler remains responsible for settling.
  }
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    // A malformed/garbage NDJSON line must never abort the run.
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Strips control code points, collapses whitespace, caps length on a
 * code-point boundary (mirrors packages/core's sanitizeAndCap, not exported
 * through its barrel). Filters by numeric code point rather than a regex
 * control-char class so no literal control byte ever sits in this file's
 * source (a stray NUL byte makes `grep`/some tooling silently treat the file
 * as binary).
 */
function summarize(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const isControlCodePoint = (code: number): boolean => code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  const filtered = Array.from(text)
    .filter((ch) => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("");
  const stripped = filtered.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(stripped);
  if (codePoints.length <= maxChars) return stripped;
  return `${codePoints.slice(0, maxChars - 1).join("")}…`;
}

/** Mirrors packages/core/src/util/bytes.ts's capUtf8Bytes (not exported through the package's public barrel). */
function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return { text, truncated: false };
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, maxBytes));
  const clean = decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
  return { text: clean, truncated: true };
}

function cappedOutcome(state: ChildState, status: SubagentOutcome["status"], startedAt: number): SubagentOutcome {
  const capped = capBytes(state.finalText, SUBAGENT_OUTPUT_MAX_BYTES);
  return {
    status,
    finalText: capped.text,
    truncated: capped.truncated,
    turns: state.turns,
    toolCalls: state.toolCalls,
    durationMs: Date.now() - startedAt,
  };
}

function cancelledOutcome(startedAt: number): SubagentOutcome {
  return { status: "cancelled", finalText: "", truncated: false, turns: 0, toolCalls: 0, durationMs: Date.now() - startedAt };
}

function errorOutcome(message: string, startedAt: number): SubagentOutcome {
  return { status: "error", finalText: message, truncated: false, turns: 0, toolCalls: 0, durationMs: Date.now() - startedAt };
}

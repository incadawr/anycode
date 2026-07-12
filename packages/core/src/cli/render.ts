/**
 * CLI event/table rendering (design slice-4.1-cut.md §3.2, slice-4.2-cut.md
 * §2.3/§3.1-3.2/§3.4). Task 4.1.1 moved these out of main.ts verbatim
 * (behaviour byte-identical) and added the optional `theme` parameter to
 * renderEvent as a frozen seam. Task 4.1.3 wrapped the EXISTING strings in
 * theme roles (string content unchanged; SGR only when color=true; paint
 * applied AFTER padEnd so table alignment survives). Task 4.2.2 (this file)
 * implements the transcript-v2 branches: Edit/Write diffs (delegated to
 * diff.ts), tool_result/input collapse, and reasoning rendering — all gated
 * on the 4th `transcript` parameter so every existing call site (main.test.ts,
 * print.ts, commands.ts's /compact — none of which pass it) stays
 * byte-identical to today. No module outside cli/ imports from here.
 *
 * When `theme` is omitted, or `theme.color===false`, every function here

 * the no-color anchor main.test.ts's snapshots depend on) — `paint()` below
 * degrades to identity in both cases. Roles `banner` and `warn` have no call
 * site in this file: the banner line and most `[warn]` lines are written
 * directly by cli/main.ts (outside this task's file scope), not through
 * renderEvent/the tables — theme.ts still implements their SGR correctly for
 * whichever lane/integration task threads them through.
 */

import { estimateTokensFromText } from "../context/tokens.js";
import type { CommandHookDeclaration } from "../dispatch/index.js";
import type { ContextBreakdown, ContextInfo } from "../loop/index.js";
import type { LspServerStatus } from "../ports/lsp.js";
import type { McpServerStatus } from "../ports/mcp.js";
import type { TelemetryStatus } from "../ports/telemetry.js";
import type { BackgroundTaskSnapshot } from "../ports/tasks.js";
import type { SkillMeta } from "../ports/skills.js";
import type { WorkflowDefinition, WorkflowMeta } from "../ports/workflow.js";
import type { AgentEvent } from "../types/events.js";
import type { ToolCallOutcome } from "../types/tools.js";
import { formatEditDiff, formatWriteDiff } from "./diff.js";
import type { CliStyleRole, CliTheme } from "./theme.js";

/**
 * Behavioural options for transcript v2 (design slice-4.2-cut.md §2.3). The
 * ABSENCE of the object (every pre-4.2 call site: main.test.ts, print.ts,
 * commands.ts's /compact) means all features are off, i.e. output byte-identical

 * `reasoning` is mutated live by the /reasoning command (main owns the object).
 */
export interface TranscriptOptions {
  /** Render Edit/Write as a diff block instead of the raw JSON input line. */
  diffs?: boolean;
  /** Cap/collapse long tool_result bodies and other tools' JSON input previews. */
  collapse?: boolean;
  /** Render the model's reasoning stream (default on in interactive, off in print/non-TTY). */
  reasoning?: boolean;
}

/**
 * Collapse thresholds (design slice-4.2-cut.md §2.3/§3.2). Exported constants so
 * a future /config slice can surface them. THRESHOLD > HEAD+TAIL+1 is a constant
 * invariant: collapse only ever shortens output (a unit guard in 4.2.2).
 */
export const CLI_COLLAPSE_THRESHOLD_LINES = 20;
export const CLI_COLLAPSE_HEAD_LINES = 10;
export const CLI_COLLAPSE_TAIL_LINES = 5;
/** Per-line character cap for minified one-line tool_result bodies. */
export const CLI_RESULT_MAX_LINE_CHARS = 500;
/** One-line cap on the JSON input preview of non-Edit/Write tools (mirrors the broker's ask preview). */
export const CLI_INPUT_PREVIEW_MAX_CHARS = 400;

export interface CollapsedLines {
  /** Surviving lines before the hidden gap (or all of them, if untruncated), per-line char-capped. */
  head: string[];
  /** Surviving lines after the hidden gap; empty when untruncated. */
  tail: string[];
  /** Count of lines hidden between head and tail; 0 when untruncated. */
  hiddenCount: number;
}

/**
 * Core head/tail line-collapse (design §3.2), unpainted and un-prefixed —
 * callers own how the surviving lines and the overflow marker get formatted.
 * Shared by `collapseOutput` (tool_result prose, below) and diff.ts's
 * `formatWriteDiff` (Write content, design §3.1), so both cap the exact same
 * way off the exact same constants. Per-line char cap is applied to EVERY

 * exceeds CLI_COLLAPSE_THRESHOLD_LINES, the array collapses to HEAD + TAIL
 * with the gap reported as `hiddenCount`. THRESHOLD > HEAD+TAIL+1 is a
 * constant invariant (see the module-level constants) — collapsing can only
 * ever shorten the line count, never lengthen it (unit-guarded in
 * render.test.ts).
 */
export function collapseLinesRaw(lines: string[]): CollapsedLines {
  const capped = lines.map((line) =>
    line.length > CLI_RESULT_MAX_LINE_CHARS ? `${line.slice(0, CLI_RESULT_MAX_LINE_CHARS)}…` : line,
  );
  if (capped.length <= CLI_COLLAPSE_THRESHOLD_LINES) {
    return { head: capped, tail: [], hiddenCount: 0 };
  }
  const head = capped.slice(0, CLI_COLLAPSE_HEAD_LINES);
  const tail = capped.slice(capped.length - CLI_COLLAPSE_TAIL_LINES);
  const hiddenCount = capped.length - CLI_COLLAPSE_HEAD_LINES - CLI_COLLAPSE_TAIL_LINES;
  return { head, tail, hiddenCount };
}

/**
 * Pure line-collapse of a tool_result body (design §3.2): builds on
 * `collapseLinesRaw` and adds the dim `  … (+K more lines)` overflow marker
 * (K = hiddenCount) between head and tail when truncated. `theme` is only
 * for that marker's dim role — surviving lines are never painted here (the
 * tool_result case below paints the status, not the body).
 */
export function collapseOutput(text: string, theme?: CliTheme): string {
  const { head, tail, hiddenCount } = collapseLinesRaw(text.split("\n"));
  if (hiddenCount === 0) {
    return head.join("\n");
  }
  const marker = theme?.paint("dim", `  … (+${hiddenCount} more lines)`) ?? `  … (+${hiddenCount} more lines)`;
  return [...head, marker, ...tail].join("\n");
}

/* */
function isEditInput(
  input: unknown,
): input is { file_path: string; old_string: string; new_string: string; replace_all?: boolean } {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.file_path === "string" &&
    typeof candidate.old_string === "string" &&
    typeof candidate.new_string === "string" &&
    (candidate.replace_all === undefined || typeof candidate.replace_all === "boolean")
  );
}

/* */
function isWriteInput(input: unknown): input is { file_path: string; content: string } {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return typeof candidate.file_path === "string" && typeof candidate.content === "string";
}

/** Structural (duck-type) validation of an ExitPlanMode tool's `unknown` input (design slice-4.3-cut.md §3.5). */
function isExitPlanModeInput(input: unknown): input is { plan: string } {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return typeof candidate.plan === "string";
}

// ---------------------------------------------------------------------------
// 4.2-R display-projection (design slice-4.5-cut.md §2.4): a pure, cli-only
// fix for the bug where Bash/Read/Grep/Glob's tool_result.modelText is a
// single JSON-stringified line (dispatch/dispatcher.ts's default
// formatModelText, since none of these four tools implement
// formatResultForModel), so the per-line collapseOutput above never sees
// multiple lines. formatResultForDisplay projects the RAW result.output
// (tools/schemas.ts's duck shapes) into human-readable multi-line prose for
// the transcript ONLY; modelText (what the model actually saw) is untouched
// and remains what print/non-interactive/stream-json paths carry (§6.1: no
// core delta, no ToolCallOutcome.displayText).

/** Verbatim truncation marker reused from dispatch/dispatcher.ts's capText (design §2.4, A23 dispatcher.ts:318). */
const TRUNCATION_MARKER = "… [truncated]";

/** Strips exactly one trailing "\n" from a text payload (design §2.4: avoids a blank line once sections are joined). */
function stripOneTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

interface BashDuck {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Structural (duck-type) validation of a Bash tool's `unknown` output (mirrors tools/schemas.ts's BashOutput). */
function isBashOutput(output: unknown): output is BashDuck {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const c = output as Record<string, unknown>;
  return (
    typeof c.stdout === "string" &&
    typeof c.stderr === "string" &&
    (c.exitCode === null || typeof c.exitCode === "number") &&
    typeof c.stdoutTruncated === "boolean" &&
    typeof c.stderrTruncated === "boolean"
  );
}

interface ReadDuck {
  content: string;
  totalLines: number;
  truncated: boolean;
}

/** Structural (duck-type) validation of a Read tool's `unknown` output (mirrors tools/schemas.ts's ReadOutput). */
function isReadOutput(output: unknown): output is ReadDuck {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const c = output as Record<string, unknown>;
  return typeof c.content === "string" && typeof c.totalLines === "number" && typeof c.truncated === "boolean";
}

interface GrepDuck {
  mode: "content" | "files_with_matches" | "count";
  matches?: Array<{ path: string; lineNumber?: number; line?: string }>;
  files?: string[];
  counts?: Record<string, number>;
  totalMatches: number;
  truncated: boolean;
}

/** Structural (duck-type) validation of a Grep tool's `unknown` output (mirrors tools/schemas.ts's GrepOutput). */
function isGrepOutput(output: unknown): output is GrepDuck {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const c = output as Record<string, unknown>;
  if (c.mode !== "content" && c.mode !== "files_with_matches" && c.mode !== "count") {
    return false;
  }
  if (typeof c.totalMatches !== "number" || typeof c.truncated !== "boolean") {
    return false;
  }
  if (c.matches !== undefined && !Array.isArray(c.matches)) {
    return false;
  }
  if (c.files !== undefined && !Array.isArray(c.files)) {
    return false;
  }
  if (c.counts !== undefined && (typeof c.counts !== "object" || c.counts === null)) {
    return false;
  }
  return true;
}

interface GlobDuck {
  files: string[];
  totalMatched: number;
  truncated: boolean;
}

/** Structural (duck-type) validation of a Glob tool's `unknown` output (mirrors tools/schemas.ts's GlobOutput). */
function isGlobOutput(output: unknown): output is GlobDuck {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const c = output as Record<string, unknown>;
  return Array.isArray(c.files) && typeof c.totalMatched === "number" && typeof c.truncated === "boolean";
}

/** Projects a Bash tool's raw output onto multi-line prose (design §2.4). */
function formatBashOutput(output: BashDuck, modelText: string): string {
  const sections: string[] = [];
  if (output.stdout !== "") {
    const stdout = stripOneTrailingNewline(output.stdout);
    sections.push(output.stdoutTruncated ? `${stdout}\n${TRUNCATION_MARKER}` : stdout);
  }
  if (output.stderr !== "") {
    const stderr = stripOneTrailingNewline(output.stderr);
    sections.push(`[stderr]\n${output.stderrTruncated ? `${stderr}\n${TRUNCATION_MARKER}` : stderr}`);
  }
  if (output.exitCode !== 0 && output.exitCode !== null) {
    sections.push(`[exit ${output.exitCode}]`);
  }
  return sections.length > 0 ? sections.join("\n") : modelText;
}

/** Projects a Read tool's raw output onto multi-line prose (design §2.4). */
function formatReadOutput(output: ReadDuck): string {
  const sections = [stripOneTrailingNewline(output.content)];
  if (output.truncated) {
    sections.push(`… [truncated: ${output.totalLines} lines total]`);
  }
  return sections.join("\n");
}

/** Projects a Grep tool's raw output onto multi-line prose (design §2.4, branched on `mode`). */
function formatGrepOutput(output: GrepDuck): string {
  const lines: string[] = [];
  switch (output.mode) {
    case "content":
      for (const match of output.matches ?? []) {
        lines.push(
          match.lineNumber !== undefined && match.line !== undefined
            ? `${match.path}:${match.lineNumber}: ${match.line}`
            : match.path,
        );
      }
      break;
    case "files_with_matches":
      lines.push(...(output.files ?? []));
      break;
    case "count":
      for (const [path, count] of Object.entries(output.counts ?? {})) {
        lines.push(`${path}: ${count}`);
      }
      break;
  }
  if (output.truncated) {
    lines.push(`… [truncated: ${output.totalMatches} matches total]`);
  }
  return lines.join("\n");
}

/** Projects a Glob tool's raw output onto multi-line prose (design §2.4). */
function formatGlobOutput(output: GlobDuck): string {
  const lines = [...output.files];
  if (output.truncated) {
    lines.push(`… [truncated: ${output.totalMatched} matched total]`);
  }
  return lines.join("\n");
}

/**
 * Display-projection of a tool_result for the transcript (design
 * slice-4.5-cut.md §2.4). Gated on `status === "success" && result?.ok ===
 * true` PLUS a per-tool duck-shape match on `result.output` (toolName AND
 * shape, mirroring isEditInput/isWriteInput above); MCP tools are
 * `mcp__*`-prefixed so there is no name collision with the four built-ins
 * projected here. ANY mismatch — denied/error/timed_out status, `ok:false`,
 * a missing `result`, a foreign toolName, or a malformed shape — fails open

 * throws and never drops to `[object Object]`. Does NOT touch modelText
 * itself (model-facing truth) and is not consulted by print/stream-json
 * (§6.1: cli-only, zero core deltas).
 */
export function formatResultForDisplay(outcome: ToolCallOutcome): string {
  if (outcome.status !== "success" || outcome.result?.ok !== true) {
    return outcome.modelText;
  }
  const output = outcome.result.output;
  switch (outcome.toolName) {
    case "Bash":
      return isBashOutput(output) ? formatBashOutput(output, outcome.modelText) : outcome.modelText;
    case "Read":
      return isReadOutput(output) ? formatReadOutput(output) : outcome.modelText;
    case "Grep":
      return isGrepOutput(output) ? formatGrepOutput(output) : outcome.modelText;
    case "Glob":
      return isGlobOutput(output) ? formatGlobOutput(output) : outcome.modelText;
    default:
      return outcome.modelText;
  }
}

/**
 * Exported for the render-path unit test (task 3.1.3) — no live subagent run
 * needed. `theme` (design §2.6 wiring) is an optional, additive parameter: 4.1.1
 * ignores it (identity paint); 4.1.3 uses it to wrap the same strings in SGR.
 * `transcript` (design slice-4.2-cut.md §2.3) is a 4th additive parameter,
 * absent on every pre-4.2 call site (main.test.ts, print.ts, commands.ts's
 * /compact) ⇒ those stay byte-identical to today by construction: every
 * branch below that honours `transcript` is gated on one of its optional
 * fields (`transcript?.diffs`/`transcript?.collapse`/`transcript?.reasoning`),
 * so `transcript === undefined` takes the exact same path as the pre-4.2.2
 * no-op stub did.
 */
export function renderEvent(
  event: AgentEvent,
  write: (text: string) => void,
  theme?: CliTheme,
  transcript?: TranscriptOptions,
): void {
  // Identity when no theme is threaded through (main.ts callers that predate
  // theming, and every existing main.test.ts snapshot) — matches theme.color
  // ===false's own identity paint, so the two "no color" paths agree.
  const paint = (role: CliStyleRole, text: string): string => theme?.paint(role, text) ?? text;
  switch (event.type) {
    case "text_delta":
      write(event.text);
      break;
    case "tool_execution_start": {
      // design §3.1: Edit/Write get a diff block instead of the raw JSON input
      // line, but ONLY when diffs are on AND the input duck-validates —
      // malformed input (a model can send garbage) falls through to the same

      // old view, never fail silently or crash the render).
      if (transcript?.diffs && event.toolName === "Edit" && isEditInput(event.input)) {
        write(
          formatEditDiff({
            filePath: event.input.file_path,
            oldString: event.input.old_string,
            newString: event.input.new_string,
            replaceAll: event.input.replace_all,
            theme,
          }),
        );
        break;
      }
      if (transcript?.diffs && event.toolName === "Write" && isWriteInput(event.input)) {
        write(formatWriteDiff({ filePath: event.input.file_path, content: event.input.content, theme }));
        break;
      }
      // design slice-4.3-cut.md §3.5: ExitPlanMode gets a name-only line instead
      // of the plan dumped as JSON — the terminal broker's ask block is the
      // authoritative, self-contained presentation of the plan (design §0.1: the
      // render channel and the ask prompt race, so the ask cannot depend on the
      // render having already shown anything), and repeating the whole plan here
      // would just be a second wall of text. Gated on the transcript object's
      // presence (interactive mode) like the diff branches above; a malformed
      // input (no string `plan`) or an absent transcript falls through to the

      if (transcript && event.toolName === "ExitPlanMode" && isExitPlanModeInput(event.input)) {
        write(`\n[tool] ${paint("toolName", event.toolName)}\n`);
        break;
      }
      const inputJson = JSON.stringify(event.input);
      const preview =
        transcript?.collapse && inputJson.length > CLI_INPUT_PREVIEW_MAX_CHARS
          ? `${inputJson.slice(0, CLI_INPUT_PREVIEW_MAX_CHARS)}…`
          : inputJson;
      write(`\n[tool] ${paint("toolName", event.toolName)} ${preview}\n`);
      break;
    }
    case "tool_result": {
      const { outcome } = event;
      const statusRole: CliStyleRole = outcome.status === "success" ? "toolResultOk" : "toolResultError";
      // design §3.2: only the body after the fixed "[tool result] ... : "
      // prefix is subject to collapse — the prefix line is never touched,
      // and short outputs stay byte-identical (collapseOutput is a
      // mathematical identity below the threshold, design §3.2 invariant).
      // design slice-4.5-cut.md §2.4 (4.2-R fix): collapse now runs over
      // formatResultForDisplay(outcome) rather than raw modelText, so
      // Bash/Read/Grep/Glob's multi-line output (today a single JSON-escaped
      // line) actually gets split into lines the head/tail collapse can see.
      // modelText itself is untouched; this projection is display-only and
      // only reachable under transcript?.collapse (print/non-interactive
      // paths keep printing modelText verbatim).
      const body = transcript?.collapse ? collapseOutput(formatResultForDisplay(outcome), theme) : outcome.modelText;
      write(`[tool result] ${outcome.toolName} ${paint(statusRole, `(${outcome.status})`)}: ${body}\n`);
      break;
    }
    case "finish": {
      const { usage } = event;
      const total = usage.totalTokens ?? estimateTokensFromText("");
      write(
        paint(
          "usage",
          `\n[usage] in=${usage.inputTokens ?? "?"} out=${usage.outputTokens ?? "?"} total=${total}\n`,
        ),
      );
      break;
    }
    case "error":
      write(paint("error", `\n[error] ${String(event.error)}\n`));
      break;
    case "loop_end":
      write(event.reason === "max_turns"
        ? `\n[stopped: reached the turn limit (${event.turns} turns) — raise it in Settings or ANYCODE_MAX_TURNS]\n`
        : `\n[loop_end: ${event.reason}, turns=${event.turns}]\n`);
      break;
    case "stream_retry":
      write(
        `\n[retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.reason}]\n`,
      );
      break;
    case "microcompact":
      write(
        `\n[microcompact: cleared ${event.clearedToolResults} tool result(s), saved ~${event.savedTokens} tokens]\n`,
      );
      break;
    case "compaction_start":
      write(`\n[compaction: ${event.trigger} — summarizing earlier context…]\n`);
      break;
    case "compaction_end":
      write(
        event.ok
          ? `\n[compaction: ${event.preTokens} → ${event.postTokens ?? "?"} tokens in ${event.durationMs}ms]\n`
          : `\n[compaction skipped/failed (${event.error ?? "unknown"})]\n`,
      );
      break;
    case "context_usage":
      write(
        paint(
          "usage",
          `\n[context: ~${event.estimatedTokens}/${event.budgetTokens} tokens (${event.source})]\n`,
        ),
      );
      break;
    // Subagent coarse-progress (design phase-3.md §3.3/§4.2): rendered as
    // prefixed status lines, same terse style as tool-call lines above. The
    // toolCallId prefix disambiguates output when up to MAX_CONCURRENT_SUBAGENTS
    // children interleave their lines in the same terminal stream.
    case "subagent_start":
      write(
        paint("progress", `\n[subagent ${event.toolCallId}] start: ${event.agentType} — ${event.description}\n`),
      );
      break;
    case "subagent_progress":
      write(
        paint(
          "progress",
          `[subagent ${event.toolCallId}] progress: turns=${event.turns} toolCalls=${event.toolCalls}` +
            `${event.lastTool !== undefined ? ` lastTool=${event.lastTool}` : ""}\n`,
        ),
      );
      break;
    case "subagent_end":
      write(
        paint(
          "progress",
          `[subagent ${event.toolCallId}] end (${event.status}): turns=${event.turns} durationMs=${event.durationMs}\n`,
        ),
      );
      break;
    // Workflow coarse-progress (design slice-3.4-cut.md §2.3/§3.4): rendered the
    // same terse, toolCallId-prefixed way as subagent_* above — a workflow run
    // is itself the Workflow tool call, and its steps additionally carry a
    // stepId so a DAG's step lines stay disambiguated inside one run.
    case "workflow_start":
      write(
        paint(
          "progress",
          `\n[workflow ${event.toolCallId}] start: ${event.workflow} (${event.totalSteps} step(s))\n`,
        ),
      );
      break;
    case "workflow_step_start":
      write(
        paint("progress", `[workflow ${event.toolCallId}] step ${event.stepId} start: ${event.agentType}\n`),
      );
      break;
    case "workflow_step_progress":
      write(
        paint(
          "progress",
          `[workflow ${event.toolCallId}] step ${event.stepId} progress: turns=${event.turns} toolCalls=${event.toolCalls}` +
            `${event.lastTool !== undefined ? ` lastTool=${event.lastTool}` : ""}\n`,
        ),
      );
      break;
    case "workflow_step_end":
      write(
        paint(
          "progress",
          `[workflow ${event.toolCallId}] step ${event.stepId} end (${event.status}): turns=${event.turns} durationMs=${event.durationMs}\n`,
        ),
      );
      break;
    case "workflow_end":
      write(
        paint(
          "progress",
          `[workflow ${event.toolCallId}] end (${event.status}): completedSteps=${event.completedSteps}/${event.totalSteps} durationMs=${event.durationMs}\n`,
        ),
      );
      break;
    // design §3.4: reasoning is rendered ONLY when transcript?.reasoning is
    // truthy — absent object, reasoning:false, print mode, and non-TTY all
    // take this same false branch, which is today's silent drop (byte-
    // identical to the pre-4.2.2 no-op). The header is emitted even in
    // no-color: without it, dim reasoning text is otherwise indistinguishable

    case "reasoning_start":
      if (transcript?.reasoning) {
        write(paint("reasoning", "\n[reasoning]\n"));
      }
      break;
    case "reasoning_delta":
      if (transcript?.reasoning) {
        write(paint("reasoning", event.text));
      }
      break;
    case "reasoning_end":
      if (transcript?.reasoning) {
        write("\n");
      }
      break;
    case "turn_end":
      if (event.finishReason === "length") {
        write("\n[output truncated: hit the model's max-output-token limit — raise ANYCODE_MAX_OUTPUT_TOKENS or split the write]\n");
      }
      break;
    case "turn_start":
    case "start":
    case "text_start":
    case "text_end":
    case "tool_input_start":
    case "tool_input_delta":
    case "tool_input_end":
    case "tool_call":
      // No terminal output for these Phase 0 events (structural/streaming-internal).
      break;
    // Checkpoint events (design slice-4.7-cut.md §2.7): rides the existing

    case "checkpoint_created":
      write(paint("dim", `[checkpoint] ${event.id.slice(0, 8)} — ${event.label}`) + "\n");
      return;
    case "checkpoint_failed":
      write(paint("warn", `[checkpoint] disabled for this session: ${event.reason}`) + "\n");
      return;
    default:
      break;
  }
}

/**
 * Renders `McpManager.status()` as a fixed-width table (design slice-3.2-cut.md
 * §6): name, transport, state, tool count, error. Exported for a direct
 * snapshot test (task 3.2.3 §5.2 item 6) without driving a full CLI session.
 * Task 4.1.3 adds the optional `theme`: widths/padding are computed on the
 * UNPAINTED strings first, and only then is the (already fully-formatted)
 * header row wrapped in the `dim` role — SGR never perturbs column alignment

 * ⇒ byte-identical to before theming.
 */
export function renderMcpStatusTable(statuses: McpServerStatus[], theme?: CliTheme): string {
  if (statuses.length === 0) {
    return "[mcp] no servers configured\n";
  }
  const header = ["name", "transport", "state", "tools", "error"];
  const rows = statuses.map((status) => [
    status.name,
    status.transport,
    status.state,
    String(status.toolCount),
    status.error ?? "",
  ]);
  const widths = header.map((label, i) =>
    Math.max(label.length, ...rows.map((row) => row[i]!.length)),
  );
  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  const headerLine = formatRow(header);
  return [theme?.paint("dim", headerLine) ?? headerLine, ...rows.map(formatRow)].join("\n") + "\n";
}

/**
 * Renders a SkillPort.list() snapshot as a fixed-width table (design
 * slice-3.3-cut.md §6): name, source, description. Exported for a direct
 * snapshot test without driving a full CLI session, mirroring
 * renderMcpStatusTable (task 3.2.3). Same `theme`/paint-after-padEnd rule as
 * renderMcpStatusTable (task 4.1.3).
 */
export function renderSkillsTable(metas: SkillMeta[], theme?: CliTheme): string {
  if (metas.length === 0) {
    return "[skills] no skills discovered\n";
  }
  const header = ["name", "source", "description"];
  const rows = metas.map((meta) => [meta.name, meta.source, meta.description]);
  const widths = header.map((label, i) =>
    Math.max(label.length, ...rows.map((row) => row[i]!.length)),
  );
  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  const headerLine = formatRow(header);
  return [theme?.paint("dim", headerLine) ?? headerLine, ...rows.map(formatRow)].join("\n") + "\n";
}

/**
 * Renders a workflow-metas snapshot as a fixed-width table (design
 * slice-3.4-cut.md §6): name, source, steps, description. Mirrors
 * renderSkillsTable; the metas are projected from ExtensionsBootstrap.workflows
 * at wiring time (design §2.9) rather than read through the AgentLoop's
 * WorkflowPort, so this table stays available before/independent of the
 * engine's own list() projection (workflow/engine.ts, task 3.4.2). Same
 * `theme`/paint-after-padEnd rule as renderMcpStatusTable (task 4.1.3).
 */
export function renderWorkflowsTable(metas: WorkflowMeta[], theme?: CliTheme): string {
  if (metas.length === 0) {
    return "[workflows] no workflows discovered\n";
  }
  const header = ["name", "source", "steps", "description"];
  const rows = metas.map((meta) => [meta.name, meta.source, String(meta.stepCount), meta.description]);
  const widths = header.map((label, i) =>
    Math.max(label.length, ...rows.map((row) => row[i]!.length)),
  );
  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  const headerLine = formatRow(header);
  return [theme?.paint("dim", headerLine) ?? headerLine, ...rows.map(formatRow)].join("\n") + "\n";
}

/**
 * Renders a CommandHookDeclaration list as a fixed-width table (design
 * slice-5.6-cut.md wave C): event, matcher, command — read-only introspection
 * of the boot-resolved config-driven hooks (dispatch/hook-config.ts), mirroring
 * renderMcpStatusTable/renderSkillsTable's shape (same width/padEnd/trimEnd
 * rule, deterministic bytes, no theme — this table has no call site that
 * threads one through). An absent/empty matcher renders as `—` (it means "runs
 * for every event", not "no matcher configured" — an empty cell would read as
 * missing data). A declaration with a `timeoutMs` gets a `  (timeout Nms)`
 * suffix appended to its command cell (the last column, so the suffix never
 * disturbs column alignment for rows without one).
 */
export function renderHooksTable(decls: readonly CommandHookDeclaration[]): string {
  if (decls.length === 0) {
    return "[hooks] no command hooks configured\n";
  }
  const header = ["event", "matcher", "command"];
  const rows = decls.map((decl) => [
    decl.event,
    decl.matcher !== undefined && decl.matcher !== "" ? decl.matcher : "—",
    decl.timeoutMs !== undefined ? `${decl.command}  (timeout ${decl.timeoutMs}ms)` : decl.command,
  ]);
  const widths = header.map((label, i) =>
    Math.max(label.length, ...rows.map((row) => row[i]!.length)),
  );
  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  return [formatRow(header), ...rows.map(formatRow)].join("\n") + "\n";
}

/** Per-row command-cell truncation cap for /tasks (design slice-5.5-cut.md wave C): a table row, unlike the JSON input preview above, must stay short enough for every column to line up. */
const TASKS_TABLE_COMMAND_MAX_CHARS = 60;

/** Whole-second elapsed time: uptime (now - startedAt) for a running task, or its final duration (endedAt - startedAt) for a terminal one. */
function formatTaskElapsed(snapshot: BackgroundTaskSnapshot, now: number): string {
  const elapsedMs =
    snapshot.status === "running" ? now - snapshot.startedAt : (snapshot.endedAt ?? now) - snapshot.startedAt;
  return `${Math.max(0, Math.round(elapsedMs / 1000))}s`;
}

/**
 * Renders an InProcessTaskManager.list() snapshot as a fixed-width table
 * (design slice-5.5-cut.md wave C, mirror of renderHooksTable's 5.6-C2
 * shape): id, status, uptime/duration, exit code, and command (truncated at
 * TASKS_TABLE_COMMAND_MAX_CHARS so a long command never blows out column
 * alignment). `now` defaults to Date.now(); overridable so a snapshot test
 * can render deterministic uptimes for still-`running` tasks.
 */
export function renderTasksTable(snapshots: readonly BackgroundTaskSnapshot[], opts?: { now?: number }): string {
  if (snapshots.length === 0) {
    return "[tasks] no background tasks in this session\n";
  }
  const now = opts?.now ?? Date.now();
  const header = ["id", "status", "time", "exit", "command"];
  const rows = snapshots.map((snapshot) => [
    snapshot.taskId,
    snapshot.status,
    formatTaskElapsed(snapshot, now),
    snapshot.exitCode !== null ? String(snapshot.exitCode) : "-",
    snapshot.command.length > TASKS_TABLE_COMMAND_MAX_CHARS
      ? `${snapshot.command.slice(0, TASKS_TABLE_COMMAND_MAX_CHARS)}…`
      : snapshot.command,
  ]);
  const widths = header.map((label, i) => Math.max(label.length, ...rows.map((row) => row[i]!.length)));
  const formatRow = (cols: string[]): string => cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  return [formatRow(header), ...rows.map(formatRow)].join("\n") + "\n";
}

/** Per-row stderr-tail truncation cap for /lsp crashed rows (mirrors TASKS_TABLE_COMMAND_MAX_CHARS). */
const LSP_TABLE_STDERR_MAX_CHARS = 200;

/**
 * Renders an LspManager.status() snapshot as a fixed-width table (design
 * slice-6.1-cut.md §2-D3, mirror of renderTasksTable's shape): name, state,
 * pid, extensions. A `crashed` server with a non-empty stderrTail gets a
 * `  (stderr: …)` suffix appended to its LAST column (mirrors
 * renderHooksTable's `(timeout Nms)` suffix on the command cell) — truncated
 * at LSP_TABLE_STDERR_MAX_CHARS so one noisy server never blows out column
 * alignment for every row. A missing pid (not yet spawned) renders as `-`,
 * mirroring renderTasksTable's null-exit-code convention.
 */
export function renderLspTable(statuses: LspServerStatus[]): string {
  if (statuses.length === 0) {
    return "[lsp] no language servers configured\n";
  }
  const header = ["name", "state", "pid", "extensions"];
  const rows = statuses.map((status) => {
    const extensionsCell = status.extensions.join(",");
    const showStderr = status.state === "crashed" && status.stderrTail !== "";
    const stderrSuffix = showStderr
      ? `  (stderr: ${
          status.stderrTail.length > LSP_TABLE_STDERR_MAX_CHARS
            ? `${status.stderrTail.slice(0, LSP_TABLE_STDERR_MAX_CHARS)}…`
            : status.stderrTail
        })`
      : "";
    return [
      status.name,
      status.state,
      status.pid !== undefined ? String(status.pid) : "-",
      `${extensionsCell}${stderrSuffix}`,
    ];
  });
  const widths = header.map((label, i) => Math.max(label.length, ...rows.map((row) => row[i]!.length)));
  const formatRow = (cols: string[]): string => cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  return [formatRow(header), ...rows.map(formatRow)].join("\n") + "\n";
}

/** Projects a discovered WorkflowDefinition onto its advertised WorkflowMeta (mirror of ports/workflow.ts's list() shape). */
export function toWorkflowMeta(workflow: WorkflowDefinition): WorkflowMeta {
  return {
    name: workflow.name,
    description: workflow.description,
    stepCount: workflow.steps.length,
    source: workflow.source,
  };
}

/** Renders /context (slice 6.4): line 1 mirrors the transcript's context_usage format for recognizability. */
export function formatContextInfo(info: ContextInfo): string {
  const pct =
    info.effectiveWindowTokens > 0
      ? Math.round((info.estimatedTokens / info.effectiveWindowTokens) * 100)
      : 0;
  const lines = [
    `[context] ~${info.estimatedTokens}/${info.effectiveWindowTokens} tokens (${pct}% of budget, source: ${info.source})`,
    `[context] window ${info.contextWindowTokens} — output reserve ${info.outputReserveTokens} — auto-compact at ${info.compactThresholdTokens}`,
    info.breakerTripped
      ? "[context] auto-compaction: disabled (circuit breaker tripped; /compact still works)"
      : "[context] auto-compaction: ready",
  ];
  return lines.join("\n") + "\n";
}

/**
 * Renders /context's per-category breakdown (design slice-P7.17-cut.md §2.1,
 * CLI-parity with the desktop hover popover): a cheap read-only appendix to
 * formatContextInfo's snapshot, straight off AgentLoop.contextBreakdown().
 * Percentages are tokens/totalEstimatedTokens (0 when the total is 0, never
 * NaN); categories with 0 tokens are omitted — mirrors the renderer
 * popover's "empty sections don't render" rule (§2.3). All six categories
 * are ALWAYS estimated (never provider-anchored, §2.1), so their sum can
 * legitimately diverge from formatContextInfo's provider-anchored total.
 */
export function formatContextBreakdown(breakdown: ContextBreakdown): string {
  const total = breakdown.totalEstimatedTokens;
  const rows: Array<[string, number]> = [
    ["Messages", breakdown.messagesTokens],
    ["System tools", breakdown.systemToolsTokens],
    ["MCP tools", breakdown.mcpToolsTokens],
    ["Skills", breakdown.skillsTokens],
    ["System prompt", breakdown.systemPromptTokens],
    ["Meta context", breakdown.metaTokens],
  ];
  const nonZeroRows = rows.filter(([, tokens]) => tokens > 0);
  const header = `[context] breakdown (estimated, total ~${total} tokens):`;
  if (nonZeroRows.length === 0) {
    return `${header}\n[context]   (no categories to report)\n`;
  }
  const lines = nonZeroRows.map(([label, tokens]) => {
    const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
    return `[context]   ${label}: ${tokens} tokens (${pct}%)`;
  });
  return [header, ...lines].join("\n") + "\n";
}

/** Renders /telemetry (slice 6.6). null = the opt-in sink was never built. */
export function renderTelemetryStatus(status: TelemetryStatus | null): string {
  if (status === null) {
    return "[telemetry] disabled (opt-in: set telemetry.enabled=true in .anycode/config.json)\n";
  }
  const lines = [
    `[telemetry] enabled — ${status.filePath}`,
    `[telemetry] records written ${status.written} — dropped ${status.dropped}`,
  ];
  if (status.lastWriteError !== undefined) {
    lines.push(`[telemetry] last write error: ${status.lastWriteError}`);
  }
  return lines.join("\n") + "\n";
}

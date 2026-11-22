/**
 * Pure parser for the Claude CLI's own subagent transcripts
 * (`<config>/projects/<project>/<session>/subagents/agent-<id>.jsonl`).
 *
 * The file is one JSON object per line. Only `user` and `assistant` lines
 * carry conversation (`message.content` is a string or a block array); the
 * rest (`attachment`, `api-request*`, ...) is CLI bookkeeping and is skipped.
 * Never throws: a malformed line is dropped. Every text field is capped so a
 * huge tool result cannot flood the renderer.
 */

/**
 * `prompt` is the task the agent was launched with (only ever the true first
 * line of the file); `message` is any later user-side text, including the
 * coordinating session's messages; `note` is CLI/harness-injected text (isMeta
 * lines, context-compaction summaries); `text` is the agent's own speech.
 */
export type ClaudeSubagentEntryKind = "prompt" | "message" | "note" | "text" | "thinking" | "tool_use" | "tool_result";

export interface ClaudeSubagentEntry {
  kind: ClaudeSubagentEntryKind;
  /** Tool name for `tool_use`; empty otherwise. */
  title: string;
  text: string;
  /** True for a `tool_result` the CLI flagged as an error. */
  isError?: true;
}

export const SUBAGENT_ENTRY_MAX_CHARS = 4_000;
export const SUBAGENT_MAX_ENTRIES = 600;

function cap(text: string): string {
  return text.length > SUBAGENT_ENTRY_MAX_CHARS ? `${text.slice(0, SUBAGENT_ENTRY_MAX_CHARS)}\n[truncated]` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One-line subject of a tool call: the field a reader would name it by, else compact JSON. */
export function summarizeSubagentToolInput(input: unknown): string {
  if (!isRecord(input)) return typeof input === "string" ? cap(input) : "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return cap(value);
  }
  try {
    return cap(JSON.stringify(input));
  } catch {
    return "";
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) parts.push(part.text);
    else if (part.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/** A user line that is nothing but harness `<system-reminder>` blocks carries no information for a reader. */
function isPureSystemReminder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>") && trimmed.indexOf("</system-reminder>") === trimmed.length - "</system-reminder>".length;
}

interface ParseState {
  /** The true first line of the file has not been consumed yet. */
  firstLineOpen: boolean;
}

interface UserLineFlags {
  /** `isMeta`: injected by the CLI/harness rather than typed by the user. */
  meta: boolean;
  /** Context-compaction summary (`isCompactSummary` / `isVisibleInTranscriptOnly`). */
  compact: boolean;
  /** A message from the coordinating session (`origin.kind === "coordinator"`). */
  coordinator: boolean;
}

function userTextEntry(text: string, flags: UserLineFlags, state: ParseState): ClaudeSubagentEntry[] {
  if (text.trim().length === 0) return [];
  const entry = (kind: ClaudeSubagentEntryKind): ClaudeSubagentEntry[] => [{ kind, title: "", text: cap(text) }];
  if (flags.compact) return entry("note");
  if (flags.meta && isPureSystemReminder(text)) return [];
  // The first user text of any kind is the run's prompt (a skill-invoked agent's
  // real prompt can be an isMeta line); a window that started mid-file has none.
  const wasFirst = state.firstLineOpen;
  state.firstLineOpen = false;
  if (wasFirst) return entry("prompt");
  return entry(flags.meta && !flags.coordinator ? "note" : "message");
}

function lineEntries(line: unknown, state: ParseState): ClaudeSubagentEntry[] {
  if (!isRecord(line) || (line.type !== "user" && line.type !== "assistant")) return [];
  const message = line.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  const isUser = line.type === "user";
  const origin = isRecord(line.origin) ? line.origin : undefined;
  const flags: UserLineFlags = {
    meta: line.isMeta === true,
    compact: line.isCompactSummary === true || line.isVisibleInTranscriptOnly === true,
    coordinator: origin?.kind === "coordinator",
  };
  if (typeof content === "string") {
    return isUser ? userTextEntry(content, flags, state) : content.trim().length > 0 ? [{ kind: "text", title: "", text: cap(content) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ClaudeSubagentEntry[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      if (isUser) out.push(...userTextEntry(block.text, flags, state));
      else out.push({ kind: "text", title: "", text: cap(block.text) });
    } else if (!isUser && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) {
      out.push({ kind: "thinking", title: "", text: cap(block.thinking) });
    } else if (!isUser && block.type === "tool_use" && typeof block.name === "string") {
      out.push({ kind: "tool_use", title: block.name.slice(0, 80), text: summarizeSubagentToolInput(block.input) });
    } else if (block.type === "tool_result") {
      out.push({
        kind: "tool_result",
        title: "",
        text: cap(resultText(block.content)),
        ...(block.is_error === true ? { isError: true as const } : {}),
      });
    }
  }
  return out;
}

/**
 * Parses JSONL `text` into display entries, oldest first. When more than
 * `maxEntries` survive, the NEWEST are kept (a running agent's tail matters
 * most) and `droppedEntries` counts the rest. `startedMidFile` means `text` is
 * a tail window: no entry may then be labelled `prompt`, since the real first
 * line is not in view.
 */
export function parseClaudeSubagentTranscript(
  text: string,
  options: { maxEntries?: number; startedMidFile?: boolean } = {},
): { entries: ClaudeSubagentEntry[]; droppedEntries: number } {
  const maxEntries = options.maxEntries ?? SUBAGENT_MAX_ENTRIES;
  const all: ClaudeSubagentEntry[] = [];
  const state: ParseState = { firstLineOpen: options.startedMidFile !== true };
  for (const raw of text.split("\n")) {
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    all.push(...lineEntries(parsed, state));
  }
  const droppedEntries = Math.max(0, all.length - maxEntries);
  return { entries: droppedEntries > 0 ? all.slice(droppedEntries) : all, droppedEntries };
}

export type ClaudeSubagentTranscriptResult =
  | { ok: true; entries: ClaudeSubagentEntry[]; droppedEntries: number; truncatedHead: boolean }
  | { ok: false; reason: "unavailable" | "not_found" };

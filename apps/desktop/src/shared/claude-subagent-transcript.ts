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

export type ClaudeSubagentEntryKind = "prompt" | "text" | "thinking" | "tool_use" | "tool_result";

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
  return content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

function lineEntries(line: unknown, seenFirstPrompt: { value: boolean }): ClaudeSubagentEntry[] {
  if (!isRecord(line) || (line.type !== "user" && line.type !== "assistant")) return [];
  const message = line.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string") {
    if (content.trim().length === 0) return [];
    const kind: ClaudeSubagentEntryKind = line.type === "user" && !seenFirstPrompt.value ? "prompt" : "text";
    if (line.type === "user") seenFirstPrompt.value = true;
    return [{ kind, title: "", text: cap(content) }];
  }
  if (!Array.isArray(content)) return [];
  const out: ClaudeSubagentEntry[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      out.push({ kind: "text", title: "", text: cap(block.text) });
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0) {
      out.push({ kind: "thinking", title: "", text: cap(block.thinking) });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
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
 * most) and `droppedEntries` counts the rest.
 */
export function parseClaudeSubagentTranscript(
  text: string,
  maxEntries: number = SUBAGENT_MAX_ENTRIES,
): { entries: ClaudeSubagentEntry[]; droppedEntries: number } {
  const all: ClaudeSubagentEntry[] = [];
  const seenFirstPrompt = { value: false };
  for (const raw of text.split("\n")) {
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    all.push(...lineEntries(parsed, seenFirstPrompt));
  }
  const droppedEntries = Math.max(0, all.length - maxEntries);
  return { entries: droppedEntries > 0 ? all.slice(droppedEntries) : all, droppedEntries };
}

export type ClaudeSubagentTranscriptResult =
  | { ok: true; entries: ClaudeSubagentEntry[]; droppedEntries: number; truncatedHead: boolean }
  | { ok: false; reason: "unavailable" | "not_found" };

/**
 * Pure summary helper for the subagent activity feed (slice P7.18/F16b).
 *
 * Produces one short, human-readable subject line per child tool call for the
 * renderer's live feed. It NEVER ships raw child input on the wire: the result
 * is hard-capped at SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS and is a single line
 * (control chars collapsed), so a runaway command or file path cannot flood or
 * corrupt the parent stream. The verb word lives renderer-side; this returns the
 * subject only (e.g. the command, file path, pattern, or description), empty for
 * tools with no meaningful one-line subject (the tool name alone is shown then).
 */

/** Hard cap on an activity summary; longer subjects are truncated with an ellipsis. */
export const SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS = 160;

/** Reads a string field off an unknown input object, or "" when absent/non-string. */
function str(input: unknown, key: string): string {
  if (input !== null && typeof input === "object" && key in input) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

/** First non-empty line of a string (commands may be multi-line). */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return text.trim();
}

/**
 * Strips C0 (\u0000-\u001F incl. ESC), DEL (\u007F) and C1 (\u0080-\u009F)
 * control bytes, collapses remaining whitespace runs to a single space, and
 * truncates on a CODE-POINT boundary (never mid-surrogate-pair) with an
 * ellipsis marker on truncation (W1-FIX, hardening). Shared with the agent.ts
 * wire bridge (FIX-2) so both trust boundaries agree on one sanitize+cap rule.
 * Terminal-control bytes from e.g. a raw Bash command can never reach the
 * feed; a 160th-char boundary landing mid-surrogate-pair truncates cleanly
 * instead of emitting a lone surrogate.
 */
export function sanitizeAndCap(text: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex -- control-byte strip is the point
  const stripped = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  const oneLine = stripped.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(oneLine);
  if (codePoints.length <= maxChars) {
    return oneLine;
  }
  return codePoints.slice(0, maxChars - 1).join("") + "…";
}

/** Collapses any whitespace/control runs to single spaces and caps the length. */
function cap(text: string): string {
  return sanitizeAndCap(text, SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS);
}

/** TodoWrite subject: the in-progress item's text plus done/total counts. */
function summarizeTodoWrite(input: unknown): string {
  if (input === null || typeof input !== "object" || !("todos" in input)) {
    return "";
  }
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) {
    return "";
  }
  const total = todos.length;
  let done = 0;
  let inProgress = "";
  for (const item of todos) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const status = (item as { status?: unknown }).status;
    const content = (item as { content?: unknown }).content;
    if (status === "completed") {
      done += 1;
    }
    if (status === "in_progress" && inProgress === "" && typeof content === "string") {
      inProgress = content;
    }
  }
  const counts = `${done}/${total}`;
  return inProgress ? `${inProgress} ${counts}` : counts;
}

/**
 * Maps a child tool call (name + raw unvalidated input) to a bounded subject
 * line for the activity feed. Pure; the length cap is enforced on every branch.
 */
export function summarizeChildToolCall(name: string, input: unknown): string {
  switch (name) {
    case "Bash":
      return cap(firstLine(str(input, "command")));
    case "Read":
    case "Write":
    case "Edit":
      return cap(str(input, "file_path"));
    case "Grep":
    case "Glob":
      return cap(str(input, "pattern"));
    case "Agent":
      return cap(str(input, "description"));
    case "TodoWrite":
      return cap(summarizeTodoWrite(input));
    default:
      return "";
  }
}

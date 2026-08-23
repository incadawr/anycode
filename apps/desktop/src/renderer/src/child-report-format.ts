/**
 * TASK.145 срез 2 (spec §4 point 3): renders a system-origin `user_text`
 * transcript block ("фоновый сабагент <тип> завершился: completed/failed")
 * without importing @anycode/core's `child-notification.ts` formatter as a
 * runtime value — renderer PRODUCTION code imports core type-only, never as
 * a value (see subagent-card.ts's own doc for why: a value import pulls the
 * whole core module graph, node deps included, into the browser bundle).
 *
 * Instead this is a small, renderer-owned, best-effort READER of the exact
 * text format that module writes (a fixed `[SYSTEM NOTIFICATION...]` header
 * + a `<task-notification>` block with `<subagent-type>`/`<status>`/
 * `<summary>` fields, all XML-escaped). It never throws and never blocks
 * rendering on a parse miss — a block whose text doesn't match the expected
 * shape (a future format change, or the coalesced cap-notice, which carries
 * no `<task-notification>` body at all) still renders, just with generic
 * fallback fields instead of the real subagent-type/status.
 */

const STATUSES = ["completed", "failed", "cancelled"] as const;
export type ParsedChildReportStatus = (typeof STATUSES)[number] | "unknown";

export interface ParsedChildReport {
  subagentType: string;
  status: ParsedChildReportStatus;
  /** Unescaped `<summary>` content when present; otherwise the raw input text (never hides information). */
  summary: string;
}

/** Extracts the text between `<tag>...</tag>` (non-greedy, tolerant of embedded newlines); `undefined` if the tag is absent. */
function extractField(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1];
}

/** Inverse of child-notification.ts's `escapeXmlText` — only the three entities that formatter ever emits. */
function unescapeXmlText(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function isKnownStatus(value: string): value is (typeof STATUSES)[number] {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * Parses ONE detached-child report's display fields out of its full
 * model-facing text. Total (never throws): every field independently
 * defaults when absent or unrecognized, so a coalesced cap-notice (no
 * `<task-notification>` body at all) still yields a renderable result —
 * `summary` falls back to the ENTIRE input text, never an empty string.
 */
export function parseChildReportText(text: string): ParsedChildReport {
  const rawSubagentType = extractField(text, "subagent-type");
  const rawStatus = extractField(text, "status");
  const rawSummary = extractField(text, "summary");
  return {
    subagentType: rawSubagentType !== undefined ? unescapeXmlText(rawSubagentType) : "subagent",
    status: rawStatus !== undefined && isKnownStatus(rawStatus) ? rawStatus : "unknown",
    summary: rawSummary !== undefined ? unescapeXmlText(rawSummary) : text,
  };
}

const STATUS_LABEL: Record<ParsedChildReportStatus, string> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  unknown: "finished",
};

/** The compact card's one-line summary — "Background subagent <type> <status-label>". */
export function childReportCardLabel(parsed: ParsedChildReport): string {
  return `Background subagent ${parsed.subagentType} ${STATUS_LABEL[parsed.status]}`;
}

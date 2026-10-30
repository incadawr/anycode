import { scrubApprovalText } from "@anycode/core";
export { scrubApprovalText } from "@anycode/core";

/**
 * Taskana 4763: a short, scrubbed, single-line description of a pending tool
 * request, for the Sessions API (`list_pending_approvals`) and for any channel
 * plugin that shows it to a person. It never carries file contents, edit
 * bodies, typed browser text, query strings or credentials. It is pure and it
 * never throws. Output is always one line and at most MAX_LENGTH characters.
 */

const MAX_LENGTH = 200;
const FIELD_LIMIT = 160;
const MAX_KEYS = 5;
/** One line, control characters removed, capped. */
function finish(text: string, limit: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
  const scrubbed = scrubApprovalText(flat);
  return scrubbed.length > limit ? `${scrubbed.slice(0, limit - 1)}…` : scrubbed;
}

function stringField(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function urlWithoutSecrets(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(invalid url)";
  }
}

function originOf(raw: string | undefined): string {
  if (raw === undefined) return "page";
  try {
    return new URL(raw).origin;
  } catch {
    return "page";
  }
}

function describeKnown(toolName: string, input: unknown): string | undefined {
  switch (toolName) {
    case "Bash":
    case "CodexExec": {
      const command = stringField(input, "command");
      if (command === undefined) return "(no command)";
      const collapsed = command.replace(/\s*[\r\n]+\s*/g, " ; ");
      return finish(scrubApprovalText(collapsed), FIELD_LIMIT);
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "Read":
    case "Glob":
    case "Grep": {
      const target = stringField(input, "file_path") ?? stringField(input, "path") ?? stringField(input, "pattern");
      return target === undefined ? "(no target)" : finish(target, FIELD_LIMIT);
    }
    case "NotebookEdit": {
      const target = stringField(input, "notebook_path") ?? stringField(input, "file_path");
      return target === undefined ? "(no target)" : finish(target, FIELD_LIMIT);
    }
    case "CodexApplyPatch": {
      const paths = (input !== null && typeof input === "object" && Array.isArray((input as Record<string, unknown>).paths)
        ? ((input as Record<string, unknown>).paths as unknown[])
        : []
      ).filter((p): p is string => typeof p === "string");
      const shown = paths.slice(0, 3).map((p) => finish(p, FIELD_LIMIT)).join(", ");
      return `patch touching ${paths.length} file(s): ${shown}`;
    }
    case "WebFetch":
    case "BrowserNavigate":
    case "BrowserOpen": {
      const raw = stringField(input, "url") ?? stringField(input, "path");
      return raw === undefined ? "(no url)" : finish(urlWithoutSecrets(raw), FIELD_LIMIT);
    }
    case "BrowserClick":
    case "BrowserType":
      return `on ${originOf(stringField(input, "url"))}`;
    case "BrowserEval":
      return "run JavaScript in the page";
    default:
      return undefined;
  }
}

/**
 * The description of a pending request. Commands are shown collapsed and
 * scrubbed; file bodies, edit text, typed text and eval expressions never
 * appear. Any other tool (including MCP tools) gets its argument COUNT and its
 * top-level key names, never values.
 */
export function describeApproval(toolName: string, input: unknown): string {
  try {
    const known = describeKnown(toolName, input);
    if (known !== undefined) return finish(known, MAX_LENGTH);
    const keys = input !== null && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
    const shownKeys = keys.slice(0, MAX_KEYS).map((k) => finish(k, 40)).join(", ");
    const tail = keys.length > MAX_KEYS ? `, +${keys.length - MAX_KEYS} more` : "";
    const summary = keys.length === 0
      ? `${finish(toolName, 60)} with no arguments`
      : `${finish(toolName, 60)} with ${keys.length} argument(s): ${shownKeys}${tail}`;
    return finish(summary, MAX_LENGTH);
  } catch {
    return "(description unavailable)";
  }
}

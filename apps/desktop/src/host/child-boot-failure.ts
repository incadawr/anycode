import { scrubApprovalText } from "@anycode/core";
import { CHILD_FINAL_TEXT_MAX_CHARS, CHILD_TERMINAL_TYPE, type ChildTerminal } from "../shared/child-sessions.js";

const STARTUP_HINT = "\nThis is a startup failure; retry the task unchanged.";

export function sanitizeBootFailure(message: string): { message: string; truncated: boolean } {
  const safe = scrubApprovalText(message);
  const limit = CHILD_FINAL_TEXT_MAX_CHARS - STARTUP_HINT.length;
  return { message: safe.slice(0, limit), truncated: safe.length > limit };
}

export function childBootFailure(message: string, truncated = false): ChildTerminal {
  return {
    type: CHILD_TERMINAL_TYPE,
    status: "error",
    finalText: message + STARTUP_HINT,
    truncated,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

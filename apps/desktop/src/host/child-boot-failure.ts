import { scrubFailureText } from "@anycode/core";
import { CHILD_FINAL_TEXT_MAX_CHARS, CHILD_TERMINAL_TYPE, type ChildTerminal } from "../shared/child-sessions.js";

const STARTUP_HINT = "\nThis is a startup failure; do not retry the task unchanged.";

export function sanitizeBootFailure(message: string): { message: string; truncated: boolean } {
  const limit = CHILD_FINAL_TEXT_MAX_CHARS - STARTUP_HINT.length;
  const truncated = message.length > limit;
  // Do not expose an incomplete token (such as URL userinfo) at the cut.
  let cut = Math.min(message.length, limit);
  if (truncated && !/\s/.test(message[cut]!)) {
    while (cut > 0 && !/\s/.test(message[cut - 1]!)) cut--;
  }
  const bounded = message.slice(0, cut);
  const safe = scrubFailureText(bounded);
  return { message: safe.slice(0, limit), truncated: truncated || safe.length > limit };
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

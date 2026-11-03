import { scrubApprovalText } from "@anycode/core";
import { CHILD_FINAL_TEXT_MAX_CHARS, CHILD_TERMINAL_TYPE, type ChildTerminal } from "../shared/child-sessions.js";

export function childBootFailure(message: string): ChildTerminal {
  const hint = "\nThis is a startup failure; retry the task unchanged.";
  const safe = scrubApprovalText(message);
  const limit = CHILD_FINAL_TEXT_MAX_CHARS - hint.length;
  return {
    type: CHILD_TERMINAL_TYPE,
    status: "error",
    finalText: safe.slice(0, limit) + hint,
    truncated: safe.length > limit,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

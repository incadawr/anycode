import { CHILD_TERMINAL_TYPE, type ChildTerminal } from "../shared/child-sessions.js";

export function childBootFailure(message: string): ChildTerminal {
  return {
    type: CHILD_TERMINAL_TYPE,
    status: "error",
    finalText: `${message}\nThis is a startup failure; retry the task unchanged.`,
    truncated: false,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

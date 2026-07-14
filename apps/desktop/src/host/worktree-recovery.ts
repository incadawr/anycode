import type { HistoryItem } from "@anycode/core";

/** Exact history/journal correlation for crash recovery of terminal tools. */
export function hasDurableTransitionResult(
  history: readonly HistoryItem[],
  kind: "enter_worktree" | "exit_worktree",
  origin: "tool" | "chrome",
  toolCallId: string | undefined,
): boolean {
  if (origin === "chrome") return true;
  if (toolCallId === undefined) return false;
  const toolName = kind === "enter_worktree" ? "EnterWorktree" : "ExitWorktree";
  for (let itemIndex = history.length - 1; itemIndex >= 0; itemIndex--) {
    const message = history[itemIndex]!.message;
    if (message.role === "tool") {
      for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
        const part = message.content[partIndex]!;
        if (part.toolName === toolName && part.toolCallId === toolCallId) return part.status === "success";
      }
    } else if (message.role === "assistant") {
      for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
        const part = message.content[partIndex]!;
        if (part.type === "tool_call" && part.toolName === toolName && part.toolCallId === toolCallId) return false;
      }
    }
  }
  return false;
}

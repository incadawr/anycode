import type { WireAgentEvent } from "../../shared/protocol.js";

export type ClaudeBackgroundTask = Extract<WireAgentEvent, { type: "claude_background_task" }>;

/** Tasks the CLI tracks for a foreground call are not background tasks: never shown. */
export function visibleBackgroundTasks(tasks: readonly ClaudeBackgroundTask[]): ClaudeBackgroundTask[] {
  return tasks.filter(task => task.foreground !== true);
}

export function backgroundTaskForToolCall(tasks: readonly ClaudeBackgroundTask[], toolCallId: string): ClaudeBackgroundTask | undefined {
  return tasks.find(task => task.toolCallId === toolCallId && task.foreground !== true);
}

/** `exit code 2` / `exit code: 2` as the CLI words it in the completion summary. */
export function backgroundExitCode(summary: string | undefined): number | undefined {
  const match = summary?.match(/exit(?:ed)?(?: with)?(?: code|status)?[:\s]+(-?\d{1,4})\b/i);
  return match ? Number(match[1]) : undefined;
}

/** The path the CLI names in the launch result: "Output is being written to: <path>". */
export function outputFileFromResult(text: string | null | undefined): string | undefined {
  const match = text?.match(/(?:output (?:is being )?written to|output file)\s*:\s*(\/[^\r\n]+)/i);
  return match?.[1]?.trim().replace(/[.)\]]+$/, "") || undefined;
}

export type BackgroundCardTone = "running" | "success" | "error" | "unknown";

/** Card badge for a tool call that launched a background task. */
export function backgroundCardStatus(task: ClaudeBackgroundTask): { label: string; tone: BackgroundCardTone } {
  const code = backgroundExitCode(task.summary);
  const exit = code === undefined ? "" : ` (exit ${code})`;
  switch (task.status) {
    case "running": return { label: "Running in background", tone: "running" };
    case "completed": return { label: `Completed${exit}`, tone: "success" };
    case "failed": return { label: `Failed${exit}`, tone: "error" };
    case "stopped": return { label: "Stopped", tone: "unknown" };
    default: return { label: "Unknown", tone: "unknown" };
  }
}

export function backgroundTaskKindLabel(task: ClaudeBackgroundTask): string {
  return task.kind === "bash" ? "Bash" : "Monitor";
}

export function formatTaskElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

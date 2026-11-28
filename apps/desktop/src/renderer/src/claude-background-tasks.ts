import type { WireAgentEvent } from "../../shared/protocol.js";

export type ClaudeBackgroundTask = Extract<WireAgentEvent, { type: "claude_background_task" }>;

/** Tasks the CLI tracks for a foreground call are not background tasks: never shown. */
export function visibleBackgroundTasks(tasks: readonly ClaudeBackgroundTask[]): ClaudeBackgroundTask[] {
  return tasks.filter(task => task.foreground !== true);
}

/** How many listed (non-foreground) tasks are still running: the sidebar badge's task count. */
export function runningBackgroundTaskCount(tasks: readonly ClaudeBackgroundTask[]): number {
  return visibleBackgroundTasks(tasks).filter(task => task.status === "running").length;
}

/**
 * The command count the sidebar pill shows for a tab: the CLI's own list on a Claude tab, core's task list on a core tab
 * (the engines AnyCode runs DeepSeek and other providers on), and none on other engines. Only the engine that is live
 * counts, so a list left behind by an engine the tab switched away from can not keep the pill lit. An engine that is
 * not known yet counts both lists, which is safe because only the live engine ever fills its own.
 */
export function badgeTaskCount(
  engineId: string | undefined,
  claudeTasks: readonly ClaudeBackgroundTask[],
  coreTasks: readonly { status: string }[],
): number {
  const claude = engineId === undefined || engineId === "claude" ? runningBackgroundTaskCount(claudeTasks) : 0;
  const core = engineId === undefined || engineId === "core" ? coreTasks.filter(task => task.status === "running").length : 0;
  return claude + core;
}

/** Exit code from the CLI's closing wording: `... completed (exit code 0)` / `... failed with exit code 144`. Anchored to the end: the description may mention "exit 3". */
export function backgroundExitCode(summary: string | undefined): number | undefined {
  const match = summary?.trim().match(/(?:\(exit code (-?\d{1,4})\)|exit code (-?\d{1,4}))\.?$/i);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : Number(value);
}

/** The path the CLI names in the launch result, which continues on the same line ("…ID.output. You will be notified…"). */
export function outputFileFromResult(text: string | null | undefined): string | undefined {
  return text?.match(/written to:\s*(\/\S+?\.output)(?=[.\s,;]|$)/i)?.[1];
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

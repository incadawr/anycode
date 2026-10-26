/** Stale-plan reminder (Taskana 4665): pure counter, wired by AgentLoop. */
import type { TodoItem } from "../tools/todo-store.js";
import type { ToolCallStatus } from "../types/tools.js";
import { classifyBashCommandLine } from "../permissions/safe-command.js";

/** Only workspace mutations advance the stale-plan clock. */
export function isTodoMutation(name: string, input: unknown): boolean {
  if (name === "Bash") {
    const command = typeof input === "object" && input !== null && "command" in input ? input.command : undefined;
    return typeof command !== "string" || classifyBashCommandLine(command).class !== "read-only";
  }
  return name === "Write" || name === "Edit" || name === "MultiEdit" || name === "ApplyPatch";
}

export const DEFAULT_TODO_REMINDER_EVERY_TOOL_CALLS = 10;

export interface TodoReminderConfig {
  enabled?: boolean;
  everyToolCalls?: number;
}

/** null => reminder disabled. */
export function resolveTodoReminderEvery(config: TodoReminderConfig | undefined): number | null {
  if (config?.enabled === false) return null;
  const every = config?.everyToolCalls ?? DEFAULT_TODO_REMINDER_EVERY_TOOL_CALLS;
  if (!Number.isInteger(every) || every < 1) return null;
  return every;
}

export function formatTodoReminder(callsSinceUpdate: number, openItems: number): string {
  return (
    "<system-reminder>\n" +
    `The todo list has not been updated for ${callsSinceUpdate} tool calls and still has ${openItems} unfinished item(s). ` +
    "If you have made progress, call TodoWrite now: mark finished items completed and the current one in_progress. " +
    "If the plan is still accurate, continue. Do not mention this reminder to the user.\n" +
    "</system-reminder>"
  );
}

export class TodoReminderTracker {
  private sinceUpdate = 0;
  private sinceReminder = 0;

  constructor(private every: number) {}

  setThreshold(every: number): void { this.every = every; }

  snapshot(): { count: number; threshold: number } {
    return { count: this.sinceUpdate, threshold: this.every };
  }

  /** One settled tool call, in proposal order. */
  observe(toolName: string, status: ToolCallStatus, mutating = true): void {
    if (toolName === "TodoWrite" && status === "success") {
      this.sinceUpdate = 0;
      this.sinceReminder = 0;
      return;
    }
    if (!mutating) return;
    this.sinceUpdate += 1;
    this.sinceReminder += 1;
  }

  /**
   * Once per step after all observe() calls. Reads todos ONLY when due.
   * Firing resets sinceReminder.
   */
  take(readTodos: () => readonly TodoItem[]): string | null {
    if (this.sinceReminder < this.every) return null;
    const open = readTodos().filter((t) => t.status !== "completed").length;
    if (open === 0) return null;
    this.sinceReminder = 0;
    return formatTodoReminder(this.sinceUpdate, open);
  }
}

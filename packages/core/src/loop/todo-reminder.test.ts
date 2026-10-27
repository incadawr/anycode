import { describe, expect, it, vi } from "vitest";

import type { TodoItem } from "../tools/todo-store.js";

import {
  DEFAULT_TODO_REMINDER_EVERY_TOOL_CALLS,
  formatTodoReminder,
  resolveTodoReminderEvery,
  TodoReminderTracker,
  isTodoMutation,
} from "./todo-reminder.js";

it("counts edits and mutating shell commands, not reads", () => {
  expect(isTodoMutation("Read", {})).toBe(false);
  expect(isTodoMutation("Grep", {})).toBe(false);
  expect(isTodoMutation("Bash", { command: "cat src/main.ts" })).toBe(false);
  expect(isTodoMutation("Bash", { command: "rg -n pattern src" })).toBe(false);
  expect(isTodoMutation("Bash", { command: "sed -n '1,200p' src/main.ts" })).toBe(false);
  expect(isTodoMutation("Bash", { command: "sed -i 's/a/b/' file" })).toBe(true);
  expect(isTodoMutation("Bash", { command: "rg --pre=script pattern src" })).toBe(true);
  expect(isTodoMutation("Bash", { command: "echo x > file" })).toBe(true);
  expect(isTodoMutation("Edit", {})).toBe(true);
  const tracker = new TodoReminderTracker(20);
  for (let i = 0; i < 30; i++) tracker.observe("Read", "success", false);
  expect(tracker.snapshot()).toEqual({ count: 0, threshold: 20 });
  tracker.observe("Edit", "denied", true);
  tracker.observe("Edit", "invalid_input", true);
  expect(tracker.snapshot().count).toBe(0);
  tracker.observe("Edit", "success", true);
  expect(tracker.snapshot().count).toBe(1);
  tracker.observe("TodoWrite", "success", false);
  expect(tracker.snapshot().count).toBe(0);
});

function items(...statuses: Array<TodoItem["status"]>): TodoItem[] {
  return statuses.map((status, i) => ({ id: `t${i}`, content: `item ${i}`, status }));
}

describe("resolveTodoReminderEvery", () => {
  it("defaults to 10 for undefined config", () => {
    expect(resolveTodoReminderEvery(undefined)).toBe(10);
    expect(DEFAULT_TODO_REMINDER_EVERY_TOOL_CALLS).toBe(10);
  });

  it("honors an explicit everyToolCalls", () => {
    expect(resolveTodoReminderEvery({ everyToolCalls: 3 })).toBe(3);
  });

  it("enabled:false disables", () => {
    expect(resolveTodoReminderEvery({ enabled: false })).toBeNull();
    expect(resolveTodoReminderEvery({ enabled: false, everyToolCalls: 3 })).toBeNull();
  });

  it("rejects 0, negatives and non-integers", () => {
    expect(resolveTodoReminderEvery({ everyToolCalls: 0 })).toBeNull();
    expect(resolveTodoReminderEvery({ everyToolCalls: -1 })).toBeNull();
    expect(resolveTodoReminderEvery({ everyToolCalls: 2.5 })).toBeNull();
  });
});

describe("TodoReminderTracker threshold", () => {
  it("does not fire before the threshold, fires on it", () => {
    const tracker = new TodoReminderTracker(3);
    const readTodos = vi.fn(() => items("pending") as readonly TodoItem[]);
    tracker.observe("Bash", "success");
    tracker.observe("Bash", "success");
    expect(tracker.take(readTodos)).toBeNull();
    tracker.observe("Bash", "success");
    const out = tracker.take(readTodos);
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("3 mutating tool calls");
    expect(out).toContain("1 unfinished");
    expect(readTodos).toHaveBeenCalledTimes(1);
  });

  it("formats the reminder with the open-item count", () => {
    expect(formatTodoReminder(4, 2)).toBe(
      "<system-reminder>\n" +
        "The todo list has not been updated for 4 mutating tool calls and still has 2 unfinished item(s). " +
        "If you have made progress, call TodoWrite now: mark finished items completed and the current one in_progress. " +
        "If the plan is still accurate, continue. Do not mention this reminder to the user.\n" +
        "</system-reminder>",
    );
  });
});

describe("TodoReminderTracker frequency", () => {
  it("fires at most once per window; sinceUpdate keeps counting across firings", () => {
    const tracker = new TodoReminderTracker(3);
    const open = () => items("pending");
    for (let i = 0; i < 3; i += 1) tracker.observe("Bash", "success");
    expect(tracker.take(open)).toContain("3 mutating tool calls");
    // Not due again yet.
    tracker.observe("Bash", "success");
    tracker.observe("Bash", "success");
    expect(tracker.take(open)).toBeNull();
    // Due again; the message reports calls since the last update, not since the last reminder.
    tracker.observe("Bash", "success");
    const second = tracker.take(open);
    expect(second).toContain("<system-reminder>");
    expect(second).toContain("6 mutating tool calls");
  });
});

describe("TodoReminderTracker reset on successful TodoWrite", () => {
  it("a successful TodoWrite resets both counters", () => {
    const tracker = new TodoReminderTracker(3);
    const open = () => items("in_progress");
    tracker.observe("Bash", "success");
    tracker.observe("Bash", "success");
    tracker.observe("TodoWrite", "success");
    tracker.observe("Bash", "success");
    tracker.observe("Bash", "success");
    expect(tracker.take(open)).toBeNull();
    tracker.observe("Bash", "success");
    expect(tracker.take(open)).toContain("3 mutating tool calls");
  });

  it("a failed TodoWrite neither resets nor advances the mutation counter", () => {
    const tracker = new TodoReminderTracker(3);
    tracker.observe("Bash", "success");
    tracker.observe("TodoWrite", "error", false);
    expect(tracker.snapshot().count).toBe(1);
  });
});

describe("TodoReminderTracker without open items", () => {
  it("never fires on an empty store and defers the read until due", () => {
    const tracker = new TodoReminderTracker(1);
    const readTodos = vi.fn(() => [] as readonly TodoItem[]);
    // Not due: sinceReminder (0) < every (1) — the store must not be read yet.
    expect(tracker.take(readTodos)).toBeNull();
    expect(readTodos).not.toHaveBeenCalled();
    tracker.observe("Bash", "success");
    expect(tracker.take(readTodos)).toBeNull();
    expect(readTodos).toHaveBeenCalledTimes(1);
  });

  it("never fires when everything is completed, fires once an item opens", () => {
    const tracker = new TodoReminderTracker(3);
    let store: readonly TodoItem[] = items("completed", "completed");
    const readTodos = () => store;
    for (let i = 0; i < 6; i += 1) {
      tracker.observe("Bash", "success");
      expect(tracker.take(readTodos)).toBeNull();
    }
    store = items("completed", "pending");
    tracker.observe("Bash", "success");
    expect(tracker.take(readTodos)).toContain("1 unfinished");
  });
});

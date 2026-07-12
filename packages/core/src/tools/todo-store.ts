/**
 * Session todo state (design §2.4): in-process only — todos are not persisted
 * in Phase 1. TodoWrite has replace-all semantics, so the store is a plain
 * swap-and-read container. Wired as CorePorts.todos.
 */

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoStore {
  read(): TodoItem[];
  /** Replaces the whole list (TodoWrite semantics); returns the stored items. */
  replaceAll(items: TodoItem[]): TodoItem[];
}

export class InMemoryTodoStore implements TodoStore {
  private items: TodoItem[] = [];

  read(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  replaceAll(items: TodoItem[]): TodoItem[] {
    this.items = items.map((item) => ({ ...item }));
    return this.read();
  }
}

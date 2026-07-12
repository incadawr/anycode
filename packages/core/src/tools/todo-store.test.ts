/** InMemoryTodoStore: replace-all semantics and defensive copying (design §2.4). */

import { describe, expect, it } from "vitest";
import { InMemoryTodoStore, type TodoItem } from "./todo-store.js";

describe("InMemoryTodoStore", () => {
  it("starts empty and round-trips replaceAll -> read", () => {
    const store = new InMemoryTodoStore();
    expect(store.read()).toEqual([]);

    const items: TodoItem[] = [
      { id: "1", content: "first", status: "pending" },
      { id: "2", content: "second", status: "in_progress" },
    ];
    const stored = store.replaceAll(items);
    expect(stored).toEqual(items);
    expect(store.read()).toEqual(items);
  });

  it("replaceAll replaces the entire list (no merge)", () => {
    const store = new InMemoryTodoStore();
    store.replaceAll([{ id: "1", content: "first", status: "pending" }]);
    store.replaceAll([{ id: "9", content: "only", status: "completed" }]);
    expect(store.read()).toEqual([{ id: "9", content: "only", status: "completed" }]);
  });

  it("read returns copies — mutating the result does not affect the store", () => {
    const store = new InMemoryTodoStore();
    store.replaceAll([{ id: "1", content: "first", status: "pending" }]);
    const copy = store.read();
    copy[0]!.content = "tampered";
    expect(store.read()[0]?.content).toBe("first");
  });
});

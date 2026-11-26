// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ToolCallBlock, TranscriptBlock } from "./store.js";
import { blockIdByToolCall, blockIdEntry, isAbove, resolveAnchorElement, toolBlocksFor } from "./use-deck-anchors.js";

const tool = (id: string, toolCallId: string): TranscriptBlock => ({ kind: "tool_call", id, toolCallId, toolName: "Bash", input: {}, status: "success", modelText: null, snapshots: { before: null, after: null }, subagent: null } as TranscriptBlock);
const text = (id: string, t = "x"): TranscriptBlock => ({ kind: "assistant_text", id, text: t });

describe("blockIdByToolCall", () => {
  it("maps live (same id) and hydrated (item:part) blocks", () => {
    const map = blockIdByToolCall([tool("live1", "live1"), tool("item9:2", "toolu_x")]);
    expect(map.get("live1")).toBe("live1");
    expect(map.get("toolu_x")).toBe("item9:2");
  });
  it("ignores non-tool blocks", () => {
    expect(blockIdByToolCall([text("a")]).size).toBe(0);
  });
  it("keeps identity when an unrelated block changes", () => {
    const first = blockIdEntry(null, [text("a", "1"), tool("t", "t")]);
    const second = blockIdEntry(first, [text("a", "2"), text("b"), tool("t", "t")]);
    expect(second.map).toBe(first.map);
  });
  it("changes identity when tool blocks change", () => {
    const first = blockIdEntry(null, [tool("t", "t")]);
    expect(blockIdEntry(first, [tool("t", "t"), tool("u", "u")]).map).not.toBe(first.map);
  });
});

describe("toolBlocksFor", () => {
  it("returns an empty map with no ids and never walks blocks", () => {
    const blocks = new Proxy([] as TranscriptBlock[], { get() { throw new Error("walked"); } });
    expect(toolBlocksFor(blocks, new Set()).size).toBe(0);
  });
  it("returns only requested tool blocks by toolCallId", () => {
    const map = toolBlocksFor([tool("a", "ca"), tool("b", "cb"), text("c")], new Set(["cb"]));
    expect([...map.keys()]).toEqual(["cb"]);
    expect((map.get("cb") as ToolCallBlock).id).toBe("b");
  });
});

describe("isAbove", () => {
  it("becomes above at the collapsed bottom", () => {
    expect(isAbove(100, 100, false)).toBe(true);
    expect(isAbove(101, 100, false)).toBe(false);
  });
  it("stays above inside the hysteresis band and releases beyond it", () => {
    expect(isAbove(104, 100, true)).toBe(true);
    expect(isAbove(105, 100, true)).toBe(false);
  });
  it("honours a custom hysteresis", () => {
    expect(isAbove(110, 100, true, 10)).toBe(true);
    expect(isAbove(111, 100, true, 10)).toBe(false);
  });
});

describe("resolveAnchorElement", () => {
  const rects = (el: HTMLElement, laidOut: boolean) => {
    el.getClientRects = () => (laidOut ? [{}] : []) as unknown as DOMRectList;
    el.getBoundingClientRect = () => ({ top: 0, bottom: laidOut ? 10 : 0, width: laidOut ? 10 : 0, height: laidOut ? 10 : 0 }) as DOMRect;
  };
  it("is null for an unknown id", () => {
    const list = document.createElement("div");
    expect(resolveAnchorElement(list, "nope")).toBeNull();
  });
  it("returns the laid-out element", () => {
    const list = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-block-id", "a");
    rects(el, true);
    list.append(el);
    expect(resolveAnchorElement(list, "a")).toBe(el);
  });
  it("falls back to the nearest laid-out ancestor for a hidden member", () => {
    const list = document.createElement("div");
    const stack = document.createElement("div");
    stack.setAttribute("data-block-id", "stack");
    rects(stack, true);
    const hidden = document.createElement("div");
    hidden.setAttribute("data-block-id", "member");
    rects(hidden, false);
    stack.append(hidden);
    list.append(stack);
    expect(resolveAnchorElement(list, "member")).toBe(stack);
  });
  it("is null when nothing is laid out", () => {
    const list = document.createElement("div");
    const hidden = document.createElement("div");
    hidden.setAttribute("data-block-id", "m");
    rects(hidden, false);
    list.append(hidden);
    expect(resolveAnchorElement(list, "m")).toBeNull();
  });
});

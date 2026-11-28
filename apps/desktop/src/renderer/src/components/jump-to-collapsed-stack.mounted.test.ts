// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { jumpToTranscriptBlock } from "./MessageList.js";
import { ToolCallStack } from "./ToolCallStack.js";
import type { ToolCallBlock } from "../store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const call = (id: string): ToolCallBlock => ({
  kind: "tool_call", id, toolCallId: id, toolName: "Bash", input: { command: "ls" }, status: "success", modelText: null,
  snapshots: { before: null, after: null }, subagent: null, workflow: null,
});

let root: Root | null = null;
let frames: FrameRequestCallback[] = [];
const runFrames = () => act(() => { while (frames.length > 0) frames.shift()!(0); });

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mountStack(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(ToolCallStack, { blocks: [call("head"), call("tail")] })));
  return container;
}

const toggle = (container: HTMLElement) => container.querySelector<HTMLButtonElement>(".tool-call-stack-toggle")!;

// The head member's block id lives on the stack's own root, the others on hidden anchors. A jump to any of them has to open the stack:
// scrolling to a hidden node, or to the header, shows nothing of the card.
it.each(["head", "tail"])("opens a collapsed tool-call stack when jumping to its %s member, and scrolls to the revealed card", id => {
  const container = mountStack();
  expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
  const afterJump = vi.fn();
  act(() => jumpToTranscriptBlock(container as never, id, afterJump));
  expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
  runFrames();
  const card = container.querySelector<HTMLElement>(`.tool-call-stack-body [data-block-id="${id}"]`);
  expect(card).not.toBeNull();
  expect(afterJump).toHaveBeenCalledTimes(1);
});

it("does not close a stack that is already open when jumping to a member", () => {
  const container = mountStack();
  act(() => toggle(container).click());
  expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
  vi.useFakeTimers();
  const afterJump = vi.fn();
  act(() => jumpToTranscriptBlock(container as never, "head", afterJump));
  expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
  // The ordinary path scrolls at once and settles on scrollend or its fallback timer.
  act(() => { vi.advanceTimersByTime(700); });
  expect(afterJump).toHaveBeenCalledTimes(1);
});

// @vitest-environment jsdom
import { act, createElement, useMemo, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { TabContext } from "./tab-context.js";
import type { AnchorState, DeckRow } from "./running-deck.js";
import type { TranscriptBlock } from "./store.js";
import { blockIdByToolCall, useDeckAnchors } from "./use-deck-anchors.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tool = (id: string): TranscriptBlock => ({ kind: "tool_call", id, toolCallId: id, toolName: "Bash", input: {}, status: "success", modelText: null, snapshots: { before: null, after: null }, subagent: null } as TranscriptBlock);
const row = (toolCallId: string): DeckRow => ({ key: `task:${toolCallId}`, kind: "task", toolCallId, title: "x", typeLabel: "Bash", startedAt: 0, waiting: false, detail: undefined });
const task = (toolCallId: string) => ({ type: "claude_background_task", taskId: toolCallId, toolCallId, kind: "bash", description: "d", startedAt: 0, status: "running" });

let roots: Root[] = [];
let frames: FrameRequestCallback[] = [];
const flush = () => { const run = frames; frames = []; act(() => run.forEach(cb => cb(0))); };

beforeEach(() => {
  frames = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
});
afterEach(() => { roots.forEach(r => act(() => r.unmount())); roots = []; document.body.replaceChildren(); vi.unstubAllGlobals(); });

function attachedList(): HTMLElement {
  const list = document.createElement("div");
  document.body.append(list);
  return list;
}

function card(list: HTMLElement, id: string, bottom: number): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-block-id", id);
  el.getClientRects = () => [{}] as unknown as DOMRectList;
  el.getBoundingClientRect = vi.fn(() => ({ top: bottom - 10, bottom, width: 10, height: 10 }) as DOMRect);
  list.append(el);
  return el;
}

function mount(opts: { list: HTMLElement; blocks: TranscriptBlock[]; rows: DeckRow[]; deckBottom?: number }) {
  const store = createStore(() => ({ claudeTaskByToolCall: Object.fromEntries(opts.rows.map(r => [r.toolCallId!, task(r.toolCallId!)])) }));
  const seen: ReadonlyMap<string, AnchorState>[] = [];
  const schedule = { current: (() => undefined) as () => void };
  const listRef = { current: opts.list } as RefObject<HTMLElement | null>;
  function Probe(p: { blocks: TranscriptBlock[]; rows: DeckRow[] }) {
    const idByCall = useMemo(() => blockIdByToolCall(p.blocks), [p.blocks]);
    const result = useDeckAnchors({ listRef, blocks: p.blocks, rows: p.rows, collapsedDeckBottom: () => opts.deckBottom ?? 100, idByCall });
    schedule.current = result.schedule;
    seen.push(result.anchors);
    return null;
  }
  const el = (p: { blocks: TranscriptBlock[]; rows: DeckRow[] }) => createElement(TabContext.Provider, { value: { tabId: "t", store: store as never } }, createElement(Probe, p));
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(el({ blocks: opts.blocks, rows: opts.rows })));
  return { seen, store, schedule, rerender: (p: { blocks: TranscriptBlock[]; rows: DeckRow[] }) => act(() => root.render(el(p))) };
}

it("reports a card scrolled above before the first paint, with no frame needed", () => {
  const list = attachedList();
  card(list, "a", 50);
  const { seen } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  expect(seen.at(-1)!.get("task:a")).toEqual({ hasCard: true, live: true, above: true, distance: -50 });
  flush();
  expect(seen.at(-1)!.get("task:a")).toEqual({ hasCard: true, live: true, above: true, distance: -50 });
});

it("reads a newly added row synchronously, but leaves block-only changes to the frame", () => {
  const list = attachedList();
  const a = card(list, "a", 50);
  card(list, "b", 60);
  const { seen, rerender } = mount({ list, blocks: [tool("a"), tool("b")], rows: [row("a")] });
  flush();
  const reads = (a.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length;
  rerender({ blocks: [tool("a"), tool("b"), tool("c")], rows: [row("a")] });
  expect((a.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
  rerender({ blocks: [tool("a"), tool("b"), tool("c")], rows: [row("a"), row("b")] });
  expect(seen.at(-1)!.get("task:b")).toBeDefined();
});

it("coalesces two scrolls in a frame into one read and one update, none when unchanged", () => {
  const list = attachedList();
  const a = card(list, "a", 50);
  const { seen } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  flush();
  const renders = seen.length;
  const reads = (a.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length;
  list.dispatchEvent(new Event("scroll"));
  list.dispatchEvent(new Event("scroll"));
  expect(frames.length).toBe(1);
  flush();
  expect((a.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads + 1);
  expect(seen.length).toBe(renders);
});

it("updates state when the result changes", () => {
  const list = attachedList();
  const a = card(list, "a", 50);
  const { seen } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  flush();
  a.getBoundingClientRect = () => ({ top: 290, bottom: 300, width: 10, height: 10 }) as DOMRect;
  list.dispatchEvent(new Event("scroll"));
  flush();
  expect(seen.at(-1)!.get("task:a")).toMatchObject({ above: false, distance: 200 });
});

it("re-queries a removed node", () => {
  const list = attachedList();
  const a = card(list, "a", 50);
  const { seen } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  flush();
  a.remove();
  const b = card(list, "a", 300);
  list.dispatchEvent(new Event("scroll"));
  flush();
  expect(b.getBoundingClientRect).toHaveBeenCalled();
  expect(seen.at(-1)!.get("task:a")).toMatchObject({ above: false, distance: 200 });
});

it("reads only anchors of rows", () => {
  const list = attachedList();
  card(list, "a", 50);
  const other = card(list, "other", 50);
  mount({ list, blocks: [tool("a"), tool("other")], rows: [row("a")] });
  flush();
  expect(other.getBoundingClientRect).not.toHaveBeenCalled();
});

it("marks a row with no card", () => {
  const list = attachedList();
  const { seen } = mount({ list, blocks: [], rows: [row("gone")] });
  flush();
  expect(seen.at(-1)!.get("task:gone")).toMatchObject({ hasCard: false, above: false, live: false });
});

it("does not iterate blocks while scrolling after the first derive", () => {
  const list = attachedList();
  card(list, "a", 50);
  let touched = 0;
  const blocks = new Proxy([tool("a")], { get(target, key, receiver) { touched += 1; return Reflect.get(target, key, receiver); } });
  mount({ list, blocks, rows: [row("a")] });
  flush();
  touched = 0;
  list.dispatchEvent(new Event("scroll"));
  list.dispatchEvent(new Event("scroll"));
  flush();
  expect(touched).toBe(0);
});

it("updates live when the linked task flips with rows and blocks unchanged", () => {
  const list = attachedList();
  card(list, "a", 50);
  const { seen, store } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  flush();
  expect(seen.at(-1)!.get("task:a")!.live).toBe(true);
  act(() => store.setState({ claudeTaskByToolCall: { a: { ...task("a"), status: "completed" } } } as never));
  flush();
  expect(seen.at(-1)!.get("task:a")!.live).toBe(false);
});

it("exposes schedule: an external trigger costs one coalesced read", () => {
  const list = attachedList();
  const a = card(list, "a", 50);
  const { schedule } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  flush();
  const reads = (a.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length;
  act(() => { schedule.current(); schedule.current(); });
  expect(frames.length).toBe(1);
  flush();
  expect((a.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads + 1);
});

it("a rows-only change does not iterate blocks", () => {
  const list = attachedList();
  card(list, "a", 50);
  let touched = 0;
  const blocks = new Proxy([tool("a")], { get(target, key, receiver) { touched += 1; return Reflect.get(target, key, receiver); } });
  const { rerender } = mount({ list, blocks, rows: [row("a")] });
  flush();
  touched = 0;
  rerender({ blocks, rows: [{ ...row("a"), title: "progress 2" }] });
  flush();
  expect(touched).toBe(0);
});

it("does not publish a new map when only distances change", () => {
  const list = attachedList();
  const a = card(list, "a", 50);
  const { seen } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  flush();
  const renders = seen.length;
  a.getBoundingClientRect = () => ({ top: 20, bottom: 60, width: 10, height: 10 }) as DOMRect;
  list.dispatchEvent(new Event("scroll"));
  flush();
  expect(seen.length).toBe(renders);
});

it("publishes when the order of above rows changes", () => {
  const list = attachedList();
  const a = card(list, "a", 50);
  const b = card(list, "b", 20);
  const { seen } = mount({ list, blocks: [tool("a"), tool("b")], rows: [row("a"), row("b")] });
  flush();
  const renders = seen.length;
  a.getBoundingClientRect = () => ({ top: 0, bottom: 10, width: 10, height: 10 }) as DOMRect;
  b.getBoundingClientRect = () => ({ top: 0, bottom: 90, width: 10, height: 10 }) as DOMRect;
  list.dispatchEvent(new Event("scroll"));
  flush();
  expect(seen.length).toBe(renders + 1);
});

it("does not re-query a block whose element is not laid out until blocks change", () => {
  const list = attachedList();
  const spy = vi.spyOn(list, "querySelectorAll");
  const { rerender } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  flush();
  const queries = spy.mock.calls.length;
  list.dispatchEvent(new Event("scroll"));
  flush();
  list.dispatchEvent(new Event("scroll"));
  flush();
  expect(spy.mock.calls.length).toBe(queries);
  rerender({ blocks: [tool("a"), tool("z")], rows: [row("a")] });
  flush();
  expect(spy.mock.calls.length).toBeGreaterThan(queries);
});

it("keeps a row listed while its card is hidden inside a collapsed stack, and drops it once the stack opens", () => {
  const list = attachedList();
  const stack = card(list, "stack", 50);
  const member = document.createElement("div");
  member.setAttribute("data-block-id", "a");
  member.getClientRects = () => [] as unknown as DOMRectList;
  member.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect);
  stack.append(member);
  const { seen, schedule } = mount({ list, blocks: [tool("a")], rows: [row("a")], deckBottom: 10 });
  // The stack's header stands in for the card: nothing says the task is running, so the card is not live and the row is listed.
  expect(seen.at(-1)!.get("task:a")).toMatchObject({ hasCard: true, live: false });
  // The user opens the stack: the card is laid out, and its row is no longer needed while the card is in view.
  member.getClientRects = () => [{}] as unknown as DOMRectList;
  member.getBoundingClientRect = vi.fn(() => ({ top: 80, bottom: 90, width: 10, height: 10 }) as DOMRect);
  schedule.current();
  flush();
  expect(seen.at(-1)!.get("task:a")).toMatchObject({ hasCard: true, live: true, above: false });
});

it("re-reads when the transcript's DOM changes without a scroll or a block change, such as opening a stack", async () => {
  const list = attachedList();
  const stack = card(list, "stack", 50);
  const member = document.createElement("div");
  member.setAttribute("data-block-id", "a");
  member.getClientRects = () => [] as unknown as DOMRectList;
  member.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect);
  stack.append(member);
  const { seen } = mount({ list, blocks: [tool("a")], rows: [row("a")], deckBottom: 10 });
  expect(seen.at(-1)!.get("task:a")).toMatchObject({ live: false });
  // Opening the stack lays the member out and changes the DOM; nothing scrolls and `blocks` stays the same.
  member.getClientRects = () => [{}] as unknown as DOMRectList;
  member.getBoundingClientRect = vi.fn(() => ({ top: 80, bottom: 90, width: 10, height: 10 }) as DOMRect);
  list.append(document.createElement("span"));
  await act(async () => { await Promise.resolve(); });
  flush();
  expect(seen.at(-1)!.get("task:a")).toMatchObject({ live: true, above: false });
});

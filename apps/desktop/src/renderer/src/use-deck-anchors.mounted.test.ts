// @vitest-environment jsdom
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { TabContext } from "./tab-context.js";
import type { AnchorState, DeckRow } from "./running-deck.js";
import type { TranscriptBlock } from "./store.js";
import { useDeckAnchors } from "./use-deck-anchors.js";

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
afterEach(() => { document.body.replaceChildren(); roots.forEach(r => act(() => r.unmount())); roots = []; vi.unstubAllGlobals(); });

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
  const listRef = { current: opts.list } as RefObject<HTMLElement | null>;
  function Probe(p: { blocks: TranscriptBlock[]; rows: DeckRow[] }) {
    seen.push(useDeckAnchors({ listRef, blocks: p.blocks, rows: p.rows, collapsedDeckBottom: () => opts.deckBottom ?? 100 }));
    return null;
  }
  const el = (p: { blocks: TranscriptBlock[]; rows: DeckRow[] }) => createElement(TabContext.Provider, { value: { tabId: "t", store: store as never } }, createElement(Probe, p));
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(el({ blocks: opts.blocks, rows: opts.rows })));
  return { seen, rerender: (p: { blocks: TranscriptBlock[]; rows: DeckRow[] }) => act(() => root.render(el(p))) };
}

it("reports a card scrolled above after one frame", () => {
  const list = attachedList();
  card(list, "a", 50);
  const { seen } = mount({ list, blocks: [tool("a")], rows: [row("a")] });
  expect(seen.at(-1)!.size).toBe(0);
  flush();
  expect(seen.at(-1)!.get("task:a")).toEqual({ hasCard: true, live: true, above: true, distance: -50 });
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

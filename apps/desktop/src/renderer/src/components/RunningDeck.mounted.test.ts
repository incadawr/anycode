// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useState, type ReactElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabContext } from "../tab-context.js";
import type { AnchorState, DeckRow } from "../running-deck.js";
import { createDesktopStore, type TranscriptBlock } from "../store.js";
import { RunningDeck } from "./RunningDeck.js";
import { RunningDeckHost, deckPlacement, resetFoldedDecks } from "./RunningDeckHost.js";
import { MessageList } from "./MessageList.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// MessageList renders TodoPanel on every render of its own: counting TodoPanel
// renders counts MessageList renders without touching MessageList.
const todoRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./TodoPanel.js", () => ({
  TodoPanel: () => {
    todoRenders.count += 1;
    return null;
  },
}));

const SPACING = { gap: 8, chipZone: 56, floorRows: 3, rowHeight: 44, defaultTop: 12 } as const;
const card = (left: number, right: number, bottom: number) => ({ left, right, bottom });

describe("deckPlacement", () => {
  it("drops below the todo card when the card overlaps the deck horizontally", () => {
    const p = deckPlacement({ left: 100, width: 600 }, card(500, 760, 200), SPACING, 900);
    expect(p).toEqual({ top: 208, chipOnly: false, maxHeight: 900 - 208 - 56 });
  });

  it("stays at the default top with no card, or a card beside the deck", () => {
    expect(deckPlacement({ left: 100, width: 600 }, null, SPACING, 900)).toEqual({ top: "default", chipOnly: false, maxHeight: 900 - 12 - 56 });
    expect(deckPlacement({ left: 100, width: 600 }, card(720, 980, 400), SPACING, 900).top).toBe("default");
    expect(deckPlacement({ left: 100, width: 600 }, card(700, 960, 400), SPACING, 900).top).toBe("default");
  });

  it("falls back to the chip alone at the default top in a short window with a tall card", () => {
    const p = deckPlacement({ left: 0, width: 600 }, card(300, 560, 400), SPACING, 520);
    expect(p.chipOnly).toBe(true);
    expect(p.top).toBe("default");
  });

  it("computes maxHeight from the list height, the top and the chip zone", () => {
    expect(deckPlacement({ left: 0, width: 600 }, card(300, 560, 100), SPACING, 700).maxHeight).toBe(700 - 108 - 56);
    // exactly the floor (3 rows) is enough room
    expect(deckPlacement({ left: 0, width: 600 }, card(300, 560, 100), SPACING, 108 + 56 + 132).chipOnly).toBe(false);
    expect(deckPlacement({ left: 0, width: 600 }, card(300, 560, 100), SPACING, 108 + 56 + 131).chipOnly).toBe(true);
  });

  it("is a pure function of its inputs (no oscillation)", () => {
    const args = [{ left: 0, width: 600 }, card(300, 560, 150), SPACING, 800] as const;
    const first = deckPlacement(...args);
    expect(deckPlacement(...args)).toEqual(first);
    expect(deckPlacement(...args)).toEqual(first);
  });
});

let roots: Root[] = [];

beforeEach(() => {
  todoRenders.count = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  resetFoldedDecks();
  roots.forEach(r => act(() => r.unmount()));
  roots = [];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountInto(el: ReactElement, host: HTMLElement = document.body) {
  const container = document.createElement("div");
  container.tabIndex = -1;
  host.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(el));
  return { container, root, rerender: (next: ReactElement) => act(() => root.render(next)) };
}

const row = (id: string, over: Partial<DeckRow> = {}): DeckRow => ({
  key: `task:${id}`, kind: "task", toolCallId: id, title: `run ${id}`, typeLabel: "Bash", startedAt: 1_000, waiting: false, detail: undefined, ...over,
});

interface DeckArgs {
  rows: readonly DeckRow[];
  blockIds?: ReadonlyMap<string, string>;
  onJump?: (id: string) => void;
  anchors?: ReadonlyMap<string, AnchorState>;
}

/** RunningDeck with its collapse flag held in a tiny stateful parent, like the host does. */
function Deck(props: DeckArgs) {
  const [collapsed, setCollapsed] = useState(false);
  return createElement(RunningDeck, {
    rows: props.rows,
    anchors: props.anchors ?? new Map(),
    blockIdByToolCall: props.blockIds ?? new Map(),
    elapsedNow: 61_000,
    onJumpToBlock: props.onJump ?? (() => undefined),
    collapsed,
    onCollapsedChange: setCollapsed,
  });
}

const deck = (args: DeckArgs) => createElement(Deck, args);
const region = () => document.querySelector<HTMLElement>('[role="region"]');
const rowButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".ak-peekstack__row")];
const labels = () => rowButtons().map(b => b.getAttribute("aria-label"));
const byText = (text: string) => [...document.querySelectorAll<HTMLElement>("button, span")].find(el => el.textContent?.trim() === text);
const keyDown = (target: Element, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const focus = (el: HTMLElement) => act(() => el.focus());
const outside = () => {
  const b = document.createElement("button");
  document.body.append(b);
  return b;
};

describe("RunningDeck", () => {
  it("renders nothing with zero rows", () => {
    const { container } = mountInto(deck({ rows: [] }));
    expect(container.innerHTML).toBe("");
  });

  it("is a labelled region that can take programmatic focus, without aria-live", () => {
    mountInto(deck({ rows: [row("a")] }));
    expect(region()?.getAttribute("aria-label")).toBe("Running");
    expect(region()?.tabIndex).toBe(-1);
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("names each row by kind, description and state, without meta or elapsed", () => {
    mountInto(deck({ rows: [row("a", { detail: "3 tools" })] }));
    const [button] = rowButtons();
    expect(button!.tagName).toBe("BUTTON");
    expect(button!.getAttribute("aria-label")).toBe("Bash: run a, running");
    expect(button!.textContent).toContain("1m 0s");
  });

  it("shows three rows and a +N running chip when collapsed", () => {
    mountInto(deck({ rows: ["a", "b", "c", "d", "e"].map(id => row(id)) }));
    expect(rowButtons()).toHaveLength(3);
    expect(byText("+2 running")).toBeDefined();
  });

  it("folds into one N running chip and reopens on click", () => {
    mountInto(deck({ rows: ["a", "b", "c", "d"].map(id => row(id)) }));
    const collapse = document.querySelector<HTMLButtonElement>(".ak-peekstack__fold")!;
    focus(collapse);
    act(() => collapse.click());
    expect(rowButtons()).toHaveLength(0);
    const chip = document.querySelector<HTMLButtonElement>(".ak-peekstack__chip")!;
    expect(chip.textContent).toContain("4 running");
    expect(document.activeElement).toBe(chip);
    act(() => chip.click());
    expect(rowButtons().length).toBeGreaterThan(0);
  });

  it("opens on focus within and mounts every row", () => {
    mountInto(deck({ rows: ["a", "b", "c", "d", "e"].map(id => row(id)) }));
    focus(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    expect(rowButtons()).toHaveLength(5);
    expect(byText("+2 running")).toBeUndefined();
  });

  it("closes on Escape, consumes it, and stays closed until focus leaves", () => {
    mountInto(deck({ rows: ["a", "b", "c", "d"].map(id => row(id)) }));
    focus(rowButtons()[0]!);
    const first = keyDown(document.activeElement!, "Escape");
    expect(first.defaultPrevented).toBe(true);
    expect(region()!.hasAttribute("data-open")).toBe(false);
    focus(rowButtons()[1]!);
    expect(region()!.hasAttribute("data-open")).toBe(false);
    const second = keyDown(document.activeElement!, "Escape");
    expect(second.defaultPrevented).toBe(false);
    focus(outside());
    focus(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
  });

  it("does not consume Escape while closed", () => {
    mountInto(deck({ rows: [row("a")] }));
    expect(keyDown(region()!, "Escape").defaultPrevented).toBe(false);
  });

  it("jumps to the resolved block on click; a card-less row does nothing", () => {
    const onJump = vi.fn();
    mountInto(deck({ rows: [row("a", { startedAt: 2_000 }), row("b")], blockIds: new Map([["a", "block-a"]]), onJump }));
    const [withCard, cardless] = rowButtons();
    expect(withCard!.textContent).toContain("↑ jump");
    expect(cardless!.textContent).not.toContain("↑ jump");
    act(() => withCard!.click());
    expect(onJump).toHaveBeenCalledWith("block-a");
    act(() => cardless!.click());
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("freezes the rendered rows while the pointer is on the stack and applies changes when it leaves", () => {
    const rows = [row("a", { startedAt: 3 }), row("b", { startedAt: 2 }), row("c", { startedAt: 1 })];
    const { rerender } = mountInto(deck({ rows }));
    const first = rowButtons()[0]!;
    over(first);
    rerender(deck({ rows: rows.slice(0, 2) }));
    expect(labels()).toContain("Bash: run c, running");
    act(() => { first.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
    expect(labels()).not.toContain("Bash: run c, running");
  });

  it("drops a row whose work ended at once when only keyboard focus has the deck open", () => {
    const rows = [row("a", { startedAt: 3 }), row("b", { startedAt: 2 }), row("c", { startedAt: 1 })];
    const { rerender } = mountInto(deck({ rows }));
    focus(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    rerender(deck({ rows: rows.slice(0, 2) }));
    expect(labels()).not.toContain("Bash: run c, running");
    expect(labels()).toEqual(["Bash: run a, running", "Bash: run b, running"]);
  });

  it("does not bring a finished row back when the pointer arrives while keyboard focus holds the deck open", () => {
    const rows = [row("a", { startedAt: 3 }), row("b", { startedAt: 2 }), row("c", { startedAt: 1 })];
    const { rerender } = mountInto(deck({ rows }));
    focus(rowButtons()[0]!);
    rerender(deck({ rows: rows.slice(0, 2) }));
    over(rowButtons()[0]!);
    expect(labels()).not.toContain("Bash: run c, running");
  });

  it("shows a row added while keyboard focus holds the deck open", () => {
    const rows = [row("a", { startedAt: 3 }), row("b", { startedAt: 2 })];
    const { rerender } = mountInto(deck({ rows }));
    focus(rowButtons()[0]!);
    rerender(deck({ rows: [...rows, row("c", { startedAt: 1 })] }));
    expect(labels()).toContain("Bash: run c, running");
  });

  it("moves focus from an unmounting row to the next row, never to body", () => {
    const rows = [row("a", { startedAt: 3 }), row("b", { startedAt: 2 }), row("c", { startedAt: 1 })];
    const { rerender } = mountInto(deck({ rows }));
    focus(rowButtons()[1]!);
    keyDown(document.activeElement!, "Escape");
    rerender(deck({ rows: [rows[0]!, rows[2]!] }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Bash: run c, running");
  });

  it("moves focus to the collapse control when the last row unmounts", () => {
    const rows = [row("a", { startedAt: 3 }), row("b", { startedAt: 2 })];
    const { rerender } = mountInto(deck({ rows }));
    focus(rowButtons()[1]!);
    keyDown(document.activeElement!, "Escape");
    rerender(deck({ rows: [rows[0]!] }));
    expect(document.activeElement?.classList.contains("ak-peekstack__fold")).toBe(true);
  });

  it("hands focus to the focusable ancestor when the whole deck unmounts", () => {
    const { container, rerender } = mountInto(deck({ rows: [row("a")] }));
    focus(rowButtons()[0]!);
    keyDown(document.activeElement!, "Escape");
    rerender(deck({ rows: [] }));
    expect(document.activeElement).toBe(container);
  });

  it("clears a pending expanded-row collapse on unmount", () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root } = mountInto(deck({ rows: [row("a", { detail: "x" }), row("b")] }));
    const [a] = rowButtons();
    act(() => { a!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body })); });
    act(() => { a!.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: region() })); });
    act(() => root.unmount());
    roots = roots.filter(r => r !== root);
    expect(() => act(() => { vi.advanceTimersByTime(200); })).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
  });
});

// ── final-wave interaction guards ──

const over = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body })); });
const five = () => ["a", "b", "c", "d", "e"].map(id => row(id));

describe("RunningDeck pointer, focus and a11y guards", () => {
  it("opens from the row stack only: the foot never opens or moves the deck", () => {
    mountInto(deck({ rows: five() }));
    const hide = document.querySelector<HTMLButtonElement>(".ak-peekstack__fold")!;
    over(hide);
    expect(region()!.hasAttribute("data-open")).toBe(false);
    over(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    over(hide);
    expect(region()!.hasAttribute("data-open")).toBe(true);
  });

  it("does not open the deck when Hide takes focus (a press would otherwise move it)", () => {
    mountInto(deck({ rows: five() }));
    focus(document.querySelector<HTMLButtonElement>(".ak-peekstack__fold")!);
    expect(region()!.hasAttribute("data-open")).toBe(false);
    expect(rowButtons()).toHaveLength(3);
  });

  it("does not focus the region when its background is pressed, but leaves controls alone", () => {
    mountInto(deck({ rows: five() }));
    const down = (el: Element) => { const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true }); act(() => { el.dispatchEvent(e); }); return e.defaultPrevented; };
    expect(down(region()!)).toBe(true);
    expect(down(document.querySelector(".ak-peekstack__foot")!)).toBe(true);
    expect(down(rowButtons()[0]!)).toBe(false);
    expect(down(document.querySelector(".ak-peekstack__fold")!)).toBe(false);
  });

  it("leaves focus on a live element when the chip is clicked, even if the browser blurs the removed chip", () => {
    mountInto(deck({ rows: five() }));
    act(() => document.querySelector<HTMLButtonElement>(".ak-peekstack__fold")!.click());
    const chip = document.querySelector<HTMLButtonElement>(".ak-peekstack__chip")!;
    focus(chip);
    const remove = Node.prototype.removeChild;
    vi.spyOn(Node.prototype, "removeChild").mockImplementation(function (this: Node, child: Node) {
      if (child === chip || (child instanceof Element && child.contains(chip))) {
        act(() => { chip.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })); });
      }
      return remove.call(this, child) as never;
    } as never);
    act(() => chip.click());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(document.querySelector(".ak-peekstack__fold"));
    expect(region()!.hasAttribute("data-open")).toBe(false);
  });

  it("keeps peek rows out of the tab order while closed, including after Escape", () => {
    mountInto(deck({ rows: five() }));
    expect(rowButtons().map(b => b.tabIndex)).toEqual([0, -1, -1]);
    focus(rowButtons()[0]!);
    expect(rowButtons().every(b => b.tabIndex === 0)).toBe(true);
    keyDown(document.activeElement!, "Escape");
    expect(rowButtons().map(b => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it("names jumpable rows by their affordance and disables rows without a card", () => {
    const ids = new Map([["a", "block-a"]]);
    mountInto(deck({ rows: [row("a", { detail: "turn 2 · 3 tools" }), row("b")], blockIds: ids }));
    const [a, b] = rowButtons();
    expect(a!.getAttribute("aria-label")).toBe("Bash: run a, running, jump to its card");
    expect(a!.hasAttribute("aria-disabled")).toBe(false);
    expect(document.getElementById(a!.getAttribute("aria-describedby")!)!.textContent).toBe("turn 2 · 3 tools");
    expect(b!.getAttribute("aria-label")).toBe("Bash: run b, running");
    expect(b!.getAttribute("aria-disabled")).toBe("true");
  });

  it("contains overscroll only while the open stack overflows", () => {
    const sh = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(500);
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(100);
    mountInto(deck({ rows: five() }));
    const stack = () => document.querySelector<HTMLElement>(".ak-peekstack__stack")!;
    expect(stack().hasAttribute("data-scrollable")).toBe(false);
    focus(rowButtons()[0]!);
    expect(stack().hasAttribute("data-scrollable")).toBe(true);
    sh.mockReturnValue(100);
    keyDown(document.activeElement!, "Escape");
    focus(rowButtons()[0]!);
    ch.mockReturnValue(100);
    act(() => { rowButtons()[0]!.blur(); });
    focus(rowButtons()[0]!);
    expect(stack().hasAttribute("data-scrollable")).toBe(false);
  });

  it("makes the chip-only chip a real button that jumps to the first card", () => {
    const jumps: string[] = [];
    mountInto(deck({ rows: [row("a")], blockIds: new Map([["a", "block-a"]]), onJump: id => jumps.push(id) }));
    const chip = document.querySelector<HTMLButtonElement>(".ak-peekstack__chip-only")!;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("aria-label")).toBe("1 running: run a, jump to its card");
    act(() => chip.click());
    expect(jumps).toEqual(["block-a"]);
  });

  it("orders nearest-above first in the rendered rows", () => {
    const rows = [row("far"), row("near")];
    const anchors = new Map([["task:far", { hasCard: true, live: true, above: true, distance: -900 }], ["task:near", { hasCard: true, live: true, above: true, distance: -30 }]]);
    mountInto(deck({ rows, anchors }));
    expect(labels()).toEqual(["Bash: run near, running", "Bash: run far, running"]);
  });
});

// ── host ──

const task = (id: string, startedAt = 1_000) => ({ type: "claude_background_task" as const, taskId: id, toolCallId: id, kind: "bash" as const, description: `job ${id}`, startedAt, status: "running" as const });

function storeWith(ids: readonly string[]) {
  const store = createDesktopStore();
  store.setState({ engine: { id: "claude" }, claudeBackgroundTasks: ids.map((id, i) => task(id, 1_000 + i)) } as never);
  return store;
}

function hostIn(tabId: string, store: ReturnType<typeof createDesktopStore>, listRef: RefObject<HTMLElement | null>) {
  return createElement(TabContext.Provider, { value: { tabId, store } },
    createElement(RunningDeckHost, { listRef, blocks: [] as TranscriptBlock[], onJumpToBlock: () => undefined }));
}

describe("RunningDeckHost", () => {
  it("keeps the collapse flag per tab", () => {
    const list = document.createElement("div");
    document.body.append(list);
    const listRef = { current: list };
    const a = storeWith(["a1"]);
    const b = storeWith(["b1"]);
    const { rerender } = mountInto(hostIn("A", a, listRef), list);
    act(() => document.querySelector<HTMLButtonElement>(".ak-peekstack__fold")!.click());
    expect(document.querySelector(".ak-peekstack__chip")).not.toBeNull();
    rerender(hostIn("B", b, listRef));
    expect(document.querySelector(".ak-peekstack__chip")).toBeNull();
    expect(rowButtons()).toHaveLength(1);
    rerender(hostIn("A", a, listRef));
    expect(document.querySelector(".ak-peekstack__chip")).not.toBeNull();
  });

  it("keeps the folded flag when the tab's list is remounted (key={tabId})", () => {
    const list = document.createElement("div");
    document.body.append(list);
    const store = storeWith(["a1", "a2"]);
    const first = mountInto(hostIn("A", store, { current: list }), list);
    act(() => document.querySelector<HTMLButtonElement>(".ak-peekstack__fold")!.click());
    expect(document.querySelector(".ak-peekstack__chip")).not.toBeNull();
    act(() => first.root.unmount());
    roots = roots.filter(r => r !== first.root);
    document.body.replaceChildren(list);
    mountInto(hostIn("A", store, { current: list }), list);
    expect(document.querySelector(".ak-peekstack__chip")).not.toBeNull();
    expect(rowButtons()).toHaveLength(0);
  });

  it("stops the elapsed tick in chip-only mode (no room for rows)", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearInterval");
    const list = document.createElement("div");
    Object.defineProperty(list, "clientHeight", { value: 0 });
    document.body.append(list);
    mountInto(hostIn("A", storeWith(["a1"]), { current: list }), list);
    expect(clear).toHaveBeenCalled();
  });

  it("stops the elapsed tick while folded", () => {
    vi.useFakeTimers();
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const list = document.createElement("div");
    Object.defineProperty(list, "clientHeight", { value: 800 });
    document.body.append(list);
    mountInto(hostIn("A", storeWith(["a1"]), { current: list }), list);
    expect(set).toHaveBeenCalledTimes(1);
    act(() => document.querySelector<HTMLButtonElement>(".ak-peekstack__fold")!.click());
    expect(clear).toHaveBeenCalledTimes(1);
    act(() => document.querySelector<HTMLButtonElement>(".ak-peekstack__chip")!.click());
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("uses the transcript fallback for a task without a description", () => {
    const list = document.createElement("div");
    document.body.append(list);
    const store = createDesktopStore();
    store.setState({ engine: { id: "claude" }, claudeBackgroundTasks: [{ ...task("x"), description: "" }] } as never);
    const blocks = [{ kind: "tool_call", id: "x", toolCallId: "x", toolName: "Bash", input: { command: "npm test" }, status: "success", modelText: null, snapshots: { before: null, after: null }, subagent: null }] as unknown as TranscriptBlock[];
    mountInto(createElement(TabContext.Provider, { value: { tabId: "t", store } },
      createElement(RunningDeckHost, { listRef: { current: list }, blocks, onJumpToBlock: () => undefined })), list);
    expect(labels()).toEqual(["Bash: npm test, running, jump to its card"]);
  });

  it("ticks elapsed time only while rows exist", () => {
    vi.useFakeTimers();
    const intervals = vi.spyOn(globalThis, "setInterval");
    const list = document.createElement("div");
    document.body.append(list);
    const empty = storeWith([]);
    mountInto(hostIn("A", empty, { current: list }), list);
    expect(intervals).not.toHaveBeenCalled();
    act(() => empty.setState({ claudeBackgroundTasks: [task("x")] } as never));
    expect(intervals).toHaveBeenCalledTimes(1);
  });
});

const child = (id: string) => ({ childSessionId: id, agentType: "general", description: `child ${id}`, startedAt: 1 });

describe("RunningDeckHost store wiring", () => {
  it("shows one row per running task and detached child, and drops a completed task", () => {
    const list = document.createElement("div");
    document.body.append(list);
    const store = storeWith(["bash1"]);
    store.setState({ backgroundChildren: [child("c1")] } as never);
    mountInto(hostIn("A", store, { current: list }), list);
    expect(rowButtons()).toHaveLength(2);
    expect(labels().some(l => l?.includes("job bash1"))).toBe(true);
    expect(labels().some(l => l?.includes("child c1"))).toBe(true);
    act(() => store.setState({ claudeBackgroundTasks: [{ ...task("bash1"), status: "completed" }] } as never));
    expect(rowButtons()).toHaveLength(1);
    expect(labels().some(l => l?.includes("job bash1"))).toBe(false);
  });

  it("shows a core task as a row without a jump, and only while no other engine is live", () => {
    const list = document.createElement("div");
    document.body.append(list);
    const store = createDesktopStore();
    const coreTask = { taskId: "k1", command: "npm run dev", description: "Dev server", status: "running", startedAt: 1, exitCode: null, outputBytes: 0, outputTruncated: false };
    store.setState({ backgroundTasks: [coreTask] } as never);
    mountInto(hostIn("A", store, { current: list }), list);
    expect(labels()).toEqual(["Bash: Dev server, running"]);
    act(() => store.setState({ engine: { id: "claude" } } as never));
    expect(rowButtons()).toHaveLength(0);
    act(() => store.setState({ engine: null } as never));
    expect(rowButtons()).toHaveLength(1);
    act(() => store.setState({ backgroundTasks: [{ ...coreTask, status: "completed" }] } as never));
    expect(rowButtons()).toHaveLength(0);
  });

  it("drops the Claude rows when a live tab switches from Claude to core, where the engine block goes away", () => {
    const list = document.createElement("div");
    document.body.append(list);
    const store = storeWith(["bash1"]);
    mountInto(hostIn("A", store, { current: list }), list);
    expect(rowButtons()).toHaveLength(1);
    act(() => store.setState({ engine: null } as never));
    expect(rowButtons()).toHaveLength(0);
  });

  it("does not leak rows between tab stores", () => {
    const listA = document.createElement("div");
    const listB = document.createElement("div");
    document.body.append(listA, listB);
    const a = storeWith(["a1"]);
    const b = storeWith(["b1", "b2"]);
    mountInto(hostIn("A", a, { current: listA }), listA);
    mountInto(hostIn("B", b, { current: listB }), listB);
    expect(listA.querySelectorAll(".ak-peekstack__row")).toHaveLength(1);
    expect(listB.querySelectorAll(".ak-peekstack__row")).toHaveLength(2);
    act(() => a.setState({ claudeBackgroundTasks: [] } as never));
    expect(listA.querySelectorAll(".ak-peekstack__row")).toHaveLength(0);
    expect(listB.querySelectorAll(".ak-peekstack__row")).toHaveLength(2);
  });
});

const CARD_BOTTOM = 50;
const SPACING_GAP_PX = 8; // --sp-2 fallback (0.5rem at the 16px root) when the token is not defined in jsdom

describe("RunningDeckHost machinery", () => {
  let observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
  let frames: FrameRequestCallback[] = [];
  const raf = vi.fn((cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  beforeEach(() => {
    observers = [];
    frames = [];
    raf.mockClear();
    vi.stubGlobal("ResizeObserver", class {
      readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) { this.entry = { callback, targets: [] }; observers.push(this.entry); }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  const flush = () => { const run = frames; frames = []; act(() => run.forEach(cb => cb(0))); };

  function listWithCard() {
    const list = document.createElement("div");
    Object.defineProperty(list, "clientHeight", { value: 800 });
    const panel = document.createElement("div");
    panel.className = "todo-panel";
    const todo = document.createElement("div");
    todo.className = "todo-panel-card";
    panel.append(todo);
    list.append(panel);
    document.body.append(list);
    return { list, todo };
  }

  it("builds no observers and asks for no frames while there are no rows", () => {
    const { list } = listWithCard();
    mountInto(hostIn("A", storeWith([]), { current: list }), list);
    expect(observers).toHaveLength(0);
    expect(raf).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it("re-reads the anchors once when the todo card resizes", () => {
    const { list, todo } = listWithCard();
    const anchor = document.createElement("div");
    anchor.setAttribute("data-block-id", "x");
    anchor.getClientRects = () => [{}] as unknown as DOMRectList;
    anchor.getBoundingClientRect = vi.fn(() => ({ top: 90, bottom: 100, left: 0, right: 10, width: 10, height: 10 }) as DOMRect);
    list.append(anchor);
    const blocks = [{ kind: "tool_call", id: "x", toolCallId: "x", toolName: "Bash", input: { command: "ls" }, status: "success", modelText: null, snapshots: { before: null, after: null }, subagent: null }] as unknown as TranscriptBlock[];
    const store = storeWith(["x"]);
    mountInto(createElement(TabContext.Provider, { value: { tabId: "A", store } },
      createElement(RunningDeckHost, { listRef: { current: list }, blocks, onJumpToBlock: () => undefined })), list);
    flush();
    const reads = () => (anchor.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = reads();
    expect(before).toBeGreaterThan(0);
    const cardObserver = observers.find(o => o.targets.includes(todo));
    expect(cardObserver).toBeDefined();
    act(() => { cardObserver!.callback([], {} as ResizeObserver); });
    flush();
    expect(reads()).toBe(before + 1);
  });

  it("attaches observers and places when mounted in the same commit as the list (real MessageList)", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top: 0, left: 0, right: 100, bottom: CARD_BOTTOM, width: 100, height: CARD_BOTTOM }) as DOMRect);
    mountInto(messageList(storeWith(["x"])));
    const list = document.querySelector<HTMLElement>(".message-list")!;
    expect(observers.some(o => o.targets.includes(list))).toBe(true);
    const wrap = document.querySelector<HTMLElement>(".running-deck-wrap")!;
    expect(wrap.style.getPropertyValue("--deck-max")).not.toBe("");
  });

  it("places the deck in a layout effect, before the first paint", () => {
    const { list } = listWithCard();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top: 0, left: 0, right: 100, bottom: CARD_BOTTOM, width: 100, height: CARD_BOTTOM }) as DOMRect);
    let placedAtLayout: string | null = null;
    function After() {
      useLayoutEffect(() => { placedAtLayout = document.querySelector<HTMLElement>(".running-deck-wrap")?.style.getPropertyValue("--deck-top") ?? null; }, []);
      return null;
    }
    mountInto(createElement("div", null,
      hostIn("A", storeWith(["x"]), { current: list }),
      createElement(After)), list);
    expect(placedAtLayout).toBe(`${CARD_BOTTOM + SPACING_GAP_PX}px`);
  });
});

// ── MessageList wiring ──

function messageList(store: ReturnType<typeof createDesktopStore>, readOnly = false) {
  return createElement(TabContext.Provider, { value: { tabId: "t", store } },
    createElement(MessageList, {
      blocks: [] as TranscriptBlock[], turn: { status: "idle" } as never, workspace: null, connection: "ready", retry: null,
      onTryAgain: () => undefined, continueOffer: null, onContinue: () => undefined, promptQueueLength: 0, readOnly,
    }));
}

/** Animation frames run by hand: the first anchor read of a deck whose list mounts in the same commit waits for one. */
function manualFrames(): () => void {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { queue.push(callback); return queue.length; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  return () => act(() => { queue.splice(0).forEach(callback => callback(0)); });
}

describe("MessageList and the deck", () => {
  it("renders the deck inside the list, and holds its rows until the first anchor read so none flashes on a remount", () => {
    const flush = manualFrames();
    mountInto(messageList(storeWith(["a"])));
    expect(document.querySelector(".message-list > .running-deck-wrap")).not.toBeNull();
    // The list mounts in the same commit as the deck, so its position is not known yet: nothing is painted.
    expect(rowButtons()).toHaveLength(0);
    flush();
    expect(rowButtons()).toHaveLength(1);
  });

  it("renders no deck when read-only", () => {
    mountInto(messageList(storeWith(["a"]), true));
    expect(document.querySelector(".running-deck-wrap")).toBeNull();
    expect(region()).toBeNull();
  });

  it("does not re-render when the deck's stores change", () => {
    const flush = manualFrames();
    const store = storeWith(["a"]);
    mountInto(messageList(store));
    flush();
    const renders = todoRenders.count;
    act(() => store.setState({ claudeBackgroundTasks: [task("a"), task("b")] } as never));
    act(() => store.setState({ backgroundChildren: [{ childSessionId: "c", agentType: "general", description: "d", startedAt: 1 }] } as never));
    expect(rowButtons().length).toBeGreaterThan(1);
    expect(todoRenders.count).toBe(renders);
  });
});

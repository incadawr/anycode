/**
 * Taskana 4742 — stateful wiring tests for the transcript tick rail
 * (TranscriptMinimap): hover -> popover -> rewind confirm -> onRewind, the
 * popover close-delay timer, and the jump click. The repo's
 * SettingsScreen.test.ts/BackgroundTasksPanel.test.ts pattern (node
 * environment, no DOM): `vi.mock("react")` with slot-backed
 * useState/useRef/useEffect/useCallback (+useId, which the rail uses and
 * those files' components never did), effects drained by `mountUnit` passes.
 * Invoking TranscriptMinimap as a plain function returns its element tree
 * with the REAL event props attached; the props are invoked directly, and a
 * re-mount pass reflects the state a setter wrote.
 *
 * A separate file from TranscriptMinimap.test.ts on purpose: the
 * vi.mock("react") must be module-level (vitest hoists it), which would
 * break that file's real-hook `renderToStaticMarkup` SSR renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserTurnMark } from "./TranscriptMinimap.js";
import { jumpToTranscriptBlock, type JumpTarget } from "./MessageList.js";

interface HarnessState {
  state: Record<string, unknown[]>;
  refs: Record<string, Array<{ current: unknown }>>;
  effects: Record<string, Array<{ fn: () => unknown; deps?: readonly unknown[]; cleanup?: () => void }>>;
  callbacks: Record<string, Array<{ fn: unknown; deps?: readonly unknown[] }>>;
  pending: Array<() => unknown>;
  cursor: number;
  refCursor: number;
  effectCursor: number;
  callbackCursor: number;
  key: string;
}

const harness = vi.hoisted((): HarnessState => ({
  state: {},
  refs: {},
  effects: {},
  callbacks: {},
  pending: [],
  cursor: 0,
  refCursor: 0,
  effectCursor: 0,
  callbackCursor: 0,
  key: "",
}));

/** The component's window.setTimeout'd close delay, captured so a test can fire/cancel it. */
const timerBox = vi.hoisted((): { pending: (() => void) | null; armed: number; cancelled: number } => ({
  pending: null,
  armed: 0,
  cancelled: 0,
}));

/** React's dep comparison, near enough: same length and all `Object.is`-equal. */
function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const slots = (harness.state[harness.key] ??= []);
      const slot = harness.cursor++;
      if (slots.length <= slot) {
        slots[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      const set = (next: unknown): void => {
        slots[slot] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[slot]) : next;
      };
      return [slots[slot], set];
    },
    useRef(initial: unknown) {
      const slots = (harness.refs[harness.key] ??= []);
      const slot = harness.refCursor++;
      slots[slot] ??= { current: initial };
      return slots[slot];
    },
    useId() {
      return "test-id";
    },
    useEffect(fn: () => unknown, deps?: readonly unknown[]) {
      const slots = (harness.effects[harness.key] ??= []);
      const slot = harness.effectCursor++;
      const prev = slots[slot];
      if (prev !== undefined && sameDeps(prev.deps, deps)) {
        return;
      }
      prev?.cleanup?.();
      slots[slot] = { fn, deps };
      harness.pending.push(fn);
    },
    useCallback(fn: unknown, deps?: readonly unknown[]) {
      const slots = (harness.callbacks[harness.key] ??= []);
      const slot = harness.callbackCursor++;
      const prev = slots[slot] as { fn: unknown; deps?: readonly unknown[] } | undefined;
      if (prev !== undefined && sameDeps(prev.deps, deps)) {
        return prev.fn;
      }
      slots[slot] = { fn, deps };
      return fn;
    },
  };
});

// Plain node has no `window`; the component's close-delay timer goes through
// window.setTimeout/clearTimeout (Electron convention), stubbed here.
vi.stubGlobal("window", {
  setTimeout: (fn: () => void) => {
    timerBox.pending = fn;
    timerBox.armed += 1;
    return 1;
  },
  clearTimeout: () => {
    timerBox.pending = null;
    timerBox.cancelled += 1;
  },
});

const { TranscriptMinimap } = await vi.importActual<typeof import("./TranscriptMinimap.js")>("./TranscriptMinimap.js");

type AnyElement = { type: unknown; props: Record<string, unknown> };

function isElement(value: unknown): value is AnyElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function walk(node: unknown, visit: (element: AnyElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (!isElement(node)) {
    return;
  }
  visit(node);
  // Descend through any component/fragment node too (the confirm buttons
  // live inside a fragment — the tree here is plain elements all the way).
  walk(node.props.children, visit);
}

function findButton(tree: unknown, className: string): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (element.type === "button" && typeof element.props.className === "string" && element.props.className.includes(className)) {
      found = element;
    }
  });
  return found;
}

function findTick(tree: unknown, index: number): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (element.type === "button" && element.props["data-mark-index"] === index) {
      found = element;
    }
  });
  return found;
}

function findPopover(tree: unknown): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (typeof element.props.className === "string" && element.props.className === "minimap-preview") {
      found = element;
    }
  });
  return found;
}

function popoverText(tree: unknown, className: string): string {
  let text = "";
  walk(tree, (element) => {
    if (typeof element.props.className === "string" && element.props.className === className) {
      text = element.props.children as string;
    }
  });
  return text;
}

function mountRail(props: Record<string, unknown>): unknown {
  let tree: unknown = undefined;
  for (let pass = 0; pass < 10; pass++) {
    harness.key = "rail";
    harness.cursor = 0;
    harness.refCursor = 0;
    harness.effectCursor = 0;
    harness.callbackCursor = 0;
    harness.pending = [];
    tree = (TranscriptMinimap as unknown as (p: Record<string, unknown>) => unknown)(props);
    const pending = harness.pending;
    harness.pending = [];
    if (pending.length === 0) {
      break;
    }
    for (const fn of pending) {
      const cleanup = fn();
      const slots = harness.effects[harness.key];
      if (typeof cleanup === "function" && slots) {
        const slot = slots.find((s) => s.fn === fn);
        if (slot && slot.cleanup === undefined) {
          slot.cleanup = cleanup as () => void;
        }
      }
    }
  }
  return tree;
}

function resetHarness(): void {
  harness.state = {};
  harness.refs = {};
  harness.effects = {};
  harness.callbacks = {};
  harness.pending = [];
  timerBox.pending = null;
  timerBox.armed = 0;
  timerBox.cancelled = 0;
}

const railMarks: UserTurnMark[] = [
  { id: "u1", index: 0, questionExcerpt: "first question" },
  { id: "u2", index: 3, questionExcerpt: "<b>x</b> second" },
];

describe("TranscriptMinimap wiring (4742 — slot-backed hooks harness)", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    for (const slot of harness.effects["rail"] ?? []) {
      slot.cleanup?.();
      slot.cleanup = undefined;
    }
  });

  it("a tick's click handler calls onJump with the mark's block id", () => {
    const onJump = vi.fn();
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump });
    (findTick(tree, 1)!.props.onClick as () => void)();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("u2");
  });

  it("hovering a tick opens the popover with the query as PLAIN TEXT (markup-escaped, never HTML)", () => {
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    (findTick(tree, 1)!.props.onMouseEnter as () => void)();
    const open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    const popover = findPopover(open);
    expect(popover).toBeDefined();
    expect(popoverText(open, "minimap-preview-counter")).toBe("Message 2 of 2");
    // The query is a React text node — "<b>x</b>" renders as literal text,
    // never as markup.
    expect(popoverText(open, "minimap-preview-question")).toBe("<b>x</b> second");
  });

  it("no Rewind button without the rewind prop (child panes/tests: popover is a pure tooltip)", () => {
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    (findTick(tree, 0)!.props.onMouseEnter as () => void)();
    const open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    expect(findButton(open, "minimap-preview-rewind")).toBeUndefined();
    expect(findPopover(open)!.props.role).toBe("tooltip");
  });

  it("no Rewind button with the rewind prop but NO matched checkpoint for the open turn", () => {
    const rewind = { checkpointIds: ["cp-1", null], onRewind: () => {} };
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    // Hover tick 1 (no checkpoint).
    (findTick(tree, 1)!.props.onMouseEnter as () => void)();
    const open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    expect(findButton(open, "minimap-preview-rewind")).toBeUndefined();
  });

  it("a matched checkpoint offers Rewind; confirm calls onRewind exactly once with the right id; cancel calls nothing", () => {
    const onRewind = vi.fn();
    const rewind = { checkpointIds: ["cp-1", null], onRewind };
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    (findTick(tree, 0)!.props.onMouseEnter as () => void)();
    const open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });

    const rewindButton = findButton(open, "minimap-preview-rewind");
    expect(rewindButton).toBeDefined();
    expect(rewindButton!.props.children).toBe("Rewind to before this message");
    // The popover with actions is a labeled group (not a tooltip).
    expect(findPopover(open)!.props.role).toBe("group");
    expect(findPopover(open)!.props["aria-label"]).toBe("Message 1 of 2 actions");

    // Click Rewind -> inline confirm (the old panel's copy).
    (rewindButton!.props.onClick as () => void)();
    const confirming = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    expect(popoverText(confirming, "minimap-preview-confirm-text")).toBe(
      "Rewind to this checkpoint? Files and conversation after it are discarded.",
    );

    // Cancel: nothing sent, confirm state reset back to the plain button.
    (findButton(confirming, "minimap-preview-confirm-cancel")!.props.onClick as () => void)();
    const cancelled = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    expect(onRewind).not.toHaveBeenCalled();
    expect(findButton(cancelled, "minimap-preview-rewind")).toBeDefined();

    // Rewind: exactly one onRewind with the matched checkpoint id.
    (findButton(cancelled, "minimap-preview-rewind")!.props.onClick as () => void)();
    const confirming2 = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    (findButton(confirming2, "minimap-preview-confirm-confirm")!.props.onClick as () => void)();
    expect(onRewind).toHaveBeenCalledTimes(1);
    expect(onRewind).toHaveBeenCalledWith("cp-1");
  });

  it("leaving the tick arms the close delay; entering the popover cancels it; the fired timer closes the popover", () => {
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    (findTick(tree, 0)!.props.onMouseEnter as () => void)();
    let open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });

    // Pointer leaves the tick (headed for the popover): timer armed, popover still open.
    (findTick(open, 0)!.props.onMouseLeave as () => void)();
    open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    expect(findPopover(open)).toBeDefined();
    expect(timerBox.pending).not.toBeNull();

    // Pointer enters the popover: timer cancelled, popover stays open.
    (findPopover(open)!.props.onMouseEnter as () => void)();
    const stayed = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    expect(findPopover(stayed)).toBeDefined();
    expect(timerBox.pending).toBeNull(); // cancelled by the re-enter

    // Leave the popover -> armed again; fire the timer -> closed.
    (findPopover(stayed)!.props.onMouseLeave as () => void)();
    const armed = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    expect(timerBox.pending).not.toBeNull();
    timerBox.pending!();
    const closed = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    expect(findPopover(closed)).toBeUndefined();
  });

  it("Esc (closeNow) closes the popover immediately via the rail's key handler", () => {
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    (findTick(tree, 0)!.props.onMouseEnter as () => void)();
    let open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    expect(findPopover(open)).toBeDefined();
    // The rail root's onKeyDown handler with an Escape key event.
    let railRoot: AnyElement | undefined;
    walk(open, (element) => {
      if (typeof element.props.className === "string" && element.props.className === "minimap") {
        railRoot = element;
      }
    });
    expect(railRoot).toBeDefined();
    const preventDefault = vi.fn();
    (railRoot!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: "Escape", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    const closed = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {} });
    expect(findPopover(closed)).toBeUndefined();
  });

  it("a half-confirmed rewind resets when the popover closes (timer-fired close discards the confirm)", () => {
    const onRewind = vi.fn();
    const rewind = { checkpointIds: ["cp-1", null], onRewind };
    const tree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    (findTick(tree, 0)!.props.onMouseEnter as () => void)();
    let open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    (findButton(open, "minimap-preview-rewind")!.props.onClick as () => void)();
    open = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    expect(findButton(open, "minimap-preview-confirm-confirm")).toBeDefined();

    // Close the popover (leave both tick and popover, fire the timer).
    (findTick(open, 0)!.props.onMouseLeave as () => void)();
    mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    timerBox.pending!();
    mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });

    // Re-open the same tick: the confirm is gone, the plain button is back.
    const reopenedTree = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    (findTick(reopenedTree, 0)!.props.onMouseEnter as () => void)();
    const reopened = mountRail({ marks: railMarks, activeIndex: null, onJump: () => {}, rewind });
    expect(findButton(reopened, "minimap-preview-confirm-confirm")).toBeUndefined();
    expect(findButton(reopened, "minimap-preview-rewind")).toBeDefined();
    expect(onRewind).not.toHaveBeenCalled();
  });
});

/**
 * GitHub #19: selecting a mark inside a COLLAPSED agent-message group must
 * expand the group and land on the exact original message. The rail stays the
 * entry point (its mark click is the `onJump` the transcript wires to
 * `jumpToTranscriptBlock`), so this pins the real wiring end to end with a
 * structural fake DOM — the package's vitest environment has no jsdom.
 */
interface FakeNode {
  tag: string;
  classes: string[];
  blockId?: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  onClick?: () => void;
  clicked: number;
  scrolls: Array<{ block?: string; behavior?: string } | undefined>;
}

function fakeNode(tag: string, classes: string[], blockId?: string, attrs: Record<string, string> = {}): FakeNode {
  return { tag, classes, ...(blockId !== undefined ? { blockId } : {}), attrs, children: [], parent: null, clicked: 0, scrolls: [] };
}

function append(parent: FakeNode, child: FakeNode): FakeNode {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

function matches(node: FakeNode, selector: string): boolean {
  if (selector.startsWith(".")) {
    return node.classes.includes(selector.slice(1));
  }
  const attribute = /^\[([a-z-]+)="(.*)"\]$/.exec(selector);
  if (attribute) {
    const value = attribute[1] === "data-block-id" ? node.blockId : node.attrs[attribute[1]!];
    return value === attribute[2];
  }
  return false;
}

/** One stable wrapper per node: `closest()` must return the SAME object for the node itself. */
const targetWrappers = new WeakMap<FakeNode, JumpTarget>();

function fakeTarget(node: FakeNode): JumpTarget {
  const cached = targetWrappers.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const wrapper: JumpTarget = {
    closest(selector: string): JumpTarget | null {
      let current: FakeNode | null = node;
      while (current !== null) {
        if (matches(current, selector)) return fakeTarget(current);
        current = current.parent;
      }
      return null;
    },
    classList: { contains: (token: string) => node.classes.includes(token) },
    querySelector: (selector: string) => {
      const found = findBySelector(node, selector);
      return found === null ? null : fakeTarget(found);
    },
    getAttribute: (name: string) => node.attrs[name] ?? null,
    click: () => {
      node.clicked += 1;
      node.onClick?.();
    },
    scrollIntoView: (options?) => {
      node.scrolls.push(options);
    },
  };
  targetWrappers.set(node, wrapper);
  return wrapper;
}

function findBySelector(root: FakeNode, selector: string): FakeNode | null {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = findBySelector(child, selector);
    if (nested !== null) return nested;
  }
  return null;
}

/** Runs `body` with a queue-backed requestAnimationFrame; the queue is drained by the caller. */
function withAnimationFrames(body: (frames: Array<() => void>) => void): void {
  const frames: Array<() => void> = [];
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: () => void) => {
    frames.push(callback);
    return frames.length;
  }) as typeof globalThis.requestAnimationFrame;
  try {
    body(frames);
  } finally {
    globalThis.requestAnimationFrame = previous;
  }
}

const agentMarks: UserTurnMark[] = [
  { id: "agent-message:a", index: 0, questionExcerpt: "first agent message", agentMessage: true },
  { id: "agent-message:b", index: 1, questionExcerpt: "second agent message", agentMessage: true },
];

interface CollapsedGroup {
  container: FakeNode;
  stack: FakeNode;
  toggle: FakeNode;
  memberA: FakeNode;
  memberB: FakeNode;
}

/** A collapsed group of two agent messages + the expanded members it swaps in on toggle. */
function collapsedGroup(): CollapsedGroup {
  const container = fakeNode("div", ["message-list"]);
  const stack = append(container, fakeNode("div", ["agent-message-stack", "minimap-turn"], "agent-message:a"));
  const toggle = append(stack, fakeNode("button", ["agent-message-stack-toggle"], undefined, { "aria-expanded": "false" }));
  append(stack, fakeNode("div", ["agent-message-preview"]));
  const anchorB = append(stack, fakeNode("span", ["agent-message-stack-anchor", "minimap-turn"], "agent-message:b"));
  const memberA = fakeNode("div", ["message", "message-child-report", "minimap-turn"], "agent-message:a");
  const memberB = fakeNode("div", ["message", "message-child-report", "minimap-turn"], "agent-message:b");
  toggle.onClick = () => {
    toggle.attrs["aria-expanded"] = "true";
    stack.blockId = undefined;
    stack.classes = ["agent-message-stack"];
    stack.children = [toggle, memberA, memberB];
    memberA.parent = stack;
    memberB.parent = stack;
  };
  void anchorB;
  return { container, stack, toggle, memberA, memberB };
}

describe("TranscriptMinimap -> grouped agent-message jump (GitHub #19)", () => {
  beforeEach(() => resetHarness());

  it("selecting the second mark expands the group and scrolls the second original id", () => {
    const group = collapsedGroup();
    const afterJump = vi.fn();
    const onJump = vi.fn((blockId: string) => jumpToTranscriptBlock(fakeTarget(group.container), blockId, afterJump));
    withAnimationFrames((frames) => {
      const tree = mountRail({ marks: agentMarks, activeIndex: null, onJump });
      // The SECOND mark of the rail is the tail member of the collapsed group.
      (findTick(tree, 1)!.props.onClick as () => void)();
      expect(onJump).toHaveBeenCalledWith("agent-message:b");
      expect(group.toggle.clicked).toBe(1);
      expect(group.toggle.attrs["aria-expanded"]).toBe("true");
      // Two rAFs: the React commit after the toggle click, then layout.
      while (frames.length > 0) {
        const queued = frames.splice(0);
        for (const frame of queued) frame();
      }
      expect(group.memberB.scrolls).toEqual([{ block: "center", behavior: "auto" }]);
      expect(group.memberA.scrolls).toHaveLength(0);
      expect(afterJump).toHaveBeenCalledTimes(1);
    });
  });

  it("selecting the FIRST mark (the group root) also expands and targets the head member", () => {
    const group = collapsedGroup();
    const afterJump = vi.fn();
    withAnimationFrames((frames) => {
      const onJump = (blockId: string) => jumpToTranscriptBlock(fakeTarget(group.container), blockId, afterJump);
      const tree = mountRail({ marks: agentMarks, activeIndex: null, onJump });
      (findTick(tree, 0)!.props.onClick as () => void)();
      expect(group.toggle.clicked).toBe(1);
      while (frames.length > 0) {
        const queued = frames.splice(0);
        for (const frame of queued) frame();
      }
      expect(group.memberA.scrolls).toEqual([{ block: "center", behavior: "auto" }]);
      expect(afterJump).toHaveBeenCalledTimes(1);
    });
  });

  it("an already-expanded member takes the plain scroll path (no second toggle click)", () => {
    const group = collapsedGroup();
    group.toggle.onClick!();
    const afterJump = vi.fn();
    const onJump = (blockId: string) => jumpToTranscriptBlock(fakeTarget(group.container), blockId, afterJump);
    const tree = mountRail({ marks: agentMarks, activeIndex: null, onJump });
    (findTick(tree, 1)!.props.onClick as () => void)();
    expect(group.toggle.clicked).toBe(0);
  });
});

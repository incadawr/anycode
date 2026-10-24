/**
 * Unit gate for BackgroundTasksPanel.tsx (TASK.91 / Taskana 4097 follow-up).
 *
 * Scope of this gate (the wire/reducer seams have their own gates):
 *  - the live-tail poll fires ONLY while drawer-open ∧ row-selected ∧
 *    running, and stops on close, on deselect and at task end (fake timers);
 *  - the output <pre> renders as an accordion DIRECTLY UNDER its own row,
 *    not under the list;
 *  - Stop is offered for a running task and NOT offered once terminal.
 *
 * Harness: the repo's SettingsScreen.test.ts pattern (node environment, no
 * DOM) — `vi.mock("react")` with slot-based useState/useEffect/useCallback,
 * effects drained by `mountUnit` passes. Two Taskana-4097 extensions over
 * that pattern: useEffect slots keep their CLEANUP and re-run it on a deps
 * change (the poll interval is started/stopped exactly through effect
 * cleanups), and `unmountKey` runs every live cleanup (poll stops on
 * unmount). Store hooks (`useTabStore`/`useTabsStore`/`useTabSend`) and the
 * D8 overlay flag are module-mocked to read this file's hoisted harness
 * state, so the component reads exactly the snapshot a test hands it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTaskSnapshot } from "@anycode/core";
import type { ReactNode } from "react";
import { Fragment } from "react";

/* ------------------------------------------------------------------ mocks */

interface HarnessState {
  tabContextValue: unknown;
  tabState: Record<string, unknown>;
  tabsState: Record<string, unknown>;
  send: (message: unknown) => void;
  sent: unknown[];
  state: Record<string, unknown[]>;
  effects: Record<string, Array<{ fn: () => unknown; deps?: readonly unknown[]; cleanup?: () => void }>>;
  callbacks: Record<string, unknown[]>;
  pending: Array<() => unknown>;
  cursor: number;
  effectCursor: number;
  callbackCursor: number;
  key: string;
}

const harness = vi.hoisted((): HarnessState => ({
  tabContextValue: { tabId: "tab-1" },
  tabState: {},
  tabsState: {},
  send: (message: unknown) => {
    void message;
  },
  sent: [],
  state: {},
  effects: {},
  callbacks: {},
  pending: [],
  cursor: 0,
  effectCursor: 0,
  callbackCursor: 0,
  key: "",
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
    // Outside a React render (`ReactCurrentOwner`/dispatcher null), the real
    // useContext throws — the panel is the only consumer, and its TabContext
    // is the mocked tab-context sentinel below.
    useContext(_context: unknown) {
      return harness.tabContextValue;
    },
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
    // useRef shares useState's slot array/cursor (call order is stable per render).
    useRef(initial: unknown) {
      const slots = (harness.state[harness.key] ??= []);
      const slot = harness.cursor++;
      if (slots.length <= slot) {
        slots[slot] = { current: initial };
      }
      return slots[slot];
    },
    useEffect(fn: () => unknown, deps?: readonly unknown[]) {
      const slots = (harness.effects[harness.key] ??= []);
      const slot = harness.effectCursor++;
      const prev = slots[slot];
      if (prev !== undefined && sameDeps(prev.deps, deps)) {
        return;
      }
      // Taskana 4097: a deps change re-runs the effect — the PREVIOUS effect's
      // cleanup must fire first (this is what stops a live-tail interval when
      // the drawer closes, the selection moves, or the task settles).
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

// The per-tab store hooks read the harness state verbatim; `TabContext` is a
// stable sentinel (the mocked react's useContext below ignores its argument).
// Modules are spread from the originals so the rest of their export surface
// (used by BackgroundAgents.tsx, imported for `backgroundElapsed`) stays intact.
vi.mock("../tab-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tab-context.js")>();
  const sentinel: unknown = { __tabContextSentinel: true };
  return {
    ...actual,
    TabContext: sentinel,
    useTabStore: (selector: (state: unknown) => unknown) => selector(harness.tabState),
    useTabSend: () => harness.send,
  };
});

vi.mock("../tabs-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tabs-store.js")>();
  // A zustand-store-shaped fake (getState/subscribe/useState-compatible
  // selector call): tab-registry subscribes to it at module load, and the
  // component reads `tabs`/`setTasksPanelOpen` off its state.
  const listeners = new Set<() => void>();
  const fakeStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(harness.tabsState),
    {
      getState: () => harness.tabsState,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getInitialState: () => harness.tabsState,
      setState: () => {},
    },
  );
  return {
    ...actual,
    useTabsStore: fakeStore,
  };
});

vi.mock("../preview/overlay-flag.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../preview/overlay-flag.js")>();
  return {
    ...actual,
    useOverlayFlag: () => {},
  };
});

/* ----------------------------------------------------------------- imports */

import {
  BackgroundTasksPanel,
  TASK_OUTPUT_POLL_MS,
  buildTaskOutputRequest,
  shouldLiveTailOutput,
} from "./BackgroundTasksPanel.js";

/* ----------------------------------------------------------------- harness */

type AnyElement = { type: unknown; props: Record<string, unknown> };

function isElement(value: unknown): value is AnyElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/** Depth-first walk; descends fragments/host elements (component children are lazy). */
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
  if (node.type === Fragment || typeof node.type === "string") {
    walk(node.props.children, visit);
  }
}

function mountUnit(key: string, passes = 10): unknown {
  let tree: unknown = undefined;
  for (let pass = 0; pass < passes; pass++) {
    harness.key = key;
    harness.cursor = 0;
    harness.effectCursor = 0;
    harness.callbackCursor = 0;
    harness.pending = [];
    tree = (BackgroundTasksPanel as unknown as () => unknown)();
    const pending = harness.pending;
    harness.pending = [];
    if (pending.length === 0) {
      break;
    }
    for (const fn of pending) {
      const cleanup = fn();
      // Store the cleanup on this effect's slot (found by identity among the
      // pending fns' slots) so a later deps change or unmount can run it.
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

/** Runs every live effect cleanup for a key (poll stops on unmount). */
function unmountKey(key: string): void {
  for (const slot of harness.effects[key] ?? []) {
    slot.cleanup?.();
    slot.cleanup = undefined;
  }
}

function resetHarness(): void {
  harness.tabState = {};
  harness.tabsState = {};
  harness.sent = [];
  harness.send = (message: unknown) => {
    harness.sent.push(message);
  };
  harness.state = {};
  harness.effects = {};
  harness.callbacks = {};
  harness.pending = [];
  harness.tabContextValue = { tabId: "tab-1" };
}

/** The TaskRow component element for a task (found by its handler props — it is not a host element). */
function findRowElement(tree: unknown, taskId: string): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (
      typeof element.type === "function" &&
      element.props.task !== undefined &&
      (element.props.task as BackgroundTaskSnapshot).taskId === taskId
    ) {
      found = element;
    }
  });
  return found;
}

/** Renders one TaskRow element to a host tree so its buttons are inspectable. */
function renderRow(element: AnyElement | undefined): unknown {
  if (!element) {
    return undefined;
  }
  return (element.type as (props: Record<string, unknown>) => ReactNode)(element.props);
}

function findButtons(rowTree: unknown): AnyElement[] {
  const buttons: AnyElement[] = [];
  walk(rowTree, (element) => {
    if (element.type === "button") {
      buttons.push(element);
    }
  });
  return buttons;
}

/** The accordion item wrapper (host div, so its children ARE in the tree). */
function findItem(tree: unknown, taskId: string): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (element.type === "div" && element.props["data-task-id"] === taskId && element.props.className === "background-tasks-item") {
      found = element;
    }
  });
  return found;
}

function findPre(item: AnyElement | undefined): AnyElement | undefined {
  if (!item) {
    return undefined;
  }
  let found: AnyElement | undefined;
  walk(item.props.children, (element) => {
    if (element.type === "pre") {
      found = element;
    }
  });
  return found;
}

/* ------------------------------------------------------------------ fixtures */

function runningTask(overrides: Partial<BackgroundTaskSnapshot> = {}): BackgroundTaskSnapshot {
  return {
    taskId: "task-1",
    command: "npm run watch",
    status: "running",
    startedAt: 1_000,
    exitCode: null,
    endedAt: null,
    ...overrides,
  } as BackgroundTaskSnapshot;
}

function mountPanel(tasks: BackgroundTaskSnapshot[], output: Record<string, string> = {}, open = true): unknown {
  harness.tabState = { backgroundTasks: tasks, backgroundTaskOutput: output };
  harness.tabsState = {
    tabs: [{ tabId: "tab-1", tasksPanelOpen: open }],
    setTasksPanelOpen: () => {},
  };
  return mountUnit("panel");
}

function outputRequests(): number {
  return harness.sent.filter((m) => (m as { type?: string }).type === "task_output_request").length;
}

/* ---------------------------------------------------------------------- tests */

describe("shouldLiveTailOutput (pure predicate)", () => {
  it("polls only while open AND a task is selected AND it is running", () => {
    const run = runningTask();
    const done = runningTask({ taskId: "task-2", status: "completed" });
    expect(shouldLiveTailOutput(true, run)).toBe(true);
    expect(shouldLiveTailOutput(false, run)).toBe(false); // drawer closed
    expect(shouldLiveTailOutput(true, undefined)).toBe(false); // nothing selected
    expect(shouldLiveTailOutput(false, undefined)).toBe(false);
    expect(shouldLiveTailOutput(true, done)).toBe(false); // task finished
  });
});

describe("BackgroundTasksPanel live-tail (Taskana 4097)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });

  afterEach(() => {
    unmountKey("panel");
    vi.useRealTimers();
  });

  it("does not poll while the drawer is merely open with no row selected", () => {
    mountPanel([runningTask()]);
    expect(harness.sent).toEqual([{ type: "task_list_request" }]); // refresh-on-open only
    vi.advanceTimersByTime(5_000);
    expect(harness.sent).toEqual([{ type: "task_list_request" }]);
  });

  it("polls task_output_request every 1s while open + selected + running", () => {
    const tree = mountPanel([runningTask()]);
    // Select the row through its own handler (what the Output button calls).
    const row = findRowElement(tree, "task-1");
    expect(row).toBeDefined();
    (row!.props.onToggleOutput as () => void)();

    mountUnit("panel"); // re-render with the selection applied
    // One immediate fetch on select, then one per second.
    expect(outputRequests()).toBe(1);
    vi.advanceTimersByTime(TASK_OUTPUT_POLL_MS);
    expect(outputRequests()).toBe(2);
    vi.advanceTimersByTime(3 * TASK_OUTPUT_POLL_MS);
    expect(outputRequests()).toBe(5);
    expect(harness.sent.every((m) => m instanceof Object)).toBe(true);
    expect(harness.sent.filter((m) => (m as { type?: string }).type === "task_output_request")).toEqual([
      buildTaskOutputRequest("task-1"),
      buildTaskOutputRequest("task-1"),
      buildTaskOutputRequest("task-1"),
      buildTaskOutputRequest("task-1"),
      buildTaskOutputRequest("task-1"),
    ]);
  });

  it("stops polling when the drawer closes (selection kept)", () => {
    const tree = mountPanel([runningTask()]);
    (findRowElement(tree, "task-1")!.props.onToggleOutput as () => void)();
    mountUnit("panel");
    expect(outputRequests()).toBe(1);

    // The drawer closes: same tab state minus the open flag.
    harness.tabsState = { tabs: [{ tabId: "tab-1", tasksPanelOpen: false }], setTasksPanelOpen: () => {} };
    mountUnit("panel"); // renders null; the open-flag effect deps changed -> cleanup
    vi.advanceTimersByTime(5_000);
    expect(outputRequests()).toBe(1); // no further requests
  });

  it("stops polling when the row is deselected", () => {
    const tree = mountPanel([runningTask()]);
    const row = findRowElement(tree, "task-1");
    (row!.props.onToggleOutput as () => void)();
    mountUnit("panel");
    expect(outputRequests()).toBe(1);

    // Toggle the SAME row again = deselect (accordion closes).
    const rowAgain = findRowElement(mountUnit("panel"), "task-1");
    (rowAgain!.props.onToggleOutput as () => void)();
    mountUnit("panel");
    vi.advanceTimersByTime(5_000);
    expect(outputRequests()).toBe(1);
  });

  it("stops polling the moment the task settles (idle host push refreshed the row)", () => {
    const tree = mountPanel([runningTask()]);
    (findRowElement(tree, "task-1")!.props.onToggleOutput as () => void)();
    mountUnit("panel");
    expect(outputRequests()).toBe(1);

    // The host's idle task-settled push lands: same task, now completed.
    harness.tabState = {
      backgroundTasks: [runningTask({ status: "completed", exitCode: 0, endedAt: 4_000 })],
      backgroundTaskOutput: { "task-1": "done" },
    };
    mountUnit("panel");
    // Exactly one final peek on the running -> terminal edge (the last <1s of
    // output), then nothing: running -> terminal ended the poll.
    expect(outputRequests()).toBe(2);
    vi.advanceTimersByTime(5_000);
    mountUnit("panel");
    expect(outputRequests()).toBe(2);
  });

  it("never polls a task that is already terminal when selected", () => {
    const tree = mountPanel([runningTask({ status: "failed" })]);
    (findRowElement(tree, "task-1")!.props.onToggleOutput as () => void)();
    mountUnit("panel");
    expect(outputRequests()).toBe(1); // the single on-select fetch only
    vi.advanceTimersByTime(5_000);
    expect(outputRequests()).toBe(1);
  });
});

describe("BackgroundTasksPanel accordion + Stop affordance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });

  afterEach(() => {
    unmountKey("panel");
    vi.useRealTimers();
  });

  it("renders the output <pre> directly under ITS OWN row, not under the list", () => {
    const tasks = [runningTask(), runningTask({ taskId: "task-2", command: "cargo build", startedAt: 2_000 })];
    const tree = mountPanel(tasks, { "task-1": "hello\nworld" });
    (findRowElement(tree, "task-1")!.props.onToggleOutput as () => void)();
    const updated = mountUnit("panel");

    const item1 = findItem(updated, "task-1");
    const item2 = findItem(updated, "task-2");
    expect(item1).toBeDefined();
    expect(item2).toBeDefined();

    const pre1 = findPre(item1);
    expect(pre1).toBeDefined();
    expect(pre1!.props.className).toBe("background-tasks-output");
    expect(pre1!.props.children).toBe("hello\nworld");
    // The other row's item carries NO output pane — the output is not a
    // single view under the whole list.
    expect(findPre(item2)).toBeUndefined();
  });

  it("hides the output pane again when the row is toggled off", () => {
    const tree = mountPanel([runningTask()], { "task-1": "x" });
    (findRowElement(tree, "task-1")!.props.onToggleOutput as () => void)();
    const selected = mountUnit("panel");
    expect(findPre(findItem(selected, "task-1"))).toBeDefined();

    (findRowElement(selected, "task-1")!.props.onToggleOutput as () => void)();
    const deselected = mountUnit("panel");
    expect(findPre(findItem(deselected, "task-1"))).toBeUndefined();
  });

  it("offers Stop on a running task and NOT on a finished one", () => {
    const running = runningTask();
    const tree = mountPanel([running]);
    const rowTree = renderRow(findRowElement(tree, "task-1"));
    const stopRunning = findButtons(rowTree).filter((button) => (button.props.className as string).includes("background-tasks-stop"));
    expect(stopRunning).toHaveLength(1);
    expect((stopRunning[0]!.props as { "aria-label": string })["aria-label"]).toBe("Stop background task npm run watch");

    // The task finishes between turns (idle push) — the row re-renders
    // without Stop; the Output toggle remains.
    const settled = runningTask({ status: "completed", exitCode: 0, endedAt: 4_000 });
    const updated = mountPanel([settled]);
    const rowTreeAfter = renderRow(findRowElement(updated, "task-1"));
    const buttonsAfter = findButtons(rowTreeAfter);
    expect(buttonsAfter.filter((button) => (button.props.className as string).includes("background-tasks-stop"))).toHaveLength(0);
    expect(buttonsAfter.filter((button) => button.props.children === "Output")).toHaveLength(1);
  });

  it("shows the terminal status and exit code on the settled row", () => {
    const updated = mountPanel([runningTask({ status: "failed", exitCode: 3, endedAt: 9_000 })]);
    const rowTree = renderRow(findRowElement(updated, "task-1"));
    let status = "";
    walk(rowTree, (element) => {
      if (typeof element.props.className === "string" && element.props.className.includes("background-tasks-status")) {
        status = element.props.children as string;
      }
    });
    expect(status).toBe("Failed");
    let elapsed = "";
    walk(rowTree, (element) => {
      if (typeof element.props.className === "string" && element.props.className.includes("background-tasks-elapsed")) {
        elapsed = element.props.children as string;
      }
    });
    expect(elapsed).toContain("exit 3");
  });
});

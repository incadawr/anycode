/**
 * terminal-view tests (design slice-2.4-cut.md §4, task 2.4.4 criteria): the
 * xterm-instance-per-tab registry that lives outside React. No jsdom in this
 * package's vitest config (apps/desktop/vitest.config.ts, `environment:
 * "node"`) — `@xterm/xterm`'s `Terminal`/`@xterm/addon-fit`'s `FitAddon` DO
 * construct fine under plain Node (verified: only `.open()` needs a real DOM
 * element), but `.open()` itself does not, so every test here injects fake
 * `TerminalLike`/`FitAddonLike`/holder doubles via `TerminalFactories` instead
 * of touching the real classes or `document` at all — same
 * fake-primitive-double style as tab-registry.test.ts's `FakeMessagePort`.
 */
import { describe, expect, it, vi } from "vitest";
import { createTerminalView, type FitAddonLike, type TerminalFactories, type TerminalLike } from "./terminal-view.js";

/** Minimal DOM-node double: just enough of Element's child-management surface for reparent tests. */
class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;

  appendChild(node: FakeElement): FakeElement {
    node.parentElement?.removeChild(node);
    this.children.push(node);
    node.parentElement = this;
    return node;
  }

  removeChild(node: FakeElement): FakeElement {
    this.children = this.children.filter((c) => c !== node);
    if (node.parentElement === this) {
      node.parentElement = null;
    }
    return node;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.children]) {
      child.parentElement = null;
    }
    this.children = [];
    for (const node of nodes) {
      node.parentElement?.removeChild(node);
      this.children.push(node);
      node.parentElement = this;
    }
  }
}

function asElement(fake: FakeElement): HTMLDivElement {
  return fake as unknown as HTMLDivElement;
}

/** Minimal `TerminalLike` double: records writes/opens/dispose, forwards `onData` through a swappable sink. */
class FakeTerminal implements TerminalLike {
  written: string[] = [];
  opened: HTMLElement | null = null;
  disposed = false;
  cols = 80;
  rows = 24;
  private dataSink: ((data: string) => void) | null = null;
  cleared = 0;
  selection = "";
  selectionSubDisposed = false;
  private selectionSink: (() => void) | null = null;

  write(data: string, callback?: () => void): void {
    this.written.push(data);
    callback?.();
  }

  onData(cb: (data: string) => void): { dispose(): void } {
    this.dataSink = cb;
    return {
      dispose: () => {
        this.dataSink = null;
      },
    };
  }

  loadAddon(): void {}

  open(el: HTMLElement): void {
    this.opened = el;
  }

  dispose(): void {
    this.disposed = true;
  }

  clear(): void {
    this.cleared += 1;
  }

  getSelection(): string {
    return this.selection;
  }

  hasSelection(): boolean {
    return this.selection.length > 0;
  }

  onSelectionChange(cb: () => void): { dispose(): void } {
    this.selectionSink = cb;
    return {
      dispose: () => {
        this.selectionSubDisposed = true;
        this.selectionSink = null;
      },
    };
  }

  /** Test helper: simulates the user typing, routed through whatever sink `onData` currently holds. */
  emitData(data: string): void {
    this.dataSink?.(data);
  }

  /** Test helper: simulates an xterm selection change, routed through whatever sink `onSelectionChange` currently holds. */
  setSelection(text: string): void {
    this.selection = text;
    this.selectionSink?.();
  }
}

class FakeFitAddon implements FitAddonLike {
  fitCalls = 0;

  fit(): void {
    this.fitCalls += 1;
  }
}

interface FakeRig {
  factories: TerminalFactories;
  terminals: FakeTerminal[];
  fits: FakeFitAddon[];
  holders: FakeElement[];
}

function createFakeRig(): FakeRig {
  const terminals: FakeTerminal[] = [];
  const fits: FakeFitAddon[] = [];
  const holders: FakeElement[] = [];
  const factories: TerminalFactories = {
    createTerminal: vi.fn(() => {
      const term = new FakeTerminal();
      terminals.push(term);
      return term;
    }),
    createFitAddon: vi.fn(() => {
      const fit = new FakeFitAddon();
      fits.push(fit);
      return fit;
    }),
    createHolder: vi.fn(() => {
      const holder = new FakeElement();
      holders.push(holder);
      return asElement(holder);
    }),
  };
  return { factories, terminals, fits, holders };
}

describe("terminal-view — ensure (no recreation)", () => {
  it("creates the term/fit/holder triple once; a second ensure for the same tab reuses it", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);

    view.ensure("tab-a", () => {});
    view.ensure("tab-a", () => {});

    expect(rig.factories.createTerminal).toHaveBeenCalledTimes(1);
    expect(rig.factories.createFitAddon).toHaveBeenCalledTimes(1);
    expect(rig.factories.createHolder).toHaveBeenCalledTimes(1);
  });

  it("routes onData through whichever onInput sink was last supplied, without registering a second listener", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    const first = vi.fn();
    const second = vi.fn();

    view.ensure("tab-a", first);
    rig.terminals[0]?.emitData("a");
    view.ensure("tab-a", second); // e.g. TerminalPanel's mount effect re-running
    rig.terminals[0]?.emitData("b");

    expect(first).toHaveBeenCalledWith("a");
    expect(first).not.toHaveBeenCalledWith("b");
    expect(second).toHaveBeenCalledWith("b");
    expect(second).not.toHaveBeenCalledWith("a");
  });
});

describe("terminal-view — attachHolder (DOM reparent, not recreate)", () => {
  it("reparents the same holder across two containers without recreating the terminal", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});

    const containerA = new FakeElement();
    const containerB = new FakeElement();
    view.attachHolder("tab-a", asElement(containerA));
    view.attachHolder("tab-a", asElement(containerB));

    expect(containerA.children).toHaveLength(0);
    expect(containerB.children).toEqual([rig.holders[0]]);
    expect(rig.factories.createTerminal).toHaveBeenCalledTimes(1);
    // xterm's own `.open()` contract: called exactly once per instance's life,
    // never again on a subsequent reparent.
    expect(rig.terminals[0]?.opened).toBe(rig.holders[0]);
  });

  it("evicts a DIFFERENT tab's holder from a shared container without touching that tab's own instance", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    view.ensure("tab-b", () => {});

    const container = new FakeElement();
    view.attachHolder("tab-a", asElement(container));
    view.attachHolder("tab-b", asElement(container));

    expect(container.children).toEqual([rig.holders[1]]);
    expect(rig.holders[0]?.parentElement).toBeNull();
    // tab-a's own term/fit are untouched — still alive, not disposed, still trackable.
    expect(view.has("tab-a")).toBe(true);
    expect(rig.terminals[0]?.disposed).toBe(false);

    // Switching back reparents tab-a's SAME holder in — proves the "reparent,
    // not recreate" criterion across a simulated tab switch.
    view.attachHolder("tab-a", asElement(container));
    expect(container.children).toEqual([rig.holders[0]]);
    expect(rig.factories.createTerminal).toHaveBeenCalledTimes(2); // tab-a + tab-b, no third
  });

  it("is a no-op for a tab that was never ensured", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    const container = new FakeElement();

    expect(() => view.attachHolder("ghost", asElement(container))).not.toThrow();
    expect(container.children).toHaveLength(0);
  });
});

describe("terminal-view — write/markOpened/markDead", () => {
  it("write() forwards bytes into the tab's own terminal, and is a no-op for an unknown tab", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});

    view.write("tab-a", "hello");
    expect(rig.terminals[0]?.written).toEqual(["hello"]);

    expect(() => view.write("ghost", "nope")).not.toThrow();
  });

  it("markOpened writes the replay tail (term_opened.replay) and clears the dead flag", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    view.markDead("tab-a", "boom");
    expect(view.isDead("tab-a")).toBe(true);

    view.markOpened("tab-a", "replayed output");

    expect(view.isDead("tab-a")).toBe(false);
    expect(rig.terminals[0]?.written).toContain("replayed output");
  });

  it("markOpened with an empty replay (fresh spawn) writes nothing extra", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});

    view.markOpened("tab-a", "");

    expect(rig.terminals[0]?.written).toEqual([]);
  });

  it("markDead writes a banner line into the buffer and flips isDead", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});

    view.markDead("tab-a", "process exited (code 1)");

    expect(view.isDead("tab-a")).toBe(true);
    expect(rig.terminals[0]?.written.some((chunk) => chunk.includes("terminal exited: process exited (code 1)"))).toBe(
      true,
    );
  });

  it("subscribeDead fires only on an actual transition, not on a repeated markDead/markOpened", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    const events: boolean[] = [];
    view.subscribeDead("tab-a", (dead) => events.push(dead));

    view.markDead("tab-a", "first");
    view.markDead("tab-a", "second"); // already dead — no second notification
    view.markOpened("tab-a", ""); // reopen — transition back to alive
    view.markOpened("tab-a", ""); // already alive — no second notification

    expect(events).toEqual([true, false]);
  });

  it("subscribeDead's unsubscribe stops further notifications", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    const events: boolean[] = [];
    const unsubscribe = view.subscribeDead("tab-a", (dead) => events.push(dead));

    unsubscribe();
    view.markDead("tab-a", "boom");

    expect(events).toEqual([]);
  });
});

describe("terminal-view — fitNow/currentDims", () => {
  it("fitNow runs the fit-addon and returns the terminal's resulting geometry", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    rig.terminals[0]!.cols = 120;
    rig.terminals[0]!.rows = 40;

    const dims = view.fitNow("tab-a");

    expect(rig.fits[0]?.fitCalls).toBe(1);
    expect(dims).toEqual({ cols: 120, rows: 40 });
  });

  it("fitNow/currentDims return undefined for an unknown tab", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    expect(view.fitNow("ghost")).toBeUndefined();
    expect(view.currentDims("ghost")).toBeUndefined();
  });

  it("currentDims reads geometry WITHOUT re-fitting", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});

    const dims = view.currentDims("tab-a");

    expect(rig.fits[0]?.fitCalls).toBe(0);
    expect(dims).toEqual({ cols: 80, rows: 24 });
  });
});

describe("terminal-view — dispose (no leaks)", () => {
  it("unsubscribes onData, disposes the terminal, detaches the holder, and forgets the tab entirely", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    const onInput = vi.fn();
    view.ensure("tab-a", onInput);
    const container = new FakeElement();
    view.attachHolder("tab-a", asElement(container));

    view.dispose("tab-a");

    expect(rig.terminals[0]?.disposed).toBe(true);
    expect(container.children).toHaveLength(0);
    expect(view.has("tab-a")).toBe(false);

    // A stray onData firing after dispose (e.g. a lingering reference) must not resurrect anything.
    rig.terminals[0]?.emitData("stray");
    expect(onInput).not.toHaveBeenCalled();
  });

  it("dispose is a no-op for a tab that was never ensured", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    expect(() => view.dispose("ghost")).not.toThrow();
  });

  it("reset() disposes every tracked terminal", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    view.ensure("tab-b", () => {});

    view.reset();

    expect(view.has("tab-a")).toBe(false);
    expect(view.has("tab-b")).toBe(false);
    expect(rig.terminals.every((t) => t.disposed)).toBe(true);
  });

  it("dispose(tabId) disposes the selection subscription", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});

    view.dispose("tab-a");

    expect(rig.terminals[0]?.selectionSubDisposed).toBe(true);
  });
});

describe("terminal-view — clear/getSelection/hasSelection/subscribeSelection (R18)", () => {
  it("clear() forwards to the right tab's terminal, and is a no-throw no-op for an unknown tab", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    view.ensure("tab-b", () => {});

    view.clear("tab-a");

    expect(rig.terminals[0]?.cleared).toBe(1);
    expect(rig.terminals[1]?.cleared).toBe(0);
    expect(() => view.clear("ghost")).not.toThrow();
  });

  it("getSelection/hasSelection pass through the terminal's current selection, and default for an unknown tab", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});

    expect(view.getSelection("tab-a")).toBe("");
    expect(view.hasSelection("tab-a")).toBe(false);

    rig.terminals[0]!.selection = "hello";

    expect(view.getSelection("tab-a")).toBe("hello");
    expect(view.hasSelection("tab-a")).toBe(true);

    expect(view.getSelection("ghost")).toBe("");
    expect(view.hasSelection("ghost")).toBe(false);
  });

  it("subscribeSelection fires with the new hasSelection on every selection change, and unsubscribe stops delivery", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);
    view.ensure("tab-a", () => {});
    const events: boolean[] = [];
    const unsubscribe = view.subscribeSelection("tab-a", (hasSelection) => events.push(hasSelection));

    rig.terminals[0]!.setSelection("x");
    rig.terminals[0]!.setSelection("");

    expect(events).toEqual([true, false]);

    unsubscribe();
    rig.terminals[0]!.setSelection("y");

    expect(events).toEqual([true, false]);
  });

  it("subscribeSelection returns a no-op unsubscribe for an unknown tab", () => {
    const rig = createFakeRig();
    const view = createTerminalView(rig.factories);

    expect(() => view.subscribeSelection("ghost", () => {})()).not.toThrow();
  });
});

/**
 * tab-registry tests (design phase-2.md §2.4/§4.3, task 2.1.4 criterion): two
 * fake ports with different tabIds land messages in their own store, an
 * unknown tabId auto-registers, a closed tabId is dropped, host-exited flips
 * only its own tab, dispose removes the entry AND its subscription (no
 * leaks), and switching the active tab doesn't stall a background tab's
 * delta accumulation.
 *
 * Slice 2.4 (design slice-2.4-cut.md §4, task 2.4.4) adds the "tab-registry —
 * terminal plane" suite below: term-port routing by tabId (and dropping an
 * unknown/closed tab), `term_opened.replay` reaching terminal-view.ts,
 * `markHostExited`/`disposeTab` tearing the terminal down (banner + no
 * leaks), and a respawned port resending `term_open` when the panel was left
 * open. Those tests inject a FAKE `TerminalView` (see `createFakeTerminalView`
 * below) instead of the real xterm-backed singleton — the xterm/DOM-reparent
 * mechanics are terminal-view.test.ts's job; this suite only asserts that
 * tab-registry.ts calls the right terminal-view method, with the right
 * tabId/args, at the right time.
 *
 * Every test builds its own `createTabsStore()`/`createTabRegistry()` pair
 * (not the app singletons) so registry/tabs-store state never leaks between
 * cases — same isolation discipline as store.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";
import { createTabStatusStore } from "./tab-status-store.js";
import { createDesktopStore, type FrameScheduler, type TranscriptBlock } from "./store.js";
import type { HostToUiMessage } from "../../shared/protocol.js";
import type { TermToHostMessage, TermToUiMessage } from "../../shared/terminal.js";
import type { TerminalDims, TerminalView } from "./terminal-view.js";

/** Typed lookup by transcript block kind (same helper as store.test.ts) so `.text`/etc. narrow correctly. */
function findBlock<K extends TranscriptBlock["kind"]>(
  blocks: TranscriptBlock[],
  kind: K,
): Extract<TranscriptBlock, { kind: K }> | undefined {
  return blocks.find((b): b is Extract<TranscriptBlock, { kind: K }> => b.kind === kind);
}

/** A FrameScheduler double that captures the flush callback instead of running it (same shape as store.test.ts's). */
function createManualScheduler(): { scheduler: FrameScheduler; runPending: () => void } {
  let pending: (() => void) | null = null;
  return {
    scheduler: {
      schedule(flush) {
        pending = flush;
      },
    },
    runPending(): void {
      const cb = pending;
      pending = null;
      cb?.();
    },
  };
}

/** A minimal MessagePort double: captures outgoing sends and lets tests push inbound messages via `.emit`. */
class FakeMessagePort {
  onmessage: ((event: MessageEvent<HostToUiMessage>) => void) | null = null;
  sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  emit(message: HostToUiMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<HostToUiMessage>);
  }
}

function asPort(fake: FakeMessagePort): MessagePort {
  return fake as unknown as MessagePort;
}

/** The term-channel twin of FakeMessagePort, typed for `TermToHostMessage`/`TermToUiMessage`. */
class FakeTerminalPort {
  onmessage: ((event: MessageEvent<TermToUiMessage>) => void) | null = null;
  sent: TermToHostMessage[] = [];

  postMessage(message: TermToHostMessage): void {
    this.sent.push(message);
  }

  emit(message: TermToUiMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<TermToUiMessage>);
  }
}

function asTerminalPort(fake: FakeTerminalPort): MessagePort {
  return fake as unknown as MessagePort;
}

const HOST_READY = (workspace: string, sessionId: string): HostToUiMessage => ({
  type: "host_ready",
  workspace,
  mode: "build",
  model: "m1",
  sessionId,
});

/**
 * A `TerminalView` double that just records every call (tabId + args) instead
 * of touching `@xterm/xterm` — terminal-view.test.ts already covers the real
 * xterm/DOM mechanics; this suite only cares whether tab-registry.ts calls
 * the right method with the right tabId at the right time.
 */
function createFakeTerminalView() {
  const opened: Array<{ tabId: string; replay: string }> = [];
  const written: Array<{ tabId: string; data: string }> = [];
  const deadMarks: Array<{ tabId: string; reason: string }> = [];
  const disposed: string[] = [];
  const dims = new Map<string, TerminalDims>();

  const view: TerminalView = {
    ensure: vi.fn(),
    attachHolder: vi.fn(),
    write: vi.fn((tabId: string, data: string) => written.push({ tabId, data })),
    markOpened: vi.fn((tabId: string, replay: string) => opened.push({ tabId, replay })),
    markDead: vi.fn((tabId: string, reason: string) => deadMarks.push({ tabId, reason })),
    fitNow: vi.fn(() => undefined),
    currentDims: vi.fn((tabId: string) => dims.get(tabId)),
    isDead: vi.fn(() => false),
    has: vi.fn(() => false),
    subscribeDead: vi.fn(() => () => {}),
    clear: vi.fn(),
    getSelection: vi.fn(() => ""),
    hasSelection: vi.fn(() => false),
    subscribeSelection: vi.fn(() => () => {}),
    dispose: vi.fn((tabId: string) => disposed.push(tabId)),
    reset: vi.fn(),
  };

  return { view, opened, written, deadMarks, disposed, setDims: (tabId: string, d: TerminalDims) => dims.set(tabId, d) };
}

/** Builds a registry whose stores use a manual (test-controlled) scheduler, tracking one scheduler per created tab store in creation order, plus a fake terminal-view. */
function createTestRegistry(tabsStore: ReturnType<typeof createTabsStore>) {
  const schedulers: ReturnType<typeof createManualScheduler>[] = [];
  const fakeTerminalView = createFakeTerminalView();
  const statusStore = createTabStatusStore();
  const registry = createTabRegistry(
    tabsStore,
    () => {
      const manual = createManualScheduler();
      schedulers.push(manual);
      return createDesktopStore(manual.scheduler);
    },
    fakeTerminalView.view,
    statusStore,
  );
  return { registry, schedulers, terminalView: fakeTerminalView, statusStore };
}

describe("tab-registry — routing by tabId", () => {
  it("delivers each port's messages only to its own tab's store", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);

    const portA = new FakeMessagePort();
    const portB = new FakeMessagePort();
    expect(registry.registerPort("tab-a", "/ws/a", asPort(portA))).toBe(true);
    expect(registry.registerPort("tab-b", "/ws/b", asPort(portB))).toBe(true);

    portA.emit(HOST_READY("/ws/a", "sess-a"));
    portB.emit(HOST_READY("/ws/b", "sess-b"));

    expect(registry.getStore("tab-a")?.getState().workspace).toBe("/ws/a");
    expect(registry.getStore("tab-b")?.getState().workspace).toBe("/ws/b");

    // sessionId lifted from host_ready lands on the RIGHT tab's tabs-store entry.
    const tabs = tabsStore.getState().tabs;
    expect(tabs.find((t) => t.tabId === "tab-a")?.sessionId).toBe("sess-a");
    expect(tabs.find((t) => t.tabId === "tab-b")?.sessionId).toBe("sess-b");

    // A turn/transcript event addressed to tab-a must not appear in tab-b's transcript.
    registry.getStore("tab-a")?.getState().applyHostMessage({ type: "turn_started", requestId: "r1", turnId: "t1" });
    registry.getStore("tab-a")?.getState().applyHostMessage({
      type: "agent_event",
      turnId: "t1",
      event: { type: "loop_end", reason: "completed", turns: 1 },
    });
    expect(registry.getStore("tab-a")?.getState().transcript).toHaveLength(1);
    expect(registry.getStore("tab-b")?.getState().transcript).toHaveLength(0);
  });

  it("auto-registers a tab on the first port for an unknown tabId (reload restoration, design §2.2)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);

    expect(tabsStore.getState().tabs).toHaveLength(0);
    const port = new FakeMessagePort();
    const attached = registry.registerPort("fresh-tab", "/ws/fresh", asPort(port));

    expect(attached).toBe(true);
    expect(tabsStore.getState().tabs.map((t) => t.tabId)).toEqual(["fresh-tab"]);
    // First-ever tab becomes active automatically.
    expect(tabsStore.getState().activeTabId).toBe("fresh-tab");
    expect(registry.getStore("fresh-tab")).toBeDefined();
    // The handshake fires immediately on attach.
    expect(port.sent).toEqual([{ type: "ui_ready" }]);
  });

  it("drops a port for an already-closed tab instead of resurrecting it", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    registry.disposeTab("tab-a");
    expect(registry.isClosed("tab-a")).toBe(true);

    const latePort = new FakeMessagePort();
    const attached = registry.registerPort("tab-a", "/ws/a", asPort(latePort));

    expect(attached).toBe(false);
    expect(registry.getStore("tab-a")).toBeUndefined();
    expect(tabsStore.getState().tabs).toHaveLength(0);
  });

  it("markHostExited flips only its own tab's connection/banner state", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);

    const portA = new FakeMessagePort();
    const portB = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(portA));
    registry.registerPort("tab-b", "/ws/b", asPort(portB));
    portA.emit(HOST_READY("/ws/a", "sess-a"));
    portB.emit(HOST_READY("/ws/b", "sess-b"));

    registry.markHostExited("tab-a");

    expect(registry.getStore("tab-a")?.getState().connection).toBe("host_exited");
    expect(registry.getStore("tab-b")?.getState().connection).toBe("ready");

    const tabs = tabsStore.getState().tabs;
    expect(tabs.find((t) => t.tabId === "tab-a")?.hostExited).toBe(true);
    expect(tabs.find((t) => t.tabId === "tab-b")?.hostExited).toBe(false);

    // A respawn's fresh port clears the flag and reconnects (design §2.2: respawn = resume).
    const respawnPort = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(respawnPort));
    expect(registry.getStore("tab-a")?.getState().connection).toBe("awaiting_host_ready");
    expect(tabsStore.getState().tabs.find((t) => t.tabId === "tab-a")?.hostExited).toBe(false);
  });

  it("sendToTab warns and drops when the tab has no live connection (e.g. mid-exit)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    registry.markHostExited("tab-a");

    registry.sendToTab("tab-a", { type: "cancel_turn" });
    expect(warnSpy).toHaveBeenCalled();
    expect(port.sent).toEqual([{ type: "ui_ready" }]); // no cancel_turn appended

    warnSpy.mockRestore();
  });

  it("dispose removes the entry AND its message subscription — no leaks", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    const staleStoreRef = registry.getStore("tab-a")!;
    expect(staleStoreRef.getState().connection).toBe("awaiting_host_ready");

    registry.disposeTab("tab-a");
    expect(registry.getStore("tab-a")).toBeUndefined();
    expect(tabsStore.getState().tabs).toHaveLength(0);

    // The port is still technically alive (its owner would tear it down
    // separately), but the registry's subscription to it is gone: a stray
    // message must not resurrect state on the old store instance.
    port.emit(HOST_READY("/ws/a", "sess-a"));
    expect(staleStoreRef.getState().connection).toBe("awaiting_host_ready");
    expect(staleStoreRef.getState().workspace).toBeNull();
  });

  it("lifts title_changed into the tabs-store's title, for the right tab only (Phase 4 slice 4.4-T, design §4)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);

    const portA = new FakeMessagePort();
    const portB = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(portA));
    registry.registerPort("tab-b", "/ws/b", asPort(portB));
    portA.emit(HOST_READY("/ws/a", "sess-a"));
    portB.emit(HOST_READY("/ws/b", "sess-b"));

    portA.emit({ type: "title_changed", title: "Fix the flaky test" });

    const tabs = tabsStore.getState().tabs;
    expect(tabs.find((t) => t.tabId === "tab-a")?.title).toBe("Fix the flaky test");
    expect(tabs.find((t) => t.tabId === "tab-b")?.title).toBeUndefined();

    // A later refinement overwrites the same tab's title (setTitle is a plain replace).
    portA.emit({ type: "title_changed", title: "Fix flaky node-execution test" });
    expect(tabsStore.getState().tabs.find((t) => t.tabId === "tab-a")?.title).toBe(
      "Fix flaky node-execution test",
    );
  });

  it("switching the active tab does not stall a background tab's delta accumulation", () => {
    const tabsStore = createTabsStore();
    const { registry, schedulers } = createTestRegistry(tabsStore);

    const portA = new FakeMessagePort();
    const portB = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(portA)); // schedulers[0]
    registry.registerPort("tab-b", "/ws/b", asPort(portB)); // schedulers[1]
    portA.emit(HOST_READY("/ws/a", "sess-a"));
    portB.emit(HOST_READY("/ws/b", "sess-b"));

    // tab-a is the active/rendered tab...
    tabsStore.getState().setActiveTab("tab-a");
    expect(tabsStore.getState().activeTabId).toBe("tab-a");

    // ...but tab-b (backgrounded) keeps streaming: turn_started + text deltas
    // land in ITS store and flush via ITS own scheduler, unaffected by which
    // tab is "active" (that's a pure tabs-store selection with zero wire effect).
    portB.emit({ type: "turn_started", requestId: "r1", turnId: "bg-turn" });
    portB.emit({ type: "agent_event", turnId: "bg-turn", event: { type: "text_start", id: "s1" } });
    portB.emit({ type: "agent_event", turnId: "bg-turn", event: { type: "text_delta", id: "s1", text: "back" } });
    portB.emit({ type: "agent_event", turnId: "bg-turn", event: { type: "text_delta", id: "s1", text: "ground" } });

    // Still active tab-a, unchanged by tab-b's activity.
    expect(tabsStore.getState().activeTabId).toBe("tab-a");
    // Not yet flushed (batched) — but the flush IS scheduled on tab-b's own scheduler.
    const tabBTranscript = registry.getStore("tab-b")?.getState().transcript ?? [];
    expect(findBlock(tabBTranscript, "assistant_text")?.text).toBe("");

    schedulers[1]?.runPending();

    expect(findBlock(registry.getStore("tab-b")?.getState().transcript ?? [], "assistant_text")?.text).toBe(
      "background",
    );
    // tab-a's own store never saw any of this traffic.
    expect(registry.getStore("tab-a")?.getState().transcript).toHaveLength(0);
    // Active selection is still whatever the UI last chose — independent axis.
    expect(tabsStore.getState().activeTabId).toBe("tab-a");
  });
});

describe("tab-registry — queueInitialPrompt (slice P7.12 §4.2)", () => {
  it("dispatches immediately when the tab is already ready", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    expect(registry.getStore("tab-a")?.getState().connection).toBe("ready");

    registry.queueInitialPrompt("tab-a", "hello there");

    const transcript = registry.getStore("tab-a")?.getState().transcript ?? [];
    expect(findBlock(transcript, "user_text")?.text).toBe("hello there");
    const sent = port.sent;
    expect(sent).toHaveLength(2); // ui_ready + user_message
    const userMessage = sent[1] as { type: string; requestId: string; text: string };
    expect(userMessage).toMatchObject({ type: "user_message", text: "hello there" });
    // The transcript block id and the wire requestId are the same generated id.
    expect(findBlock(transcript, "user_text")?.id).toBe(userMessage.requestId);
  });

  it("TASK.33 W8: records the dispatched text as lastSentMessage, so a later retryable failure can offer to replay it", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));

    registry.queueInitialPrompt("tab-a", "hello there");

    expect(registry.getStore("tab-a")?.getState().lastSentMessage).toEqual({ text: "hello there", images: [] });
  });

  it("queues and dispatches exactly once when host_ready arrives after the call", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    expect(registry.getStore("tab-a")?.getState().connection).toBe("awaiting_host_ready");

    registry.queueInitialPrompt("tab-a", "queued prompt");
    // Not dispatched yet — only the handshake went out.
    expect(port.sent).toEqual([{ type: "ui_ready" }]);

    port.emit(HOST_READY("/ws/a", "sess-a"));

    const transcript = registry.getStore("tab-a")?.getState().transcript ?? [];
    expect(findBlock(transcript, "user_text")?.text).toBe("queued prompt");
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]).toMatchObject({ type: "user_message", text: "queued prompt" });
  });

  it("a respawn's second host_ready does not re-send an already-dispatched prompt", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    registry.queueInitialPrompt("tab-a", "only once");
    port.emit(HOST_READY("/ws/a", "sess-a"));
    expect(port.sent).toHaveLength(2);

    // Host crashes and respawns — a fresh port arrives for the same tabId.
    // (Its own host_ready resets the transcript per store.ts's respawn
    // semantics — unrelated to this feature; a real respawn's session_history
    // replay would follow on the same port. What matters here is the WIRE:
    // the queued prompt was consumed by the first dispatch and must not
    // re-fire on the second host_ready.)
    registry.markHostExited("tab-a");
    const respawnPort = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(respawnPort));
    respawnPort.emit(HOST_READY("/ws/a", "sess-a2"));

    expect(respawnPort.sent.filter((m: unknown) => (m as { type: string }).type === "user_message")).toHaveLength(0);
  });

  it("queueInitialPrompt for an unknown/closed tabId is dropped silently", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    expect(() => registry.queueInitialPrompt("ghost", "hi")).not.toThrow();

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    registry.disposeTab("tab-a");
    expect(() => registry.queueInitialPrompt("tab-a", "hi")).not.toThrow();
  });

  it("disposeTab clears any pending prompt — a stray host_ready after dispose cannot resurrect it", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    const staleStoreRef = registry.getStore("tab-a")!;
    registry.queueInitialPrompt("tab-a", "never sent");

    registry.disposeTab("tab-a");
    // A stray host_ready on the now-unsubscribed port must not dispatch anything.
    port.emit(HOST_READY("/ws/a", "sess-a"));

    expect(staleStoreRef.getState().transcript).toHaveLength(0);
  });
});

describe("tab-registry — queueInitialPrompt task-model seam (slice F5#1b, D3)", () => {
  /** Filters port.sent down to just the message `type`s, in send order. */
  function sentTypes(port: FakeMessagePort): string[] {
    return port.sent.map((m) => (m as { type: string }).type);
  }

  it("sends set_model BEFORE the initial user_message when the pick differs from the boot model", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));

    registry.queueInitialPrompt("tab-a", "hello there", "gpt-5");
    expect(sentTypes(port)).toEqual(["ui_ready"]); // not dispatched yet

    port.emit(HOST_READY("/ws/a", "sess-a")); // boot model "m1" (see HOST_READY fixture)

    expect(sentTypes(port)).toEqual(["ui_ready", "set_model", "user_message"]);
    expect(port.sent[1]).toEqual({ type: "set_model", model: "gpt-5" });
    expect(port.sent[2]).toMatchObject({ type: "user_message", text: "hello there" });
  });

  it("sends a selected mode before the first user_message", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));

    registry.queueInitialPrompt("tab-a", "make a plan", undefined, "plan");
    port.emit(HOST_READY("/ws/a", "sess-a")); // boot mode is build

    expect(sentTypes(port)).toEqual(["ui_ready", "set_mode", "user_message"]);
    expect(port.sent[1]).toEqual({ type: "set_mode", mode: "plan" });
  });

  it("orders mode, model, then the first user_message when both start picks differ", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));

    registry.queueInitialPrompt("tab-a", "make a plan", "gpt-5", "plan");
    port.emit(HOST_READY("/ws/a", "sess-a"));

    expect(sentTypes(port)).toEqual(["ui_ready", "set_mode", "set_model", "user_message"]);
  });

  it("sends no set_model when the pending model equals the boot model", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));

    registry.queueInitialPrompt("tab-a", "hello there", "m1"); // matches HOST_READY's model "m1"
    port.emit(HOST_READY("/ws/a", "sess-a"));

    expect(sentTypes(port)).toEqual(["ui_ready", "user_message"]);
  });

  it("sends no set_model when no model was passed (current behavior preserved)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));

    registry.queueInitialPrompt("tab-a", "hello there");
    port.emit(HOST_READY("/ws/a", "sess-a"));

    expect(sentTypes(port)).toEqual(["ui_ready", "user_message"]);
  });

  it("a respawn's second host_ready re-sends neither the prompt nor the model (delete-before-dispatch)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    registry.queueInitialPrompt("tab-a", "only once", "gpt-5");
    port.emit(HOST_READY("/ws/a", "sess-a"));
    expect(sentTypes(port)).toEqual(["ui_ready", "set_model", "user_message"]);

    // Host crashes and respawns — a fresh port arrives for the same tabId.
    registry.markHostExited("tab-a");
    const respawnPort = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(respawnPort));
    respawnPort.emit(HOST_READY("/ws/a", "sess-a2"));

    // The queued entry was consumed by the first dispatch; neither set_model
    // nor user_message re-fires on the respawn's host_ready.
    expect(sentTypes(respawnPort)).toEqual(["ui_ready"]);
  });

  it("already-ready shortcut: sends set_model BEFORE the initial user_message when the pick differs from the current model", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a")); // boot model "m1"
    expect(registry.getStore("tab-a")?.getState().connection).toBe("ready");

    registry.queueInitialPrompt("tab-a", "hello there", "gpt-5");

    expect(sentTypes(port)).toEqual(["ui_ready", "set_model", "user_message"]);
    expect(port.sent[1]).toEqual({ type: "set_model", model: "gpt-5" });
    expect(port.sent[2]).toMatchObject({ type: "user_message", text: "hello there" });
  });

  it("already-ready shortcut: sends no set_model when the pick equals the tab's current model", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a")); // boot model "m1"

    registry.queueInitialPrompt("tab-a", "hello there", "m1"); // matches the tab's current model

    expect(sentTypes(port)).toEqual(["ui_ready", "user_message"]);
  });

  it("already-ready shortcut: sends no set_model when no model was passed (current behavior preserved)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));

    registry.queueInitialPrompt("tab-a", "hello there");

    expect(sentTypes(port)).toEqual(["ui_ready", "user_message"]);
  });

  it("already-ready shortcut: a model_changed after host_ready is the compare baseline (tracks the LIVE model, not the boot model)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a")); // boot model "m1"
    port.emit({ type: "model_changed", model: "gpt-5", reasoningEffort: "off" });
    expect(registry.getStore("tab-a")?.getState().model).toBe("gpt-5");

    // Picking the model the tab already switched TO is a no-op set_model.
    registry.queueInitialPrompt("tab-a", "hello there", "gpt-5");

    expect(sentTypes(port).filter((t) => t === "set_model")).toHaveLength(0);
  });
});

describe("tab-registry — prompt-queue drainer (slice P7.14 · F15)", () => {
  /** Filters port.sent down to the user_message drains (skips the ui_ready handshake). */
  function userMessages(port: FakeMessagePort): Array<{ requestId: string; text: string; images?: unknown[] }> {
    return port.sent.filter((m) => (m as { type: string }).type === "user_message") as Array<{
      requestId: string;
      text: string;
      images?: unknown[];
    }>;
  }

  it("drains exactly one queued prompt per turn-end, FIFO, gated by inFlight (re-entrancy safe)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const store = registry.getStore("tab-a")!;

    // A turn is running → enqueued prompts are held, not drained.
    port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
    store.getState().enqueuePrompt({ text: "a", images: [] });
    store.getState().enqueuePrompt({ text: "b", images: [] });
    expect(userMessages(port)).toHaveLength(0);

    // Turn ends cleanly → the drainer dispatches exactly ONE (the head "a").
    // Two enqueued items, one turn-end, one dispatch — proves the inFlight gate.
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(userMessages(port).map((m) => m.text)).toEqual(["a"]);
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["b"]);
    expect(store.getState().queueInFlight).not.toBeNull();
    // The drained item's transcript echo was appended (byte-parity with a normal send).
    expect(findBlock(store.getState().transcript, "user_text")?.text).toBe("a");

    // Host acks the drain (turn_started for ITS requestId) → inFlight clears; that
    // turn then ends → "b" drains. The wire requestId of the drain matches the echo.
    const drainReq = userMessages(port)[0]!.requestId;
    expect(findBlock(store.getState().transcript, "user_text")?.id).toBe(drainReq);
    port.emit({ type: "turn_started", requestId: drainReq, turnId: "t2" });
    expect(store.getState().queueInFlight).toBeNull();
    port.emit({ type: "agent_event", turnId: "t2", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(userMessages(port).map((m) => m.text)).toEqual(["a", "b"]);
    expect(store.getState().promptQueue).toHaveLength(0);
  });

  it("TASK.33 W8: records the drained item's text+images as lastSentMessage on dispatch", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const store = registry.getStore("tab-a")!;
    const image = { name: "a.png", sizeBytes: 10, attachment: { mediaType: "image/png" as const, data: "AA==" } };

    port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
    store.getState().enqueuePrompt({ text: "with image", images: [image] });
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });

    expect(store.getState().lastSentMessage).toEqual({ text: "with image", images: [image] });
  });

  // Regression (P7.14/F15 W1 fix): the drainer subscription fires SYNCHRONOUSLY
  // inside each store set(). A non-"completed" loop_end must flip the turn to
  // idle AND pause the queue in ONE atomic set(), or the drainer observes the
  // idle+unpaused intermediate and silently dispatches a queued prompt after a
  // cancelled/errored/max_turns end — the exact "don't send silently" anomaly.
  // (These assert on the drainer's reaction, which is why store.test.ts's
  // final-state assertions missed the two-set() bug: with one queued item the
  // premature drain empties the queue, so the pause branch never even runs and
  // queuePaused stays false while the item has already gone out on the wire.)
  for (const reason of ["cancelled", "error", "max_turns"] as const) {
    it(`does NOT drain and pauses when the turn ends "${reason}" with a queued prompt (anomalous end)`, () => {
      const tabsStore = createTabsStore();
      const { registry } = createTestRegistry(tabsStore);
      const port = new FakeMessagePort();
      registry.registerPort("tab-a", "/ws/a", asPort(port));
      port.emit(HOST_READY("/ws/a", "sess-a"));
      const store = registry.getStore("tab-a")!;

      // A user turn is running with exactly one prompt queued behind it and
      // no in-flight drain (the precise state the two-set() bug drained from).
      port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
      store.getState().enqueuePrompt({ text: "held", images: [] });
      expect(store.getState().queueInFlight).toBeNull();

      port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason, turns: 1 } });

      // The synchronous drainer never fired: no user_message went out, the
      // queue is paused, and the head is untouched (still at the front).
      expect(userMessages(port)).toHaveLength(0);
      expect(store.getState().queuePaused).toBe(true);
      expect(store.getState().queueInFlight).toBeNull();
      expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["held"]);

      // Resume re-enables the drainer, which now dispatches the held prompt.
      store.getState().resumeQueue();
      expect(userMessages(port).map((m) => m.text)).toEqual(["held"]);
    });
  }

  it('a "completed" turn-end with a queued prompt drains exactly one and does NOT pause', () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const store = registry.getStore("tab-a")!;

    port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
    store.getState().enqueuePrompt({ text: "go", images: [] });
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });

    // Clean completion is the drain trigger: exactly one leaves, queue stays unpaused.
    expect(userMessages(port).map((m) => m.text)).toEqual(["go"]);
    expect(store.getState().queuePaused).toBe(false);
    expect(store.getState().queueInFlight).not.toBeNull();
  });

  it("an enqueue while the turn is already idle drains immediately (turn-end/enqueue race, §2.2b)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));

    registry.getStore("tab-a")!.getState().enqueuePrompt({ text: "now", images: [] });

    expect(userMessages(port).map((m) => m.text)).toEqual(["now"]);
  });

  it("a busy turn_rejected on the drain restores the head + pauses; Resume re-drains it", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const store = registry.getStore("tab-a")!;

    port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
    store.getState().enqueuePrompt({ text: "x", images: [] });
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });
    const drainReq = userMessages(port)[0]!.requestId;
    expect(userMessages(port)).toHaveLength(1);

    // Host raced us and rejected the drain as busy.
    port.emit({ type: "turn_rejected", requestId: drainReq, reason: "busy" });
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["x"]);
    expect(store.getState().queuePaused).toBe(true);
    expect(store.getState().queueInFlight).toBeNull();
    // Paused holds the drainer even though the turn is idle — no re-send yet.
    expect(userMessages(port)).toHaveLength(1);

    // Resume → the drainer fires again and re-dispatches "x".
    store.getState().resumeQueue();
    expect(userMessages(port).map((m) => m.text)).toEqual(["x", "x"]);
  });

  it("a respawn preserves the queue paused and does NOT drain onto the fresh connection", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const store = registry.getStore("tab-a")!;

    port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
    store.getState().enqueuePrompt({ text: "keep", images: [] });

    // Host crashes (pauses the queue) and respawns with a fresh port.
    registry.markHostExited("tab-a");
    expect(store.getState().queuePaused).toBe(true);
    const respawnPort = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(respawnPort));
    respawnPort.emit(HOST_READY("/ws/a", "sess-a2"));

    // The typed-ahead prompt survived and stays paused — nothing auto-drains.
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["keep"]);
    expect(store.getState().queuePaused).toBe(true);
    expect(userMessages(respawnPort)).toHaveLength(0);
  });

  it("a crash while a drained item is IN FLIGHT restores it to the head (paused) instead of losing it; respawn does not re-drain (P7.14/F15 codex fix)", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const store = registry.getStore("tab-a")!;

    // A user turn runs, one prompt queued behind it.
    port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
    store.getState().enqueuePrompt({ text: "boom", images: [] });
    // Turn ends cleanly → the drainer dispatches "boom" into queueInFlight; the
    // host's turn_started for THIS drain has not arrived yet (the in-flight
    // window). This is the precise state where the crash loses the prompt.
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(userMessages(port).map((m) => m.text)).toEqual(["boom"]);
    expect(store.getState().queueInFlight?.item.text).toBe("boom");
    expect(store.getState().promptQueue).toEqual([]);

    // Host crashes mid-flight (before acking the drain).
    registry.markHostExited("tab-a");
    // The in-flight prompt was restored to the head, not dropped, and paused.
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["boom"]);
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().queuePaused).toBe(true);

    // Respawn: the prompt survives, still paused, and never auto-drains.
    const respawnPort = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(respawnPort));
    respawnPort.emit(HOST_READY("/ws/a", "sess-a2"));
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["boom"]);
    expect(store.getState().queuePaused).toBe(true);
    expect(userMessages(respawnPort)).toHaveLength(0);

    // Resume re-drains it exactly once onto the fresh connection.
    store.getState().resumeQueue();
    expect(userMessages(respawnPort).map((m) => m.text)).toEqual(["boom"]);
  });

  it("F5#1a non-intersection: a queued INITIAL prompt dispatches via dispatchInitialPrompt only — the drainer never races it", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));

    // The F5#1a path (queueInitialPrompt) is separate from the prompt queue.
    registry.queueInitialPrompt("tab-a", "first prompt");
    port.emit(HOST_READY("/ws/a", "sess-a"));

    const store = registry.getStore("tab-a")!;
    // The initial prompt went out exactly once, and never entered promptQueue.
    expect(userMessages(port).map((m) => m.text)).toEqual(["first prompt"]);
    expect(store.getState().promptQueue).toEqual([]);
    expect(store.getState().queueInFlight).toBeNull();
  });

  it("carries a queued prompt's image attachments onto the drained wire message", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const store = registry.getStore("tab-a")!;

    const attachment = { mediaType: "image/png" as const, data: "BASE64" };
    port.emit({ type: "turn_started", requestId: "user-1", turnId: "t1" });
    store.getState().enqueuePrompt({ text: "see this", images: [{ name: "s.png", sizeBytes: 9, attachment }] });
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });

    const drained = userMessages(port)[0]!;
    expect(drained.text).toBe("see this");
    expect(drained.images).toEqual([attachment]);
    // The transcript echo carries the image badge (transcriptTextWithImages).
    expect(findBlock(store.getState().transcript, "user_text")?.text).toBe("see this\n\n[1 image attached]");
  });

  it("disposeTab unsubscribes the drainer — a late enqueue on the retained store cannot dispatch", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    const staleStore = registry.getStore("tab-a")!;

    registry.disposeTab("tab-a");
    staleStore.getState().enqueuePrompt({ text: "orphan", images: [] });

    // The drainer subscription is gone: nothing was dispatched to the old port.
    expect(userMessages(port)).toHaveLength(0);
  });
});

describe("tab-registry — terminal plane (design slice-2.4-cut.md §4)", () => {
  it("routes term-port messages to terminal-view.ts keyed by tabId", () => {
    const tabsStore = createTabsStore();
    const { registry, terminalView } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));

    const termA = new FakeTerminalPort();
    const termB = new FakeTerminalPort();
    expect(registry.registerTerminalPort("tab-a", asTerminalPort(termA))).toBe(true);
    expect(registry.registerTerminalPort("tab-b", asTerminalPort(termB))).toBe(true);

    termA.emit({ type: "term_data", data: "from-a" });
    termB.emit({ type: "term_data", data: "from-b" });

    expect(terminalView.written).toEqual([
      { tabId: "tab-a", data: "from-a" },
      { tabId: "tab-b", data: "from-b" },
    ]);
  });

  it("drops a term-port for an unknown tabId (no paired UI port) instead of auto-registering it", () => {
    const tabsStore = createTabsStore();
    const { registry, terminalView } = createTestRegistry(tabsStore);

    const attached = registry.registerTerminalPort("never-registered", asTerminalPort(new FakeTerminalPort()));

    expect(attached).toBe(false);
    expect(terminalView.written).toEqual([]);
  });

  it("drops a term-port for an already-closed tab", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    registry.disposeTab("tab-a");

    const attached = registry.registerTerminalPort("tab-a", asTerminalPort(new FakeTerminalPort()));

    expect(attached).toBe(false);
  });

  it("term_opened.replay is forwarded to terminal-view.ts's markOpened", () => {
    const tabsStore = createTabsStore();
    const { registry, terminalView } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const term = new FakeTerminalPort();
    registry.registerTerminalPort("tab-a", asTerminalPort(term));

    term.emit({ type: "term_opened", reattached: true, replay: "tail of the ring buffer" });

    expect(terminalView.opened).toEqual([{ tabId: "tab-a", replay: "tail of the ring buffer" }]);
  });

  it("term_exited/term_error mark the terminal dead with a descriptive reason", () => {
    const tabsStore = createTabsStore();
    const { registry, terminalView } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const term = new FakeTerminalPort();
    registry.registerTerminalPort("tab-a", asTerminalPort(term));

    term.emit({ type: "term_exited", exitCode: 1, signal: 9 });

    expect(terminalView.deadMarks).toEqual([{ tabId: "tab-a", reason: "process exited (code 1, signal 9)" }]);
  });

  it("disposeTab tears the terminal down (unsubscribe + terminal-view dispose) — no leaks", () => {
    const tabsStore = createTabsStore();
    const { registry, terminalView } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const term = new FakeTerminalPort();
    registry.registerTerminalPort("tab-a", asTerminalPort(term));

    registry.disposeTab("tab-a");

    expect(terminalView.disposed).toEqual(["tab-a"]);

    // A stray message on the now-orphaned port must not resurrect anything.
    term.emit({ type: "term_data", data: "late" });
    expect(terminalView.written).toEqual([]);
  });

  it("markHostExited marks the terminal dead and drops the dead connection", () => {
    const tabsStore = createTabsStore();
    const { registry, terminalView } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const term = new FakeTerminalPort();
    registry.registerTerminalPort("tab-a", asTerminalPort(term));

    registry.markHostExited("tab-a");

    expect(terminalView.deadMarks).toEqual([{ tabId: "tab-a", reason: "host process exited" }]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.sendToTerminal("tab-a", { type: "term_input", data: "x" });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("a respawned term-port resends term_open when the tab's panel was left open (reattach)", () => {
    const tabsStore = createTabsStore();
    const { registry, terminalView } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const firstTerm = new FakeTerminalPort();
    registry.registerTerminalPort("tab-a", asTerminalPort(firstTerm));
    registry.openTerminal("tab-a", { cols: 100, rows: 30 });
    expect(firstTerm.sent).toEqual([{ type: "term_open", cols: 100, rows: 30 }]);

    // Host respawns (or the page reloads): the old port dies, markHostExited
    // runs, and a brand new term-port is delivered for the same tabId.
    registry.markHostExited("tab-a");
    terminalView.setDims("tab-a", { cols: 100, rows: 30 });
    const respawnTerm = new FakeTerminalPort();
    const attached = registry.registerTerminalPort("tab-a", asTerminalPort(respawnTerm));

    expect(attached).toBe(true);
    // The panel's terminalOpen flag survived the host exit — reattach fires automatically.
    expect(respawnTerm.sent).toEqual([{ type: "term_open", cols: 100, rows: 30 }]);
  });

  it("a fresh term-port does NOT auto-send term_open when the tab's panel was never opened", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const term = new FakeTerminalPort();

    registry.registerTerminalPort("tab-a", asTerminalPort(term));

    expect(term.sent).toEqual([]);
  });

  it("openTerminal flips the tabs-store flag and sends term_open on the live connection", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const term = new FakeTerminalPort();
    registry.registerTerminalPort("tab-a", asTerminalPort(term));

    registry.openTerminal("tab-a", { cols: 80, rows: 24 });

    expect(tabsStore.getState().tabs.find((t) => t.tabId === "tab-a")?.terminalOpen).toBe(true);
    expect(term.sent).toEqual([{ type: "term_open", cols: 80, rows: 24 }]);
  });

  it("openTerminal is safe to call with no live terminal connection yet — just sets the flag", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));

    expect(() => registry.openTerminal("tab-a", { cols: 80, rows: 24 })).not.toThrow();
    expect(tabsStore.getState().tabs.find((t) => t.tabId === "tab-a")?.terminalOpen).toBe(true);
  });

  it("sendToTerminal warns and drops when the tab has no live terminal connection", () => {
    const tabsStore = createTabsStore();
    const { registry } = createTestRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    registry.sendToTerminal("tab-a", { type: "term_kill" });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("tab-registry — status mirror (slice-R10)", () => {
  const PERMISSION_REQUEST = (requestId: string): HostToUiMessage => ({
    type: "permission_request",
    requestId,
    toolName: "Bash",
    input: { command: "ls" },
    mode: "build",
    metadata: {
      name: "Bash",
      description: "run a command",
      readOnly: false,
      destructive: true,
      riskLevel: "high",
      sideEffectScope: "process",
    },
  });

  it("registerPort seeds an all-false mirror entry synchronously, before any message arrives", () => {
    const tabsStore = createTabsStore();
    const { registry, statusStore } = createTestRegistry(tabsStore);

    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));

    expect(statusStore.getState().statuses.get("tab-a")).toEqual({
      running: false,
      needsApproval: false,
      attention: false,
    });
  });

  it("coarse flips land but high-frequency deltas bail (map identity unchanged across a delta burst)", () => {
    const tabsStore = createTabsStore();
    const { registry, schedulers, statusStore } = createTestRegistry(tabsStore);

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port)); // schedulers[0]
    port.emit(HOST_READY("/ws/a", "sess-a"));
    port.emit({ type: "turn_started", requestId: "r1", turnId: "t1" });

    expect(statusStore.getState().statuses.get("tab-a")).toMatchObject({ running: true, needsApproval: false });
    const identityAfterRunning = statusStore.getState().statuses;

    // Streaming deltas + a context_usage tick must never touch the mirror.
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "text_start", id: "s1" } });
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "text_delta", id: "s1", text: "a" } });
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "text_delta", id: "s1", text: "b" } });
    port.emit({
      type: "agent_event",
      turnId: "t1",
      event: { type: "context_usage", estimatedTokens: 42_000, budgetTokens: 176_000, source: "provider" },
    });
    schedulers[0]?.runPending();

    expect(statusStore.getState().statuses).toBe(identityAfterRunning);
  });

  it("a permission request mirrors needsApproval mid-turn; a ui settlement clears it", () => {
    const tabsStore = createTabsStore();
    const { registry, statusStore } = createTestRegistry(tabsStore);

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    port.emit({ type: "turn_started", requestId: "r1", turnId: "t1" });
    port.emit(PERMISSION_REQUEST("r1"));

    expect(statusStore.getState().statuses.get("tab-a")).toMatchObject({ running: true, needsApproval: true });

    port.emit({ type: "permission_settled", requestId: "r1", behavior: "allow", origin: "ui" });

    expect(statusStore.getState().statuses.get("tab-a")).toMatchObject({ running: true, needsApproval: false });
  });

  it("a background completion sets attention; visiting the tab clears it via the tabsStore subscription", () => {
    const tabsStore = createTabsStore();
    const { registry, statusStore } = createTestRegistry(tabsStore);

    const portA = new FakeMessagePort();
    const portB = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(portA)); // first tab → auto-active
    registry.registerPort("tab-b", "/ws/b", asPort(portB));
    portA.emit(HOST_READY("/ws/a", "sess-a"));
    portB.emit(HOST_READY("/ws/b", "sess-b"));
    tabsStore.getState().setActiveTab("tab-a");

    // tab-b completes a turn while backgrounded.
    portB.emit({ type: "turn_started", requestId: "r1", turnId: "bg-turn" });
    portB.emit({ type: "agent_event", turnId: "bg-turn", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(statusStore.getState().statuses.get("tab-b")).toMatchObject({ running: false, attention: true });

    // Visiting tab-b clears its attention — no component involved, the registry's
    // tabsStore subscription did it on the activeTabId flip.
    tabsStore.getState().setActiveTab("tab-b");
    expect(statusStore.getState().statuses.get("tab-b")?.attention).toBe(false);
  });

  it("a completion on the ACTIVE tab mints no attention", () => {
    const tabsStore = createTabsStore();
    const { registry, statusStore } = createTestRegistry(tabsStore);

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port)); // first tab → auto-active
    port.emit(HOST_READY("/ws/a", "sess-a"));
    expect(tabsStore.getState().activeTabId).toBe("tab-a");

    port.emit({ type: "turn_started", requestId: "r1", turnId: "t1" });
    port.emit({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });

    expect(statusStore.getState().statuses.get("tab-a")).toMatchObject({ running: false, attention: false });
  });

  it("a respawn does not double-subscribe the tab store; the mirror stays all-false (no phantom attention)", () => {
    const tabsStore = createTabsStore();
    const statusStore = createTabStatusStore();
    const fakeTerminalView = createFakeTerminalView();
    const subscribeSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    const registry = createTabRegistry(
      tabsStore,
      () => {
        const store = createDesktopStore(createManualScheduler().scheduler);
        subscribeSpies.push(vi.spyOn(store, "subscribe"));
        return store;
      },
      fakeTerminalView.view,
      statusStore,
    );

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    port.emit(HOST_READY("/ws/a", "sess-a"));
    port.emit({ type: "turn_started", requestId: "r1", turnId: "t1" });

    // Host crashes and a fresh port arrives for the SAME tabId (respawn).
    registry.markHostExited("tab-a");
    const respawnPort = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(respawnPort));
    respawnPort.emit(HOST_READY("/ws/a", "sess-a2"));

    // Exactly one store was created and its `.subscribe` was called exactly
    // twice (the R10 status mirror + the P7.14 prompt-queue drainer, both
    // store-lifetime) — the respawn reused the entry, it did not stack more
    // listeners (this would be 4 if the respawn re-subscribed).
    expect(subscribeSpies).toHaveLength(1);
    expect(subscribeSpies[0]).toHaveBeenCalledTimes(2);

    // The whole host-crash/respawn sequence never minted a phantom "finished" dot.
    expect(statusStore.getState().statuses.get("tab-a")).toEqual({
      running: false,
      needsApproval: false,
      attention: false,
    });
  });

  it("disposeTab removes the mirror entry and unsubscribes — a stale setState cannot resurrect it", () => {
    const tabsStore = createTabsStore();
    const { registry, statusStore } = createTestRegistry(tabsStore);

    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    const staleStoreRef = registry.getStore("tab-a")!;

    registry.disposeTab("tab-a");
    expect(statusStore.getState().statuses.has("tab-a")).toBe(false);

    // A setState on the retained store ref must not re-appear in the mirror.
    const before = statusStore.getState().statuses;
    staleStoreRef.getState().setHostExited();
    expect(statusStore.getState().statuses).toBe(before);
  });

  it("disposing the active tab activates a neighbor, whose attention is cleared by the visit path", () => {
    const tabsStore = createTabsStore();
    const { registry, statusStore } = createTestRegistry(tabsStore);

    const portA = new FakeMessagePort();
    const portB = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(portA)); // first tab → auto-active
    registry.registerPort("tab-b", "/ws/b", asPort(portB));
    portA.emit(HOST_READY("/ws/a", "sess-a"));
    portB.emit(HOST_READY("/ws/b", "sess-b"));

    // tab-b earns an attention dot while tab-a is active.
    portB.emit({ type: "turn_started", requestId: "r1", turnId: "bg-turn" });
    portB.emit({ type: "agent_event", turnId: "bg-turn", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(statusStore.getState().statuses.get("tab-b")?.attention).toBe(true);

    // Closing the active tab-a activates tab-b (removeTab neighbor path) → visit-clear.
    registry.disposeTab("tab-a");
    expect(tabsStore.getState().activeTabId).toBe("tab-b");
    expect(statusStore.getState().statuses.get("tab-b")?.attention).toBe(false);
  });
});

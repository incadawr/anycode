/**
 * A child session's UI steer that misses the Core seam is moved into the child
 * host's own queue (`steer_requeued` with `hostQueued`) and runs as the next
 * turn. The renderer must show that text exactly once: it keeps the pending
 * row until the matching turn starts, never resends it and never appends a
 * second bubble from the next-turn echo.
 */
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, SessionPermissionRules, type AgentLoopConfig, type ModelStreamEvent } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../../shared/protocol.js";
import { CoreEngine } from "../../host/engines/core-engine.js";
import { IpcPermissionBroker } from "../../host/permission-broker.js";
import { Outbound, Session, type ChildTerminalReport } from "../../host/session.js";
import { GatedModelPort, createHarness, nodeWirePort, textStep } from "../../host/test-harness.js";
import { agentMessageText, type AgentDisplayCard } from "../../shared/communication.js";
import { createDesktopStore } from "./store.js";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";

type Store = ReturnType<typeof createDesktopStore>;

const userTexts = (store: Store, text: string): number =>
  store.getState().transcript.filter((block) => block.kind === "user_text" && block.text === text).length;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Rig {
  session: Session;
  port: GatedModelPort;
  terminal: ReturnType<typeof vi.fn<(report: ChildTerminalReport) => void>>;
  received: HostToUiMessage[];
  sent: UiToHostMessage[];
  store: () => Store;
  post: (message: UiToHostMessage) => void;
  /** Fresh renderer store over the same host connection (a reconnect). */
  reconnect: () => Promise<Store>;
  waitStore: (predicate: () => boolean) => Promise<void>;
  close: () => void;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.close();
});

async function rig(steps: ModelStreamEvent[][]): Promise<Rig> {
  const donor = createHarness({ steps: [] });
  const port = new GatedModelPort(steps, 0);
  const broker = new IpcPermissionBroker(() => {});
  const config: AgentLoopConfig = { ...donor.config, modelPort: port, permissionBroker: broker };
  const channel = new MessageChannel();
  const received: HostToUiMessage[] = [];
  const sent: UiToHostMessage[] = [];
  channel.port1.on("message", (value: unknown) => received.push(value as HostToUiMessage));
  const terminal = vi.fn<(report: ChildTerminalReport) => void>();
  const session = new Session({
    outbound: new Outbound(),
    engine: new CoreEngine({ loop: new AgentLoop(config), config }),
    broker,
    fs: donor.toolFs,
    workspace: "/workspace",
    projectRoot: "/workspace",
    model: "fixture",
    sessionId: "child-session",
    bootHistory: [],
    rules: new SessionPermissionRules(),
    child: { onReady: () => {}, onProgress: () => {}, flushHistory: () => Promise.resolve(), onTerminal: terminal },
  });
  session.bindPort(nodeWirePort(channel.port2));

  let offset = 0;
  let listener: ((event: MessageEvent<HostToUiMessage>) => void) | null = null;
  const events = new EventTarget();
  const msgPort = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    get onmessage() { return listener; },
    set onmessage(value: typeof listener) { listener = value; },
    postMessage(message: UiToHostMessage) { sent.push(message); channel.port1.postMessage(message); },
  } as unknown as MessagePort;
  const makeTabs = () => createTabRegistry(createTabsStore(), () => createDesktopStore({ schedule: (fn) => fn() }));
  let tabs = makeTabs();
  const pump = setInterval(() => {
    while (offset < received.length) listener?.({ data: received[offset++] } as MessageEvent<HostToUiMessage>);
  }, 0);
  const wait = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 500 && !predicate(); i++) await sleep(2);
    expect(predicate()).toBe(true);
  };
  tabs.registerPort("tab", "/workspace", msgPort);
  await wait(() => tabs.getStore("tab")?.getState().connection === "ready");
  tabs.getStore("tab")!.getState().setChildSurface();
  const r: Rig = {
    session, port, terminal, received, sent,
    store: () => tabs.getStore("tab")!,
    post: (message) => { channel.port1.postMessage(message); },
    waitStore: wait,
    reconnect: async () => {
      tabs.disposeTab("tab");
      tabs = makeTabs();
      offset = 0;
      tabs.registerPort("tab", "/workspace", msgPort);
      await wait(() => tabs.getStore("tab")?.getState().connection === "ready");
      tabs.getStore("tab")!.getState().setChildSurface();
      await sleep(60);
      return tabs.getStore("tab")!;
    },
    close: () => {
      clearInterval(pump);
      tabs.disposeTab("tab");
      port.release();
      channel.port1.close();
      channel.port2.close();
    },
  };
  rigs.push(r);
  return r;
}

/** Sends a UI steer the way the composer does for a Core surface. */
function steer(r: Rig, requestId: string, text: string): void {
  const store = r.store();
  store.getState().recordPendingSteer(requestId, text, undefined, { text, images: [] });
  store.getState().markUiSteer(requestId);
  r.sent.push({ type: "steer_message", requestId, text });
  r.post({ type: "steer_message", requestId, text });
}

describe("child host-queued steer (real child host)", () => {
  it("renders a steer that missed the seam exactly once and never resends it", async () => {
    const r = await rig([textStep("FIRST"), textStep("SECOND")]);
    expect(r.session.startProgrammaticTurn("INITIAL")).toEqual({ ok: true });
    await r.waitStore(() => r.store().getState().turn.status === "running");
    steer(r, "s1", "STEER_ONE");
    await sleep(30);
    r.port.release();
    await vi.waitFor(() => expect(r.terminal).toHaveBeenCalled());
    await sleep(60);
    const store = r.store();
    expect(r.received.filter((m) => m.type === "steer_requeued")).toEqual([expect.objectContaining({ requestId: "s1", hostQueued: true })]);
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().pendingSteers).toHaveLength(0);
    expect(store.getState().uiSteerPending).toHaveLength(0);
    expect(r.sent.filter((m) => m.type === "user_message")).toHaveLength(0);
    expect(r.received.filter((m) => m.type === "turn_rejected")).toHaveLength(0);
    expect(r.port.requests).toHaveLength(2);
  });

  it("replaying the same live events into the same store adds no bubble", async () => {
    const r = await rig([textStep("FIRST"), textStep("SECOND")]);
    r.session.startProgrammaticTurn("INITIAL");
    await r.waitStore(() => r.store().getState().turn.status === "running");
    steer(r, "s1", "STEER_ONE");
    await sleep(30);
    r.port.release();
    await vi.waitFor(() => expect(r.terminal).toHaveBeenCalled());
    await sleep(60);
    const store = r.store();
    for (const message of [...r.received]) store.getState().applyHostMessage(message);
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().pendingSteers).toHaveLength(0);
  });

  it("a fresh store over the same host (reconnect after the turn ran) shows one bubble and nothing pending", async () => {
    const r = await rig([textStep("FIRST"), textStep("SECOND")]);
    r.session.startProgrammaticTurn("INITIAL");
    await r.waitStore(() => r.store().getState().turn.status === "running");
    steer(r, "s1", "STEER_ONE");
    await sleep(30);
    r.port.release();
    await vi.waitFor(() => expect(r.terminal).toHaveBeenCalled());
    await sleep(60);
    const store = await r.reconnect();
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().pendingSteers).toHaveLength(0);
    expect(r.sent.filter((m) => m.type === "user_message")).toHaveLength(0);
  });
});

describe("child host-queued steer (store-level event orders)", () => {
  const requeued = (requestId = "s1", text = "STEER_ONE"): HostToUiMessage => ({ type: "steer_requeued", requestId, reason: "core turn ended before injection", text, hostQueued: true });
  const started = (requestId: string, turnId: string): HostToUiMessage => ({ type: "turn_started", requestId, turnId });
  const loopEnd = (turnId: string): HostToUiMessage => ({ type: "agent_event", turnId, step: 1, event: { type: "loop_end", reason: "completed" } } as HostToUiMessage);
  function childStore(): Store {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().setChildSurface();
    store.getState().applyHostMessage(started("initial", "t1"));
    store.getState().recordPendingSteer("s1", "STEER_ONE", undefined, { text: "STEER_ONE", images: [] });
    store.getState().markUiSteer("s1");
    return store;
  }

  it("loop_end first, then the host-queued announcement: nothing is queued in the renderer", () => {
    const store = childStore();
    store.getState().applyHostMessage(loopEnd("t1"));
    expect(store.getState().promptQueue).toHaveLength(0);
    store.getState().applyHostMessage(requeued());
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().uiSteerPending).toEqual([]);
    expect(store.getState().pendingSteers.map((entry) => entry.requestId)).toEqual(["s1"]);
    store.getState().applyHostMessage(started("s1", "t2"));
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    expect(store.getState().pendingSteers).toHaveLength(0);
  });

  it("host-queued announcement first, then loop_end: same single pending row", () => {
    const store = childStore();
    store.getState().applyHostMessage(requeued());
    store.getState().applyHostMessage(loopEnd("t1"));
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().pendingSteers.map((entry) => entry.requestId)).toEqual(["s1"]);
    store.getState().applyHostMessage(started("s1", "t2"));
    expect(userTexts(store, "STEER_ONE")).toBe(1);
  });

  it("a renderer that already re-queued the text hands the item back to the host", () => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage(started("initial", "t1"));
    store.getState().recordPendingSteer("s1", "STEER_ONE", undefined, { text: "STEER_ONE", images: [] });
    store.getState().markUiSteer("s1");
    store.getState().applyHostMessage(loopEnd("t1"));
    expect(store.getState().promptQueue.map((item) => item.id)).toEqual(["s1"]);
    store.getState().applyHostMessage(requeued());
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().pendingSteers.map((entry) => entry.requestId)).toEqual(["s1"]);
    store.getState().applyHostMessage(started("s1", "t2"));
    expect(userTexts(store, "STEER_ONE")).toBe(1);
  });

  it("a replayed announcement into a fresh store (no pending entry) restores the pending row once, never a queue item", () => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().setChildSurface();
    store.getState().applyHostMessage(requeued());
    store.getState().applyHostMessage(requeued());
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().pendingSteers.map((entry) => entry.requestId)).toEqual(["s1"]);
    store.getState().applyHostMessage(started("s1", "t2"));
    store.getState().applyHostMessage(started("s1", "t2"));
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    expect(store.getState().pendingSteers).toHaveLength(0);
  });

  it("an existing block with the same id is reconciled, not duplicated, when the turn starts", () => {
    const store = childStore();
    store.getState().applyHostMessage(requeued());
    store.getState().appendUserText("s1", "STEER_ONE");
    store.getState().applyHostMessage(started("s1", "t2"));
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    expect(store.getState().pendingSteers).toHaveLength(0);
  });

  it("history hydration that already holds the steer frame, then the replayed announcement and start: one bubble", () => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().setChildSurface();
    store.getState().applyHostMessage({
      type: "session_history", sessionId: "child", truncated: false,
      items: [{ id: "h1", createdAt: 1, turnId: "t2", step: 0, message: { role: "user", content: "STEER_ONE" } }],
    } as HostToUiMessage);
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    store.getState().applyHostMessage(requeued());
    store.getState().applyHostMessage(started("s1", "t2"));
    store.getState().applyHostMessage(requeued());
    store.getState().applyHostMessage(started("s1", "t2"));
    expect(userTexts(store, "STEER_ONE")).toBe(1);
    expect(store.getState().promptQueue).toHaveLength(0);
    expect(store.getState().pendingSteers).toHaveLength(0);
  });

  it("two intentionally identical prompts with different ids both render", () => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().appendUserText("a", "same words");
    store.getState().appendUserText("a", "same words");
    store.getState().appendUserText("b", "same words");
    expect(userTexts(store, "same words")).toBe(2);
  });

  it("a refused child steer without a host queue is held for Restore, never parked silently", () => {
    const store = childStore();
    store.getState().applyHostMessage({ type: "steer_requeued", requestId: "s1", reason: "No active core turn", text: "STEER_ONE" });
    const state = store.getState();
    expect(state.promptQueue).toEqual([expect.objectContaining({ id: "s1", text: "STEER_ONE", requiresRestore: true })]);
    expect(state.queuePaused).toBe(true);
    expect(state.pendingSteers).toHaveLength(0);
  });

  it("the refused-steer notice says held on a child surface and queued on the root, for both recovery paths", () => {
    const refusal = { type: "steer_requeued", requestId: "s1", reason: "No active core turn", text: "STEER_ONE" } as HostToUiMessage;
    // Reload recovery (no pending entry).
    const child = childStore();
    child.getState().applyHostMessage(refusal);
    expect(child.getState().notice?.text).toBe("Steer not delivered — held; restore the draft to send it again.");
    // Live pending entry.
    const live = childStore();
    live.getState().recordPendingSteer("s1", "STEER_ONE", undefined, { text: "STEER_ONE", images: [] });
    live.getState().markUiSteer("s1");
    live.getState().applyHostMessage(refusal);
    expect(live.getState().notice?.text).toContain("held");
    expect(live.getState().notice?.text).not.toContain("queued for the next turn");
    const root = createDesktopStore({ schedule: (fn) => fn() });
    root.getState().applyHostMessage(refusal);
    expect(root.getState().notice?.text).toBe("Steer not delivered into the running turn — queued for the next turn.");
  });

  it("a root steer keeps the renderer-owned requeue at loop_end", () => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage(started("initial", "t1"));
    store.getState().recordPendingSteer("s1", "STEER_ONE", undefined, { text: "STEER_ONE", images: [] });
    store.getState().markUiSteer("s1");
    store.getState().applyHostMessage(loopEnd("t1"));
    expect(store.getState().promptQueue.map((item) => item.id)).toEqual(["s1"]);
    expect(store.getState().promptQueue[0]?.requiresRestore).toBeUndefined();
  });
});

describe("parent message to a running child (envelope display card)", () => {
  const card: AgentDisplayCard = {
    direction: "incoming",
    state: "acknowledged",
    envelope: {
      messageId: "m1", sender: "parent", recipientSessionId: "child", payload: "please tighten the summary",
      kind: "agent_message", mode: "steer", createdAt: "2026-01-01", correlationId: "c1",
      principal: { kind: "session", sessionId: "parent", tabId: "tp" },
    },
  };
  const wrapper = agentMessageText(card.envelope);
  const injected = (turnId: string): HostToUiMessage => ({ type: "agent_event", turnId, step: 2, event: { type: "user_injected", text: wrapper } } as HostToUiMessage);
  const cardBlocks = (store: Store) => store.getState().transcript.filter((block) => block.kind === "user_text" && block.id === "agent-message:m1");
  const rawWrappers = (store: Store) => store.getState().transcript.filter((block) => block.kind === "user_text" && block.id !== "agent-message:m1" && block.text === wrapper);

  it.each([true, false])("shows one card and no raw wrapper whichever of the card and the injected frame arrives first (card first: %s)", (cardFirst) => {
    const store = createDesktopStore({ schedule: (fn) => fn() });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "r", turnId: "t1" });
    const display = () => store.getState().applyHostMessage({ type: "agent_message_display", cards: [card] });
    if (cardFirst) display();
    store.getState().applyHostMessage(injected("t1"));
    store.getState().applyHostMessage(injected("t1"));
    if (cardFirst) expect(rawWrappers(store)).toHaveLength(0);
    display();
    expect(cardBlocks(store)).toHaveLength(1);
    expect(rawWrappers(store)).toHaveLength(0);
  });
});

/**
 * Taskana 4068 / TASK.98 (review 23.08 narrowing) — Session-level wire tests
 * for the in-session engine swap: the host-side Session can replace its
 * SessionEngine BETWEEN turns via `engine_switch_request`, old engine disposed
 * only after the replacement is live, canonical transcript continuous, the
 * boundary announced with an engine_notice on the ENGINE_SWITCH_TURN_ID
 * sentinel, and the new engine's FIRST turn receives the rendered import
 * prompt (one-shot) while later turns get the raw user text.
 *
 * createHarness drives the REAL Session over a real worker_threads
 * MessageChannel; the two fake engines below implement the SessionEngine
 * contract minimally (turn_start + loop_end, seeded history, dispose
 * recording). No live CLIs anywhere.
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent, HistoryItem, PermissionMode } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "./engines/session-engine.js";
import { ENGINE_SWITCH_TURN_ID } from "./engine-switch.js";
import { createHarness } from "./test-harness.js";

const NO_CORE_CAPS: EngineCapabilities = {
  supportsCorePermissions: false,
  supportsRewind: false,
  supportsWorkflow: false,
  supportsGitMutations: false,
  supportsContextUsage: false,
  supportsContextBreakdown: false,
  supportsInteractiveApprovals: false,
  costAccounting: false,
  supportsModelSelection: false,
  supportsReasoningEffort: false,
  supportsImages: false,
  supportsTasks: false,
  supportsFileSnapshots: false,
  supportsManualCompact: false,
};

/** Plain wire helpers (same shape session.test.ts uses). */
type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;

const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isSessionHistory = (m: HostToUiMessage): m is Of<"session_history"> => m.type === "session_history";
const isEngineSwitched = (m: HostToUiMessage): m is Of<"engine_switched"> => m.type === "engine_switched";
const isEngineSwitchFailed = (m: HostToUiMessage): m is Of<"engine_switch_failed"> =>
  m.type === "engine_switch_failed";
const isTurnRejected = (m: HostToUiMessage): m is Of<"turn_rejected"> => m.type === "turn_rejected";

const agentEventOf =
  (innerType: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === innerType;

const engineNoticeEvents = (received: readonly HostToUiMessage[]): Of<"agent_event">[] =>
  received.filter(
    (m): m is Of<"agent_event"> => m.type === "agent_event" && m.turnId === ENGINE_SWITCH_TURN_ID,
  );

/**
 * The engine being switched AWAY from: id "core", two seeded history items,
 * runTurn yields turn_start + loop_end{completed}, dispose records its reason.
 * `parkTurn` holds the stream open so a test can pin the busy gate.
 */
class SwitchableFakeEngine implements SessionEngine {
  readonly id = "core" as const;
  readonly capabilities = NO_CORE_CAPS;
  /** Every runTurn input, in order (asserts the import-prompt one-shot). */
  readonly inputs: string[] = [];
  disposeReasons: string[] = [];
  private release: (() => void) | null = null;
  private readonly items: HistoryItem[];

  constructor(items: HistoryItem[]) {
    this.items = items;
  }

  mode(): PermissionMode {
    return "build";
  }

  reasoningEffort(): undefined {
    return undefined;
  }

  setReasoningEffort(): void {}

  historyItems(): readonly HistoryItem[] {
    return this.items;
  }

  /** Holds each runTurn's stream open until releaseTurn() (busy-gate fixture). */
  parked = false;

  releaseTurn(): void {
    this.release?.();
    this.release = null;
  }

  async *runTurn(input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    yield { type: "turn_start", turn: 1 };
    if (this.parked) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    yield { type: "loop_end", reason: "completed", turns: 1 };
  }

  dispose(reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposeReasons.push(reason);
    return Promise.resolve();
  }
}

/** The engine being switched TO: id "codex", records runTurn inputs. */
class NextFakeEngine implements SessionEngine {
  readonly id = "codex" as const;
  readonly capabilities = NO_CORE_CAPS;
  readonly inputs: string[] = [];
  disposeReasons: string[] = [];

  mode(): PermissionMode {
    return "build";
  }

  reasoningEffort(): undefined {
    return undefined;
  }

  setReasoningEffort(): void {}

  historyItems(): readonly HistoryItem[] {
    return [];
  }

  async *runTurn(input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    yield { type: "turn_start", turn: 1 };
    yield { type: "loop_end", reason: "completed", turns: 1 };
  }

  dispose(reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposeReasons.push(reason);
    return Promise.resolve();
  }
}

const SEEDED: HistoryItem[] = [
  { id: "seed-1", createdAt: 1, message: { role: "user", content: "first seeded turn" }, kind: "normal" },
  { id: "seed-2", createdAt: 2, message: { role: "assistant", content: [{ type: "text", text: "seeded answer" }] }, kind: "normal" },
];

function seededHistory(): HistoryItem[] {
  return SEEDED.map((item) => ({ ...item, message: { ...item.message } }));
}

describe("Session — engine switch (Taskana 4068)", () => {
  it("success: swaps the engine, disposes the old one after, announces once, keeps the transcript continuous", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw1", engine: "codex" });
      const switched = await h.waitFor(isEngineSwitched);
      expect(switched).toMatchObject({ requestId: "sw1", engine: "codex", previousEngine: "core" });

      // Live engine pointer moved; old engine disposed exactly once, after the swap.
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("codex");
      expect(next.disposeReasons).toEqual([]);
      expect(oldEngine.disposeReasons).toEqual(["session-close"]);

      // Exactly ONE switch announcement, on the sentinel turn id, as an info engine_notice.
      const notices = engineNoticeEvents(h.received).filter((m) => m.event.type === "engine_notice");
      expect(notices).toHaveLength(1);
      const notice = notices[0];
      if (notice !== undefined && notice.event.type === "engine_notice") {
        expect(notice.event.level).toBe("info");
        expect(notice.event.message).toContain('from the "core" engine to the "codex" engine');
        expect(notice.event.message).toContain("imported summary");
      }

      // Transcript continuity: a fresh ui_ready's session_history still carries
      // the 2 seeded canonical items (rebuilt from the SAME items at swap time).
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some(isSessionHistory));
      const handshake = h.received.slice(before).find(isSessionHistory);
      expect(handshake?.items.map((i) => i.id)).toEqual(["seed-1", "seed-2"]);
    } finally {
      h.close();
    }
  });

  it("busy: refuses while a turn runs, engine unchanged, old engine not disposed", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    oldEngine.parked = true;
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Start a turn; the parked stream holds busy=true.
      h.send({ type: "user_message", requestId: "r1", text: "hold this turn open" });
      await h.waitUntil(() => oldEngine.inputs.length === 1);

      h.send({ type: "engine_switch_request", requestId: "sw2", engine: "codex" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed).toMatchObject({ requestId: "sw2", reason: "a turn is running" });

      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
      expect(h.received.some(isEngineSwitched)).toBe(false);

      // Release the parked turn so the harness drains cleanly.
      oldEngine.releaseTurn();
      await h.waitFor(agentEventOf("loop_end"));
    } finally {
      oldEngine.releaseTurn();
      h.close();
    }
  });

  it("same engine: refuses with 'already running' and touches nothing", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw3", engine: "core" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed.reason).toBe('already running the "core" engine');
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("factory throws: fails with the factory's error, old engine stays live and runs the next turn", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => {
        throw new Error("codex not signed in");
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw4", engine: "codex" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed).toMatchObject({ requestId: "sw4", reason: "codex not signed in" });

      // Old engine STILL active: not disposed, and the next turn still runs on it.
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
      h.send({ type: "user_message", requestId: "r2", text: "still on the old engine" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(oldEngine.inputs).toEqual(["still on the old engine"]);
      expect(h.received.some(isTurnRejected)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("factory absent: the message is refused with the explicit unavailability reason", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw5", engine: "codex" });
      const failed = await h.waitFor(isEngineSwitchFailed);
      expect(failed.reason).toBe("engine switch is not available in this host");
      expect(oldEngine.disposeReasons).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("import prompt: the new engine's FIRST runTurn receives the rendered header, the second gets the raw text", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "engine_switch_request", requestId: "sw6", engine: "codex" });
      await h.waitFor(isEngineSwitched);

      h.send({ type: "user_message", requestId: "r1", text: "my typed message" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(next.inputs).toHaveLength(1);
      const firstInput = next.inputs[0] ?? "";
      expect(firstInput.startsWith("Session continued in this codex engine")).toBe(true);
      expect(firstInput).toContain("# user first seeded turn");
      expect(firstInput).toContain("# assistant seeded answer");
      // The import is PREPENDED: the user's own message still reaches the engine.
      expect(firstInput.endsWith("# user (current message)\nmy typed message")).toBe(true);

      // Second turn: raw user text, no header — the import was strictly one-shot.
      h.send({ type: "user_message", requestId: "r2", text: "plain follow-up" });
      await h.waitUntil(() => next.inputs.length === 2 && h.received.filter(agentEventOf("loop_end")).length >= 2);
      const secondInput = next.inputs[1] ?? "";
      expect(secondInput).toBe("plain follow-up");
      expect(secondInput.startsWith("Session continued")).toBe(false);
    } finally {
      h.close();
    }
  });

  it("schema: engine_switch_request without requestId is dropped by zod before route()", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: async () => next,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const before = h.received.length;
      // Malformed on purpose: missing requestId -> zod fail-closed drop, no reply.
      h.send({ type: "engine_switch_request", engine: "codex" } as unknown as UiToHostMessage);
      h.send({ type: "engine_switch_request", requestId: "", engine: "codex" } as unknown as UiToHostMessage);
      h.send({ type: "engine_switch_request", requestId: "r", engine: "gpt" } as unknown as UiToHostMessage);

      // Inversion of the usual waitUntil: nothing may arrive within a short window.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const arrivals = h.received.slice(before).filter((m) => isEngineSwitched(m) || isEngineSwitchFailed(m));
      expect(arrivals).toEqual([]);
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
      expect(oldEngine.disposeReasons).toEqual([]);
    } finally {
      h.close();
    }
  });
  it("shutdown racing the factory: the switched-to engine is disposed, never orphaned", async () => {
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    const next = new NextFakeEngine();
    let resolveFactory!: (engine: SessionEngine) => void;
    let factoryCalled = false;
    const h = createHarness({
      steps: [],
      engine: oldEngine as SessionEngine,
      switchEngineFactory: () => {
        factoryCalled = true;
        return new Promise<SessionEngine>((resolve) => (resolveFactory = resolve));
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw7", engine: "codex" });
      for (let i = 0; i < 100 && !factoryCalled; i++) await new Promise((r) => setTimeout(r, 5));
      expect(factoryCalled).toBe(true);
      const shutdown = h.session.shutdown();
      resolveFactory(next);
      await shutdown;
      expect(next.disposeReasons).toEqual(["host-shutdown"]);
      expect((h.session as unknown as { engine: SessionEngine }).engine.id).toBe("core");
    } finally {
      h.close();
    }
  });

  it("permission mode survives a swap between core-permission engines", async () => {
    const corePerms = { ...NO_CORE_CAPS, supportsCorePermissions: true };
    class ModalEngine extends NextFakeEngine {
      override readonly capabilities = corePerms;
      current: PermissionMode = "build";
      override mode(): PermissionMode {
        return this.current;
      }
      setMode(mode: PermissionMode): void {
        this.current = mode;
      }
    }
    const oldEngine = new SwitchableFakeEngine(seededHistory());
    Object.defineProperty(oldEngine, "capabilities", { value: corePerms });
    oldEngine.mode = () => "plan";
    const next = new ModalEngine();
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw8", engine: "codex" });
      await h.waitFor(isEngineSwitched);
      expect(next.current).toBe("plan");
    } finally {
      h.close();
    }
  });

  it("prefers the old engine's live transcript over its boot snapshot", async () => {
    const oldEngine = new SwitchableFakeEngine([]);
    (oldEngine as unknown as { readTranscript: () => Promise<readonly HistoryItem[]> }).readTranscript = async () => seededHistory();
    const next = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw9", engine: "codex" });
      await h.waitFor(isEngineSwitched);
      h.send({ type: "user_message", requestId: "r1", text: "go" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(next.inputs[0]).toContain("# user first seeded turn");
    } finally {
      h.close();
    }
  });

  it("empty import is announced honestly", async () => {
    const oldEngine = new SwitchableFakeEngine([]);
    const next = new NextFakeEngine();
    const h = createHarness({ steps: [], engine: oldEngine as SessionEngine, switchEngineFactory: async () => next });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "engine_switch_request", requestId: "sw10", engine: "codex" });
      await h.waitFor(isEngineSwitched);
      const notice = engineNoticeEvents(h.received)[0];
      expect(notice?.event.type === "engine_notice" ? notice.event.message : "").toContain("no conversation history could be imported");
    } finally {
      h.close();
    }
  });
});

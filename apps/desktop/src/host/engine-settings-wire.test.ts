/**
 * TASK.39 — the Session wire for an engine with NATIVE model/permission controls.
 *
 * Session is built directly here (not through createHarness): the harness is
 * hard-wired to a core AgentLoop engine, and what is under test is precisely the
 * seam a non-core engine plugs into. The fake engine below is deliberately dumb —
 * every validation rule it enforces is asserted against the REAL CodexEngine in
 * engines/codex/codex-engine.test.ts; here we assert the wire: which message is
 * accepted, what is emitted, what is persisted, and what is refused.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import type { AgentEvent, PermissionMode } from "@anycode/core";
import { SessionPermissionRules } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session, type EngineSettingsChange, type EngineSettingsSeam, type SessionPersistence } from "./session.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "./engines/session-engine.js";
import { MemFs, nodeWirePort } from "./test-harness.js";

const CODEX_CAPABILITIES: EngineCapabilities = {
  supportsCorePermissions: false,
  supportsRewind: false,
  supportsWorkflow: false,
  supportsGitMutations: false,
  supportsContextUsage: false,
  supportsContextBreakdown: false,
  supportsInteractiveApprovals: true,
  costAccounting: false,
  supportsModelSelection: true,
  supportsReasoningEffort: false,
  supportsImages: false,
  supportsTasks: false,
  supportsFileSnapshots: false,
};

/** The engine seam, with the SAME contract CodexEngine implements: validate host-side, send nothing, ack on apply. */
class FakeEngine implements SessionEngine, EngineSettingsSeam {
  readonly id = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;
  readonly catalog = ["gpt-5.6-sol", "gpt-5.4-mini"];
  readonly presetTable = ["read-only", "ask", "workspace"];
  model = "gpt-5.6-sol";
  presetId = "ask";
  turns = 0;
  private pending: { model: string; activePresetId: string } | null = null;
  private readonly listeners = new Set<(snapshot: { model: string; activePresetId: string }) => void>();
  /** Resolves the in-flight turn (a turn is held open so the busy gate can be exercised). */
  private release: (() => void) | null = null;

  mode(): PermissionMode {
    return "build";
  }

  reasoningEffort(): undefined {
    return undefined;
  }

  setReasoningEffort(): void {}

  historyItems(): [] {
    return [];
  }

  models(): { id: string; label?: string }[] {
    return this.catalog.map((id) => ({ id, label: id }));
  }

  presets(): { id: string; label: string; description: string }[] {
    return this.presetTable.map((id) => ({ id, label: id, description: `${id} posture` }));
  }

  /**
   * APPLIED, not chosen — the same split CodexEngine implements (cut §2(k).3):
   * `model`/`presetId` are the CHOSEN values (what the next turn/start carries),
   * and these are what a turn/start has actually carried. They diverge exactly
   * while a change is pending.
   */
  private applied = { model: this.model, activePresetId: this.presetId };

  snapshot(): { model: string; activePresetId: string } {
    return { ...this.applied };
  }

  private chosen(): { model: string; activePresetId: string } {
    return { model: this.model, activePresetId: this.presetId };
  }

  pendingSnapshot(): { model: string; activePresetId: string } | null {
    return this.pending === null ? null : { ...this.pending };
  }

  private markPending(): EngineSettingsChange {
    const chosen = this.chosen();
    this.pending =
      chosen.model === this.applied.model && chosen.activePresetId === this.applied.activePresetId ? null : chosen;
    return { ok: true, ...chosen };
  }

  selectModel(id: string): EngineSettingsChange {
    if (!this.catalog.includes(id)) return { ok: false, reason: `Codex model "${id}" is not available for this account.` };
    this.model = id;
    return this.markPending();
  }

  selectPreset(id: string): EngineSettingsChange {
    if (!this.presetTable.includes(id)) return { ok: false, reason: `Unknown Codex permission preset "${id}".` };
    this.presetId = id;
    return this.markPending();
  }

  onSettingsApplied(listener: (snapshot: { model: string; activePresetId: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async *runTurn(_input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
    this.turns += 1;
    yield { type: "turn_start", turn: this.turns };
    // The engine's turn/start goes out HERE — and with it, the pending settings.
    if (this.pending !== null) {
      const applied = this.pending;
      this.pending = null;
      this.applied = applied;
      for (const listener of this.listeners) listener(applied);
    }
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield { type: "turn_end", turn: this.turns, finishReason: "stop" };
    yield { type: "loop_end", reason: "completed", turns: this.turns };
  }

  finishTurn(): void {
    this.release?.();
    this.release = null;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

interface Fixture {
  engine: FakeEngine;
  received: HostToUiMessage[];
  touches: Parameters<SessionPersistence["touch"]>[0][];
  send(message: UiToHostMessage): void;
  settle(): Promise<void>;
  close(): void;
}

const open: Fixture[] = [];

function fixture(): Fixture {
  const channel = new MessageChannel();
  const received: HostToUiMessage[] = [];
  channel.port1.on("message", (value: unknown) => received.push(value as HostToUiMessage));
  channel.port1.start();

  const outbound = new Outbound();
  const engine = new FakeEngine();
  const touches: Parameters<SessionPersistence["touch"]>[0][] = [];
  const session = new Session({
    outbound,
    engine,
    engineSettings: engine,
    broker: new IpcPermissionBroker((message) => outbound.emit(message)),
    fs: new MemFs(),
    workspace: "/work",
    model: engine.model,
    sessionId: "codex-session",
    rules: new SessionPermissionRules(),
    persistence: { touch: (patch) => touches.push(patch) },
  });
  session.bindPort(nodeWirePort(channel.port2 as NodeMessagePort));

  const value: Fixture = {
    engine,
    received,
    touches,
    send: (message) => channel.port1.postMessage(message),
    // A ui->host->ui round trip is two MessageChannel hops (each its own
    // macrotask), and a turn adds more; drain several rather than exactly one.
    settle: async () => {
      for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
  open.push(value);
  return value;
}

function settings(received: HostToUiMessage[]): Extract<HostToUiMessage, { type: "engine_settings_changed" }>[] {
  return received.filter((message): message is Extract<HostToUiMessage, { type: "engine_settings_changed" }> =>
    message.type === "engine_settings_changed",
  );
}

afterEach(() => {
  for (const value of open.splice(0)) value.close();
});

describe("TASK.39 — host_ready presentation", () => {
  it("carries the native model catalog and preset table (no AnyCode provider catalog involved)", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    await ui.settle();

    const ready = ui.received.find((message) => message.type === "host_ready")!;
    expect(ready).toMatchObject({
      engine: {
        id: "codex",
        capabilities: { supportsModelSelection: true, supportsCorePermissions: false },
        model: { current: "gpt-5.6-sol", available: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.4-mini" }] },
        permissions: { activePresetId: "ask", presets: [{ id: "read-only" }, { id: "ask" }, { id: "workspace" }] },
      },
    });
  });

  /**
   * REPLACES a test that asserted the opposite (a reload showed the pending,
   * never-applied posture as CURRENT). That was the W3-review defect, not the
   * contract: `state:"pending"`/`state:"applied"` is a two-phase ack (cut
   * §2(k).3), so until a turn/start carries the change, the ACTIVE posture is
   * still the old one — enforcement (every turn/start re-asserts the chosen
   * preset) is unaffected and untouched.
   */
  it("re-handshakes with the APPLIED settings after a pending change, and re-asserts the pending delta (a renderer reload sees the old posture, still pending)", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    ui.send({ type: "set_engine_preset", presetId: "read-only" });
    ui.send({ type: "set_model", model: "gpt-5.4-mini" });
    ui.send({ type: "ui_ready" });
    await ui.settle();

    const readies = ui.received.filter((message) => message.type === "host_ready");
    expect(readies.at(-1)).toMatchObject({
      model: "gpt-5.6-sol",
      engine: { model: { current: "gpt-5.6-sol" }, permissions: { activePresetId: "ask" } },
    });
    // ...and the un-applied delta is re-asserted after the handshake, so the
    // renderer can restore the pending badge it just reset.
    expect(settings(ui.received).at(-1)).toEqual({
      type: "engine_settings_changed",
      model: "gpt-5.4-mini",
      activePresetId: "read-only",
      state: "pending",
      appliesFrom: "next_turn",
    });
  });

  it("re-handshakes with the new settings once a turn has actually applied them", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    ui.send({ type: "set_engine_preset", presetId: "read-only" });
    ui.send({ type: "user_message", requestId: "r1", text: "go" });
    await ui.settle();
    ui.engine.finishTurn();
    await ui.settle();

    ui.send({ type: "ui_ready" });
    await ui.settle();

    const readies = ui.received.filter((message) => message.type === "host_ready");
    expect(readies.at(-1)).toMatchObject({ engine: { permissions: { activePresetId: "read-only" } } });
    // Nothing is pending any more, so no pending re-assert rides this ui_ready.
    expect(settings(ui.received).at(-1)).toMatchObject({ state: "applied", activePresetId: "read-only" });
  });

  it("emits no pending re-assert on ui_ready when nothing is pending", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    ui.send({ type: "ui_ready" });
    await ui.settle();

    expect(settings(ui.received)).toEqual([]);
  });
});

describe("TASK.39 — set_engine_preset / set_model routing", () => {
  it("acks an accepted preset as pending, persists it, and applies it on the next turn", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    ui.send({ type: "set_engine_preset", presetId: "workspace" });
    await ui.settle();

    expect(settings(ui.received)).toEqual([
      {
        type: "engine_settings_changed",
        model: "gpt-5.6-sol",
        activePresetId: "workspace",
        state: "pending",
        appliesFrom: "next_turn",
      },
    ]);
    // Persisted at ACCEPT time (cut §2(k).4): quitting before the next turn still
    // resumes under the chosen posture. The preset rides the `mode` column.
    expect(ui.touches).toEqual([{ enginePreset: "workspace" }]);

    ui.send({ type: "user_message", requestId: "r1", text: "go" });
    await ui.settle();
    ui.engine.finishTurn();
    await ui.settle();

    expect(settings(ui.received).at(-1)).toMatchObject({ state: "applied", activePresetId: "workspace" });
  });

  it("reuses set_model for a native model switch and never touches the core switchModel path", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    ui.send({ type: "set_model", model: "gpt-5.4-mini" });
    await ui.settle();

    expect(settings(ui.received)).toEqual([
      {
        type: "engine_settings_changed",
        model: "gpt-5.4-mini",
        activePresetId: "ask",
        state: "pending",
        appliesFrom: "next_turn",
      },
    ]);
    // `model_changed` is the CORE ack (it carries a core reasoning-effort payload);
    // a native engine answers on the engine-settings channel instead.
    expect(ui.received.some((message) => message.type === "model_changed")).toBe(false);
    expect(ui.touches).toEqual([{ model: "gpt-5.4-mini" }]);
  });

  it("refuses an unknown model/preset with a recoverable notice and changes nothing", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    ui.send({ type: "set_model", model: "gpt-imaginary" });
    ui.send({ type: "set_engine_preset", presetId: "danger-full-access" });
    await ui.settle();

    expect(ui.received.filter((message) => message.type === "mode_change_rejected")).toEqual([
      { type: "mode_change_rejected", reason: 'Codex model "gpt-imaginary" is not available for this account.' },
      { type: "mode_change_rejected", reason: 'Unknown Codex permission preset "danger-full-access".' },
    ]);
    expect(settings(ui.received)).toEqual([]);
    expect(ui.touches).toEqual([]);
    expect(ui.engine.snapshot()).toEqual({ model: "gpt-5.6-sol", activePresetId: "ask" });
  });

  it("cannot be sent a raw sandbox / policy / config payload — zod drops it before route()", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    // Exactly the shapes TASK.39 DoD-4 forbids.
    ui.send({ type: "set_engine_preset", presetId: "ask", sandbox: "danger-full-access" } as unknown as UiToHostMessage);
    ui.send({ type: "set_engine_preset", config: { approvalPolicy: "never" } } as unknown as UiToHostMessage);
    ui.send({ type: "set_engine_preset", presetId: { type: "workspaceWrite" } } as unknown as UiToHostMessage);
    await ui.settle();

    expect(settings(ui.received)).toEqual([]);
    expect(ui.engine.snapshot()).toEqual({ model: "gpt-5.6-sol", activePresetId: "ask" });
  });

  it("refuses a preset change during a turn (between-turns discipline)", async () => {
    const ui = fixture();
    ui.send({ type: "ui_ready" });
    ui.send({ type: "user_message", requestId: "r1", text: "go" });
    await ui.settle();

    ui.send({ type: "set_engine_preset", presetId: "read-only" });
    ui.send({ type: "set_model", model: "gpt-5.4-mini" });
    await ui.settle();

    expect(ui.received.filter((message) => message.type === "mode_change_rejected")).toEqual([
      { type: "mode_change_rejected", reason: "cannot change permissions during an active turn" },
    ]);
    // set_model is silently dropped while busy (its pre-existing discipline).
    expect(settings(ui.received)).toEqual([]);
    expect(ui.engine.snapshot()).toEqual({ model: "gpt-5.6-sol", activePresetId: "ask" });

    ui.engine.finishTurn();
    await ui.settle();
  });
});

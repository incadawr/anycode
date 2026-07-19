/**
 * SLICE-CC §1.5 — WHEN a settings choice is persisted, for an engine that
 * applies changes over its own acknowledged control request (Claude) rather
 * than on the next `turn/start` (codex).
 *
 * The bug this pins: persisting at ACCEPT time is safe for codex, because
 * nothing was sent and the engine re-asserts the choice on every turn/start. It
 * is not safe for Claude. `set_permission_mode` is a real control request that
 * the CLI can REJECT or that can time out — and when it does, the CLI stays on
 * its previous posture while the row already says otherwise. Quitting there and
 * resuming later spawns under a preset the engine never adopted: pick
 * `workspace`, have the CLI refuse it, and the next resume silently runs
 * `acceptEdits` on a session the user left at `ask`. That is a permission
 * WIDENING, produced entirely by a write that happened too early.
 *
 * So: no write until the ack. The failure path then needs no compensating
 * write at all — the prior row is retained by construction.
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

const CLAUDE_CAPABILITIES: EngineCapabilities = {
  supportsCorePermissions: false,
  supportsRewind: false,
  supportsWorkflow: false,
  supportsGitMutations: false,
  supportsContextUsage: true,
  supportsContextBreakdown: false,
  supportsInteractiveApprovals: true,
  costAccounting: true,
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  supportsImages: false,
  supportsTasks: false,
  supportsFileSnapshots: false,
};

/**
 * The immediate-apply seam shape (ClaudeSettingsSeam's contract, not its code):
 * `selectX` validates + fires an async control request; the ack decides whether
 * the choice ever becomes real. `settleAck` stands in for the CLI answering.
 */
class ImmediateApplySeam implements SessionEngine, EngineSettingsSeam {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly persistsOnApply = true;
  private applied = { model: "haiku", activePresetId: "ask" };
  private inFlight: { model: string; activePresetId: string } | null = null;
  private readonly listeners = new Set<(snapshot: { model: string; activePresetId: string }) => void>();

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
    return [{ id: "haiku" }, { id: "opus[1m]" }];
  }

  presets(): { id: string; label: string; description: string }[] {
    return ["read-only", "ask", "workspace"].map((id) => ({ id, label: id, description: `${id} posture` }));
  }

  snapshot(): { model: string; activePresetId: string } {
    return { ...this.applied };
  }

  pendingSnapshot(): { model: string; activePresetId: string } | null {
    return this.inFlight === null ? null : { ...this.inFlight };
  }

  selectModel(id: string): EngineSettingsChange {
    this.inFlight = { model: id, activePresetId: this.applied.activePresetId };
    return { ok: true, ...this.inFlight };
  }

  selectPreset(id: string): EngineSettingsChange {
    this.inFlight = { model: this.applied.model, activePresetId: id };
    return { ok: true, ...this.inFlight };
  }

  onSettingsApplied(listener: (snapshot: { model: string; activePresetId: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The CLI's control_response landing — success applies + notifies, failure is a clean no-op. */
  settleAck(ok: boolean): void {
    const next = this.inFlight;
    this.inFlight = null;
    if (next === null || !ok) return;
    this.applied = next;
    for (const listener of this.listeners) listener(next);
  }

  async *runTurn(_input: string, _options: RunTurnOptions): AsyncIterable<AgentEvent> {
    yield { type: "turn_start", turn: 1 };
    yield { type: "turn_end", turn: 1, finishReason: "stop" };
    yield { type: "loop_end", reason: "completed", turns: 1 };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

interface Fixture {
  engine: ImmediateApplySeam;
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
  const engine = new ImmediateApplySeam();
  const touches: Parameters<SessionPersistence["touch"]>[0][] = [];
  const session = new Session({
    outbound,
    engine,
    engineSettings: engine,
    broker: new IpcPermissionBroker((message) => outbound.emit(message)),
    fs: new MemFs(),
    workspace: "/work",
    model: "haiku",
    sessionId: "claude-session",
    rules: new SessionPermissionRules(),
    persistence: { touch: (patch) => touches.push(patch) },
  });
  session.bindPort(nodeWirePort(channel.port2 as NodeMessagePort));

  const value: Fixture = {
    engine,
    received,
    touches,
    send: (message) => channel.port1.postMessage(message),
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

afterEach(() => {
  for (const value of open.splice(0)) value.close();
});

describe("SLICE-CC §1.5 — an immediate-apply engine persists ONLY from its ack", () => {
  it("writes NOTHING at accept time (an accept-time write outlives a rejected control request)", async () => {
    const ui = fixture();
    ui.send({ type: "set_engine_preset", presetId: "workspace" });
    await ui.settle();

    // The renderer is still told the change is in flight...
    expect(
      ui.received.some((message) => message.type === "engine_settings_changed" && message.state === "pending"),
    ).toBe(true);
    // ...but nothing is on disk yet. An implementation that persists here is
    // the defect: the CLI has not answered, so the row would describe a posture
    // that may never exist.
    expect(ui.touches).toEqual([]);
  });

  it("writes the choice once the ack lands", async () => {
    const ui = fixture();
    ui.send({ type: "set_engine_preset", presetId: "workspace" });
    await ui.settle();
    ui.engine.settleAck(true);
    await ui.settle();

    expect(ui.touches).toEqual([{ model: "haiku", enginePreset: "workspace" }]);
  });

  it("a REJECTED ack leaves the prior row standing — the widening scenario, end to end", async () => {
    const ui = fixture();
    // The session is at `ask`. The user picks `workspace`; the CLI refuses it.
    ui.send({ type: "set_engine_preset", presetId: "workspace" });
    await ui.settle();
    ui.engine.settleAck(false);
    await ui.settle();

    // Nothing was written, so a later resume reads the row it already had and
    // spawns `ask` — not the `acceptEdits` the user's rejected pick implied.
    expect(ui.touches).toEqual([]);
    expect(ui.engine.snapshot().activePresetId).toBe("ask");
  });

  it("a model change follows the same rule", async () => {
    const ui = fixture();
    ui.send({ type: "set_model", model: "opus[1m]" });
    await ui.settle();
    expect(ui.touches).toEqual([]);

    ui.engine.settleAck(true);
    await ui.settle();
    expect(ui.touches).toEqual([{ model: "opus[1m]", enginePreset: "ask" }]);
  });
});

/**
 * cut §1.5 D3 / hazard (д): Claude's `EngineSettingsSeam` glue applies
 * IMMEDIATELY on the control-ack, never on a `turn/start` — the opposite of
 * codex's seam (`selectModel` is synchronous and sends nothing; the engine
 * puts the choice on the NEXT `turn/start`). The discriminator this file
 * pins: after `selectModel`, `pendingSnapshot()` clears and `onSettingsApplied`
 * fires on the control-ack, with NO `runTurn` ever having been called on the
 * underlying engine. A codex-shaped (deferred) implementation would leave
 * `pendingSnapshot()` non-null forever (nothing here ever starts a turn) and
 * never call `onSettingsApplied` — that implementation must go RED against
 * these assertions.
 */

import { describe, expect, it, vi } from "vitest";
import { ClaudeEngine, type ClaudeTransport } from "./claude-engine.js";
import { ClaudeModelCatalog } from "./models.js";
import { findClaudePreset } from "./presets.js";
import { ClaudeSettingsSeam } from "./settings-seam.js";
import type { ClaudeStreamMessage } from "./protocol.js";

/** A transport whose `controlRequest` never resolves on its own — the test drives the ack explicitly, to observe the in-flight window. */
class ControlledTransport implements ClaudeTransport {
  private pendingControl: { subtype: string; resolve: (value: unknown) => void; reject: (error: unknown) => void } | null = null;

  async initialize(): Promise<{ commands: unknown[]; models: unknown[]; account: { tokenSource?: string; subscriptionType?: string } }> {
    return { commands: [], models: [], account: { tokenSource: "oauth" } };
  }

  controlRequest<T>(_subtype: string, _request?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pendingControl = { subtype: _subtype, resolve: resolve as (value: unknown) => void, reject };
    });
  }

  async getContextUsage(): Promise<Record<string, unknown>> {
    return {};
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    return { stillQueued: [] };
  }

  sendUserMessage(): void {}

  notifications(): AsyncIterable<ClaudeStreamMessage> {
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  }

  async close(): Promise<void> {}

  settleControl(response: unknown = undefined): void {
    this.pendingControl?.resolve(response);
    this.pendingControl = null;
  }

  rejectControl(message: string): void {
    this.pendingControl?.reject(new Error(message));
    this.pendingControl = null;
  }
}

function catalog(): ClaudeModelCatalog {
  return ClaudeModelCatalog.fromInitialize([
    { value: "model-a", resolvedModel: "model-a", displayName: "A" },
    { value: "model-b", resolvedModel: "model-b", displayName: "B" },
  ]);
}

function buildEngine(transport: ClaudeTransport): ClaudeEngine {
  return new ClaudeEngine(transport, "session-ref-1", undefined, {
    catalog: catalog(),
    model: "model-a",
    preset: findClaudePreset("ask")!,
    effortsByModel: new Map(),
    notices: [],
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ClaudeSettingsSeam (cut §1.5 D3, hazard (д))", () => {
  it("applies immediately on the control-ack, pendingSnapshot clearing, with NO turn/start ever run", async () => {
    const transport = new ControlledTransport();
    const engine = buildEngine(transport);
    const seam = new ClaudeSettingsSeam(engine);
    const applied = vi.fn();
    seam.onSettingsApplied(applied);

    const result = seam.selectModel("model-b");
    expect(result).toEqual({ ok: true, model: "model-b", activePresetId: "ask" });
    expect(seam.pendingSnapshot()).toEqual({ model: "model-b", activePresetId: "ask" });
    expect(applied).not.toHaveBeenCalled();

    transport.settleControl();
    await flushMicrotasks();

    expect(seam.pendingSnapshot()).toBeNull();
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith({ model: "model-b", activePresetId: "ask" });
    expect(seam.snapshot().model).toBe("model-b");
  });

  it("rejects synchronously for a model absent from the catalog — no control request sent", () => {
    const transport = new ControlledTransport();
    const spy = vi.spyOn(transport, "controlRequest");
    const engine = buildEngine(transport);
    const seam = new ClaudeSettingsSeam(engine);

    const result = seam.selectModel("does-not-exist");
    expect(result.ok).toBe(false);
    expect(seam.pendingSnapshot()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("an ack-fail rolls back to a no-op: pending clears, onSettingsApplied never fires, the engine's own model is unchanged", async () => {
    const transport = new ControlledTransport();
    const engine = buildEngine(transport);
    const seam = new ClaudeSettingsSeam(engine);
    const applied = vi.fn();
    seam.onSettingsApplied(applied);

    seam.selectModel("model-b");
    transport.rejectControl("claude refused");
    await flushMicrotasks();

    expect(seam.pendingSnapshot()).toBeNull();
    expect(applied).not.toHaveBeenCalled();
    expect(seam.snapshot().model).toBe("model-a");
  });

  it("selectPreset follows the same immediate-apply semantics", async () => {
    const transport = new ControlledTransport();
    const engine = buildEngine(transport);
    const seam = new ClaudeSettingsSeam(engine);
    const applied = vi.fn();
    seam.onSettingsApplied(applied);

    const result = seam.selectPreset("workspace");
    expect(result.ok).toBe(true);
    expect(seam.pendingSnapshot()).toEqual({ model: "model-a", activePresetId: "workspace" });

    transport.settleControl();
    await flushMicrotasks();

    expect(seam.pendingSnapshot()).toBeNull();
    expect(applied).toHaveBeenCalledWith({ model: "model-a", activePresetId: "workspace" });
  });

  it("unsubscribing onSettingsApplied stops further notifications", async () => {
    const transport = new ControlledTransport();
    const engine = buildEngine(transport);
    const seam = new ClaudeSettingsSeam(engine);
    const applied = vi.fn();
    const unsubscribe = seam.onSettingsApplied(applied);
    unsubscribe();

    seam.selectModel("model-b");
    transport.settleControl();
    await flushMicrotasks();

    expect(applied).not.toHaveBeenCalled();
  });
});

/**
 * Concurrent changes. Each Claude control is a SEPARATE in-flight request, so
 * two quick picks (model B, then preset Workspace) are genuinely overlapping
 * and can acknowledge in either order.
 *
 * The bug this pins: publishing the snapshot CAPTURED at accept time. The
 * preset change assembles its `next` from the engine as it stands — which, if
 * the model ack has not landed yet, still says model A. Its own ack then
 * republishes `{model: A, preset: Workspace}`, undoing the model change in the
 * UI (and, since Session persists from this signal, on disk too). Publishing
 * `engine.snapshot()` instead is monotonically true: it only ever reflects acks
 * that actually landed.
 */
describe("ClaudeSettingsSeam — concurrent changes (each ack publishes the engine's real state)", () => {
  /** Holds every in-flight control request so acks can be settled out of order. */
  class QueueingTransport implements ClaudeTransport {
    private readonly waiting: { subtype: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];

    async initialize(): Promise<{ commands: unknown[]; models: unknown[]; account: { tokenSource?: string } }> {
      return { commands: [], models: [], account: { tokenSource: "oauth" } };
    }

    controlRequest<T>(subtype: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        this.waiting.push({ subtype, resolve: resolve as (v: unknown) => void, reject });
      });
    }

    async getContextUsage(): Promise<Record<string, unknown>> {
      return {};
    }

    async interrupt(): Promise<{ stillQueued: string[] }> {
      return { stillQueued: [] };
    }

    sendUserMessage(): void {}

    notifications(): AsyncIterable<ClaudeStreamMessage> {
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    }

    async close(): Promise<void> {}

    pendingSubtypes(): string[] {
      return this.waiting.map((entry) => entry.subtype);
    }

    ack(subtype: string): void {
      const index = this.waiting.findIndex((entry) => entry.subtype === subtype);
      if (index < 0) throw new Error(`no in-flight ${subtype}`);
      this.waiting.splice(index, 1)[0]!.resolve(undefined);
    }
  }

  it("a later preset ack does not republish the pre-change model (in-order acks)", async () => {
    const transport = new QueueingTransport();
    const seam = new ClaudeSettingsSeam(buildEngine(transport));
    const applied: { model: string; activePresetId: string }[] = [];
    seam.onSettingsApplied((snapshot) => applied.push({ ...snapshot }));

    seam.selectModel("model-b");
    seam.selectPreset("workspace");
    expect(transport.pendingSubtypes()).toEqual(["set_model", "set_permission_mode"]);

    transport.ack("set_model");
    await flushMicrotasks();
    transport.ack("set_permission_mode");
    await flushMicrotasks();

    // Both changes are real, and the FINAL published snapshot carries both.
    // Republishing the captured `next` would end on {model-a, workspace}.
    expect(applied.at(-1)).toEqual({ model: "model-b", activePresetId: "workspace" });
    expect(seam.snapshot()).toEqual({ model: "model-b", activePresetId: "workspace" });
  });

  it("survives OUT-OF-ORDER acks (the preset answers first)", async () => {
    const transport = new QueueingTransport();
    const seam = new ClaudeSettingsSeam(buildEngine(transport));
    const applied: { model: string; activePresetId: string }[] = [];
    seam.onSettingsApplied((snapshot) => applied.push({ ...snapshot }));

    seam.selectModel("model-b");
    seam.selectPreset("workspace");

    transport.ack("set_permission_mode");
    await flushMicrotasks();
    transport.ack("set_model");
    await flushMicrotasks();

    expect(applied.at(-1)).toEqual({ model: "model-b", activePresetId: "workspace" });
    expect(seam.snapshot()).toEqual({ model: "model-b", activePresetId: "workspace" });
  });

  it("the pending badge is owned by the NEWEST change — an older ack settling first does not clear it", async () => {
    const transport = new QueueingTransport();
    const seam = new ClaudeSettingsSeam(buildEngine(transport));

    seam.selectModel("model-b");
    seam.selectPreset("workspace");
    expect(seam.pendingSnapshot()).not.toBeNull();

    // The OLDER request answers first; the preset change is still in flight, so
    // the badge must stay up.
    transport.ack("set_model");
    await flushMicrotasks();
    expect(seam.pendingSnapshot()).not.toBeNull();

    transport.ack("set_permission_mode");
    await flushMicrotasks();
    expect(seam.pendingSnapshot()).toBeNull();
  });
});

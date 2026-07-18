/**
 * Claude's own `EngineSettingsSeam` glue (SLICE-CC D-min/D3, cut §1.5). Reuses
 * ONLY the structural interface `host/session.ts` defines for codex's
 * model/preset picker wire (`set_model`/`set_engine_preset` ->
 * `engineSettings`) — never its implementation. Copying codex's
 * implementation is explicitly forbidden by the cut: codex's `selectModel`/
 * `selectPreset` are synchronous, send NOTHING, and the engine applies the
 * choice on the NEXT `turn/start` — `pendingSnapshot` stays non-null the
 * whole time in between. Claude's own control protocol applies
 * `set_model`/`set_permission_mode` IMMEDIATELY over an async control request
 * (`w0-16-setmodel.jsonl`), so holding a codex-shaped pending state until the
 * next turn would show the renderer a FALSE pending badge that never clears
 * until the user sends another message.
 *
 * Claude's semantics instead:
 *  - `selectModel`/`selectPreset`/`selectEffort` are SYNCHRONOUS host-side
 *    validation against the live catalog / frozen preset table (exactly what
 *    `ClaudeEngine.selectModel` already validates before its own control
 *    request) + recording the in-flight choice, THEN firing the async control
 *    request without awaiting it here.
 *  - `pendingSnapshot()` is non-null ONLY for that in-flight window (bounded
 *    by `CLAUDE_CONTROL_REQUEST_TIMEOUT_MS` inside `ClaudeClient`, live <1s).
 *  - `onSettingsApplied` fires the moment the control-ack RESOLVES
 *    successfully — never on a `turn/start`, and possibly with no turn
 *    running at all. This is hazard (д)'s discriminator: a codex-shaped
 *    implementation that instead waited for the next turn would leave
 *    `pendingSnapshot()` non-null and never call `onSettingsApplied` here,
 *    and the unit test built against it goes RED.
 *  - An ack failure/timeout rolls back to a no-op: `ClaudeEngine.selectModel`/
 *    `selectPreset` only mutate their OWN recorded model/preset on success, so
 *    a rejected control request already leaves the engine's real snapshot
 *    unchanged — this seam mirrors that by simply clearing `pending` without
 *    calling `onSettingsApplied`. The user still deserves to know why the
 *    "pending" badge silently vanished: `ClaudeEngine.queueNotice` queues an
 *    `engine_notice` for the next turn's stream (there is no other wire this
 *    can travel on between turns).
 */

import type { EngineModelChoice, EnginePermissionPreset } from "../../../shared/protocol.js";
import type { EngineSettingsChange, EngineSettingsSeam } from "../../session.js";
import type { ClaudeEngine } from "./claude-engine.js";

type SettingsSnapshot = { model: string; activePresetId: string; effort?: string };

function warningNotice(message: string): { type: "engine_notice"; level: "warning"; message: string } {
  return { type: "engine_notice", level: "warning", message };
}

export class ClaudeSettingsSeam implements EngineSettingsSeam {
  private pending: SettingsSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();

  constructor(private readonly engine: ClaudeEngine) {}

  models(): EngineModelChoice[] {
    return this.engine.models();
  }

  presets(): EnginePermissionPreset[] {
    return this.engine.presets();
  }

  snapshot(): SettingsSnapshot {
    return this.engine.snapshot();
  }

  selectModel(id: string): EngineSettingsChange {
    const available = this.engine.models();
    if (available.length === 0) {
      return { ok: false, reason: "Claude could not read its model list; start a new session to retry." };
    }
    if (!available.some((choice) => choice.id === id)) {
      return { ok: false, reason: `Claude model "${id}" is not available for this account.` };
    }
    const current = this.engine.snapshot();
    const next: SettingsSnapshot = { model: id, activePresetId: current.activePresetId, ...(current.effort !== undefined ? { effort: current.effort } : {}) };
    this.beginPending(next, () => this.engine.selectModel(id));
    return { ok: true, ...next };
  }

  selectPreset(id: string): EngineSettingsChange {
    const available = this.engine.presets();
    if (!available.some((preset) => preset.id === id)) {
      return { ok: false, reason: `Unknown Claude permission preset "${id}".` };
    }
    const current = this.engine.snapshot();
    const next: SettingsSnapshot = { model: current.model, activePresetId: id, ...(current.effort !== undefined ? { effort: current.effort } : {}) };
    this.beginPending(next, () => this.engine.selectPreset(id));
    return { ok: true, ...next };
  }

  selectEffort(effort: string): EngineSettingsChange {
    const current = this.engine.snapshot();
    const model = current.model;
    const supported = this.engine.models().find((choice) => choice.id === model)?.efforts ?? [];
    if (!supported.includes(effort)) {
      return { ok: false, reason: `Claude effort "${effort}" is not available for model "${model}".` };
    }
    const next: SettingsSnapshot = { model, activePresetId: current.activePresetId, effort };
    this.beginPending(next, () => this.engine.selectEffort(effort));
    return { ok: true, ...next };
  }

  onSettingsApplied(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Non-null ONLY during the in-flight control-request window (hazard (д)) — never held until a next turn. */
  pendingSnapshot(): SettingsSnapshot | null {
    return this.pending;
  }

  /** Fires the async control request without awaiting it here; settles `pending` on the ack, one way or the other. */
  private beginPending(next: SettingsSnapshot, fire: () => Promise<{ ok: true } | { ok: false; reason: string }>): void {
    this.pending = next;
    void fire()
      .then((result) => {
        this.pending = null;
        if (result.ok) {
          this.notify(next);
        } else {
          this.engine.queueNotice(warningNotice(result.reason));
        }
      })
      .catch((error: unknown) => {
        this.pending = null;
        const message = error instanceof Error ? error.message : String(error);
        this.engine.queueNotice(warningNotice(`Claude settings change failed: ${message}`));
      });
  }

  private notify(snapshot: SettingsSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }
}

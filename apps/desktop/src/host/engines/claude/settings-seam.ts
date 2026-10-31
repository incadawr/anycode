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

import type { CodexRateLimitsWire } from "@anycode/core";
import type { EngineModelChoice, EnginePermissionPreset } from "../../../shared/protocol.js";
import type { EngineSettingsChange, EngineSettingsSeam } from "../../session.js";
import type { ClaudeEngine } from "./claude-engine.js";
import { claudeQuotaToWire } from "./quota.js";

type SettingsSnapshot = { model: string; activePresetId: string; effort?: string };

function warningNotice(message: string): { type: "engine_notice"; level: "warning"; message: string } {
  return { type: "engine_notice", level: "warning", message };
}

export class ClaudeSettingsSeam implements EngineSettingsSeam {
  private pending: SettingsSnapshot | null = null;
  private readonly modelChanges = new Set<Promise<EngineSettingsChange>>();
  private readonly settingsChanges = new Set<Promise<EngineSettingsChange>>();
  /**
   * Monotonic id of the LATEST accepted change. A control-ack that is not the
   * newest generation may no longer clear `pending` or publish — see
   * `beginPending`.
   */
  private generation = 0;
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();

  /**
   * Session persists Claude's model/preset ONLY from `onSettingsApplied`
   * (host/session.ts `persistsOnApply`). An accept-time write would survive a
   * control request the CLI rejected or timed out on, and a later resume would
   * spawn under a posture the engine never adopted — silently widening
   * permissions. Failure therefore retains the prior row by construction.
   */
  readonly persistsOnApply = true;

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

  /**
   * The decoded `get_usage` snapshot, projected onto the shared quota wire
   * (`EnginePresentation.quota`, rebuilt on every `ui_ready`). Without this the
   * engine's `refreshQuota()` succeeds at boot and after every turn and the
   * result never leaves the engine — decoder unit tests stay green while the
   * host-ready payload carries no quota at all.
   */
  quotaSnapshot(): CodexRateLimitsWire | null {
    return claudeQuotaToWire(this.engine.quotaSnapshot());
  }

  /**
   * Maps a requested id onto the catalog value this session can run — `haiku`
   * and the CLI's full `claude-haiku-5-5` both name the same entry, and only
   * the value can go on the wire (`models.ts` `resolveId`). null = the account
   * offers nothing under that id.
   */
  resolveModelId(requested: string): string | null {
    return this.engine.resolveModelId(requested);
  }

  selectModel(id: string): EngineSettingsChange {
    const available = this.engine.models();
    if (available.length === 0) {
      return { ok: false, reason: "Claude could not read its model list; start a new session to retry." };
    }
    const resolved = this.resolveModelId(id);
    if (resolved === null) {
      return { ok: false, reason: `Claude model "${id}" is not available for this account.` };
    }
    const current = this.engine.snapshot();
    const next: SettingsSnapshot = { model: resolved, activePresetId: current.activePresetId, ...(current.effort !== undefined ? { effort: current.effort } : {}) };
    const change = this.beginPending(next, () => this.engine.selectModel(resolved));
    this.modelChanges.add(change);
    void change.finally(() => this.modelChanges.delete(change));
    return { ok: true, ...next };
  }

  /**
   * The ACKNOWLEDGED form (host/session.ts `set_session_model`): same
   * validation, same `beginPending` machinery, but the promise is awaited so a
   * caller learns whether the CLI actually adopted the model. This is what
   * keeps `create_session` honest — a model that is merely "requested" must not
   * be reported as the running one, and a rejected control request must be a
   * refusal rather than a silent default.
   */
  async selectModelAndWait(id: string): Promise<EngineSettingsChange> {
    const available = this.engine.models();
    if (available.length === 0) {
      return { ok: false, reason: "Claude could not read its model list; start a new session to retry." };
    }
    const resolved = this.resolveModelId(id);
    if (resolved === null) {
      return { ok: false, reason: `Claude model "${id}" is not available for this account.` };
    }
    const current = this.engine.snapshot();
    const next: SettingsSnapshot = { model: resolved, activePresetId: current.activePresetId, ...(current.effort !== undefined ? { effort: current.effort } : {}) };
    return this.beginPending(next, () => this.engine.selectModel(resolved));
  }

  async waitForModelChanges(): Promise<void> {
    while (this.modelChanges.size > 0) await Promise.all(this.modelChanges);
  }

  async waitForSettingsChanges(): Promise<void> {
    while (this.settingsChanges.size > 0) await Promise.all(this.settingsChanges);
  }

  selectPreset(id: string): EngineSettingsChange {
    const available = this.engine.presets();
    if (!available.some((preset) => preset.id === id)) {
      return { ok: false, reason: `Unknown Claude permission preset "${id}".` };
    }
    const current = this.engine.snapshot();
    const next: SettingsSnapshot = { model: current.model, activePresetId: id, ...(current.effort !== undefined ? { effort: current.effort } : {}) };
    void this.beginPending(next, () => this.engine.selectPreset(id));
    return { ok: true, ...next };
  }

  selectEffort(effort: string): EngineSettingsChange {
    const rejected = this.validateEffort(effort);
    if (rejected !== null) return rejected;
    const current = this.engine.snapshot();
    const next: SettingsSnapshot = { model: current.model, activePresetId: current.activePresetId, effort };
    void this.beginPending(next, () => this.engine.selectEffort(effort));
    return { ok: true, ...next };
  }

  /**
   * The ACKNOWLEDGED form (host/session.ts `set_session_effort`): the same
   * validation and the same `beginPending` machinery as `selectEffort` — this
   * only waits on the settlement that already existed. It exists because a
   * session created with an explicit effort must not be published before the
   * CLI has actually adopted it.
   *
   * A CLI refusal or a control timeout resolves `{ ok: false }` with the same
   * rollback `selectEffort` already guarantees: pending cleared, no applied
   * event, the prior applied effort untouched.
   */
  async selectEffortAndWait(effort: string): Promise<EngineSettingsChange> {
    const rejected = this.validateEffort(effort);
    if (rejected !== null) return rejected;
    const current = this.engine.snapshot();
    const next: SettingsSnapshot = { model: current.model, activePresetId: current.activePresetId, effort };
    return this.beginPending(next, () => this.engine.selectEffort(effort));
  }

  /** Host-side membership check shared by both effort entry points — never a guess about the account's vocabulary. */
  private validateEffort(effort: string): EngineSettingsChange | null {
    const model = this.engine.snapshot().model;
    const supported = this.engine.models().find((choice) => choice.id === model)?.efforts ?? [];
    if (!supported.includes(effort)) {
      return { ok: false, reason: `Claude effort "${effort}" is not available for model "${model}".` };
    }
    return null;
  }

  onSettingsApplied(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Non-null ONLY during the in-flight control-request window (hazard (д)) — never held until a next turn. */
  pendingSnapshot(): SettingsSnapshot | null {
    return this.pending;
  }

  /**
   * Fires the async control request without awaiting it here; settles
   * `pending` on the ack, one way or the other.
   *
   * Two rules make CONCURRENT changes safe (model B, then preset Workspace a
   * moment later, each with its own in-flight control request):
   *
   *  1. What is published on success is the ENGINE's own snapshot, never the
   *     `next` captured at accept time. `next` was assembled from the engine
   *     state as it stood BEFORE the earlier change acked, so republishing it
   *     would resurrect the pre-change model — the later ack would undo the
   *     earlier one in the UI. `engine.snapshot()` only ever reflects acks
   *     that actually landed, so every publication is monotonically true and
   *     the final one carries both changes regardless of ack order.
   *  2. `pending` is cleared only by the NEWEST change's ack (generation
   *     check). An older request settling second must not drop the badge for
   *     a change still in flight.
   */
  private beginPending(next: SettingsSnapshot, fire: () => Promise<{ ok: true } | { ok: false; reason: string }>): Promise<EngineSettingsChange> {
    const generation = ++this.generation;
    this.pending = next;
    const settle = (): void => {
      if (generation === this.generation) this.pending = null;
    };
    const change = fire()
      .then((result): EngineSettingsChange => {
        settle();
        if (result.ok) {
          const applied = this.engine.snapshot();
          this.notify(applied);
          return { ok: true, ...applied };
        }
        this.engine.queueNotice(warningNotice(result.reason));
        return { ok: false, reason: result.reason };
      })
      .catch((error: unknown): EngineSettingsChange => {
        settle();
        const message = error instanceof Error ? error.message : String(error);
        this.engine.queueNotice(warningNotice(`Claude settings change failed: ${message}`));
        return { ok: false, reason: message };
      });
    this.settingsChanges.add(change);
    void change.finally(() => this.settingsChanges.delete(change));
    return change;
  }

  private notify(snapshot: SettingsSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }
}

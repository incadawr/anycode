/**
 * TASK.198 срез E2a — the Vision settings panel: JSX + effects only. Every
 * decision rule the panel needs already lives as a tested pure function in
 * `vision-pane-model.ts` (this project's vitest runs `environment: "node"`,
 * no jsdom — see that module's own file docstring for why a `.test.tsx`
 * cannot exist here at all), so this component's own job is narrow: read the
 * settings-store snapshot, hand it to those functions, render what they
 * return, and wire the two recognizer IPC channels
 * (`window.anycode.settings.recognizerSet`/`recognizerProbe`) the panel's
 * Save/Turn off/Probe buttons drive.
 *
 * Save/error/reload shape is `ProxyRefPicker.tsx`'s own standalone-mode
 * pattern verbatim (capture the submitted value before the `await`, reload
 * the store on `{ok:true}`, render `describeMutationFailure`/the thrown
 * error's message on failure) — see that component's file docstring for the
 * full rationale. `recognizerSet`/`recognizerProbe` are a SEPARATE pair of
 * channels from the generic `settings-set` (see `shared/recognizer.ts`'s own
 * docstrings on `RECOGNIZER_SET_CHANNEL`/`RECOGNIZER_PROBE_CHANNEL`): the
 * former is the only way to DELETE `settings.recognizer` (`{recognizer:
 * null}`), and the latter resolves a candidate pair through the exact same
 * production ladder a live run uses, whether or not it has ever been saved.
 *
 * Electron 43's `window.prompt`/`confirm`/`alert` all throw (see
 * ConsentDialog.tsx's own note on this) — the "Turn off" confirmation is
 * therefore a second inline button ("Really turn off?"), never a native
 * dialog.
 */
import { useState } from "react";
import { useStore } from "zustand";
import type { RecognizerProbeResult } from "../../../shared/recognizer.js";
import { describeMutationFailure, useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import {
  RECOGNIZER_OAUTH_DISABLED_REASON,
  visionConnectionOptions,
  visionFallbackState,
  visionModelHints,
  visionSubmitDisabled,
} from "./vision-pane-model.js";

export interface VisionPaneProps {
  store?: SettingsStoreApi;
}

export function VisionPane({ store = useSettingsStore }: VisionPaneProps) {
  const snapshot = useStore(store, (s) => s.snapshot);

  // `catalog` is read before the snapshot null-guard below (hooks must run
  // unconditionally) so the SAME `authKindFor` closure — the exact idiom
  // `ConnectionTile.tsx`/`SettingsScreen.tsx`/`WelcomeScreen.tsx` already use
  // — can seed the draft fields' lazy initial state below.
  const catalog = snapshot?.catalog;
  const authKindFor = (providerId: string): "api_key" | "oauth" | undefined =>
    catalog?.find((entry) => entry.id === providerId)?.authKind;
  const initialFallback = snapshot ? visionFallbackState(snapshot.settings, authKindFor) : { enabled: false as const };

  const [connectionId, setConnectionId] = useState(() =>
    initialFallback.enabled ? initialFallback.connectionId : "",
  );
  const [modelId, setModelId] = useState(() => (initialFallback.enabled ? initialFallback.modelId : ""));
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<RecognizerProbeResult | null>(null);

  // Unreachable from every current host (none renders before its snapshot has
  // loaded) — a null guard, not a loading state (ProxyRefPicker.tsx's own
  // discipline).
  if (!snapshot) {
    return null;
  }

  const settings = snapshot.settings;
  const readOnly = snapshot.readOnly;
  const options = visionConnectionOptions(settings, catalog, authKindFor);
  const fallback = visionFallbackState(settings, authKindFor);
  const selectedOption = options.find((option) => option.id === connectionId);
  const selectedConnection = settings.provider.connections.find((c) => c.id === connectionId);
  const modelHints = visionModelHints(selectedConnection?.providerId, catalog, selectedConnection?.models);
  const anyOptionDisabled = options.some((option) => !option.selectable);
  const submitDisabled = readOnly || saving || probing || visionSubmitDisabled(connectionId, modelId);
  // Probing writes nothing: it runs the candidate pair through the production
  // ladder and reports what came back. A read-only settings file blocks the
  // Save path only — with the fields seeded from the saved pair, probing is
  // exactly how a read-only install answers "is my configured recognizer
  // still working?". Mirroring the runtime's refusals means never adding one
  // the runtime does not have.
  const probeDisabled = saving || probing || visionSubmitDisabled(connectionId, modelId);
  const currentLabel =
    fallback.enabled ? (options.find((option) => option.id === fallback.connectionId)?.label ?? fallback.connectionId) : null;

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    setProbeResult(null);
    try {
      const result = await window.anycode.settings.recognizerSet({
        recognizer: { connectionId, modelId: modelId.trim() },
      });
      if (result.ok) {
        await store.getState().load();
      } else {
        setError(describeMutationFailure(result.reason));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the vision fallback.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTurnOff(): Promise<void> {
    setTurningOff(true);
    setError(null);
    setProbeResult(null);
    try {
      const result = await window.anycode.settings.recognizerSet({ recognizer: null });
      if (result.ok) {
        setConfirmingOff(false);
        await store.getState().load();
      } else {
        setError(describeMutationFailure(result.reason));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to turn off the vision fallback.");
    } finally {
      setTurningOff(false);
    }
  }

  async function handleProbe(): Promise<void> {
    setProbing(true);
    setError(null);
    setProbeResult(null);
    try {
      const result = await window.anycode.settings.recognizerProbe({
        connectionId,
        modelId: modelId.trim(),
      });
      setProbeResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to probe the vision fallback.");
    } finally {
      setProbing(false);
    }
  }

  return (
    <section className="settings-section vision-pane">
      <div className="settings-section-title">Vision</div>

      <p className="settings-field-hint">
        A model that can't see images calls the InspectImage tool when it needs to look at one. A separate model,
        on a connection of its own, answers what the image shows — this panel picks that model.
      </p>

      <p className="vision-pane-state">
        <span className={`vision-pane-state-badge${fallback.enabled ? " vision-pane-state-badge-on" : ""}`}>
          {fallback.enabled ? "On" : "Off"}
        </span>
        {fallback.enabled && (
          <span className="vision-pane-current-pair">
            {currentLabel} · {fallback.modelId}
          </span>
        )}
      </p>

      <label className="settings-field">
        <span className="settings-field-label">Connection</span>
        <select
          className="settings-field-select vision-pane-connection-select"
          value={connectionId}
          disabled={readOnly}
          onChange={(e) => setConnectionId(e.target.value)}
        >
          <option value="" disabled>
            Select a connection…
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id} disabled={!option.selectable} data-proxy-warning={option.proxyWarning}>
              {option.selectable ? option.label : `${option.label} — OAuth`}
            </option>
          ))}
        </select>
        {anyOptionDisabled && <span className="settings-field-hint">{RECOGNIZER_OAUTH_DISABLED_REASON}</span>}
      </label>

      {selectedOption?.proxyWarning !== undefined && (
        <div className="settings-field-hint" role="note">
          {selectedOption.proxyWarning}
        </div>
      )}

      <label className="settings-field">
        <span className="settings-field-label">Model</span>
        <input
          className="settings-field-input vision-pane-model-input"
          type="text"
          list="vision-model-suggestions"
          value={modelId}
          disabled={readOnly}
          placeholder="e.g. glm-5.3-flash"
          onChange={(e) => setModelId(e.target.value)}
        />
        <datalist id="vision-model-suggestions">
          {modelHints.map((hint) => (
            <option key={hint.id} value={hint.id}>
              {hint.label}
            </option>
          ))}
        </datalist>
      </label>

      <div className="settings-field-row">
        <button
          type="button"
          className="settings-button settings-button-primary vision-pane-save-button"
          disabled={submitDisabled}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="settings-button vision-pane-probe-button"
          disabled={probeDisabled}
          onClick={() => void handleProbe()}
        >
          {probing ? "Probing…" : "Probe"}
        </button>
        {fallback.enabled && !confirmingOff && (
          <button
            type="button"
            className="settings-button vision-pane-turnoff-button"
            disabled={readOnly || turningOff}
            onClick={() => setConfirmingOff(true)}
          >
            Turn off
          </button>
        )}
        {fallback.enabled && confirmingOff && (
          <>
            <button
              type="button"
              className="settings-button settings-button-danger vision-pane-turnoff-confirm-button"
              disabled={readOnly || turningOff}
              onClick={() => void handleTurnOff()}
            >
              {turningOff ? "Turning off…" : "Really turn off?"}
            </button>
            <button type="button" className="settings-button" disabled={turningOff} onClick={() => setConfirmingOff(false)}>
              Cancel
            </button>
          </>
        )}
      </div>

      {error !== null && (
        <p className="settings-notice vision-pane-error" role="alert">
          {error}
        </p>
      )}

      {probeResult !== null &&
        (probeResult.ok ? (
          <p className="settings-notice-ok vision-pane-probe-result" role="status">
            {probeResult.text}
          </p>
        ) : (
          <p className="settings-notice vision-pane-probe-result" role="alert">
            {probeResult.message}
          </p>
        ))}
    </section>
  );
}

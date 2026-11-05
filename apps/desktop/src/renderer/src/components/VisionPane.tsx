import { findCatalogEntry } from "@anycode/core/catalog";
import { connectionContextWindow } from "../../../shared/connection-context-window.js";
import { contextWindowTokensField, modelOverrideFor, patchModelOverride } from "../../../shared/model-overrides.js";
/**
 * срез E2a — the Vision settings panel: JSX + effects only. Every
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
import { useRef, useState } from "react";
import { useStore } from "zustand";
import { Badge, Banner, Button, Field, Input } from "../ui/index.js";
import type { RecognizerProbeResult } from "../../../shared/recognizer.js";
import { describeMutationFailure, useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import {
  RECOGNIZER_OAUTH_DISABLED_REASON,
  visionConnectionOptions,
  visionFallbackState,
  visionModelHints,
  visionModelSelection,
  visionDraftKey,
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
  const [customModel, setCustomModel] = useState(false);
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({});
  const selectionRef = useRef(visionDraftKey(connectionId, modelId));
  selectionRef.current = visionDraftKey(connectionId, modelId);
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
  const modelHints = visionModelHints(selectedConnection, catalog);
  const draftKey = visionDraftKey(connectionId, modelId);
  const savedContext = modelOverrideFor(selectedConnection, modelId)?.contextWindowTokens;
  const contextDirty = Object.hasOwn(contextDrafts, draftKey);
  const contextValue = contextDrafts[draftKey] ?? (savedContext === undefined ? "" : String(savedContext));
  const parsedContext = contextWindowTokensField(contextValue);
  const hintConnection = selectedConnection ? structuredClone(selectedConnection) : undefined;
  if (hintConnection && contextDirty && parsedContext.ok) patchModelOverride(hintConnection, modelId, { contextWindowTokens: parsedContext.value === "" ? undefined : parsedContext.value });
  const effectiveContext = connectionContextWindow(hintConnection, modelId, selectedConnection ? findCatalogEntry(selectedConnection.providerId) : undefined);
  const anyOptionDisabled = options.some((option) => !option.selectable);
  const submitDisabled = readOnly || saving || probing || !parsedContext.ok || visionSubmitDisabled(connectionId, modelId);
  // Probing writes nothing: it runs the candidate pair through the production
  // ladder and reports what came back. A read-only settings file blocks the
  // Save path only — with the fields seeded from the saved pair, probing is
  // exactly how a read-only install answers "is my configured recognizer
  // still working?". Mirroring the runtime's refusals means never adding one
  // the runtime does not have.
  const probeDisabled = saving || probing || !parsedContext.ok || visionSubmitDisabled(connectionId, modelId);
  const currentLabel =
    fallback.enabled ? (options.find((option) => option.id === fallback.connectionId)?.label ?? fallback.connectionId) : null;

  async function handleSave(): Promise<void> {
    const submitted = visionDraftKey(connectionId, modelId);
    setSaving(true);
    setError(null);
    setProbeResult(null);
    try {
      const result = await window.anycode.settings.recognizerSet({
        recognizer: { connectionId, modelId: modelId.trim() },
        ...(contextDirty && parsedContext.ok ? { contextWindowTokens: parsedContext.value } : {}),
      });
      if (result.ok) {
        await store.getState().load();
        setContextDrafts((drafts) => { if (drafts[submitted] !== contextValue) return drafts; const next = { ...drafts }; delete next[submitted]; return next; });
      } else {
        if (selectionRef.current === submitted) setError(describeMutationFailure(result.reason));
      }
    } catch (err) {
      if (selectionRef.current === submitted) setError(err instanceof Error ? err.message : "Failed to save the vision fallback.");
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
    const submitted = visionDraftKey(connectionId, modelId);
    setProbing(true);
    setError(null);
    setProbeResult(null);
    try {
      const result = await window.anycode.settings.recognizerProbe({
        connectionId,
        modelId: modelId.trim(),
        ...(contextDirty && parsedContext.ok ? { contextWindowTokens: parsedContext.value } : {}),
      });
      if (selectionRef.current === submitted) setProbeResult(result);
    } catch (err) {
      if (selectionRef.current === submitted) setError(err instanceof Error ? err.message : "Failed to probe the vision fallback.");
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

      <p className="vision-pane-state" data-automation="vision-state">
        <Badge
          status={fallback.enabled ? "success" : "neutral"}
          label={fallback.enabled ? "On" : "Off"}
        />
        {fallback.enabled && (
          <span className="vision-pane-current-pair">
            {currentLabel} · {fallback.modelId}
          </span>
        )}
      </p>

      <Field
        label="Connection"
        hint={anyOptionDisabled ? RECOGNIZER_OAUTH_DISABLED_REASON : undefined}
      >
        {(control) => (
          // Raw select element: the kit's Select cannot carry the per-option
          // `data-proxy-warning` the automation probe reads.
          <select
            {...control}
            className="settings-field-select vision-pane-connection-select"
            value={connectionId}
            disabled={readOnly}
            onChange={(e) => { setConnectionId(e.target.value); setModelId(""); setCustomModel(false); setError(null); setProbeResult(null); }}
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
        )}
      </Field>

      {selectedOption?.proxyWarning !== undefined && (
        <div className="settings-field-hint" role="note">
          {selectedOption.proxyWarning}
        </div>
      )}

      <Field label="Model">
        {(control) => (
          <select {...control} className="settings-field-select vision-pane-model-select"
            value={visionModelSelection(modelId, modelHints, customModel)} disabled={readOnly}
            onChange={(e) => {
              const value = e.target.value;
              setError(null); setProbeResult(null);
              if (value === "custom") { setCustomModel(true); setModelId(""); }
              else { setCustomModel(false); setModelId(value === "" ? "" : modelHints[Number(value.slice(6))]?.id ?? ""); }
            }}>
            <option value="" disabled>Select a model…</option>
            {modelHints.map((hint, index) => <option key={hint.id} value={`model:${index}`}>{hint.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
        )}
      </Field>
      {visionModelSelection(modelId, modelHints, customModel) === "custom" && (
        <Input label="Custom model" size="sm" className="vision-pane-model-input" type="text"
          value={modelId} disabled={readOnly} placeholder="e.g. glm-5.3-flash"
          onChange={(e) => { setModelId(e.target.value); setError(null); setProbeResult(null); }} />
      )}

      <Input label="Context window (tokens)" size="sm" type="text" inputMode="numeric"
        value={contextValue} disabled={readOnly || !modelId} placeholder="Auto"
        onChange={(e) => setContextDrafts((drafts) => ({ ...drafts, [draftKey]: e.target.value }))} />
      <div className="settings-field-hint">
        {parsedContext.ok ? `Effective: ${effectiveContext.tokens.toLocaleString()} tokens (${effectiveContext.source}).` : "Enter an integer from 1024 to 1000000, or leave blank for Auto."}
        {" "}This override belongs to this connection and model and is shared with chat and connection settings.
      </div>

      <div className="settings-field-row">
        <Button
          size="sm"
          variant="primary"
          className="vision-pane-save-button"
          disabled={submitDisabled}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" className="vision-pane-probe-button" disabled={probeDisabled} onClick={() => void handleProbe()}>
          {probing ? "Probing…" : "Probe"}
        </Button>
        {fallback.enabled && !confirmingOff && (
          <Button
            size="sm"
            className="vision-pane-turnoff-button"
            disabled={readOnly || turningOff}
            onClick={() => setConfirmingOff(true)}
          >
            Turn off
          </Button>
        )}
        {fallback.enabled && confirmingOff && (
          <>
            <Button
              size="sm"
              variant="danger"
              className="vision-pane-turnoff-confirm-button"
              disabled={readOnly || turningOff}
              onClick={() => void handleTurnOff()}
            >
              {turningOff ? "Turning off…" : "Really turn off?"}
            </Button>
            <Button size="sm" disabled={turningOff} onClick={() => setConfirmingOff(false)}>
              Cancel
            </Button>
          </>
        )}
      </div>

      {error !== null && (
        <Banner tone="danger" className="vision-pane-error">
          {error}
        </Banner>
      )}

      {probeResult !== null &&
        (probeResult.ok ? (
          <Banner tone="success" className="vision-pane-probe-result">
            {probeResult.text}
          </Banner>
        ) : (
          <Banner tone="danger" className="vision-pane-probe-result">
            {probeResult.message}
          </Banner>
        ))}
    </section>
  );
}

/**
 * Taskana 4704 §3.9 (part B) — the first-run role picker dialog. Modal
 * listing the five roles; per role a primary row (engine select
 * claude/codex/«connection <id>» populated from the settings snapshot's
 * connections; route-specific model select with custom input; effort
 * select) and zero-or-more fallback rows (add/remove/move up-down). Preset
 * chips come from the PURE deriveRolePresets (role-presets.ts); every list
 * mutation goes through the pure role-editor-model helpers, so the node-env
 * vitest covers behavior and this JSX only renders and forwards.
 *
 * Same native-<dialog> posture as ConfirmDialog/GitConfirmDialog: visibility
 * is the caller's state; Save reports the payload, Skip reports nothing
 * written. Electron's window.confirm/prompt throw — all interactions are
 * inline buttons.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RoleConfig, ProviderConnection } from "../../../shared/settings.js";
import {
  autoSelectPreset,
  deriveRolePresets,
  presetApplicable,
  ROLE_PRESET_ROLES,
  type PresetEngineInput,
  type PresetRole,
  type RolePreset,
} from "../role-presets.js";
import {
  addFallback,
  draftValid,
  fromDraft,
  moveFallback,
  patchEntry,
  removeFallback,
  ROLE_EFFORT_LEVELS,
  toDraft,
  toDraftEntry,
  type RolesDraft,
} from "../role-editor-model.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { useSettingsStore } from "../settings-store.js";
import { resolveRoleModels, roleModelSelection, routePatch, nextCustomMode, type RoleModelSources } from "../role-model-options.js";
import { useRoleEngineModels } from "../use-role-engine-models.js";
import { Check, Chevron, Plus, X } from "./icons.js";

export interface RolePickerDialogProps {
  /** null hides the modal (visibility is the caller's state). */
  open: boolean;
  connections: readonly ProviderConnection[];
  activeConnectionId: string | undefined;
  engines: PresetEngineInput;
  /** Roles already persisted (edit mode); absent on first run. */
  initialRoles?: Partial<Record<PresetRole, RoleConfig>>;
  /** Save button label — "Save" (first run) / "Save roles" (Settings reuse). */
  saveLabel?: string;
  /** Whether a Skip button renders (first run only; Settings edits do not). */
  skippable?: boolean;
  /**
   * Render in the page flow instead of as a modal (the Settings Roles pane).
   * A modal there made the whole window inert with no way out. The
   * onboarding header ("Orchestration roles" + "change this later in
   * Settings") is suppressed here — the pane supplies its own heading and
   * description.
   */
  inline?: boolean;
  onSave(roles: Partial<Record<PresetRole, RoleConfig>>): void;
  onSkip?(): void;
}

export function RolePickerDialog({
  open,
  connections,
  activeConnectionId,
  engines,
  initialRoles,
  saveLabel = "Save",
  skippable = true,
  inline = false,
  onSave,
  onSkip,
}: RolePickerDialogProps) {
  const snapshot = useSettingsStore((state) => state.snapshot);
  const engineModels = useRoleEngineModels(open && engines.codexReady);
  const modelSources = useMemo<RoleModelSources>(() => ({
    connections, activeConnectionId, engineModels,
    catalog: snapshot?.catalog,
    custom: snapshot?.settings.provider.custom,
  }), [connections, activeConnectionId, engineModels, snapshot]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // D8 overlay wiring: the preview WebContentsView must hide while this
  // dialog is up.
  useOverlayFlag(open && !inline);

  const presets = deriveRolePresets(engines, activeConnectionId ?? "");
  const [draft, setDraft] = useState<RolesDraft>(() =>
    initialRoles !== undefined ? toDraft(initialRoles) : toDraft(autoSelectPreset(engines, activeConnectionId ?? "").roles),
  );
  const [presetId, setPresetId] = useState<RolePreset["id"]>(() => autoSelectPreset(engines, activeConnectionId ?? "").id);

  // Re-seed the draft whenever the dialog re-opens (the caller keeps this
  // component mounted; `open` flips per first-run attempt).
  useEffect(() => {
    if (open) {
      setDraft(initialRoles !== undefined ? toDraft(initialRoles) : toDraft(autoSelectPreset(engines, activeConnectionId ?? "").roles));
      setPresetId(autoSelectPreset(engines, activeConnectionId ?? "").id);
    }
    const dialog = dialogRef.current;
    if (dialog && open && !inline && !dialog.open) {
      dialog.showModal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const valid = draftValid(draft);

  function applyPreset(preset: RolePreset): void {
    setPresetId(preset.id);
    setDraft(toDraft(preset.roles));
  }

  function handleSave(): void {
    if (!valid) {
      return;
    }
    onSave(fromDraft(draft).roles);
  }

  if (!open) {
    return null;
  }

  const content = (
    <>
        {!inline && (
          <div className="role-picker-header">
            <span className="role-picker-title">Orchestration roles</span>
            <p className="role-picker-subtitle">
              Pick which engine or connection each role runs on. You can change this later in Settings → Roles.
            </p>
          </div>
        )}

        <div className="role-picker-presets" role="radiogroup" aria-label="Presets">
          {presets.map((preset) => {
            const applicable = presetApplicable(preset, engines);
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={presetId === preset.id}
                className={`role-picker-preset-chip${presetId === preset.id ? " role-picker-preset-chip-active" : ""}`}
                disabled={!applicable}
                title={applicable ? undefined : "Requires an engine that is not ready"
                }
                data-testid={`role-preset-${preset.id}`}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="role-picker-roles">
          {ROLE_PRESET_ROLES.map((role) => (
            <section key={role} className="role-picker-role" data-testid={`role-picker-role-${role}`}>
              <div className="role-picker-role-name">{role}</div>
              <EntryRow
                label="Primary"
                entry={draft[role].primary}
                connections={connections}
                modelSources={modelSources}
                onChange={(patch) => setDraft((d) => patchEntry(d, role, null, patch))}
              />
              {draft[role].fallbacks.map((entry, index) => (
                <EntryRow
                  key={index}
                  label={`Fallback ${index + 1}`}
                  entry={entry}
                  connections={connections}
                  modelSources={modelSources}
                  onChange={(patch) => setDraft((d) => patchEntry(d, role, index, patch))}
                  onRemove={() => setDraft((d) => removeFallback(d, role, index))}
                  onMove={(delta) => setDraft((d) => moveFallback(d, role, index, delta))}
                />
              ))}
              <button
                type="button"
                className="role-picker-add-fallback"
                data-testid={`role-add-fallback-${role}`}
                onClick={() => setDraft((d) => addFallback(d, role))}
              >
                <Plus /> Add fallback
              </button>
            </section>
          ))}
        </div>

        {!valid && (
          <div className="role-picker-error" role="alert">
            An entry cannot select both an engine and a connection — pick one.
          </div>
        )}

        <div className="role-picker-actions">
          {skippable && (
            <button type="button" className="role-picker-skip" data-testid="role-picker-skip" onClick={() => onSkip?.()}>
              Skip
            </button>
          )}
          <button
            type="button"
            className="role-picker-save"
            data-testid="role-picker-save"
            disabled={!valid}
            onClick={handleSave}
          >
            {saveLabel}
          </button>
        </div>
    </>
  );

  return inline ? (
    <section className="role-picker-dialog role-picker-inline" aria-label="Choose orchestration roles">
      {content}
    </section>
  ) : (
    <dialog ref={dialogRef} className="role-picker-dialog" aria-label="Choose orchestration roles">
      {content}
    </dialog>
  );
}

interface EntryRowProps {
  label: string;
  entry: RolesDraft[PresetRole]["primary"];
  connections: readonly ProviderConnection[];
  modelSources: RoleModelSources;
  onChange(patch: Partial<RolesDraft[PresetRole]["primary"]>): void;
  onRemove?(): void;
  onMove?(delta: -1 | 1): void;
}

function connectionRouteLabel(connection: ProviderConnection, sources: RoleModelSources): string {
  if (!connection.label) return connection.id;
  const providerName = sources.catalog?.find((provider) => provider.id === connection.providerId)?.name
    ?? sources.custom?.find((provider) => provider.id === connection.providerId)?.name
    ?? connection.providerId;
  return `${connection.label} · ${providerName}`;
}

function EntryRow({ label, entry, connections, modelSources, onChange, onRemove, onMove }: EntryRowProps) {
  const route = entry.engine !== "" ? `engine:${entry.engine}` : entry.connection.trim() !== "" ? `connection:${entry.connection}` : "connection:active";
  const models = resolveRoleModels(entry, modelSources);
  const selection = nextCustomMode(entry.customModel === true, entry.model, models) ? "custom" : roleModelSelection(entry.model, models, entry.engine);
  return (
    <div className="role-picker-entry" data-route={route}>
      <span className="role-picker-entry-label">{label}</span>
      <select
        className="role-picker-entry-route"
        aria-label={`${label} route`}
        value={route}
        onChange={(event) => onChange(routePatch(event.target.value))}
      >
        <option value="engine:claude">Claude engine</option>
        <option value="engine:codex">Codex engine</option>
        <option value="connection:active">Session's connection</option>
        {connections.map((connection) => (
          <option key={connection.id} value={`connection:${connection.id}`}>
            {connectionRouteLabel(connection, modelSources)}
          </option>
        ))}
      </select>
      <select
        className="role-picker-entry-model"
        aria-label={`${label} model`}
        value={selection}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "custom") {
            onChange({ model: "", customModel: nextCustomMode(true, "", models) });
          } else {
            onChange({ model: next === "default" ? "" : models[Number(next.slice("model:".length))]!.id, customModel: false });
          }
        }}
      >
        <option value="default">Default</option>
        {models.map((model, index) => <option key={model.id} value={`model:${index}`}>{model.name ?? model.id}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {selection === "custom" && (
        <input
          className="role-picker-entry-model"
          aria-label={`${label} custom model`}
          type="text"
          placeholder="Model ID"
          value={entry.model}
          onChange={(event) => {
            onChange({ model: event.target.value, customModel: nextCustomMode(true, event.target.value, models) });
          }}
        />
      )}
      <select
        className="role-picker-entry-effort"
        aria-label={`${label} effort`}
        value={entry.effort}
        onChange={(event) => onChange({ effort: event.target.value as (typeof ROLE_EFFORT_LEVELS)[number] })}
      >
        {ROLE_EFFORT_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level === "" ? "effort (default)" : level}
          </option>
        ))}
      </select>
      {onMove && (
        <span className="role-picker-entry-order">
          <button type="button" aria-label={`Move ${label} up`} disabled={false} onClick={() => onMove?.(-1)}>
            <Chevron />
          </button>
          <button type="button" aria-label={`Move ${label} down`} onClick={() => onMove?.(1)}>
            <Chevron />
          </button>
        </span>
      )}
      {onRemove && (
        <button type="button" className="role-picker-entry-remove" aria-label={`Remove ${label}`} onClick={onRemove}>
          <X />
        </button>
      )}
    </div>
  );
}

/** Re-exported for the smoke's model-prefill assertion and pane reuse. */
export { toDraftEntry };

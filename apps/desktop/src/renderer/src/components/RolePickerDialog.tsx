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
import type { ReactNode } from "react";
import type { RoleConfig, ProviderConnection } from "../../../shared/settings.js";
import {
  activePresetId,
  autoSelectPreset,
  deriveRolePresets,
  presetMatchesRoles,
  presetUnavailableReason,
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
import { roleOverrideNotice, type RoleProfileOverride } from "../role-profile-overrides.js";
import { useRoleEngineModels } from "../use-role-engine-models.js";
import { connectionRouteLabels } from "../role-routes.js";
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
  /**
   * roles claimed by a same-named md agent profile
   * (`.anycode/agents/<role>.md`). Such a profile OUTRANKS the Settings route,
   * so the row says so instead of letting the user save a setting that silently
   * never applies.
   */
  profileOverrides?: Partial<Record<PresetRole, RoleProfileOverride>>;
  /**
   * Save-result feedback rendered INSIDE the actions row, next to the buttons.
   * The Settings pane passes its notice here — a notice below the last field
   * sat off screen under the Save button.
   */
  actionsNotice?: ReactNode;
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
  profileOverrides,
  actionsNotice,
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
  const autoPreset = autoSelectPreset(engines, activeConnectionId ?? "");
  const [draft, setDraft] = useState<RolesDraft>(() =>
    initialRoles !== undefined ? toDraft(initialRoles) : toDraft(autoPreset.roles),
  );
  // The preset the editor last SEEDED (not the last chip clicked). A clean
  // draft is re-seeded when engine readiness or the active connection changes;
  // an edited draft is left alone.
  const seededPreset = useRef<RolePreset["id"] | null>(initialRoles === undefined ? autoPreset.id : null);
  // The highlighted chip follows the VALUES shown, never a click: a persisted
  // or edited chain that no preset describes highlights nothing.
  const activePreset = activePresetId(presets, fromDraft(draft).roles, engines);
  const unavailablePresets = presets.flatMap((preset) => {
    const reason = presetUnavailableReason(preset, engines);
    return reason === null ? [] : [{ id: preset.id, label: preset.label, reason }];
  });

  // Re-seed the draft whenever the dialog re-opens (the caller keeps this
  // component mounted; `open` flips per first-run attempt).
  useEffect(() => {
    if (open) {
      setDraft(initialRoles !== undefined ? toDraft(initialRoles) : toDraft(autoPreset.roles));
      seededPreset.current = initialRoles === undefined ? autoPreset.id : null;
    }
    const dialog = dialogRef.current;
    if (dialog && open && !inline && !dialog.open) {
      dialog.showModal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Readiness/connection can arrive or change while the dialog is open (the
  // engine list is fetched asynchronously). Only an UNTOUCHED draft follows
  // the new auto-selection — the point is that a fresh profile never keeps a
  // default that routes to an engine that is no longer available.
  useEffect(() => {
    if (!open || initialRoles !== undefined) return;
    const previous = seededPreset.current === null
      ? undefined
      : presets.find((preset) => preset.id === seededPreset.current);
    if (previous === undefined) return;
    if (!presetMatchesRoles(previous, fromDraft(draft).roles)) {
      // The user edited the seeded draft — stop following auto-selection.
      seededPreset.current = null;
      return;
    }
    seededPreset.current = autoPreset.id;
    if (autoPreset.id !== previous.id) setDraft(toDraft(autoPreset.roles));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreset.id, activeConnectionId]);

  const valid = draftValid(draft);

  function applyPreset(preset: RolePreset): void {
    seededPreset.current = preset.id;
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
            const applicable = presetUnavailableReason(preset, engines) === null;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={activePreset === preset.id}
                className={`role-picker-preset-chip${activePreset === preset.id ? " role-picker-preset-chip-active" : ""}`}
                disabled={!applicable}
                title={applicable ? preset.description : presetUnavailableReason(preset, engines) ?? undefined
                }
                data-testid={`role-preset-${preset.id}`}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        {/* A disabled chip's requirement is text, not a hover-only title. */}
        {unavailablePresets.length > 0 && (
          <p className="role-picker-preset-note" data-testid="role-preset-requirements">
            {unavailablePresets.map((preset) => `${preset.label}: ${preset.reason}`).join(" ")}
          </p>
        )}

        <div className="role-picker-roles">
          {ROLE_PRESET_ROLES.map((role) => (
            <section key={role} className="role-picker-role" data-testid={`role-picker-role-${role}`}>
              <div className="role-picker-role-name">{role}</div>
              {profileOverrides?.[role] !== undefined && (
                <p
                  className="role-picker-role-override"
                  role="status"
                  data-testid={`role-route-overridden-${role}`}
                >
                  {roleOverrideNotice(profileOverrides[role])}
                </p>
              )}
              <EntryRow
                label="Primary"
                entry={draft[role].primary}
                connections={connections}
                modelSources={modelSources}
                engineReadiness={engines}
                onChange={(patch) => setDraft((d) => patchEntry(d, role, null, patch))}
              />
              {draft[role].fallbacks.map((entry, index) => (
                <EntryRow
                  key={index}
                  label={`Fallback ${index + 1}`}
                  entry={entry}
                  connections={connections}
                  modelSources={modelSources}
                  engineReadiness={engines}
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
            An entry cannot select more than one engine, connection, or provider.
          </div>
        )}

        <div className="role-picker-actions">
          {actionsNotice}
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

export interface EntryRowProps {
  label: string;
  entry: RolesDraft[PresetRole]["primary"];
  connections: readonly ProviderConnection[];
  modelSources: RoleModelSources;
  onChange(patch: Partial<RolesDraft[PresetRole]["primary"]>): void;
  onRemove?(): void;
  onMove?(delta: -1 | 1): void;
  compact?: boolean;
  /** Engine readiness, when this surface can tell — a route to an engine that is not set up is marked, never silently kept. */
  engineReadiness?: PresetEngineInput;
}

/**
 * Route labels for the connection options: a display name, never the raw
 * `conn-<uuid>` storage id (role-routes.ts owns the rule).
 */
export function EntryRow({ label, entry, connections, modelSources, onChange, onRemove, onMove, compact = false, engineReadiness }: EntryRowProps) {
  const route = entry.engine !== "" ? `engine:${entry.engine}` : entry.connection.trim() !== "" ? `connection:${entry.connection}` : entry.provider ? `provider:${entry.provider}` : "connection:active";
  const models = resolveRoleModels(entry, modelSources);
  const selection = nextCustomMode(entry.customModel === true, entry.model, models) ? "custom" : roleModelSelection(entry.model, models, entry.engine);
  /** "" when the route does not target an engine or that engine is ready. */
  const engineOffline = entry.engine === "claude" && engineReadiness?.claudeReady === false
    ? "Claude"
    : entry.engine === "codex" && engineReadiness?.codexReady === false
      ? "Codex"
      : "";
  const routeLabels = useMemo(
    () => connectionRouteLabels(connections, modelSources.catalog, modelSources.custom),
    [connections, modelSources.catalog, modelSources.custom],
  );
  return (
    <div className={`role-picker-entry${engineOffline ? " role-picker-entry-engine-offline" : ""}`} data-route={route}>
      <span className="role-picker-entry-label">{label}</span>
      <select
        className={compact ? "settings-field-select role-picker-entry-route" : "role-picker-entry-route"}
        aria-label={`${label} route`}
        title={entry.engine ? `${entry.engine} engine${engineOffline ? ` (${engineOffline} is not connected)` : ""}` : entry.provider ? `Provider: ${entry.provider}` : entry.connection ? routeLabels.get(entry.connection) ?? `Unavailable connection: ${entry.connection}` : "Session’s connection"}
        value={route}
        onChange={(event) => onChange(routePatch(event.target.value))}
      >
        <option value="engine:claude">{engineReadiness && !engineReadiness.claudeReady ? "Claude engine (not connected)" : "Claude engine"}</option>
        <option value="engine:codex">{engineReadiness && !engineReadiness.codexReady ? "Codex engine (not connected)" : "Codex engine"}</option>
        <option value="connection:active">Session's connection</option>
        {entry.provider && <option value={`provider:${entry.provider}`}>Provider: {entry.provider}</option>}
        {entry.connection.trim() && !connections.some((connection) => connection.id === entry.connection) && <option value={`connection:${entry.connection}`}>Unavailable connection: {entry.connection}</option>}
        {connections.map((connection) => (
          <option key={connection.id} value={`connection:${connection.id}`}>
            {routeLabels.get(connection.id) ?? "Connection"}
          </option>
        ))}
      </select>
      <select
        className={compact ? "settings-field-select role-picker-entry-model" : "role-picker-entry-model"}
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
          className={compact ? "settings-field-input role-picker-entry-model" : "role-picker-entry-model"}
          aria-label={`${label} custom model`}
          type="text"
          placeholder="Model ID"
          title={entry.model}
          value={entry.model}
          onChange={(event) => {
            onChange({ model: event.target.value, customModel: nextCustomMode(true, event.target.value, models) });
          }}
        />
      )}
      <select
        className={compact ? "settings-field-select role-picker-entry-effort" : "role-picker-entry-effort"}
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
          <button type="button" className={compact ? "settings-button role-picker-entry-order-up" : "role-picker-entry-order-up"} title={`Move ${label} up`} aria-label={`Move ${label} up`} onClick={() => onMove?.(-1)}>
            <Chevron className="role-picker-entry-order-glyph" />
          </button>
          <button type="button" className={compact ? "settings-button" : undefined} title={`Move ${label} down`} aria-label={`Move ${label} down`} onClick={() => onMove?.(1)}>
            <Chevron />
          </button>
        </span>
      )}
      {engineOffline && (
        <span className="role-picker-entry-offline" role="note" data-testid={`role-entry-offline-${label}`}>
          {engineOffline} engine is not connected — set it up in Settings → {engineOffline}, or change the route.
        </span>
      )}
      {onRemove && (
        <button type="button" className={compact ? "settings-button role-picker-entry-remove" : "role-picker-entry-remove"} aria-label={`Remove ${label}`} onClick={onRemove}>
          <X />
        </button>
      )}
    </div>
  );
}

/** Re-exported for the smoke's model-prefill assertion and pane reuse. */
export { toDraftEntry };

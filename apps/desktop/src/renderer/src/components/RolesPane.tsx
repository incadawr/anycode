/**
 * Taskana 4704 §3.9 (part B) — the Settings → Roles pane: the SAME role
 * editor the first-run RolePickerDialog embeds (the dialog is reused here in
 * non-modal posture via `skippable={false}` and an open dialog rendered
 * inline), plus the `maxParallelChildren` number input (1–16). Save goes
 * through settings-set (the store's `setPatch`), exactly like every other
 * pane. Behavior lives in role-editor-model.ts/role-presets.ts (pure, node-
 * env vitest); this component renders and forwards.
 */
import { useMemo, useState } from "react";
import type { ProviderConnection } from "../../../shared/settings.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { deriveRolePresets, presetApplicable, ROLE_PRESET_ROLES, type PresetRole } from "../role-presets.js";
import type { RoleConfig } from "../../../shared/settings.js";
import { toDraft } from "../role-editor-model.js";
import { RolePickerDialog } from "./RolePickerDialog.js";

export function RolesPane(): React.JSX.Element {
  const snapshot = useSettingsStore((s) => s.snapshot);
  const setPatch = useSettingsStore((s) => s.setPatch);
  const availableEngines = useTabsStore((s) => s.availableEngines);

  const connections: readonly ProviderConnection[] = snapshot?.settings.provider.connections ?? [];
  const activeConnectionId = snapshot?.settings.provider.activeConnectionId;
  const engines = useMemo(
    () => ({
      claudeReady: availableEngines.includes("claude"),
      codexReady: availableEngines.includes("codex"),
    }),
    [availableEngines],
  );

  const persistedRoles = (snapshot?.settings.roles ?? undefined) as Partial<Record<PresetRole, RoleConfig>> | undefined;
  const [maxParallelChildren, setMaxParallelChildren] = useState<number>(snapshot?.settings.roles?.maxParallelChildren ?? 4);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  async function handleSave(roles: Partial<Record<PresetRole, RoleConfig>>): Promise<void> {
    const result = await setPatch({ roles: { ...roles, maxParallelChildren } });
    setSavedNotice(result.ok ? "Roles saved." : "Saving roles failed.");
  }

  const initialRoles = useMemo(
    () => (persistedRoles !== undefined && Object.keys(persistedRoles).length > 0 ? persistedRoles : deriveRolePresets(engines, activeConnectionId ?? "")[0]!.roles),
    // Seed once per snapshot identity; the dialog re-seeds on open anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot],
  );

  return (
    <div className="settings-pane" data-testid="settings-roles-pane">
      <RolePickerDialog
        open
        inline
        skippable={false}
        saveLabel="Save roles"
        connections={connections}
        activeConnectionId={activeConnectionId}
        engines={engines}
        initialRoles={initialRoles}
        onSave={(roles) => {
          void handleSave(roles);
        }}
      />

      <label className="settings-field">
        <span className="settings-field-label">Max parallel children</span>
        <input
          type="number"
          min={1}
          max={16}
          value={maxParallelChildren}
          aria-label="Max parallel children"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) {
              setMaxParallelChildren(Math.min(16, Math.max(1, Math.trunc(next))));
            }
          }}
        />
        <span className="settings-field-hint">Detached child sessions this orchestrator may run at once (1–16, default 4).</span>
      </label>

      {savedNotice !== null && (
        <p className="settings-notice" role="status">
          {savedNotice}
        </p>
      )}
    </div>
  );
}

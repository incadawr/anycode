/**
 * Taskana 4704 §3.9 (part B) — the Settings → Roles pane: the SAME role
 * editor the first-run RolePickerDialog embeds (the dialog is reused here in
 * non-modal posture via `skippable={false}` and an open dialog rendered
 * inline), plus the `maxParallelChildren` number input (1–16). Save goes
 * through settings-set (the store's `setPatch`), exactly like every other
 * pane. Behavior lives in role-editor-model.ts/role-presets.ts (pure, node-
 * env vitest); this component renders and forwards.
 */
import { useEffect, useMemo, useState } from "react";
import type { ProviderConnection } from "../../../shared/settings.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { deriveRolePresets, presetApplicable, ROLE_PRESET_ROLES, type PresetRole } from "../role-presets.js";
import type { RoleConfig } from "../../../shared/settings.js";
import { roleProfiles } from "../../../shared/role-profiles.js";
import { RolePickerDialog } from "./RolePickerDialog.js";

export function RolesPane(): React.JSX.Element {
  const snapshot = useSettingsStore((s) => s.snapshot);
  const setPatch = useSettingsStore((s) => s.setPatch);
  const availableEngines = useTabsStore((s) => s.availableEngines);
  const tabs = useTabsStore((s) => s.tabs);
  const [sessionProjects, setSessionProjects] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void window.anycode.listSessions().then((sessions) => {
      if (live) setSessionProjects(sessions.map((s) => s.projectRoot ?? s.workspace));
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  const connections: readonly ProviderConnection[] = snapshot?.settings.provider.connections ?? [];
  const activeConnectionId = snapshot?.settings.provider.activeConnectionId;
  const engines = useMemo(
    () => ({
      claudeReady: availableEngines.includes("claude"),
      codexReady: availableEngines.includes("codex"),
    }),
    [availableEngines],
  );

  const registry = roleProfiles(snapshot?.settings ?? {});
  const selected = registry.profiles.find((p) => p.id === registry.activeId);
  const persistedRoles = selected?.roles;
  const [maxParallelChildren, setMaxParallelChildren] = useState<number>(persistedRoles?.maxParallelChildren ?? 4);
  const [projectRoot, setProjectRoot] = useState("");
  const projects = [...new Set([...tabs.map((tab) => tab.projectRoot ?? tab.workspace), ...sessionProjects, ...registry.projects.map((p) => p.projectRoot)])];
  const [profileName, setProfileName] = useState("");
  useEffect(() => { setMaxParallelChildren(selected?.roles.maxParallelChildren ?? 4); }, [selected?.id, selected?.roles.maxParallelChildren]);
  async function saveRegistry(next: typeof registry): Promise<void> {
    const result = await setPatch({ roleProfiles: next });
    setSavedNotice(result.ok ? "Profiles saved." : "Saving profiles failed.");
  }
  function addProfile(copy: boolean): void {
    const id = crypto.randomUUID();
    const name = profileName.trim() || (copy ? "Copy" : "New profile");
    const roles = copy ? (persistedRoles ?? {}) : {};
    void saveRegistry({ ...registry, profiles: [...registry.profiles, { id, name, roles }], activeId: id });
  }
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  async function handleSave(roles: Partial<Record<PresetRole, RoleConfig>>): Promise<void> {
    const id = selected?.id ?? "default";
    const profile = { id, name: selected?.name ?? "Default", roles: { ...roles, maxParallelChildren } };
    const result = await setPatch({ roleProfiles: { ...registry, profiles: [...registry.profiles.filter((p) => p.id !== id), profile], activeId: id } });
    setSavedNotice(result.ok ? "Roles saved." : "Saving roles failed.");
  }

  const initialRoles = useMemo(
    () => (persistedRoles !== undefined && Object.keys(persistedRoles).length > 0 ? persistedRoles : deriveRolePresets(engines, activeConnectionId ?? "")[0]!.roles),
    // Seed once per snapshot identity; the dialog re-seeds on open anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, persistedRoles, engines, activeConnectionId],
  );

  return (
    <div className="settings-pane" data-testid="settings-roles-pane">
      <label className="settings-field"><span className="settings-field-label">Global role profile</span>
        <select aria-label="Global role profile" value={selected?.id ?? ""} onChange={(event) => void saveRegistry({ ...registry, activeId: event.target.value })}>
          {!selected && <option value="">Built-in defaults</option>}
          {registry.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="settings-field"><span className="settings-field-label">Profile name</span><input aria-label="Profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
      <button type="button" onClick={() => addProfile(false)}>Create profile</button>
      <button type="button" onClick={() => addProfile(true)}>Duplicate profile</button>
      <button type="button" disabled={!selected || !profileName.trim()} onClick={() => { if (selected) void saveRegistry({ ...registry, profiles: registry.profiles.map((p) => p.id === selected.id ? { ...p, name: profileName.trim() } : p) }); }}>Rename profile</button>
      <button type="button" disabled={!selected} onClick={() => { if (selected) { const profiles = registry.profiles.filter((p) => p.id !== selected.id); void saveRegistry({ profiles, activeId: profiles[0]?.id ?? "default", projects: registry.projects.filter((p) => p.profileId !== selected.id) }); } }}>Delete profile</button>
      <label className="settings-field"><span className="settings-field-label">Project</span><select aria-label="Project" value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)}><option value="">Select a project</option>{projects.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
      <label className="settings-field"><span className="settings-field-label">Project role profile</span>
        <select aria-label="Project role profile" disabled={!projectRoot} value={registry.projects.find((p) => p.projectRoot === projectRoot)?.profileId ?? ""} onChange={(event) => void saveRegistry({ ...registry, projects: [...registry.projects.filter((p) => p.projectRoot !== projectRoot), ...(event.target.value ? [{ projectRoot, profileId: event.target.value }] : [])] })}>
          <option value="">Use global profile</option>{registry.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <RolePickerDialog
        key={selected?.id ?? "default"}
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

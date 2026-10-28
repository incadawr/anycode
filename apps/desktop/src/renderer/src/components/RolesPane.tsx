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
import type { SubagentsSnapshot } from "../../../shared/subagents-config.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { deriveRolePresets, presetApplicable, ROLE_PRESET_ROLES, type PresetRole } from "../role-presets.js";
import type { RoleConfig } from "../../../shared/settings.js";
import { roleProfiles } from "../../../shared/role-profiles.js";
import { claimedRoleOverrides, type RoleProfileOverride } from "../role-profile-overrides.js";
import {
  canRenameProfile,
  createProfileName,
  duplicateProfileName,
  projectFolderName,
} from "../role-profile-controls.js";
import { RolePickerDialog } from "./RolePickerDialog.js";

export interface RolesPaneProps {
  /**
   * The tab whose workspace scopes the profile scan (the Settings scope bar's
   * project, or the active tab in Global mode). Absent = user-level profiles
   * only, mirroring the Subagents pane next to this one.
   */
  tabId?: string;
}

/** Shown in the existing save-notice slot when the cap input is unusable. */
export const ROLE_CHILD_LIMIT_INVALID_MESSAGE = "Enter a whole number from 1 to 16, or leave blank to use the session limit.";

/**
 * GitHub #17 slice B: parses the pane's "Max parallel children"
 * input. Blank (or whitespace) is VALID and means "no explicit cap" — the
 * profile stores no key and the shared session limit applies. Anything else
 * must be a whole number 1..16; everything else (zero, fractions, text,
 * out-of-range) is invalid and must refuse the save rather than be clamped.
 */
export function parseRoleChildLimitInput(raw: string): { valid: true; value?: number } | { valid: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { valid: true };
  if (!/^\d+$/.test(trimmed)) return { valid: false };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) return { valid: false };
  return { valid: true, value };
}

/**
 * GitHub #17 slice B: the roles object a save actually writes.
 * The preset roles never own the cap, so the resolved value is the ONLY
 * source: a valid number sets it, and a blank input DELETES any previously
 * stored cap (the old pane always wrote its `?? 4` default back).
 */
export function buildRoleProfileRoles<R extends object>(
  roles: R,
  raw: string,
): { valid: true; roles: R & { maxParallelChildren?: number } } | { valid: false } {
  const parsed = parseRoleChildLimitInput(raw);
  if (!parsed.valid) return { valid: false };
  const { maxParallelChildren: _previous, ...rest } = roles as R & { maxParallelChildren?: number };
  return {
    valid: true,
    roles: (parsed.value !== undefined ? { ...rest, maxParallelChildren: parsed.value } : rest) as R & {
      maxParallelChildren?: number;
    },
  };
}

export function RolesPane({ tabId }: RolesPaneProps = {}): React.JSX.Element {
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
  // GitHub #17 slice B: the field is a STRING and starts EMPTY
  // when the profile carries no explicit cap — the old numeric state seeded
  // `?? 4` and silently wrote that competing default back on every save.
  // Blank means "inherit the session limit" (shared/session-limits.ts).
  const [maxParallelChildren, setMaxParallelChildren] = useState<string>(persistedRoles?.maxParallelChildren?.toString() ?? "");
  const [projectRoot, setProjectRoot] = useState("");
  const projects = [...new Set([...tabs.map((tab) => tab.projectRoot ?? tab.workspace), ...sessionProjects, ...registry.projects.map((p) => p.projectRoot)])];
  const [profileName, setProfileName] = useState<string>(() => selected?.name ?? "");
  // The name field is prefilled from the selection so Rename starts from the
  // current name, but a prefilled value is NOT a name the user typed for
  // Create/Duplicate. Without this distinction, clicking either button right
  // after selecting a profile read the prefill as an explicit name and piled up
  // identically named profiles.
  const [nameEdited, setNameEdited] = useState(false);
  const projectProfileId = registry.projects.find((p) => p.projectRoot === projectRoot)?.profileId;
  useEffect(() => { setMaxParallelChildren(selected?.roles.maxParallelChildren?.toString() ?? ""); }, [selected?.id, selected?.roles.maxParallelChildren]);
  // The name field drives Create/Rename/Duplicate; it follows the selected
  // profile so Rename starts from the current name instead of a dead empty box.
  useEffect(() => { setProfileName(selected?.name ?? ""); setNameEdited(false); }, [selected?.id, selected?.name]);
  async function saveRegistry(next: typeof registry): Promise<void> {
    const result = await setPatch({ roleProfiles: next });
    setSavedNotice({ ok: result.ok, message: result.ok ? "Profiles saved." : "Saving profiles failed." });
  }
  function addProfile(copy: boolean): void {
    const id = crypto.randomUUID();
    const existingNames = registry.profiles.map((profile) => profile.name);
    // An untouched prefill is not a name for THIS operation: fall back to the
    // unique default series so repeated clicks never create duplicates.
    const typedName = nameEdited ? profileName : "";
    const name = copy
      ? duplicateProfileName(typedName, existingNames, selected?.name)
      : createProfileName(typedName, existingNames);
    const roles = copy ? (persistedRoles ?? {}) : {};
    void saveRegistry({ ...registry, profiles: [...registry.profiles, { id, name, roles }], activeId: id });
  }
  const [savedNotice, setSavedNotice] = useState<{ ok: boolean; message?: string } | null>(null);
  // role names a same-named md agent profile currently claims —
  // such a role's Settings route never takes effect, so the editor says which
  // file to edit or remove.
  const [profileOverrides, setProfileOverrides] = useState<Partial<Record<PresetRole, RoleProfileOverride>>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bridge = window.anycode?.subagents;
    if (bridge === undefined) return;
    let cancelled = false;
    void bridge
      .list(tabId === undefined ? {} : { tabId })
      .then((snapshot: SubagentsSnapshot) => {
        if (!cancelled) setProfileOverrides(claimedRoleOverrides(snapshot.rows, snapshot.roleClaims));
      })
      .catch(() => {
        if (!cancelled) setProfileOverrides({});
      });
    return () => {
      cancelled = true;
    };
    // Re-scan when the pane's project changes or settings are saved (the same
    // snapshot identity every other pane follows).
  }, [tabId, snapshot]);

  async function handleSave(roles: Partial<Record<PresetRole, RoleConfig>>): Promise<void> {
    const id = selected?.id ?? "default";
    // Slice B: an invalid cap refuses the WHOLE save (never writes a clamped
    // guess); a blank field writes no key at all, which clears an old
    // explicit cap and lets the session limit apply.
    const built = buildRoleProfileRoles(roles, maxParallelChildren);
    if (!built.valid) {
      setSavedNotice({ ok: false, message: ROLE_CHILD_LIMIT_INVALID_MESSAGE });
      return;
    }
    const profile = { id, name: selected?.name ?? "Default", roles: built.roles };
    const result = await setPatch({ roleProfiles: { ...registry, profiles: [...registry.profiles.filter((p) => p.id !== id), profile], activeId: id } });
    setSavedNotice({ ok: result.ok });
  }

  const initialRoles = useMemo(
    () => (persistedRoles !== undefined ? persistedRoles : deriveRolePresets(engines, activeConnectionId ?? "")[0]!.roles),
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
      <label className="settings-field"><span className="settings-field-label">Profile name</span><input aria-label="Profile name" value={profileName} onChange={(event) => { setProfileName(event.target.value); setNameEdited(true); }} /></label>
      <button type="button" onClick={() => addProfile(false)}>Create profile</button>
      <button type="button" onClick={() => addProfile(true)}>Duplicate profile</button>
      <button type="button" disabled={!canRenameProfile(selected?.name, profileName)} onClick={() => { if (selected) void saveRegistry({ ...registry, profiles: registry.profiles.map((p) => p.id === selected.id ? { ...p, name: profileName.trim() } : p) }); }}>Rename profile</button>
      <button type="button" disabled={!selected} onClick={() => { if (selected) { const profiles = registry.profiles.filter((p) => p.id !== selected.id); void saveRegistry({ profiles, activeId: profiles[0]?.id ?? "default", projects: registry.projects.filter((p) => p.profileId !== selected.id) }); } }}>Delete profile</button>
      <label className="settings-field"><span className="settings-field-label">Project</span><select aria-label="Project" title={projectRoot === "" ? undefined : projectRoot} value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)}><option value="">Select a project</option>{projects.map((path) => <option key={path} value={path} title={path}>{projectFolderName(path)}</option>)}</select></label>
      <label className="settings-field"><span className="settings-field-label">Project role profile</span>
        <select aria-label="Project role profile" disabled={!projectRoot} value={projectProfileId ?? ""} onChange={(event) => void saveRegistry({ ...registry, projects: [...registry.projects.filter((p) => p.projectRoot !== projectRoot), ...(event.target.value ? [{ projectRoot, profileId: event.target.value }] : [])] })}>
          <option value="">Use global profile</option>{projectProfileId && !registry.profiles.some((p) => p.id === projectProfileId) && <option value={projectProfileId}>Missing profile (using global)</option>}{registry.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {/* One global limit for every role, directly above the editor it saves with. */}
      <label className="settings-field">
        <span className="settings-field-label">Max parallel children</span>
        <input
          type="text"
          inputMode="numeric"
          value={maxParallelChildren}
          aria-label="Max parallel children"
          onChange={(event) => setMaxParallelChildren(event.target.value)}
        />
        <span className="settings-field-hint">
          Optional lower limit (1–16) for all roles; blank uses the session limit, default 3. The lower of both limits applies.
        </span>
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
        profileOverrides={profileOverrides}
        // The save result belongs beside the Save roles button, not below the last field.
        actionsNotice={savedNotice !== null ? <RolesSaveNotice ok={savedNotice.ok} message={savedNotice.message} /> : undefined}
        onSave={(roles) => {
          void handleSave(roles);
        }}
      />
    </div>
  );
}

/** The save result remains visible until the next save. */
export function RolesSaveNotice({ ok, message }: { ok: boolean; message?: string }): React.JSX.Element {
  return (
    <p className={ok ? "settings-notice-ok" : "settings-notice"} role="status">
      {message ?? (ok ? "Roles saved." : "Saving roles failed.")}
    </p>
  );
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SubagentsSnapshot } from "../../../shared/subagents-config.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { autoSelectPreset, deriveRolePresets, presetApplicable, ROLE_PRESET_ROLES, type PresetRole } from "../role-presets.js";
import { roleProfiles } from "../../../shared/role-profiles.js";
import { claimedRoleOverrides, type RoleProfileOverride } from "../role-profile-overrides.js";
import {
  canRenameProfile,
  createProfileName,
  duplicateProfileName,
  projectFolderName,
} from "../role-profile-controls.js";
import { EntryRow } from "./RolePickerDialog.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { addFallback, draftValid, fromDraft, moveFallback, patchEntry, removeFallback, toDraft } from "../role-editor-model.js";
import { roleOverrideNotice } from "../role-profile-overrides.js";
import { useRoleEngineModels } from "../use-role-engine-models.js";

export interface RolesPaneProps {
  /**
   * The tab whose workspace scopes the profile scan (the Settings scope bar's
   * project, or the active tab in Global mode). Absent = user-level profiles
   * only, mirroring the Subagents pane next to this one.
   */
  tabId?: string;
  projectRoot?: string;
  registerGuard?: (guard: ((action: () => void, onCancel?: () => void) => void) | null) => void;
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

let registryWriteState = { pending: false, revision: 0 };
const registryWriteListeners = new Set<() => void>();
function subscribeRegistryWrites(listener: () => void): () => void {
  registryWriteListeners.add(listener);
  return () => { registryWriteListeners.delete(listener); };
}
function registryWriteSnapshot() { return registryWriteState; }
function updateRegistryWrite(pending: boolean, saved = false): void {
  registryWriteState = { pending, revision: registryWriteState.revision + (saved ? 1 : 0) };
  registryWriteListeners.forEach((listener) => listener());
}

export function RolesPane({ tabId, projectRoot, registerGuard }: RolesPaneProps = {}): React.JSX.Element {
  const snapshot = useSettingsStore((s) => s.snapshot);
  const setPatch = useSettingsStore((s) => s.setPatch);
  const availableEngines = useTabsStore((s) => s.availableEngines);
  const tabs = useTabsStore((s) => s.tabs);
  const connections = snapshot?.settings.provider.connections ?? [];
  const activeConnectionId = snapshot?.settings.provider.activeConnectionId;
  const engines = useMemo(() => ({ claudeReady: availableEngines.includes("claude"), codexReady: availableEngines.includes("codex") }), [availableEngines]);
  const registry = roleProfiles(snapshot?.settings ?? {});
  const mapping = projectRoot ? registry.projects.find((p) => p.projectRoot === projectRoot) : undefined;
  const mapped = registry.profiles.find((p) => p.id === mapping?.profileId);
  const selected = mapped ?? registry.profiles.find((p) => p.id === registry.activeId);
  const targetKey = `${projectRoot ?? "global"}:${selected ? `profile:${selected.id}` : "implicit"}`;
  const initialRoles = selected?.roles ?? autoSelectPreset(engines, activeConnectionId ?? "").roles;
  const [draft, setDraft] = useState(() => toDraft(initialRoles));
  const [baseline, setBaseline] = useState(() => toDraft(initialRoles));
  const [cap, setCap] = useState(() => selected?.roles.maxParallelChildren?.toString() ?? "");
  const [baselineCap, setBaselineCap] = useState(() => selected?.roles.maxParallelChildren?.toString() ?? "");
  const [notice, setNotice] = useState<{ ok: boolean; message?: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [expanded, setExpanded] = useState<Partial<Record<PresetRole, boolean>>>({});
  const [recovery, setRecovery] = useState<Partial<Record<PresetRole, boolean>>>({});
  const [nameAction, setNameAction] = useState<"new" | "duplicate" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState<{ title: string; body: string; confirmLabel: string; action: () => void; onCancel?: () => void } | null>(null);
  const writeState = useSyncExternalStore(subscribeRegistryWrites, registryWriteSnapshot, registryWriteSnapshot);
  const busy = writeState.pending;
  const seenRevision = useRef(writeState.revision);
  const [sessionProjects, setSessionProjects] = useState<string[]>([]);
  const [addProject, setAddProject] = useState("");
  const [addProfile, setAddProfile] = useState("");
  const [profileOverrides, setProfileOverrides] = useState<Partial<Record<PresetRole, RoleProfileOverride>>>({});
  const engineModels = useRoleEngineModels(engines.codexReady);
  const modelSources = useMemo(() => ({ connections, activeConnectionId, engineModels, catalog: snapshot?.catalog, custom: snapshot?.settings.provider.custom }), [connections, activeConnectionId, engineModels, snapshot]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || cap !== baselineCap;
  useEffect(() => {
    if (!busy || !pending) return;
    setPending(null);
    pending.onCancel?.();
  }, [busy, pending]);
  useEffect(() => {
    const next = toDraft(initialRoles);
    setDraft(next); setBaseline(next);
    const nextCap = selected?.roles.maxParallelChildren?.toString() ?? "";
    setCap(nextCap); setBaselineCap(nextCap); setExpanded({}); setRecovery({}); setNotice(null);
    // The actual target, not readiness or catalog changes, owns the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);
  const rolesKey = selected ? JSON.stringify(selected.roles) : "implicit";
  useEffect(() => {
    if (dirty) return;
    const next = toDraft(initialRoles);
    const nextCap = selected?.roles.maxParallelChildren?.toString() ?? "";
    setDraft(next); setBaseline(next); setCap(nextCap); setBaselineCap(nextCap);
    // Refresh a clean draft when a write from another mount lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolesKey, dirty]);
  useEffect(() => {
    if (seenRevision.current === writeState.revision) return;
    seenRevision.current = writeState.revision;
    const next = toDraft(initialRoles);
    const nextCap = selected?.roles.maxParallelChildren?.toString() ?? "";
    setDraft(next); setBaseline(next); setCap(nextCap); setBaselineCap(nextCap);
    setExpanded({}); setRecovery({});
    // A successful write invalidates drafts held by other mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeState.revision]);
  useEffect(() => {
    let live = true;
    void window.anycode.listSessions().then((sessions) => {
      if (live) setSessionProjects(sessions.map((s) => s.projectRoot ?? s.workspace).filter(isAbsoluteProject));
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const bridge = window.anycode?.subagents;
    if (!bridge) return;
    let live = true;
    void bridge.list(tabId === undefined ? {} : { tabId }).then((result: SubagentsSnapshot) => {
      if (live) setProfileOverrides(claimedRoleOverrides(result.rows, result.roleClaims));
    }).catch(() => { if (live) setProfileOverrides({}); });
    return () => { live = false; };
  }, [tabId, snapshot]);
  const projects = [...new Set([...tabs.map((t) => t.projectRoot ?? t.workspace).filter(isAbsoluteProject), ...sessionProjects, ...registry.projects.map((p) => p.projectRoot)])];
  const projectLabel = (path: string) => projects.filter((p) => projectFolderName(p) === projectFolderName(path)).length > 1 ? `${projectFolderName(path)} — ${path}` : projectFolderName(path);
  function guard(action: () => void, onCancel?: () => void): void {
    if (!dirty) { action(); return; }
    setPending({ title: "Discard unsaved roles?", body: "Your unsaved role changes will be lost.", confirmLabel: "Discard changes", onCancel, action: () => { setDraft(baseline); setCap(baselineCap); action(); } });
  }
  useEffect(() => {
    registerGuard?.(guard);
    return () => registerGuard?.(null);
  });
  async function write(transform: (current: typeof registry) => typeof registry, message = "Profiles saved."): Promise<boolean> {
    if (registryWriteState.pending) return false;
    updateRegistryWrite(true);
    let saved = false;
    try {
      const current = roleProfiles(useSettingsStore.getState().snapshot?.settings ?? {});
      const result = await setPatch({ roleProfiles: transform(current) });
      saved = result.ok;
      setNotice({ ok: result.ok, message: result.ok ? message : "Saving profiles failed." });
      return result.ok;
    } catch {
      setNotice({ ok: false, message: "Saving profiles failed." }); return false;
    } finally { updateRegistryWrite(false, saved); }
  }
  function selectProfile(id: string): void {
    guard(() => { void (async () => { const ok = await write((current) => projectRoot
      ? { ...current, projects: [...current.projects.filter((p) => p.projectRoot !== projectRoot), ...(id ? [{ projectRoot, profileId: id }] : [])] }
      : { ...current, activeId: id }); if (ok && (projectRoot && !id ? registry.activeId : id) === selected?.id) { setDraft(baseline); setCap(baselineCap); } })(); });
  }
  async function submitName(): Promise<void> {
    if (!nameAction) return;
    if (nameAction === "rename") {
      if (!selected || !canRenameProfile(selected.name, name)) return;
      if (await write((current) => ({ ...current, profiles: current.profiles.map((p) => p.id === selected.id ? { ...p, name: name.trim() } : p) }))) setNameAction(null);
      return;
    }
    const action = nameAction;
    const run = async () => {
      const id = crypto.randomUUID();
      const ok = await write((current) => {
        const names = current.profiles.map((p) => p.name);
        const profile = { id, name: action === "duplicate" ? duplicateProfileName(name, names, selected?.name ?? "Default") : createProfileName(name, names), roles: action === "duplicate" ? (selected?.roles ?? fromDraft(toDraft(initialRoles)).roles) : {} };
        return { ...current, profiles: [...current.profiles, profile], ...(projectRoot ? { projects: [...current.projects.filter((p) => p.projectRoot !== projectRoot), { projectRoot, profileId: id }] } : { activeId: id }) };
      });
      if (ok) setNameAction(null);
    };
    guard(() => { void run(); });
  }
  async function save(): Promise<void> {
    if (!parseRoleChildLimitInput(cap).valid) { setNotice({ ok: false, message: ROLE_CHILD_LIMIT_INVALID_MESSAGE }); return; }
    const converted = fromDraft(draft).roles;
    // The built-ins have no profile of their own: saving from them always
    // creates a fresh unique profile, never the legacy "default" id that a
    // saved file may already own.
    const id = selected?.id ?? crypto.randomUUID();
    const ok = await write((current) => {
      const existing = current.profiles.find((p) => p.id === id);
      const roles = existing ? { ...existing.roles } : {};
      for (const role of ROLE_PRESET_ROLES) {
        if (!existing || JSON.stringify(draft[role]) !== JSON.stringify(baseline[role])) roles[role] = converted[role];
      }
      const built = buildRoleProfileRoles(roles, cap);
      if (!built.valid) return current;
      const profile = { id, name: existing?.name ?? createProfileName("", current.profiles.map((p) => p.name)), roles: built.roles };
      return { ...current, profiles: existing ? current.profiles.map((p) => p.id === id ? profile : p) : [...current.profiles, profile], ...(projectRoot ? {} : { activeId: id }), ...(!selected && projectRoot ? { projects: [...current.projects.filter((p) => p.projectRoot !== projectRoot), { projectRoot, profileId: id }] } : {}) };
    }, "Roles saved.");
    if (ok) { setBaseline(draft); setBaselineCap(cap); }
  }
  const title = projectRoot ? mapped ? `project override for ${projectFolderName(projectRoot)}` : `inherited global profile for ${projectFolderName(projectRoot)}` : "";
  return <div className="settings-pane roles-pane" data-testid="settings-roles-pane">
    {busy && <p className="settings-field-hint" role="status">Saving…</p>}
    <div className="roles-header"><span>Profile:</span>
      {registry.profiles.length ? <select className="settings-field-select" aria-label="Role profile" title={selected?.name ?? "Default"} value={projectRoot ? mapped?.id ?? "" : selected?.id ?? ""} disabled={busy} onChange={(e) => selectProfile(e.target.value)}>
        {projectRoot ? <option value="">{`Use global (${registry.profiles.find((p) => p.id === registry.activeId)?.name ?? "Built-in roles"})`}</option> : <option value="">Built-in roles</option>}{registry.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}      </select> : <strong>Built-in roles</strong>}
      {title && <span className="settings-field-hint">({title})</span>}
      <details className="roles-menu"><summary className="settings-button" aria-label="Profile actions">⋯</summary><div className="roles-menu-items">
        {(["new", "duplicate", "rename"] as const).map((action) => <button className="settings-button" type="button" key={action} disabled={busy || (action === "rename" && !selected)} onClick={() => { setNameAction(action); setName(action === "rename" ? selected?.name ?? "" : ""); }}>{action === "new" ? "New" : action === "duplicate" ? "Duplicate" : "Rename"}</button>)}
        <button className="settings-button" type="button" disabled={busy || !selected} onClick={() => { if (!selected) return; guard(() => setPending({ title: `Delete ${selected.name}?`, body: `Project mappings to ${selected.name} will be removed and will use the global profile.`, confirmLabel: "Delete", action: () => { void write((current) => { const profiles = current.profiles.filter((p) => p.id !== selected.id); return { profiles, activeId: current.activeId === selected.id ? "" : current.activeId, projects: current.projects.filter((p) => p.profileId !== selected.id) }; }); } })); }}>Delete</button>
      </div></details>
      <select className="settings-field-select roles-preset" aria-label="Apply preset" value="" disabled={busy} onChange={(e) => { const preset = deriveRolePresets(engines, activeConnectionId ?? "").find((p) => p.id === e.target.value); if (preset) guard(() => { setDraft(toDraft(preset.roles)); setCap(baselineCap); }); }}><option value="">Apply preset…</option>{deriveRolePresets(engines, activeConnectionId ?? "").map((p) => <option key={p.id} value={p.id} disabled={!presetApplicable(p, engines)}>{p.label}</option>)}</select>
    </div>
    {mapping && !mapped && <p className="settings-field-hint">Missing project profile; using the global fallback.</p>}
    {nameAction && <form className="roles-name-form" onSubmit={(e) => { e.preventDefault(); void submitName(); }}><label className="settings-field-label" htmlFor="role-profile-name">{nameAction === "rename" ? "Rename profile" : nameAction === "duplicate" ? "Duplicate profile name" : "New profile name"}</label><input id="role-profile-name" className="settings-field-input" disabled={busy} value={name} onChange={(e) => setName(e.target.value)} /><button className="settings-button settings-button-primary" type="submit" disabled={busy || (nameAction === "rename" && !canRenameProfile(selected?.name, name))}>Save</button><button className="settings-button" type="button" disabled={busy} onClick={() => setNameAction(null)}>Cancel</button></form>}
    <fieldset className="roles-editor" disabled={busy}><div className="roles-table" aria-label="Role routes">{ROLE_PRESET_ROLES.map((role) => {
      const entry = draft[role].primary;
      const unavailable = entry.engine === "claude" ? !engines.claudeReady : entry.engine === "codex" ? !engines.codexReady : false;
      return <section className="roles-row" key={role} data-testid={`role-picker-role-${role}`}><div className="roles-primary"><strong className="roles-role-name">{role}</strong>
        {unavailable && !recovery[role] ? <div className="roles-unavailable">{entry.engine} unavailable <button className="settings-button" type="button" onClick={() => setRecovery((v) => ({ ...v, [role]: true }))}>Change route</button></div> : <EntryRow compact label={`${role} primary`} entry={entry} connections={connections} modelSources={modelSources} onChange={(patch) => setDraft((d) => patchEntry(d, role, null, patch))} />}
        <button type="button" className="settings-button roles-fallback-toggle" aria-expanded={!!expanded[role]} onClick={() => setExpanded((v) => ({ ...v, [role]: !v[role] }))}>{draft[role].fallbacks.length ? `+${draft[role].fallbacks.length} fallback${draft[role].fallbacks.length === 1 ? "" : "s"}` : "Add fallback"}</button></div>
        {profileOverrides[role] && <p className="role-picker-role-override" role="status" data-testid={`role-route-overridden-${role}`}>{roleOverrideNotice(profileOverrides[role]!)}</p>}
        {expanded[role] && <div className="roles-fallbacks">{draft[role].fallbacks.map((fallback, index) => <EntryRow compact key={index} label={`${role} fallback ${index + 1}`} entry={fallback} connections={connections} modelSources={modelSources} onChange={(patch) => setDraft((d) => patchEntry(d, role, index, patch))} onRemove={() => setDraft((d) => removeFallback(d, role, index))} onMove={advanced ? (delta) => setDraft((d) => moveFallback(d, role, index, delta)) : undefined} />)}<button type="button" className="settings-button" onClick={() => setDraft((d) => addFallback(d, role))}>Add fallback</button></div>}
      </section>;
    })}</div>
    </fieldset>
    {!draftValid(draft) && <p className="settings-notice" role="alert">An entry cannot select more than one engine, connection, or provider.</p>}
    <div className="roles-actions"><button type="button" className="settings-button settings-button-primary" data-testid="role-picker-save" disabled={busy || !draftValid(draft)} onClick={() => void save()}>Save roles</button>{notice && <RolesSaveNotice ok={notice.ok} message={notice.message} />}</div>
    <details onToggle={(e) => setAdvanced(e.currentTarget.open)}><summary className="settings-button">Advanced {(selected?.roles.maxParallelChildren !== undefined || ROLE_PRESET_ROLES.some((role) => (selected?.roles[role]?.fallbacks?.length ?? 0) > 1)) && <span className="roles-badge">Configured</span>}</summary><label className="settings-field"><span className="settings-field-label">Max parallel children</span><input className="settings-field-input" type="text" inputMode="numeric" aria-label="Max parallel children" disabled={busy} value={cap} onChange={(e) => setCap(e.target.value)} /><span className="settings-field-hint">Optional limit (1–16); blank uses the session limit, default 3.</span></label></details>
    <details><summary className="settings-button">Per-project profiles ({registry.projects.length})</summary><div className="roles-projects">{registry.projects.map((p) => <div className="roles-project" key={p.projectRoot}><span title={p.projectRoot}>{projectLabel(p.projectRoot)}</span><span>{registry.profiles.find((profile) => profile.id === p.profileId)?.name ?? "Missing profile (using global fallback)"}</span><button type="button" className="settings-button" disabled={busy} aria-label={`Remove profile for ${p.projectRoot}`} onClick={() => { const run = () => { void write((current) => ({ ...current, projects: current.projects.filter((entry) => entry.projectRoot !== p.projectRoot) })); }; if (projectRoot === p.projectRoot) guard(run); else run(); }}>Remove</button></div>)}
      <div className="roles-project"><select className="settings-field-select" aria-label="Project to add" disabled={busy} value={addProject} onChange={(e) => setAddProject(e.target.value)}><option value="">Select project</option>{projects.map((p) => <option key={p} value={p}>{projectLabel(p)}</option>)}</select><select className="settings-field-select" aria-label="Profile to add" disabled={busy} value={addProfile} onChange={(e) => setAddProfile(e.target.value)}><option value="">Select profile</option>{registry.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="settings-button" type="button" disabled={busy || !addProject || !addProfile} onClick={() => { const run = () => { void write((current) => ({ ...current, projects: [...current.projects.filter((p) => p.projectRoot !== addProject), { projectRoot: addProject, profileId: addProfile }] })); }; if (projectRoot === addProject) guard(run); else run(); }}>Add</button></div></div></details>
    <ConfirmDialog request={busy ? null : pending} onCancel={() => { const cancel = pending?.onCancel; setPending(null); cancel?.(); }} onConfirm={() => { const action = pending?.action; setPending(null); action?.(); }} />
  </div>;
}

function isAbsoluteProject(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** The save result remains visible until the next save. */
export function RolesSaveNotice({ ok, message }: { ok: boolean; message?: string }): React.JSX.Element {
  return (
    <p className={ok ? "settings-notice-ok" : "settings-notice"} role="status">
      {message ?? (ok ? "Roles saved." : "Saving roles failed.")}
    </p>
  );
}

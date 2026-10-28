import type { AnycodeSettings } from "./settings.js";

type Registry = NonNullable<AnycodeSettings["roleProfiles"]>;

/**
 * The active-profile value that means "built-in defaults". Both the read and
 * write schemas require a NONEMPTY `activeId`, so the global profile select
 * cannot store an empty string to mean "no custom profile" — the settings IPC
 * refused that patch and the choice silently did nothing. A reserved id is a
 * valid nonempty value that resolves to no stored roles (built-in defaults),
 * while leaving every saved profile intact and re-selectable.
 */
export const BUILT_IN_PROFILE_ID = "builtin";

/** Legacy settings behave as an implicit first profile until explicitly saved. */
export function roleProfiles(settings: Pick<AnycodeSettings, "roles" | "roleProfiles">): Registry {
  return settings.roleProfiles ?? { profiles: settings.roles ? [{ id: "default", name: "Default", roles: settings.roles }] : [], activeId: "default", projects: [] };
}
export function resolveProfileRoles(settings: Pick<AnycodeSettings, "roles" | "roleProfiles">, projectRoot?: string): AnycodeSettings["roles"] {
  const registry = roleProfiles(settings);
  const projectId = registry.projects.find((entry) => entry.projectRoot === projectRoot)?.profileId;
  // The sentinel never resolves to a stored profile (even one whose id happens
  // to collide), and it also suppresses the legacy `roles` fallback: the user
  // explicitly asked for the built-ins.
  const globalRoles = registry.activeId === BUILT_IN_PROFILE_ID
    ? undefined
    : registry.profiles.find((profile) => profile.id === registry.activeId)?.roles;
  return registry.profiles.find((profile) => profile.id === projectId)?.roles
    ?? globalRoles
    ?? (settings.roleProfiles ? undefined : settings.roles);
}

/** First-run editor updates the profile that actually applies to the project. */
export function rolesPatch(settings: Pick<AnycodeSettings, "roles" | "roleProfiles">, roles: NonNullable<AnycodeSettings["roles"]>, projectRoot?: string): Partial<AnycodeSettings> {
  if (!settings.roleProfiles) return { roles };
  const registry = settings.roleProfiles;
  const projectId = registry.projects.find((p) => p.projectRoot === projectRoot)?.profileId;
  const id = registry.profiles.find((p) => p.id === projectId)?.id
    ?? registry.profiles.find((p) => p.id === registry.activeId)?.id ?? "default";
  const profile = registry.profiles.find((p) => p.id === id);
  return { roleProfiles: { ...registry, activeId: projectId === id || registry.profiles.some((p) => p.id === registry.activeId) ? registry.activeId : id, profiles: [...registry.profiles.filter((p) => p.id !== id), { id, name: profile?.name ?? "Default", roles }] } };
}

import type { AnycodeSettings } from "./settings.js";

type Registry = NonNullable<AnycodeSettings["roleProfiles"]>;
/** Legacy settings behave as an implicit first profile until explicitly saved. */
export function roleProfiles(settings: Pick<AnycodeSettings, "roles" | "roleProfiles">): Registry {
  return settings.roleProfiles ?? { profiles: settings.roles ? [{ id: "default", name: "Default", roles: settings.roles }] : [], activeId: "default", projects: [] };
}
export function resolveProfileRoles(settings: Pick<AnycodeSettings, "roles" | "roleProfiles">, projectRoot?: string): AnycodeSettings["roles"] {
  const registry = roleProfiles(settings);
  const projectId = registry.projects.find((entry) => entry.projectRoot === projectRoot)?.profileId;
  return registry.profiles.find((profile) => profile.id === projectId)?.roles
    ?? registry.profiles.find((profile) => profile.id === registry.activeId)?.roles
    ?? (settings.roleProfiles ? undefined : settings.roles);
}

/** The first free name in the `Profile 1`, `Profile 2`, … series (mirrors role-profile-controls). */
function nextProfileName(existing: readonly string[]): string {
  let ordinal = 1;
  while (existing.includes(`Profile ${ordinal}`)) ordinal += 1;
  return `Profile ${ordinal}`;
}

/** First-run editor updates the profile that actually applies to the project. */
export function rolesPatch(settings: Pick<AnycodeSettings, "roles" | "roleProfiles">, roles: NonNullable<AnycodeSettings["roles"]>, projectRoot?: string): Partial<AnycodeSettings> {
  if (!settings.roleProfiles) return { roles };
  const registry = settings.roleProfiles;
  const projectId = registry.projects.find((p) => p.projectRoot === projectRoot)?.profileId;
  // Built-ins have no profile of their own: when neither the project mapping
  // nor the active id matches, first-run save creates a fresh unique profile
  // (UUID id + unique name) instead of writing the legacy "default" id that a
  // saved file may already own.
  const id = registry.profiles.find((p) => p.id === projectId)?.id
    ?? registry.profiles.find((p) => p.id === registry.activeId)?.id
    ?? crypto.randomUUID();
  const profile = registry.profiles.find((p) => p.id === id);
  return { roleProfiles: { ...registry, activeId: projectId === id || registry.profiles.some((p) => p.id === registry.activeId) ? registry.activeId : id, profiles: [...registry.profiles.filter((p) => p.id !== id), { id, name: profile?.name ?? nextProfileName(registry.profiles.map((p) => p.name)), roles }] } };
}

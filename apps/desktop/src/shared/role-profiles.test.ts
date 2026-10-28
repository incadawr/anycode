import { describe, expect, it } from "vitest";
import { BUILT_IN_PROFILE_ID, roleProfiles, resolveProfileRoles, rolesPatch } from "./role-profiles.js";
import { cloneDefaults, mergeSettings, roleProfilesSchema, roleProfilesWriteSchema, settingsSchema } from "../settings/schema.js";

const legacy = { executor: { primary: { engine: "claude" as const } }, maxParallelChildren: 3 };
const other = { executor: { primary: { engine: "codex" as const } } };
const registry = { profiles: [{ id: "a", name: "A", roles: legacy }, { id: "b", name: "B", roles: other }], activeId: "a", projects: [{ projectRoot: "/project", profileId: "b" }] };
describe("role profiles", () => {
  it("migrates legacy roles without changing their value", () => {
    expect(roleProfiles({ roles: legacy }).profiles[0]?.roles).toEqual(legacy);
    expect(resolveProfileRoles({ roles: legacy })).toEqual(legacy);
  });
  it("resolves project, global, and built-in, including missing IDs", () => {
    expect(resolveProfileRoles({ roleProfiles: registry }, "/project")).toEqual(other);
    expect(resolveProfileRoles({ roleProfiles: registry }, "/other")).toEqual(legacy);
    expect(resolveProfileRoles({ roleProfiles: { ...registry, projects: [{ projectRoot: "/project", profileId: "missing" }] } }, "/project")).toEqual(legacy);
    expect(resolveProfileRoles({ roleProfiles: { ...registry, activeId: "missing" } }, "/other")).toBeUndefined();
  });
  it("first-run saves the project profile without changing the global profile", () => {
    const patch = rolesPatch({ roleProfiles: registry }, { planner: { primary: { model: "project-model" } } }, "/project");
    expect(patch.roleProfiles?.activeId).toBe("a");
    expect(patch.roleProfiles?.profiles.find((p) => p.id === "a")?.roles).toEqual(legacy);
    expect(resolveProfileRoles(patch, "/project")).toEqual({ planner: { primary: { model: "project-model" } } });
    expect(resolveProfileRoles(patch, "/other")).toEqual(legacy);
  });
  it("first-run writes the global profile when the project reference is missing", () => {
    const dangling = { ...registry, projects: [{ projectRoot: "/project", profileId: "missing" }] };
    const patch = rolesPatch({ roleProfiles: dangling }, other, "/project");
    expect(resolveProfileRoles(patch, "/project")).toEqual(other);
    expect(patch.roleProfiles?.activeId).toBe("a");
  });
  it("validates registry and updates first-run selected profile", () => {
    expect(roleProfilesSchema.safeParse(registry).success).toBe(true);
    expect(roleProfilesWriteSchema.safeParse({ ...registry, profiles: [{ id: "x", name: "X", roles: { maxParallelChildren: 100 } }] }).success).toBe(false);
    expect(roleProfilesSchema.safeParse({ ...registry, projects: [{ projectRoot: "relative", profileId: "b" }] }).success).toBe(false);
    expect(roleProfilesSchema.safeParse({ ...registry, profiles: [registry.profiles[0], registry.profiles[0]] }).success).toBe(false);
    expect(rolesPatch({ roleProfiles: registry }, other).roleProfiles?.profiles.find((p) => p.id === "a")?.roles).toEqual(other);
  });
  it("selecting built-in defaults is a valid registry whose roles resolve to the built-ins", () => {
    const builtIn = { ...registry, activeId: BUILT_IN_PROFILE_ID };
    // The settings IPC's write gate AND the read-time whole-document gate both
    // accept it (an empty activeId is what used to be refused).
    expect(roleProfilesWriteSchema.safeParse(builtIn).success).toBe(true);
    expect(roleProfilesSchema.safeParse(builtIn).success).toBe(true);
    expect(settingsSchema.safeParse(mergeSettings(cloneDefaults(), { roleProfiles: builtIn })).success).toBe(true);
    expect(roleProfiles({ roleProfiles: builtIn }).activeId).toBe(BUILT_IN_PROFILE_ID);
    // No stored roles apply; every profile survives and stays re-selectable.
    expect(resolveProfileRoles({ roleProfiles: builtIn }, "/other")).toBeUndefined();
    expect(builtIn.profiles.map((p) => p.id)).toEqual(["a", "b"]);
    // A project-specific profile still wins over the global built-ins.
    expect(resolveProfileRoles({ roleProfiles: builtIn }, "/project")).toEqual(other);
    // A profile whose id happens to equal the sentinel never becomes active.
    expect(resolveProfileRoles({ roleProfiles: { profiles: [{ id: BUILT_IN_PROFILE_ID, name: "Trap", roles: other }], activeId: BUILT_IN_PROFILE_ID, projects: [] } })).toBeUndefined();
  });
});

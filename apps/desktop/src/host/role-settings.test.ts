import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
import { readRoleSettings } from "./role-settings.js";

describe("host role settings", () => {
  it("reads the supplied settings file and resolves project routes after changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-role-settings-"));
    try {
      const path = join(dir, "settings.json");
      const global = { executor: { primary: { model: "global" } } };
      const project = { executor: { primary: { model: "project" } } };
      const settings = { ...cloneDefaults(), roleProfiles: {
        profiles: [{ id: "global", name: "Global", roles: global }, { id: "project", name: "Project", roles: project }],
        activeId: "global", projects: [{ projectRoot: "/project", profileId: "project" }],
      } };
      writeFileSync(path, JSON.stringify(settings));
      expect(readRoleSettings(path, "/project")).toEqual(project);
      expect(readRoleSettings(path, "/other")).toEqual(global);
      settings.roleProfiles.projects = [];
      writeFileSync(path, JSON.stringify(settings));
      expect(readRoleSettings(path, "/project")).toEqual(global);
      expect(readRoleSettings(join(dir, "missing"), "/project")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * Settings → Roles profile controls: creating with an empty name must not pile
 * up identically named profiles, Rename must be usable for a custom profile,
 * and the project picker shows a folder name.
 */
import { describe, expect, it } from "vitest";
import {
  canRenameProfile,
  copySeriesBaseName,
  createProfileName,
  duplicateProfileName,
  nextProfileName,
  projectFolderName,
  uniqueProfileName,
} from "./role-profile-controls.js";

describe("profile names", () => {
  it("create uses the typed name", () => {
    expect(createProfileName("Fresh", ["Profile 1"])).toBe("Fresh");
    expect(createProfileName("  Fresh  ", [])).toBe("Fresh");
  });

  it("create with an empty name takes the next free Profile N", () => {
    expect(createProfileName("", [])).toBe("Profile 1");
    expect(createProfileName("   ", ["Profile 1"])).toBe("Profile 2");
    // Old rows that were all named "New profile" never collide either.
    expect(createProfileName("", ["New profile", "New profile"])).toBe("Profile 1");
    expect(createProfileName("", ["Profile 1", "Profile 3"])).toBe("Profile 2");
    expect(nextProfileName(["Profile 1", "Profile 2"])).toBe("Profile 3");
  });

  it("duplicate falls back to a unique '<source> copy'", () => {
    expect(duplicateProfileName("", [], "Profile 1")).toBe("Profile 1 copy");
    expect(duplicateProfileName("", ["Profile 1 copy"], "Profile 1")).toBe("Profile 1 copy 2");
    expect(duplicateProfileName("", [], undefined)).toBe("Copy");
    expect(duplicateProfileName("Copied", [], "Profile 1")).toBe("Copied");
    expect(uniqueProfileName(["A"], "A")).toBe("A 2");
    expect(uniqueProfileName(["A", "A 2"], "A")).toBe("A 3");
  });

  it("duplicating an untouched copy continues the series instead of chaining ' copy copy'", () => {
    expect(copySeriesBaseName("Team")).toBe("Team");
    expect(copySeriesBaseName("Team copy")).toBe("Team");
    expect(copySeriesBaseName("Team copy 2")).toBe("Team");
    expect(duplicateProfileName("", ["Team", "Team copy"], "Team copy")).toBe("Team copy 2");
    expect(duplicateProfileName("", ["Team", "Team copy", "Team copy 2"], "Team copy 2")).toBe("Team copy 3");
  });
});

describe("canRenameProfile", () => {
  it("needs a custom profile and a name that actually changes", () => {
    expect(canRenameProfile(undefined, "Fresh")).toBe(false);
    expect(canRenameProfile("Profile 1", "")).toBe(false);
    expect(canRenameProfile("Profile 1", "   ")).toBe(false);
    expect(canRenameProfile("Profile 1", "Profile 1")).toBe(false);
    expect(canRenameProfile("Profile 1", "Fresh")).toBe(true);
  });
});

describe("projectFolderName", () => {
  it("shows the folder name, with the full path kept as a tooltip", () => {
    expect(projectFolderName("/Users/me/Projects/AnyCode")).toBe("AnyCode");
    expect(projectFolderName("/private/tmp/anycode-live/uiux-b/ws")).toBe("ws");
    expect(projectFolderName("/private/tmp/uiux-b/ws/")).toBe("ws");
    expect(projectFolderName("/")).toBe("/");
    expect(projectFolderName("relative-project")).toBe("relative-project");
  });
});

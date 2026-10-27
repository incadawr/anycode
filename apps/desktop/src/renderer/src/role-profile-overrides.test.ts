/**
 * `.anycode/agents/reviewer.md` claims the
 * `reviewer` role and silently beats the Settings route (host/index.ts's
 * `resolveRoleRouteImpl` answers null for a claimed role). Settings → Roles must
 * therefore name the claiming file, and stop naming it once the profile is gone.
 * These tests pin the projection the pane renders.
 */
import { describe, expect, it } from "vitest";
import { claimedRoleOverrides, roleOverrideNotice } from "./role-profile-overrides.js";
import type { SubagentRowView } from "../../shared/subagents-config.js";

const row = (name: string, sourceKind: SubagentRowView["sourceKind"], path?: string): SubagentRowView => ({
  name,
  description: "",
  toolsBadge: "All tools",
  toolCount: 0,
  source: sourceKind,
  sourceKind,
  editable: sourceKind === "project" || sourceKind === "user",
  ...(path !== undefined ? { path } : {}),
});

// The built-in personas ARE named after the roles — they must never read as a
// claim, or every installation would show the warning.
const builtins = ["planner", "executor", "reviewer", "explore", "orchestrator"].map((name) => row(name, "builtin"));

describe("claimedRoleOverrides — a profile claims a role by EXACTLY its name", () => {
  it("reports a project profile that claims a role, with the file to remove", () => {
    const overrides = claimedRoleOverrides([...builtins, row("reviewer", "project", "/ws/.anycode/agents/reviewer.md")]);
    expect(overrides.reviewer).toEqual({
      role: "reviewer",
      profileName: "reviewer",
      path: "/ws/.anycode/agents/reviewer.md",
    });
    expect(roleOverrideNotice(overrides.reviewer!)).toContain("/ws/.anycode/agents/reviewer.md");
    expect(roleOverrideNotice(overrides.reviewer!)).toContain("Settings route is not used");
    // Only the claimed role is affected — planner keeps its Settings route.
    expect(overrides.planner).toBeUndefined();
  });

  it("drops the notice again when the profile is removed (the removal half)", () => {
    const withProfile = claimedRoleOverrides([...builtins, row("reviewer", "project", "/ws/.anycode/agents/reviewer.md")]);
    expect(withProfile.reviewer).toBeDefined();
    const afterRemoval = claimedRoleOverrides([...builtins]);
    expect(afterRemoval).toEqual({});
  });

  it("counts user- and plugin-level profiles too, and keeps discovery precedence", () => {
    const overrides = claimedRoleOverrides([
      row("executor", "project", "/ws/.anycode/agents/executor.md"),
      row("executor", "user", "/home/u/.anycode/agents/executor.md"),
      row("planner", "plugin", "/plugins/p/agents/planner.md"),
    ]);
    // First row wins: the project file is what the host resolves.
    expect(overrides.executor?.path).toBe("/ws/.anycode/agents/executor.md");
    expect(overrides.planner?.path).toBe("/plugins/p/agents/planner.md");
  });

  it("never reports a non-route name (orchestrator) or a non-role profile", () => {
    expect(claimedRoleOverrides([row("orchestrator", "project", "/ws/.anycode/agents/orchestrator.md")])).toEqual({});
    expect(claimedRoleOverrides([row("my-helper", "project", "/ws/.anycode/agents/my-helper.md")])).toEqual({});
  });

  it("falls back to the conventional path when a row carries none", () => {
    const overrides = claimedRoleOverrides([row("explore", "plugin")]);
    expect(roleOverrideNotice(overrides.explore!)).toContain(".anycode/agents/explore.md");
  });
});

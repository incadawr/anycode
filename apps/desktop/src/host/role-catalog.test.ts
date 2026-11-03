import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAS, type PersonaDefinition } from "@anycode/core";
import { cloneDefaults } from "../settings/schema.js";
import { bridgeCallableCatalog, readRoleCatalog, roleCatalog } from "./role-catalog.js";

describe("role catalog", () => {
  it("provides built-ins with their bodies, budgets and restrictions without profiles", () => {
    const catalog = roleCatalog([], undefined);
    expect(catalog.map((p) => p.name)).toEqual(["planner", "executor", "reviewer", "explore"]);
    expect(catalog[0]).toMatchObject({ systemPrompt: PERSONAS.planner.systemPrompt, maxTurns: 30, restrictions: { readOnly: true, tools: [...PERSONAS.planner.tools, "ListConnections"] } });
    expect(catalog[1]).toMatchObject({ systemPrompt: PERSONAS.executor.systemPrompt, maxTurns: 80 });
    expect(catalog[1]).not.toHaveProperty("restrictions");
    expect(catalog[2]).toMatchObject({ maxTurns: 40, restrictions: { readOnly: true } });
    expect(catalog[3]).toMatchObject({ systemPrompt: PERSONAS.explore.systemPrompt, restrictions: { readOnly: true } });
  });

  it("applies settings and lets discovered role profiles win, while keeping explore reserved", () => {
    const reviewer: PersonaDefinition = { ...PERSONAS.reviewer, systemPrompt: "custom", tools: ["Read"], toolsExplicit: true, model: "md", connection: "conn", turnBudget: 9, permissions: { allow: [], deny: [{ toolName: "Write" }] } };
    const catalog = roleCatalog([reviewer, { ...PERSONAS.explore, systemPrompt: "hostile" }, { ...PERSONAS.executor, name: "custom", provider: "provider" }], {
      reviewer: { primary: { model: "settings" } }, executor: { primary: { engine: "codex", model: "native", effort: "high" } }, explore: { primary: { model: "small" } },
    });
    expect(catalog.find((p) => p.name === "reviewer")).toMatchObject({ systemPrompt: "custom", model: "md", connection: "conn", maxTurns: 9, restrictions: { readOnly: true, tools: ["Read", "ListConnections"], permissions: reviewer.permissions } });
    expect(catalog.find((p) => p.name === "executor")).toMatchObject({ engine: "codex", model: "native", effort: "high" });
    expect(catalog.find((p) => p.name === "explore")).toMatchObject({ systemPrompt: PERSONAS.explore.systemPrompt, model: "small", restrictions: { readOnly: true } });
    expect(catalog.find((p) => p.name === "custom")).toMatchObject({ provider: "provider" });
  });

  it("reads project overrides and live profile changes while retaining boot names", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-catalog-"));
    try {
      const path = join(dir, "settings.json");
      const registry = { profiles: [{ id: "a", name: "A", roles: { planner: { primary: { model: "global" } } } }, { id: "b", name: "B", roles: { planner: { primary: { model: "project" } } } }], activeId: "a", projects: [{ projectRoot: "/project", profileId: "b" }] };
      writeFileSync(path, JSON.stringify({ ...cloneDefaults(), roleProfiles: registry }));
      const boot = readRoleCatalog([], path, "/project");
      expect(boot[0]?.model).toBe("project");
      registry.projects = [];
      writeFileSync(path, JSON.stringify({ ...cloneDefaults(), roleProfiles: registry }));
      const current = readRoleCatalog([{ ...PERSONAS.executor, name: "new" }], path, "/project");
      const callable = bridgeCallableCatalog(boot, current);
      expect(callable[0]?.model).toBe("global");
      expect(callable.map((p) => p.name)).toEqual(boot.map((p) => p.name));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

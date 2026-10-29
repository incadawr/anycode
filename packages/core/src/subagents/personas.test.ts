/**
 * Persona registry + runner-stub guards (Phase 3 slice 3.1, design §3.6). The
 * persona tool sets are a frozen contract that slices 3.1.2/3.3 build on, so the
 * derivation rules are pinned here against the real default registry.
 */

import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../tools/registry.js";
import {
  OVERRIDABLE_PERSONAS,
  PERSONAS,
  ROLE_TURN_BUDGETS,
  getPersona,
  isKnownPersona,
  isReservedPersonaName,
  listPersonaNames,
} from "./personas.js";

describe("personas", () => {
  const registry = createDefaultToolRegistry();

  it("exposes exactly the two legacy built-ins plus the three role personas (Taskana 4704)", () => {
    expect(listPersonaNames().sort()).toEqual([
      "executor",
      "explore",
      "general-purpose",
      "planner",
      "reviewer",
    ]);
  });

  it("general-purpose is exactly the default tools minus Agent, Skill, and Workflow (spawn/child locks)", () => {
    const defaults = registry.list().sort();
    // Agent and Workflow are withheld by the non-recursion lock (SPAWN_TOOLS);
    // Skill is withheld because a child subagent inherits no SkillPort in v1
    // (design §2.7 — persona tool lists are unchanged by slices 3.3/3.4).
    // ArchMap (TASK.233 S1) is a parent-session tool that is opt-in at the
    // REGISTRY level since Taskana 4162 (default off): the filter below keeps
    // holding even in a flag-on boot, where personas.ts still deliberately
    // does not grant it to children.
    // WebSearch is NOT a default either (Taskana 4095 follow-up): it is
    // factory-built at boot only when a search backend is configured, and
    // handing it to every general-purpose child would make paid search a new
    // silent default. A child gets it only when its persona/profile `tools:`
    // list or the workflow step that spawned it names it explicitly.
    const expected = defaults.filter(
      (name) =>
        name !== "Agent" && name !== "Skill" && name !== "Workflow" && name !== "ArchMap",
    );
    expect([...PERSONAS["general-purpose"].tools].sort()).toEqual(expected);
    expect(PERSONAS["general-purpose"].tools).not.toContain("Agent");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Skill");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Workflow");
    expect(PERSONAS["general-purpose"].tools).not.toContain("ArchMap");
    expect(PERSONAS["general-purpose"].tools).not.toContain("WebSearch");
  });

  it("general-purpose carries WebFetch; neither built-in persona carries WebSearch", () => {
    // WebFetch stays a default (free, no backend). WebSearch is opt-in per
    // child (Taskana 4095 follow-up): md-profile `tools:` frontmatter or a
    // workflow step's `tools:` entry — the runner threads the boot tool in
    // only then (see runner tests).
    expect(PERSONAS["general-purpose"].tools).toContain("WebFetch");
    expect(PERSONAS["general-purpose"].tools).not.toContain("WebSearch");
    // Explore is deliberately unchanged: recon stays fetch-only, no search.
    expect(PERSONAS.explore.tools).toContain("WebFetch");
    expect(PERSONAS.explore.tools).not.toContain("WebSearch");
  });

  it("explore is a strict read-only subset with no Bash (design R7)", () => {
    expect([...PERSONAS.explore.tools].sort()).toEqual([
      "Git",
      "Glob",
      "Grep",
      "Read",
      "TodoRead",
      "TodoWrite",
      "WebFetch",
    ]);
    expect(PERSONAS.explore.tools).not.toContain("Bash");
    expect(PERSONAS.explore.tools).not.toContain("Agent");
    for (const name of PERSONAS.explore.tools) {
      expect(registry.getMetadata(name)?.readOnly, `${name} must be readOnly`).toBe(true);
    }
  });

  it("isKnownPersona narrows only registered names", () => {
    expect(isKnownPersona("explore")).toBe(true);
    expect(isKnownPersona("general-purpose")).toBe(true);
    expect(isKnownPersona("nope")).toBe(false);
    expect(getPersona("explore").name).toBe("explore");
  });

  // Taskana 4704 §5: the three role personas exist with expected
  // tools/turnBudgets/prompt substrings.
  it("planner exists with explore-equal read-only tools, budget 30, and its prompt body", () => {
    const planner = PERSONAS.planner;
    expect([...planner.tools]).toEqual([...PERSONAS.explore.tools]);
    expect(planner.tools).not.toContain("Bash");
    expect(planner.turnBudget).toBe(30);
    expect(ROLE_TURN_BUDGETS.planner).toBe(30);
    expect(planner.systemPrompt).toContain("read-only senior engineer");
  });

  it("executor exists with general-purpose-equal tools, budget 80, and its prompt body", () => {
    const executor = PERSONAS.executor;
    expect([...executor.tools]).toEqual([...PERSONAS["general-purpose"].tools]);
    expect(executor.turnBudget).toBe(80);
    expect(ROLE_TURN_BUDGETS.executor).toBe(80);
    expect(executor.systemPrompt).toContain("implement a written brief literally");
  });

  it("reviewer exists with read-only tools plus Bash, budget 40, and its prompt body", () => {
    const reviewer = PERSONAS.reviewer;
    expect([...reviewer.tools]).toEqual([...PERSONAS.explore.tools, "Bash"]);
    expect(reviewer.turnBudget).toBe(40);
    expect(ROLE_TURN_BUDGETS.reviewer).toBe(40);
    expect(reviewer.systemPrompt).toContain("CLEAN, MINOR, or DEFECTS");
  });

  it("OVERRIDABLE_PERSONAS is exactly the three role personas; the legacy built-ins stay reserved", () => {
    expect([...OVERRIDABLE_PERSONAS].sort()).toEqual(["executor", "planner", "reviewer"]);
    expect(isReservedPersonaName("planner")).toBe(false);
    expect(isReservedPersonaName("executor")).toBe(false);
    expect(isReservedPersonaName("reviewer")).toBe(false);
    expect(isReservedPersonaName("general-purpose")).toBe(true);
    expect(isReservedPersonaName("explore")).toBe(true);
    expect(isReservedPersonaName("nope")).toBe(false);
  });

  it("every persona tool is a real registered tool", () => {
    for (const persona of Object.values(PERSONAS)) {
      for (const name of persona.tools) {
        expect(registry.has(name), `${persona.name} references unknown tool ${name}`).toBe(true);
      }
    }
    // WebSearch is factory-built at boot only when a search backend is
    // configured, so the bare default registry never carries it — and no
    // built-in persona may list it (Taskana 4095 follow-up: opt-in per child).
    expect(registry.has("WebSearch")).toBe(false);
  });

  it("the built-ins stay model-agnostic data (Taskana 4131 adds no hardcoded id)", () => {
    // 4131 makes the explore model a HOST-CONFIGURED default (runner option
    // fed by ANYCODE_EXPLORE_MODEL), never a field on the built-in persona.
    for (const persona of [PERSONAS.explore, PERSONAS["general-purpose"]]) {
      expect("model" in persona).toBe(false);
      expect("turnBudget" in persona).toBe(false);
      expect("effort" in persona).toBe(false);
      expect("engine" in persona).toBe(false);
    }
  });
});

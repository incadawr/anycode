/**
 * Persona registry + runner-stub guards (Phase 3 slice 3.1, design §3.6). The
 * persona tool sets are a frozen contract that slices 3.1.2/3.3 build on, so the
 * derivation rules are pinned here against the real default registry.
 */

import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { PERSONAS, getPersona, isKnownPersona, listPersonaNames } from "./personas.js";

describe("personas", () => {
  const registry = createDefaultToolRegistry();

  it("exposes exactly general-purpose and explore", () => {
    expect(listPersonaNames().sort()).toEqual(["explore", "general-purpose"]);
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
    const expected = defaults.filter(
      (name) =>
        name !== "Agent" && name !== "Skill" && name !== "Workflow" && name !== "ArchMap",
    );
    expect([...PERSONAS["general-purpose"].tools].sort()).toEqual(expected);
    expect(PERSONAS["general-purpose"].tools).not.toContain("Agent");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Skill");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Workflow");
    expect(PERSONAS["general-purpose"].tools).not.toContain("ArchMap");
  });

  it("explore is a strict read-only subset with no Bash (design R7)", () => {
    expect([...PERSONAS.explore.tools].sort()).toEqual([
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

  it("every persona tool is a real registered tool", () => {
    for (const persona of Object.values(PERSONAS)) {
      for (const name of persona.tools) {
        expect(registry.has(name), `${persona.name} references unknown tool ${name}`).toBe(true);
      }
    }
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

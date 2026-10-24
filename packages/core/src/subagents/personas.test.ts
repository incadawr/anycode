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
    // WebSearch is NOT a default either (Taskana 4095 follow-up): it is
    // factory-built at boot only when a search backend is configured, and
    // handing it to every general-purpose child would make paid search a new
    // silent default. A child gets it only when its persona/profile `tools:`
    // list or the workflow step that spawned it names it explicitly.
    const expected = defaults.filter(
      (name) => name !== "Agent" && name !== "Skill" && name !== "Workflow",
    );
    expect([...PERSONAS["general-purpose"].tools].sort()).toEqual(expected);
    expect(PERSONAS["general-purpose"].tools).not.toContain("Agent");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Skill");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Workflow");
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
    // WebSearch is factory-built at boot only when a search backend is
    // configured, so the bare default registry never carries it — and no
    // built-in persona may list it (Taskana 4095 follow-up: opt-in per child).
    expect(registry.has("WebSearch")).toBe(false);
  });
});

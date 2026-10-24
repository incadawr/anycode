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
    // WebSearch is the one ADDITION over that set: factory-built at boot only
    // when a search backend is configured, so the bare default registry here
    // does not carry it, but the persona still lists it (the runner threads
    // the boot tool in when present; absent => silent skip).
    const expected = defaults.filter(
      (name) => name !== "Agent" && name !== "Skill" && name !== "Workflow",
    );
    expect([...PERSONAS["general-purpose"].tools].sort()).toEqual([...expected, "WebSearch"].sort());
    expect(PERSONAS["general-purpose"].tools).not.toContain("Agent");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Skill");
    expect(PERSONAS["general-purpose"].tools).not.toContain("Workflow");
  });

  it("general-purpose carries WebFetch and (backend-conditional) WebSearch; explore stays fetch-only", () => {
    // WebSearch is listed even though it is only registered into a child
    // registry when boot supplied the tool (see runner tests): listing it is
    // what makes the runner thread it in; an unconfigured site keeps the
    // silent-skip miss path.
    expect(PERSONAS["general-purpose"].tools).toContain("WebFetch");
    expect(PERSONAS["general-purpose"].tools).toContain("WebSearch");
    expect(PERSONAS["general-purpose"].tools.indexOf("WebSearch")).toBe(
      PERSONAS["general-purpose"].tools.indexOf("WebFetch") + 1,
    );
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

  it("every persona tool is a real registered tool, or the backend-conditional WebSearch", () => {
    for (const persona of Object.values(PERSONAS)) {
      for (const name of persona.tools) {
        // WebSearch is the ONE deliberate exception: factory-built at boot
        // only when a search backend is configured, so the bare default
        // registry (built here without options) does not carry it.
        if (name === "WebSearch") {
          expect(registry.has(name), "WebSearch must NOT be in the bare default registry").toBe(false);
          continue;
        }
        expect(registry.has(name), `${persona.name} references unknown tool ${name}`).toBe(true);
      }
    }
  });
});

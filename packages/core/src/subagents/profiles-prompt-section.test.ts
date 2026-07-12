/**
 * Agent-profiles prompt-section matrix (Phase 3 slice 3.7, design
 * slice-3.7-cut.md §2.3/§3.2): the zero-profiles "" regression invariant,
 * deterministic name-asc ordering independent of input order, the header
 * appearing only when the section is non-empty, and the line-wise
 * PROFILES_PROMPT_SECTION_MAX_CHARS cap (never mid-line).
 */

import { describe, expect, it } from "vitest";
import { buildProfilesPromptSection } from "./profiles-prompt-section.js";
import type { PersonaDefinition } from "./personas.js";
import { PROFILES_PROMPT_SECTION_MAX_CHARS } from "../types/config.js";

function profile(overrides: Partial<PersonaDefinition> = {}): PersonaDefinition {
  return {
    name: "demo",
    description: "A demo profile",
    tools: ["Read"],
    systemPrompt: "demo system prompt",
    ...overrides,
  };
}

describe("buildProfilesPromptSection — zero-profiles invariant", () => {
  it("returns '' for an empty list (systemPrompt stays byte-identical to before the slice)", () => {
    expect(buildProfilesPromptSection([])).toBe("");
  });
});

describe("buildProfilesPromptSection — structure and content", () => {
  it("wraps the anti-confabulation header, an 'Available agent profiles' line, and one '- name: description' line per profile", () => {
    const section = buildProfilesPromptSection([
      profile({ name: "librarian", description: "Curates docs" }),
    ]);
    const lines = section.split("\n");
    expect(lines[0]).toBe(
      'The agent profiles below are available agent profiles for the Agent tool; use only the agent_type values listed here or the built-in "general-purpose"/"explore" — never assume an unlisted profile exists.',
    );
    expect(lines[1]).toBe("Available agent profiles (spawn with the Agent tool's agent_type):");
    expect(lines[2]).toBe("- librarian: Curates docs");
    expect(lines).toHaveLength(3);
  });

  it("mentions the built-in persona names only in the header, and only because the section is non-empty", () => {
    const section = buildProfilesPromptSection([profile({ name: "librarian" })]);
    expect(section).toContain("general-purpose");
    expect(section).toContain("explore");
  });
});

describe("buildProfilesPromptSection — deterministic order", () => {
  it("orders by name-asc regardless of input order (no source field on PersonaDefinition)", () => {
    const profiles: PersonaDefinition[] = [
      profile({ name: "zeta", description: "z" }),
      profile({ name: "alpha", description: "a" }),
      profile({ name: "gamma", description: "g" }),
    ];
    const section = buildProfilesPromptSection(profiles);
    const names = section
      .split("\n")
      .slice(2)
      .map((line) => line.match(/^- (\S+):/)?.[1]);
    expect(names).toEqual(["alpha", "gamma", "zeta"]);
  });

  it("produces the identical string for any permutation of the same input set", () => {
    const a = profile({ name: "a", description: "A" });
    const b = profile({ name: "b", description: "B" });
    const c = profile({ name: "c", description: "C" });
    const orderOne = buildProfilesPromptSection([a, b, c]);
    const orderTwo = buildProfilesPromptSection([c, a, b]);
    const orderThree = buildProfilesPromptSection([b, c, a]);
    expect(orderOne).toBe(orderTwo);
    expect(orderOne).toBe(orderThree);
  });
});

describe("buildProfilesPromptSection — PROFILES_PROMPT_SECTION_MAX_CHARS cap", () => {
  it("drops whole trailing lines (never mid-line) once the cap is exceeded", () => {
    const profiles: PersonaDefinition[] = Array.from({ length: 200 }, (_, i) =>
      profile({
        name: `profile-${String(i).padStart(3, "0")}`,
        description: "d".repeat(200),
      }),
    );
    const section = buildProfilesPromptSection(profiles);
    expect(section.length).toBeLessThanOrEqual(PROFILES_PROMPT_SECTION_MAX_CHARS);

    const lines = section.split("\n");
    // Every line after the two header lines must be a COMPLETE "- name: ..." line,
    // never a truncated fragment.
    for (const line of lines.slice(2)) {
      expect(line).toMatch(/^- profile-\d{3}: d{200}$/);
    }
    // Only a strict prefix of the (deterministically ordered) full list survived.
    const survivingNames = lines.slice(2).map((line) => line.match(/^- (\S+):/)?.[1]);
    expect(survivingNames.length).toBeGreaterThan(0);
    expect(survivingNames.length).toBeLessThan(200);
    expect(survivingNames).toEqual(
      profiles.slice(0, survivingNames.length).map((p) => p.name),
    );
  });

  it("returns the full section untouched when under the cap", () => {
    const profiles = [profile({ name: "small", description: "tiny" })];
    const section = buildProfilesPromptSection(profiles);
    expect(section.length).toBeLessThan(PROFILES_PROMPT_SECTION_MAX_CHARS);
    expect(section).toContain("small");
  });
});

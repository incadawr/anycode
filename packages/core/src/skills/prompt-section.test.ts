/**

 * the zero-skills "" regression invariant, deterministic ordering independent
 * of input order, and the line-wise SKILLS_PROMPT_SECTION_MAX_CHARS cap (never
 * mid-line).
 */

import { describe, expect, it } from "vitest";
import { buildSkillsPromptSection } from "./prompt-section.js";
import type { SkillMeta } from "../ports/skills.js";
import { SKILLS_PROMPT_SECTION_MAX_CHARS } from "../types/config.js";

function meta(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: "demo",
    description: "A demo skill",
    source: "project",
    path: "/proj/.anycode/skills/demo/SKILL.md",
    ...overrides,
  };
}

describe("buildSkillsPromptSection — zero-skills invariant", () => {
  it("returns '' for an empty list (systemPrompt stays byte-identical to before the slice)", () => {
    expect(buildSkillsPromptSection([])).toBe("");
  });
});

describe("buildSkillsPromptSection — structure and content", () => {
  it("wraps the placeholder header, an 'Available skills' line, and one '- name (source): description' line per skill", () => {
    const section = buildSkillsPromptSection([meta({ name: "reviewer", source: "project", description: "Reviews diffs" })]);
    const lines = section.split("\n");
    expect(lines[0]).toBe(
      "The skills below are available in this session; load only the names listed here, and only through the Skill tool — never assume an unlisted skill exists.",
    );
    expect(lines[1]).toBe("Available skills (load full instructions with the Skill tool by name):");
    expect(lines[2]).toBe("- reviewer (project): Reviews diffs");
    expect(lines).toHaveLength(3);
  });
});

describe("buildSkillsPromptSection — deterministic order", () => {
  it("orders by source precedence (project > user > plugin:*) then name-asc, regardless of input order", () => {
    const metas: SkillMeta[] = [
      meta({ name: "zeta", source: "plugin:beta", description: "z" }),
      meta({ name: "alpha", source: "user", description: "a" }),
      meta({ name: "beta", source: "project", description: "b" }),
      meta({ name: "gamma", source: "plugin:alpha", description: "g" }),
      meta({ name: "delta", source: "project", description: "d" }),
    ];
    const section = buildSkillsPromptSection(metas);
    const names = section
      .split("\n")
      .slice(2)
      .map((line) => line.match(/^- (\S+) /)?.[1]);
    // project (name-asc) -> user -> plugin:* (source-string-asc, so plugin:alpha before plugin:beta)
    expect(names).toEqual(["beta", "delta", "alpha", "gamma", "zeta"]);
  });

  it("produces the identical string for any permutation of the same input set", () => {
    const a = meta({ name: "a", source: "project", description: "A" });
    const b = meta({ name: "b", source: "user", description: "B" });
    const c = meta({ name: "c", source: "plugin:x", description: "C" });
    const orderOne = buildSkillsPromptSection([a, b, c]);
    const orderTwo = buildSkillsPromptSection([c, a, b]);
    const orderThree = buildSkillsPromptSection([b, c, a]);
    expect(orderOne).toBe(orderTwo);
    expect(orderOne).toBe(orderThree);
  });
});

describe("buildSkillsPromptSection — SKILLS_PROMPT_SECTION_MAX_CHARS cap", () => {
  it("drops whole trailing lines (never mid-line) once the cap is exceeded", () => {
    // Each skill line is long enough that only a bounded number fit under the cap.
    const metas: SkillMeta[] = Array.from({ length: 200 }, (_, i) =>
      meta({
        name: `skill-${String(i).padStart(3, "0")}`,
        source: "project",
        description: "d".repeat(200),
      }),
    );
    const section = buildSkillsPromptSection(metas);
    expect(section.length).toBeLessThanOrEqual(SKILLS_PROMPT_SECTION_MAX_CHARS);

    const lines = section.split("\n");
    // Every line after the two header lines must be a COMPLETE "- name (...): ..." line,
    // never a truncated fragment.
    for (const line of lines.slice(2)) {
      expect(line).toMatch(/^- skill-\d{3} \(project\): d{200}$/);
    }
    // Only a strict prefix of the (deterministically ordered) full list survived.
    const survivingNames = lines.slice(2).map((line) => line.match(/^- (\S+) /)?.[1]);
    expect(survivingNames.length).toBeGreaterThan(0);
    expect(survivingNames.length).toBeLessThan(200);
    expect(survivingNames).toEqual(
      metas.slice(0, survivingNames.length).map((m) => m.name),
    );
  });

  it("returns the full section untouched when under the cap", () => {
    const metas = [meta({ name: "small", description: "tiny" })];
    const section = buildSkillsPromptSection(metas);
    expect(section.length).toBeLessThan(SKILLS_PROMPT_SECTION_MAX_CHARS);
    expect(section).toContain("small");
  });
});

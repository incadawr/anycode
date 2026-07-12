/**
 * Workflows prompt-section matrix (Phase 3 slice 3.4, design §3.6 / build-cut

 * independent of input order, and the line-wise
 * WORKFLOWS_PROMPT_SECTION_MAX_CHARS cap (never mid-line).
 */

import { describe, expect, it } from "vitest";
import { buildWorkflowsPromptSection } from "./prompt-section.js";
import type { WorkflowMeta } from "../ports/workflow.js";
import { WORKFLOWS_PROMPT_SECTION_MAX_CHARS } from "../types/config.js";

function meta(overrides: Partial<WorkflowMeta> = {}): WorkflowMeta {
  return {
    name: "demo",
    description: "A demo workflow",
    stepCount: 2,
    source: "project",
    ...overrides,
  };
}

describe("buildWorkflowsPromptSection — zero-workflows invariant", () => {
  it("returns '' for an empty list (systemPrompt stays byte-identical to before the slice)", () => {
    expect(buildWorkflowsPromptSection([])).toBe("");
  });
});

describe("buildWorkflowsPromptSection — structure and content", () => {
  it("wraps the placeholder header, an 'Available workflows' line, and one '- name (source, N steps): description' line", () => {
    const section = buildWorkflowsPromptSection([
      meta({ name: "reviewer", source: "project", stepCount: 3, description: "Reviews diffs" }),
    ]);
    const lines = section.split("\n");
    expect(lines[0]).toBe(
      "The workflows below are available in this session; run only the names listed here, and only through the Workflow tool — never assume an unlisted workflow exists.",
    );
    expect(lines[1]).toBe("Available workflows (run with the Workflow tool by name):");
    expect(lines[2]).toBe("- reviewer (project, 3 steps): Reviews diffs");
    expect(lines).toHaveLength(3);
  });
});

describe("buildWorkflowsPromptSection — deterministic order", () => {
  it("orders by source precedence (project > user > else) then name-asc, regardless of input order", () => {
    const metas: WorkflowMeta[] = [
      meta({ name: "zeta", source: "plugin:beta", description: "z" }),
      meta({ name: "alpha", source: "user", description: "a" }),
      meta({ name: "beta", source: "project", description: "b" }),
      meta({ name: "gamma", source: "plugin:alpha", description: "g" }),
      meta({ name: "delta", source: "project", description: "d" }),
    ];
    const section = buildWorkflowsPromptSection(metas);
    const names = section
      .split("\n")
      .slice(2)
      .map((line) => line.match(/^- (\S+) /)?.[1]);
    expect(names).toEqual(["beta", "delta", "alpha", "gamma", "zeta"]);
  });

  it("produces the identical string for any permutation of the same input set", () => {
    const a = meta({ name: "a", source: "project", description: "A" });
    const b = meta({ name: "b", source: "user", description: "B" });
    const c = meta({ name: "c", source: "plugin:x", description: "C" });
    const orderOne = buildWorkflowsPromptSection([a, b, c]);
    const orderTwo = buildWorkflowsPromptSection([c, a, b]);
    const orderThree = buildWorkflowsPromptSection([b, c, a]);
    expect(orderOne).toBe(orderTwo);
    expect(orderOne).toBe(orderThree);
  });
});

describe("buildWorkflowsPromptSection — WORKFLOWS_PROMPT_SECTION_MAX_CHARS cap", () => {
  it("drops whole trailing lines (never mid-line) once the cap is exceeded", () => {
    const metas: WorkflowMeta[] = Array.from({ length: 200 }, (_, i) =>
      meta({
        name: `flow-${String(i).padStart(3, "0")}`,
        source: "project",
        description: "d".repeat(200),
      }),
    );
    const section = buildWorkflowsPromptSection(metas);
    expect(section.length).toBeLessThanOrEqual(WORKFLOWS_PROMPT_SECTION_MAX_CHARS);

    const lines = section.split("\n");
    for (const line of lines.slice(2)) {
      expect(line).toMatch(/^- flow-\d{3} \(project, 2 steps\): d{200}$/);
    }
    const survivingNames = lines.slice(2).map((line) => line.match(/^- (\S+) /)?.[1]);
    expect(survivingNames.length).toBeGreaterThan(0);
    expect(survivingNames.length).toBeLessThan(200);
    expect(survivingNames).toEqual(metas.slice(0, survivingNames.length).map((m) => m.name));
  });

  it("returns the full section untouched when under the cap", () => {
    const metas = [meta({ name: "small", description: "tiny" })];
    const section = buildWorkflowsPromptSection(metas);
    expect(section.length).toBeLessThan(WORKFLOWS_PROMPT_SECTION_MAX_CHARS);
    expect(section).toContain("small");
  });
});

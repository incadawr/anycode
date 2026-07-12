/**

 * valid definitions (incl. name fallback + unknown-key tolerance), cycle
 * rejection, missing dependsOn target, self-dep, template-ref-not-in-dependsOn
 * rejection, and every cap (steps, maxTurns, template byte length).
 */

import { describe, expect, it } from "vitest";
import { parseWorkflowDefinition, type WorkflowParseContext } from "./schema.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_WORKFLOW_STEPS,
  WORKFLOW_TEMPLATE_MAX_BYTES,
} from "../types/config.js";

function ctx(overrides: Partial<WorkflowParseContext> = {}): WorkflowParseContext {
  return { source: "project", path: "/proj/.anycode/workflows/demo.json", fallbackName: "demo", ...overrides };
}

function minimalRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "A demo workflow",
    steps: [{ id: "a", agentType: "general-purpose", promptTemplate: "${input}" }],
    ...overrides,
  };
}

describe("parseWorkflowDefinition — valid definitions", () => {
  it("parses a minimal single-step definition", () => {
    const result = parseWorkflowDefinition(minimalRaw({ name: "my-flow" }), ctx());
    expect(result.problem).toBeUndefined();
    expect(result.definition).toMatchObject({
      name: "my-flow",
      description: "A demo workflow",
      source: "project",
      path: "/proj/.anycode/workflows/demo.json",
    });
    expect(result.definition?.steps).toEqual([
      { id: "a", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);
  });

  it("falls back to the file stem when name is omitted", () => {
    const result = parseWorkflowDefinition(minimalRaw(), ctx({ fallbackName: "file-stem-name" }));
    expect(result.problem).toBeUndefined();
    expect(result.definition?.name).toBe("file-stem-name");
  });

  it("falls back to the file stem when name is blank/whitespace", () => {
    const result = parseWorkflowDefinition(minimalRaw({ name: "   " }), ctx({ fallbackName: "fallback" }));
    expect(result.problem).toBeUndefined();
    expect(result.definition?.name).toBe("fallback");
  });

  it("trims a provided description", () => {
    const result = parseWorkflowDefinition(minimalRaw({ description: "  spaced  " }), ctx());
    expect(result.definition?.description).toBe("spaced");
  });

  it("carries dependsOn and maxTurns through verbatim", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "seed" },
        { id: "b", agentType: "explore", promptTemplate: "${steps.a}", dependsOn: ["a"], maxTurns: 3 },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.problem).toBeUndefined();
    expect(result.definition?.steps[1]).toMatchObject({ dependsOn: ["a"], maxTurns: 3 });
  });

  it("carries an outputTemplate through verbatim", () => {
    const result = parseWorkflowDefinition(minimalRaw({ outputTemplate: "Result: ${steps.a}" }), ctx());
    expect(result.definition?.outputTemplate).toBe("Result: ${steps.a}");
  });

  it("ignores unknown top-level keys (ecosystem/forward-compat tolerance)", () => {
    const result = parseWorkflowDefinition(
      minimalRaw({ model: "gpt-future", extra: { nested: true } }),
      ctx(),
    );
    expect(result.problem).toBeUndefined();
    expect(result.definition).not.toHaveProperty("model");
    expect(result.definition).not.toHaveProperty("extra");
  });

  it("ignores unknown per-step keys", () => {
    const raw = minimalRaw({
      steps: [{ id: "a", agentType: "general-purpose", promptTemplate: "x", model: "gpt-future" }],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.problem).toBeUndefined();
    expect(result.definition?.steps[0]).not.toHaveProperty("model");
  });

  it("accepts a diamond DAG (A -> B,C -> D) with valid refs", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "${input}" },
        { id: "b", agentType: "general-purpose", promptTemplate: "${steps.a}", dependsOn: ["a"] },
        { id: "c", agentType: "general-purpose", promptTemplate: "${steps.a}", dependsOn: ["a"] },
        {
          id: "d",
          agentType: "general-purpose",
          promptTemplate: "${steps.b} ${steps.c}",
          dependsOn: ["b", "c"],
        },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.problem).toBeUndefined();
    expect(result.definition?.steps).toHaveLength(4);
  });
});

describe("parseWorkflowDefinition — structural rejections", () => {
  it("rejects a definition with zero steps", () => {
    const result = parseWorkflowDefinition(minimalRaw({ steps: [] }), ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toBeTruthy();
  });

  it("rejects a definition missing description", () => {
    const raw = { steps: [{ id: "a", agentType: "general-purpose", promptTemplate: "x" }] };
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain(ctx().path);
  });

  it("rejects a blank description", () => {
    const result = parseWorkflowDefinition(minimalRaw({ description: "   " }), ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("description");
  });

  it("rejects an invalid top-level name", () => {
    const result = parseWorkflowDefinition(minimalRaw({ name: "not a valid name!" }), ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("not a valid name!");
  });

  it("rejects an invalid step id", () => {
    const raw = minimalRaw({
      steps: [{ id: "not valid!", agentType: "general-purpose", promptTemplate: "x" }],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("not valid!");
  });

  it("rejects duplicate step ids", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "x" },
        { id: "a", agentType: "explore", promptTemplate: "y" },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("duplicate");
  });

  it("rejects a dependsOn target that does not exist", () => {
    const raw = minimalRaw({
      steps: [{ id: "a", agentType: "general-purpose", promptTemplate: "x", dependsOn: ["ghost"] }],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("ghost");
  });

  it("rejects a self-dependency", () => {
    const raw = minimalRaw({
      steps: [{ id: "a", agentType: "general-purpose", promptTemplate: "x", dependsOn: ["a"] }],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("itself");
  });

  it("rejects a two-step cycle (A depends on B, B depends on A) — never hangs", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "x", dependsOn: ["b"] },
        { id: "b", agentType: "general-purpose", promptTemplate: "y", dependsOn: ["a"] },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("cycle");
  });

  it("rejects a longer cycle (A -> B -> C -> A)", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "x", dependsOn: ["c"] },
        { id: "b", agentType: "general-purpose", promptTemplate: "y", dependsOn: ["a"] },
        { id: "c", agentType: "general-purpose", promptTemplate: "z", dependsOn: ["b"] },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("cycle");
  });

  it("does not reject a valid graph that merely shares a diamond shape (no false-positive cycle)", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "x" },
        { id: "b", agentType: "general-purpose", promptTemplate: "${steps.a}", dependsOn: ["a"] },
        { id: "c", agentType: "general-purpose", promptTemplate: "${steps.a}", dependsOn: ["a"] },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.problem).toBeUndefined();
  });

  it("rejects a template ref to a step outside dependsOn", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "x" },
        { id: "b", agentType: "general-purpose", promptTemplate: "${steps.a}" }, // no dependsOn: ["a"]
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("steps.a");
  });

  it("rejects a template ref to a TRANSITIVE (non-direct) ancestor", () => {
    // c depends on b, b depends on a; c references ${steps.a} directly without
    // declaring "a" in its OWN dependsOn — the ancestor must be re-declared.
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "x" },
        { id: "b", agentType: "general-purpose", promptTemplate: "${steps.a}", dependsOn: ["a"] },
        {
          id: "c",
          agentType: "general-purpose",
          promptTemplate: "${steps.a} ${steps.b}",
          dependsOn: ["b"],
        },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toContain("steps.a");
  });

  it("does not restrict outputTemplate refs to any single step's dependsOn", () => {
    const raw = minimalRaw({
      steps: [
        { id: "a", agentType: "general-purpose", promptTemplate: "x" },
        { id: "b", agentType: "general-purpose", promptTemplate: "y" },
      ],
      outputTemplate: "${steps.a} ${steps.b}",
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.problem).toBeUndefined();
    expect(result.definition?.outputTemplate).toBe("${steps.a} ${steps.b}");
  });
});

describe("parseWorkflowDefinition — caps", () => {
  it("rejects more than MAX_WORKFLOW_STEPS steps", () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, i) => ({
      id: `s${i}`,
      agentType: "general-purpose",
      promptTemplate: "x",
    }));
    const result = parseWorkflowDefinition(minimalRaw({ steps }), ctx());
    expect(result.definition).toBeUndefined();
    expect(result.problem).toBeTruthy();
  });

  it("accepts exactly MAX_WORKFLOW_STEPS steps", () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS }, (_, i) => ({
      id: `s${i}`,
      agentType: "general-purpose",
      promptTemplate: "x",
    }));
    const result = parseWorkflowDefinition(minimalRaw({ steps }), ctx());
    expect(result.problem).toBeUndefined();
    expect(result.definition?.steps).toHaveLength(MAX_WORKFLOW_STEPS);
  });

  it("rejects a maxTurns above DEFAULT_SUBAGENT_MAX_TURNS", () => {
    const raw = minimalRaw({
      steps: [
        {
          id: "a",
          agentType: "general-purpose",
          promptTemplate: "x",
          maxTurns: DEFAULT_SUBAGENT_MAX_TURNS + 1,
        },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
  });

  it("rejects a maxTurns of 0", () => {
    const raw = minimalRaw({
      steps: [{ id: "a", agentType: "general-purpose", promptTemplate: "x", maxTurns: 0 }],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
  });

  it("accepts a maxTurns of exactly DEFAULT_SUBAGENT_MAX_TURNS", () => {
    const raw = minimalRaw({
      steps: [
        {
          id: "a",
          agentType: "general-purpose",
          promptTemplate: "x",
          maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
        },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.problem).toBeUndefined();
  });

  it("rejects a promptTemplate exceeding WORKFLOW_TEMPLATE_MAX_BYTES", () => {
    const raw = minimalRaw({
      steps: [
        {
          id: "a",
          agentType: "general-purpose",
          promptTemplate: "a".repeat(WORKFLOW_TEMPLATE_MAX_BYTES + 1),
        },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.definition).toBeUndefined();
  });

  it("accepts a promptTemplate at exactly WORKFLOW_TEMPLATE_MAX_BYTES", () => {
    const raw = minimalRaw({
      steps: [
        {
          id: "a",
          agentType: "general-purpose",
          promptTemplate: "a".repeat(WORKFLOW_TEMPLATE_MAX_BYTES),
        },
      ],
    });
    const result = parseWorkflowDefinition(raw, ctx());
    expect(result.problem).toBeUndefined();
  });

  it("rejects an outputTemplate exceeding WORKFLOW_TEMPLATE_MAX_BYTES", () => {
    const result = parseWorkflowDefinition(
      minimalRaw({ outputTemplate: "a".repeat(WORKFLOW_TEMPLATE_MAX_BYTES + 1) }),
      ctx(),
    );
    expect(result.definition).toBeUndefined();
  });
});

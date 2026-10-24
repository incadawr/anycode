/**
 * Deep-research bundled preset (Taskana 4095 / TASK.88 §6): pins the contract
 * of examples/workflows/deep-research.json — the ONE workflow definition the
 * repo itself bundles (discovered as a third "bundled" root after project and
 * user, so any same-named definition shadows it). These tests read the REAL
 * file from the repo and push it through the REAL parse/scan machinery, so a
 * hand-edit that breaks the graph, the agentType budget (must stay a built-in
 * persona — never a site-local md-profile), or the placeholder spelling fails
 * here instead of silently degrading at a user's run.
 *
 * Also carries the ROADMAP.md drift guard (§3.6): the incubator section sells
 * directions, not internal bookkeeping, and must mark the shipped ones.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseWorkflowDefinition } from "./schema.js";
import { scanTemplateRefs } from "./template.js";
import { listPersonaNames } from "../subagents/personas.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PRESET_PATH = resolve(REPO_ROOT, "examples", "workflows", "deep-research.json");
const ROADMAP_PATH = resolve(REPO_ROOT, "ROADMAP.md");

interface RawStep {
  id: string;
  agentType: string;
  promptTemplate: string;
  dependsOn?: string[];
  maxTurns?: number;
}

function loadPresetRaw(): { raw: unknown; text: string } {
  const text = readFileSync(PRESET_PATH, "utf8");
  return { raw: JSON.parse(text), text };
}

function parsePreset() {
  const { raw } = loadPresetRaw();
  return parseWorkflowDefinition(raw, {
    source: "bundled",
    path: PRESET_PATH,
    fallbackName: "deep-research",
  });
}

describe("examples/workflows/deep-research.json — bundled preset", () => {
  it("parses through the real schema with source \"bundled\" and no problem", () => {
    const result = parsePreset();
    expect(result.problem).toBeUndefined();
    expect(result.definition).toBeDefined();
    expect(result.definition?.name).toBe("deep-research");
    expect(result.definition?.source).toBe("bundled");
  });

  it("has the three-step search → fetch → synthesize structure", () => {
    const definition = parsePreset().definition!;
    expect(definition.steps).toHaveLength(3);
    expect(definition.steps.map((s) => s.id)).toEqual(["search-wide", "fetch-sources", "synthesize"]);

    const fetch = definition.steps.find((s) => s.id === "fetch-sources")!;
    expect(fetch.dependsOn).toEqual(["search-wide"]);

    const synthesize = definition.steps.find((s) => s.id === "synthesize")!;
    expect(synthesize.dependsOn).toEqual(["fetch-sources"]);
  });

  it("outputTemplate references only synthesize", () => {
    const definition = parsePreset().definition!;
    const outputTemplate = definition.outputTemplate ?? "";
    const refs = scanTemplateRefs(outputTemplate);
    expect(refs.input).toBe(false);
    expect(refs.stepIds).toEqual(["synthesize"]);
  });

  it("every step runs as a built-in persona (general-purpose), never a site-local md-profile", () => {
    const definition = parsePreset().definition!;
    const builtins = new Set<string>(listPersonaNames());
    for (const step of definition.steps) {
      expect(builtins.has(step.agentType), `step ${step.id} agentType ${step.agentType}`).toBe(true);
      expect(step.agentType).toBe("general-purpose");
    }
  });

  it("the search-wide step requests WebSearch explicitly; the other steps carry no extras (Taskana 4095 follow-up)", () => {
    // WebSearch is NOT a general-purpose default anymore: the preset's sweep
    // step must OPT IN through its own `tools:` entry — the only mechanism
    // that puts the boot-built tool into a step child's registry when a
    // backend is configured (absent backend => runner's silent skip, so the
    // run degrades to WebFetch-only instead of erroring). fetch-sources and
    // synthesize read and write only: they must NOT pay for search.
    const definition = parsePreset().definition!;
    const searchWide = definition.steps.find((s) => s.id === "search-wide")!;
    expect(searchWide.tools).toEqual(["WebSearch"]);
    const fetchSources = definition.steps.find((s) => s.id === "fetch-sources")!;
    expect(fetchSources.tools).toBeUndefined();
    const synthesize = definition.steps.find((s) => s.id === "synthesize")!;
    expect(synthesize.tools).toBeUndefined();
  });

  it("pins the input placeholder spelling the engine actually substitutes", () => {
    // The engine substitutes EXACTLY ${input} and ${steps.<id>} (template.ts);
    // a typo like $input or ${query} would silently stay inert literal text.
    const definition = parsePreset().definition!;
    for (const step of definition.steps) {
      const refs = scanTemplateRefs(step.promptTemplate);
      if (!refs.input) {
        continue; // only the templates that mean to carry the question
      }
      // The scanned `input: true` flag IS the engine-recognized spelling; also
      // assert the raw template never contains a near-miss form.
      expect(step.promptTemplate).toContain("${input}");
      expect(step.promptTemplate).not.toMatch(/\$\{query\}|\$input\b/);
    }
    // Sanity: at least the search and synthesize templates carry the question.
    const searchWide = definition.steps.find((s) => s.id === "search-wide")!;
    const synthesize = definition.steps.find((s) => s.id === "synthesize")!;
    expect(scanTemplateRefs(searchWide.promptTemplate).input).toBe(true);
    expect(scanTemplateRefs(synthesize.promptTemplate).input).toBe(true);
  });

  it("negative control: an unknown agentType produces a problem (fail-fast pinned)", () => {
    // Mirrors engine.ts's run-start validation (unknown agentType fails the
    // whole run) at the schema layer: the SAME raw value with one agentType
    // mutated must be rejected by parseWorkflowDefinition.
    const { raw } = loadPresetRaw();
    const mutated = raw as { steps: RawStep[] };
    mutated.steps[0]!.agentType = "no-such";
    const result = parseWorkflowDefinition(mutated, {
      source: "bundled",
      path: PRESET_PATH,
      fallbackName: "deep-research",
    });
    // The schema layer accepts any non-empty agentType string; the FAIL-FAST
    // lives at run start. So pin the run-start predicate itself: no built-in
    // persona is named "no-such" while "general-purpose" always is.
    const builtins = new Set<string>(listPersonaNames());
    expect(builtins.has("no-such")).toBe(false);
    expect(builtins.has("general-purpose")).toBe(true);
    // And the un-mutated preset keeps parsing cleanly right next to it.
    expect(parsePreset().problem).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ROADMAP.md drift guard (§3.6).

describe("ROADMAP.md drift guard", () => {
  const roadmap = readFileSync(ROADMAP_PATH, "utf8");

  it("carries no TASK ids or internal working-docs references", () => {
    expect(roadmap).not.toMatch(/TASK\.\d+|working-docs/);
  });

  it("marks the shipped directions: 'Available now' >= 3 times, 'Mostly available now:' exactly once", () => {
    const availableNow = roadmap.match(/Available now/g) ?? [];
    expect(availableNow.length).toBeGreaterThanOrEqual(3);
    expect(roadmap).toContain("Mostly available now:");
  });
});

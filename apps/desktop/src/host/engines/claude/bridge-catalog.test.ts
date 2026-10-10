/**
 * `catalogFromProfiles` (TASK.226 срез S4, plan §5 S4's one unit-testable
 * piece — the rest of `bootClaudeSession`'s wiring is index.ts glue, proven
 * only by the live smoke, project convention).
 */

import { describe, expect, it } from "vitest";
import type { PersonaDefinition } from "@anycode/core";
import { catalogFromProfiles } from "./bridge-catalog.js";

function profile(overrides: Partial<PersonaDefinition> = {}): PersonaDefinition {
  return {
    name: "reviewer",
    description: "Reviews code",
    tools: [],
    systemPrompt: "You review code.",
    ...overrides,
  };
}

describe("catalogFromProfiles (TASK.226 срез S4)", () => {
  it("carries name/description/systemPrompt verbatim for a core (no-engine) profile", () => {
    expect(catalogFromProfiles([profile()])).toEqual([
      { name: "reviewer", description: "Reviews code", systemPrompt: "You review code." },
    ]);
  });

  it("carries engine and model through for an engine profile", () => {
    expect(
      catalogFromProfiles([profile({ name: "codex-reviewer", engine: "codex", model: "gpt-5.6-sol" })]),
    ).toEqual([
      {
        name: "codex-reviewer",
        description: "Reviews code",
        systemPrompt: "You review code.",
        engine: "codex",
        model: "gpt-5.6-sol",
      },
    ]);
  });

  it("an empty input list projects to an empty catalog", () => {
    expect(catalogFromProfiles([])).toEqual([]);
  });

  it("preserves discovery's own precedence order", () => {
    const projectProfile = profile({ name: "a" });
    const userProfile = profile({ name: "b" });
    expect(catalogFromProfiles([projectProfile, userProfile]).map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("excludes a built-in persona name even if one reached this function's input", () => {
    // discoverAgentProfiles itself never returns "general-purpose"/"explore"
    // (it only scans .anycode/agents/*.md, never the PERSONAS map) — this
    // pins the defensive isKnownPersona filter as a second, independent line
    // of exclusion rather than trusting the caller alone (plan §3.1).
    expect(catalogFromProfiles([profile({ name: "general-purpose" }), profile({ name: "reviewer" })])).toEqual([
      { name: "reviewer", description: "Reviews code", systemPrompt: "You review code." },
    ]);
  });
});

// TASK.180: a profile's turnBudget survives the catalog projection as
// maxTurns — for engine profiles AND core profiles alike.
describe("catalogFromProfiles — turnBudget (TASK.180)", () => {
  it("carries turnBudget through as maxTurns for a core profile", () => {
    expect(catalogFromProfiles([profile({ turnBudget: 20 })])).toEqual([
      { name: "reviewer", description: "Reviews code", systemPrompt: "You review code.", maxTurns: 20 },
    ]);
  });

  it("carries turnBudget through as maxTurns for an engine profile", () => {
    expect(
      catalogFromProfiles([profile({ name: "codex-reviewer", engine: "codex", turnBudget: 30 })]),
    ).toEqual([
      {
        name: "codex-reviewer",
        description: "Reviews code",
        systemPrompt: "You review code.",
        engine: "codex",
        maxTurns: 30,
      },
    ]);
  });

  it("omits maxTurns when the profile declares no budget", () => {
    expect(catalogFromProfiles([profile()])).toEqual([
      { name: "reviewer", description: "Reviews code", systemPrompt: "You review code." },
    ]);
  });
});

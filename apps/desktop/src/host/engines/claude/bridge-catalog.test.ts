/**
 * `catalogFromProfiles` (TASK.226 срез S4, plan §5 S4's one unit-testable
 * piece — the rest of `bootClaudeSession`'s wiring is index.ts glue, proven
 * only by the live smoke, project convention).
 */

import { describe, expect, it } from "vitest";
import type { PersonaDefinition, SessionSubagentOutcome, SessionSubagentPort, SessionSubagentRequest } from "@anycode/core";
import { runAgentBridgeCall, type AgentBridgeCatalogEntry } from "@anycode/core";
import { bridgeCallableCatalog, catalogFromProfiles } from "./bridge-catalog.js";

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

// Taskana 4269: a profile's own connection selection rides the catalog — and
// thus the bridge's creating spawn — verbatim. An engine profile can never
// carry these (parser-fatal), so this projection adds nothing else.
describe("catalogFromProfiles — connection/provider routing (Taskana 4269)", () => {
  it("carries connection:/provider: through verbatim for core profiles", () => {
    expect(
      catalogFromProfiles([
        profile({ name: "glm-planner", connection: "conn-glm" }),
        profile({ name: "ds-executor", provider: "deepseek" }),
      ]),
    ).toEqual([
      { name: "glm-planner", description: "Reviews code", systemPrompt: "You review code.", connection: "conn-glm" },
      { name: "ds-executor", description: "Reviews code", systemPrompt: "You review code.", provider: "deepseek" },
    ]);
  });

  it("omits both routing keys when the profile declares neither", () => {
    expect(catalogFromProfiles([profile()])).toEqual([
      { name: "reviewer", description: "Reviews code", systemPrompt: "You review code." },
    ]);
  });
});

// Taskana 4101: the claude door's per-call refresh — `callTool` re-reads
// profile files and filters to the boot snapshot's declared names, matching
// the codex door's own declared-names filter (dynamic-tool-bridge.ts handle()
// — pinned "uses edited body/model for the next child without changing native
// tool declarations"). Pure-filter cases first, then the composed path
// through the real core handler.
describe("bridgeCallableCatalog (Taskana 4101)", () => {
  const BOOT_LEAD: AgentBridgeCatalogEntry = {
    name: "glm-lead",
    description: "v1 lead",
    systemPrompt: "v1 body",
  };

  function portReturning(outcome: SessionSubagentOutcome): SessionSubagentPort {
    return { run: async () => outcome };
  }

  const BASE_OUTCOME: SessionSubagentOutcome = {
    status: "completed",
    finalText: "child session done",
    truncated: false,
    turns: 2,
    toolCalls: 3,
    durationMs: 500,
    childSessionId: "child-1",
    parentSessionId: "parent-1",
    spawnToolCallId: "toolu_bridge_1",
  };

  it("edited entry survives with v2 fields; a new boot-unknown name is dropped", () => {
    const current: AgentBridgeCatalogEntry[] = [
      { name: "glm-lead", description: "v2 lead", systemPrompt: "v2 body", model: "glm-5.3-flash" },
      { name: "new-profile", description: "added after boot", systemPrompt: "never declared at boot" },
    ];
    expect(bridgeCallableCatalog([BOOT_LEAD], current)).toEqual([
      { name: "glm-lead", description: "v2 lead", systemPrompt: "v2 body", model: "glm-5.3-flash" },
    ]);
  });

  it("empty current => []; empty boot => []", () => {
    expect(bridgeCallableCatalog([BOOT_LEAD], [])).toEqual([]);
    expect(bridgeCallableCatalog([], [{ name: "glm-lead", description: "d", systemPrompt: "p" }])).toEqual([]);
  });

  it("order follows current, not boot", () => {
    const a: AgentBridgeCatalogEntry = { name: "a", description: "d", systemPrompt: "p" };
    const b: AgentBridgeCatalogEntry = { name: "b", description: "d", systemPrompt: "p" };
    expect(bridgeCallableCatalog([a, b], [b, a]).map((entry) => entry.name)).toEqual(["b", "a"]);
  });

  // Composed end-to-end through the real core handler: the filtered catalog
  // is exactly what index.ts's callTool now feeds runAgentBridgeCall.
  it("composed: the edited entry sends the edited model/body to the port; a boot-unknown name errors", async () => {
    const boot: readonly AgentBridgeCatalogEntry[] = [BOOT_LEAD];
    const current: readonly AgentBridgeCatalogEntry[] = [
      { name: "glm-lead", description: "v2 lead", systemPrompt: "v2 body", model: "glm-5.3-flash" },
      { name: "new-profile", description: "added after boot", systemPrompt: "never declared at boot" },
    ];
    const callable = bridgeCallableCatalog(boot, current);
    expect(callable.map((entry) => entry.name)).toEqual(["glm-lead"]);

    let seen: SessionSubagentRequest | undefined;
    const recordingPort: SessionSubagentPort = {
      run: async (req) => {
        seen = req;
        return { ...BASE_OUTCOME, spawnToolCallId: req.spawnToolCallId };
      },
    };
    await runAgentBridgeCall(
      { agent_type: "glm-lead", description: "d", prompt: "do it" },
      { catalog: callable, port: recordingPort, spawnToolCallId: "toolu_4101_a" },
    );
    expect(seen?.model).toBe("glm-5.3-flash");
    expect(seen?.prompt.startsWith("v2 body")).toBe(true);

    const unknownPort = portReturning(BASE_OUTCOME);
    const rejected = await runAgentBridgeCall(
      { agent_type: "new-profile", description: "d", prompt: "p" },
      { catalog: callable, port: unknownPort, spawnToolCallId: "toolu_4101_b" },
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toBe('Unknown agent_type "new-profile". Available agent types: glm-lead.');
  });
});

/**
 * Subagent preview tests (P7.21 W1): DEFAULT_TOOL_NAMES parity vs the real
 * registry, effectiveProfileTools ∩-semantics, and buildProfilePreview pinned
 * against the REAL buildChildConfig(...).systemPrompt (env/memory omitted).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_NAMES, effectiveProfileTools, buildProfilePreview } from "./preview.js";
import { buildChildConfig } from "./runner.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import type { PersonaDefinition } from "./personas.js";
import type { AgentLoopConfig } from "../loop/agent-loop.js";

describe("DEFAULT_TOOL_NAMES", () => {
  it("equals createDefaultToolRegistry().list() exactly (order included)", () => {
    expect([...DEFAULT_TOOL_NAMES]).toEqual(createDefaultToolRegistry().list());
  });
});

describe("effectiveProfileTools", () => {
  it("drops spawn tools + unknown names, keeps registry order, dedupes", () => {
    expect(effectiveProfileTools(["Read", "Agent", "Workflow", "NoSuchTool", "Grep", "Read"])).toEqual([
      "Read",
      "Grep",
    ]);
  });
  it("passes the general-purpose baseline through unchanged", () => {
    expect(effectiveProfileTools(["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoRead", "TodoWrite", "WebFetch"]))
      .toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoRead", "TodoWrite", "WebFetch"]);
  });
});

// A minimal parent — buildChildConfig only dereferences these fields to derive
// the child's systemPrompt (registry + persona), so stubs suffice.
function minimalParent(): AgentLoopConfig {
  return {
    modelPort: {},
    hooks: {},
    permissionEngine: {},
    permissionBroker: {},
    mode: "build",
    ports: {},
    cwd: "/work",
  } as unknown as AgentLoopConfig;
}

describe("buildProfilePreview parity", () => {
  it("matches buildChildConfig(...).systemPrompt with env/memory stripped", () => {
    const tools = ["Read", "Grep", "Agent", "NoSuchTool"];
    const body = "You review code carefully.";
    const persona: PersonaDefinition = {
      name: "reviewer",
      description: "d",
      tools,
      systemPrompt: body,
    };
    const child = buildChildConfig(minimalParent(), persona, {
      agentType: "reviewer",
      description: "d",
      prompt: "p",
    });
    const preview = buildProfilePreview({ name: "reviewer", description: "d", tools, body });

    expect(preview.systemPrompt).toBe(child.systemPrompt);
    expect(preview.effectiveTools).toEqual(child.registry.list());
    expect(preview.effectiveTools).toEqual(["Read", "Grep"]);
    // The real builder ran (finality note present); no env/memory leaked in.
    expect(preview.systemPrompt).toContain("You review code carefully.");
    expect(preview.systemPrompt).not.toContain("Agent");
  });

  it("applies the empty-body placeholder like the loader", () => {
    const preview = buildProfilePreview({ name: "bare", description: "d", body: "   " });
    expect(preview.systemPrompt).toContain('[agent profile "bare" — empty body]');
  });
});

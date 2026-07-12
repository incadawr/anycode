/**

 * Cover the prelude/body/finality layout, the prompt-level mirror of
 * non-recursion lock #1 (a child's prompt never names Agent/Workflow), memory
 * pass-through, and backward compatibility with the runner's required-only call.
 */

import { describe, expect, it } from "vitest";

import { buildSubagentSystemPrompt } from "./subagent.js";
import type { SystemPromptEnv } from "./system.js";
import { SECTION_SUBAGENT_FINALITY, SECTION_SUBAGENT_IDENTITY } from "./sections.js";

const PERSONA = { name: "general-purpose", systemPrompt: "PERSONA BODY MARKER" };

describe("buildSubagentSystemPrompt", () => {
  it("full child prelude matches the reviewed snapshot on a fixed fixture", () => {

    // names exclude Agent/Workflow by construction; env is included.
    const env: SystemPromptEnv = {
      workingDirectory: "/work/project",
      platform: "darwin",
      osVersion: "24.6.0",
      date: "2026-07-04",
      modelId: "test-model",
      isGitRepo: true,
    };
    const prompt = buildSubagentSystemPrompt(PERSONA, {
      toolNames: ["Read", "Grep", "Glob", "Bash", "WebFetch"],
      env,
    });
    expect(prompt).toMatchInlineSnapshot(`
      "You are a subagent that a parent agent has spun up to handle one specific task. You have no way to ask the user anything, so make your own decisions and stay tightly focused — your turn budget is limited, so use it well.

      The tools you may call are exactly those in the \`tools\` array of the CURRENT request; trust it over anything you remember — it can shrink between turns, e.g. when an MCP server reconnects.
      Do not call a tool absent from it or assume a capability exists because another product offers one; your only tools are those named to you, \`mcp__*\` included.
      If none of your tools cover a need, use Bash where that fits; otherwise tell the user plainly you cannot do it — never invent a tool name to paper over the gap.
      These are the tools available to you as this session begins:
      Bash, Glob, Grep, Read, WebFetch

      <env>
      Working directory: /work/project
      Platform: darwin
      OS version: 24.6.0
      Today's date: 2026-07-04
      Model: test-model
      Git repository: yes
      </env>

      PERSONA BODY MARKER

      Only your last message travels back to the parent; it is handed over as the result of the tool call that launched you. Make it a self-contained summary of what you did and what you found, and assume none of your earlier messages will be visible."
    `);
  });

  it("embeds the persona body verbatim and enumerates the child's tools", () => {
    const prompt = buildSubagentSystemPrompt(PERSONA, { toolNames: ["Read", "Grep", "Bash"] });
    expect(prompt).toContain("PERSONA BODY MARKER");
    expect(prompt).toContain("Bash, Grep, Read"); // sorted enumeration
  });

  it("never names Agent or Workflow — prompt-level mirror of non-recursion lock #1", () => {
    // The runner passes the child registry's names (Agent/Workflow already
    // dropped), so a realistic child tool list excludes them.
    const prompt = buildSubagentSystemPrompt(PERSONA, { toolNames: ["Read", "Grep"] });
    expect(prompt).not.toContain("Agent");
    expect(prompt).not.toContain("Workflow");
  });

  it("places the prelude before the persona body and the finality note last", () => {
    const prompt = buildSubagentSystemPrompt(PERSONA, { toolNames: ["Read"] });
    const iIdentity = prompt.indexOf(SECTION_SUBAGENT_IDENTITY);
    const iBody = prompt.indexOf("PERSONA BODY MARKER");
    const iFinality = prompt.indexOf(SECTION_SUBAGENT_FINALITY);
    expect(iIdentity).toBeGreaterThanOrEqual(0);
    expect(iIdentity).toBeLessThan(iBody);
    expect(iBody).toBeLessThan(iFinality);
  });

  it("passes the parent's memory section through when present and omits it (no gap) when empty", () => {
    const withMem = buildSubagentSystemPrompt(PERSONA, {
      toolNames: ["Read"],
      memorySection: "MEMORY MARKER",
    });
    expect(withMem).toContain("MEMORY MARKER");

    const withoutMem = buildSubagentSystemPrompt(PERSONA, { toolNames: ["Read"], memorySection: "" });
    expect(withoutMem).not.toContain("MEMORY MARKER");
    expect(withoutMem).not.toContain("\n\n\n");
  });

  it("renders the injected env facts", () => {
    const env: SystemPromptEnv = { workingDirectory: "/w", platform: "linux", date: "2026-07-04" };
    const prompt = buildSubagentSystemPrompt(PERSONA, { toolNames: ["Read"], env });
    expect(prompt).toContain("<env>");
    expect(prompt).toContain("Working directory: /w");
    expect(prompt).toContain("Platform: linux");
  });

  it("is valid with only the required toolNames (runner's 3-arg buildChildConfig path)", () => {
    const prompt = buildSubagentSystemPrompt(PERSONA, { toolNames: ["Read"] });
    expect(prompt).toContain("PERSONA BODY MARKER");
    expect(prompt).not.toContain("<env>");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

/**

 * cover the builder MECHANICS (determinism, purity, section order, graceful
 * degradation, budget) against imported section constants and injected data, so
 * they survive task 3.6.2's copy rewrite. 3.6.2 adds the full inline snapshot

 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildSystemPrompt, type SystemPromptEnv } from "./system.js";
import { IDENTITY_PROMPT } from "./identity.js";
import {
  SECTION_CONVENTIONS,
  SECTION_IDENTITY,
  SECTION_SAFETY,
  SECTION_TOOL_DISCIPLINE_TEMPLATE,
} from "./sections.js";
import { SYSTEM_PROMPT_SOFT_MAX_CHARS } from "../types/config.js";

const ENV: SystemPromptEnv = {
  workingDirectory: "/work/project",
  platform: "darwin",
  osVersion: "24.6.0",
  date: "2026-07-04",
  modelId: "test-model",
  isGitRepo: true,
};


// tool snapshot (built-ins + one mcp__ name) and full env. This inline snapshot
// is the human/orchestrator review artifact for the final base-prompt copy —
// update it CONSCIOUSLY when the section copy changes.
const SNAPSHOT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "Skill",
  "Agent",
  "Workflow",
  "mcp__example__do_thing",
];

describe("buildSystemPrompt", () => {
  it("full base prompt matches the reviewed snapshot on a fixed fixture", () => {
    expect(buildSystemPrompt({ toolNames: SNAPSHOT_TOOLS, env: ENV })).toMatchInlineSnapshot(`
      "You are AnyCode, a coding agent that operates inside the user's local workspace. You get work done strictly through the tools available to you, and everything you do runs on the user's own machine. A session is a single CLI conversation or one tab of the desktop app.

      Answer concisely — no filler, no echoing the request before acting. Learn the code before touching it: search with Read, Grep, and Glob instead of guessing. Prefer targeted Edits over rewriting files with Write. For multi-step work, keep the plan current with TodoWrite. Independent tool calls issued together in one response run concurrently — batch your reads and searches.

      Anything with side effects goes through the user's permission gate — never slip past it, e.g. by hiding a blocked action inside Bash. Run destructive or irreversible operations only when the user clearly asked. Never echo secrets, tokens, or credentials.

      The tools you may call are exactly those in the \`tools\` array of the CURRENT request; trust it over anything you remember — it can shrink between turns, e.g. when an MCP server reconnects.
      Do not call a tool absent from it or assume a capability exists because another product offers one; your only tools are those named to you, \`mcp__*\` included.
      If none of your tools cover a need, use Bash where that fits; otherwise tell the user plainly you cannot do it — never invent a tool name to paper over the gap.
      These are the tools available to you as this session begins:
      Agent, Bash, Edit, Glob, Grep, Read, Skill, TodoRead, TodoWrite, WebFetch, Workflow, Write, mcp__example__do_thing

      <env>
      Working directory: /work/project
      Platform: darwin
      OS version: 24.6.0
      Today's date: 2026-07-04
      Model: test-model
      Git repository: yes
      </env>"
    `);
  });

  it("zero-arg call returns a non-empty prompt (all existing call sites stay valid)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain(SECTION_IDENTITY);
  });

  it("is deterministic: equal options produce byte-identical output", () => {
    const a = buildSystemPrompt({ toolNames: ["Read", "Bash"], env: ENV });
    const b = buildSystemPrompt({ toolNames: ["Read", "Bash"], env: ENV });
    expect(a).toBe(b);
  });

  it("sorts toolNames, so input order does not affect output", () => {
    const a = buildSystemPrompt({ toolNames: ["Read", "Bash", "Grep"] });
    const b = buildSystemPrompt({ toolNames: ["Grep", "Read", "Bash"] });
    expect(a).toBe(b);
    // Sorted enumeration on its own line.
    expect(a).toContain("Bash, Grep, Read");
  });

  it("keeps the fixed section order: identity -> conventions -> safety -> tool-discipline -> env", () => {
    const prompt = buildSystemPrompt({ toolNames: ["Read"], env: ENV });
    const iId = prompt.indexOf(SECTION_IDENTITY);
    const iConv = prompt.indexOf(SECTION_CONVENTIONS);
    const iSafety = prompt.indexOf(SECTION_SAFETY);
    const iTools = prompt.indexOf(SECTION_TOOL_DISCIPLINE_TEMPLATE);
    const iEnv = prompt.indexOf("<env>");
    expect(iId).toBeGreaterThanOrEqual(0);
    expect(iId).toBeLessThan(iConv);
    expect(iConv).toBeLessThan(iSafety);
    expect(iSafety).toBeLessThan(iTools);
    expect(iTools).toBeLessThan(iEnv);
  });

  it("omits the env section (no empty gap) when no env is injected", () => {
    const prompt = buildSystemPrompt({ toolNames: ["Read"] });
    expect(prompt).not.toContain("<env>");
    expect(prompt).not.toContain("\n\n\n");
  });

  it("uses the generic tool-discipline text (no enumeration) when toolNames is absent or empty", () => {
    const absent = buildSystemPrompt();
    const empty = buildSystemPrompt({ toolNames: [] });
    // The enumeration TEMPLATE tail is NOT present without a snapshot.
    expect(absent).not.toContain(SECTION_TOOL_DISCIPLINE_TEMPLATE);
    expect(empty).not.toContain(SECTION_TOOL_DISCIPLINE_TEMPLATE);
    // ...but the discipline rules still are.
    expect(absent).toContain("Do not call a tool absent from it");
  });

  it("renders only the injected env fields — no arbitrary env-var value can leak (secret-form)", () => {
    const minimal = buildSystemPrompt({
      env: { workingDirectory: "/w", platform: "linux", date: "2026-07-04" },
    });
    expect(minimal).toContain("Working directory: /w");
    expect(minimal).toContain("Platform: linux");
    expect(minimal).toContain("Today's date: 2026-07-04");
    // Optional fields absent => their lines are omitted, no blank label.
    expect(minimal).not.toContain("Model:");
    expect(minimal).not.toContain("OS version:");
    expect(minimal).not.toContain("Git repository:");
  });

  it("stays under the soft budget with 12 built-ins + 40 fake mcp__ tools + full env", () => {
    const builtins = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoRead", "TodoWrite", "WebFetch", "Skill", "Agent", "Workflow"];
    const mcp = Array.from({ length: 40 }, (_, i) => `mcp__server_${i}__tool_${i}`);
    const prompt = buildSystemPrompt({ toolNames: [...builtins, ...mcp], env: ENV });
    expect(prompt.length).toBeLessThan(SYSTEM_PROMPT_SOFT_MAX_CHARS);
  });

  it("IDENTITY_PROMPT (barrel compat alias) is the identity section text", () => {
    expect(IDENTITY_PROMPT).toBe(SECTION_IDENTITY);
  });

  it("the prompt builder modules are pure: no clock, process.env, or Date reads", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    // Strip comments so a doc comment that merely NAMES process.env/the clock (to
    // document the purity contract) is not a false positive; we only want real
    // code reads.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const file of files) {
      const code = stripComments(readFileSync(join(dir, file), "utf-8"));
      expect(code, `${file} must not read the clock`).not.toMatch(/Date\.now|new Date\(/);
      expect(code, `${file} must not read process.env`).not.toMatch(/process\.env/);
    }
  });
});

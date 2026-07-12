/**
 * ModePermissionEngine rule table (Phase 0). Verifies every mode × tool cell of
 * the allow/ask/deny matrix using five fake tools that span the readOnly ×
 * riskLevel combinations the engine keys on.
 */

import { describe, expect, it } from "vitest";
import { ModePermissionEngine } from "./engine.js";
import type { PermissionMode } from "../types/permissions.js";
import type { RiskLevel, ToolMetadata } from "../types/tools.js";
import {
  agentTool,
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  skillTool,
  todoReadTool,
  todoWriteTool,
  webFetchTool,
  writeTool,
} from "../tools/index.js";

function meta(name: string, readOnly: boolean, riskLevel: RiskLevel): ToolMetadata {
  return {
    name,
    description: `${name} (fake)`,
    readOnly,
    destructive: !readOnly,
    concurrentSafe: readOnly,
    riskLevel,
    sideEffectScope: readOnly ? "none" : "filesystem",
    needsApproval: !readOnly,
    timeoutMs: 120_000,
  };
}

// Five tools chosen to cover the cells: readOnly × {low, high} and
// write × {low, medium, high}.
const tools = {
  read: meta("Read", true, "low"),
  grep: meta("Grep", true, "high"),
  write: meta("Write", false, "low"),
  edit: meta("Edit", false, "medium"),
  bash: meta("Bash", false, "high"),
} satisfies Record<string, ToolMetadata>;

type ToolKey = keyof typeof tools;

const modes: PermissionMode[] = ["yolo", "auto", "build", "edit", "plan"];

// Expected decision snapshot: mode -> tool -> ruling.decision.
const expected: Record<PermissionMode, Record<ToolKey, "allow" | "ask" | "deny">> = {
  yolo: { read: "allow", grep: "allow", write: "allow", edit: "allow", bash: "allow" },
  auto: { read: "allow", grep: "ask", write: "allow", edit: "allow", bash: "ask" },
  build: { read: "allow", grep: "allow", write: "ask", edit: "ask", bash: "ask" },
  edit: { read: "allow", grep: "allow", write: "ask", edit: "ask", bash: "ask" },
  plan: { read: "allow", grep: "allow", write: "deny", edit: "deny", bash: "deny" },
};

describe("ModePermissionEngine", () => {
  const engine = new ModePermissionEngine();

  it("matches the full mode × tool decision table", () => {
    const actual: Record<string, Record<string, string>> = {};
    for (const mode of modes) {
      actual[mode] = {};
      for (const key of Object.keys(tools) as ToolKey[]) {
        const ruling = engine.check({
          toolName: tools[key].name,
          input: {},
          metadata: tools[key],
          mode,
        });
        actual[mode]![key] = ruling.decision;
      }
    }
    expect(actual).toEqual(expected);
  });

  it("attaches a non-empty reason to every non-allow ruling", () => {
    for (const mode of modes) {
      for (const key of Object.keys(tools) as ToolKey[]) {
        const ruling = engine.check({
          toolName: tools[key].name,
          input: {},
          metadata: tools[key],
          mode,
        });
        if (ruling.decision === "allow") {
          continue;
        }
        expect(ruling.reason, `${mode}/${key}`).toBeTruthy();
        expect(ruling.reason).toContain(tools[key].name);
      }
    }
  });

  it("yolo allows even a destructive high-risk tool", () => {
    expect(engine.check({ toolName: "Bash", input: {}, metadata: tools.bash, mode: "yolo" })).toEqual({
      decision: "allow",
    });
  });

  it("auto asks for high risk regardless of readOnly", () => {
    // Grep is readOnly but high-risk: high risk wins in auto.
    expect(
      engine.check({ toolName: "Grep", input: {}, metadata: tools.grep, mode: "auto" }).decision,
    ).toBe("ask");
  });

  it("plan denies writes but allows reads", () => {
    expect(engine.check({ toolName: "Read", input: {}, metadata: tools.read, mode: "plan" }).decision).toBe(
      "allow",
    );
    expect(
      engine.check({ toolName: "Write", input: {}, metadata: tools.write, mode: "plan" }).decision,
    ).toBe("deny");
  });
});

/**
 * Phase 1 snapshot (design §2.8), extended to the eleven built-in tools (Phase 3
 * adds Agent + Skill): the needsApproval escalation runs against the real
 * registered metadata, not fakes. WebFetch (readOnly network tool,
 * needsApproval=true) must come out as "ask" in plan/build/edit and "allow" in
 * auto/yolo; the five Phase 0 tools must land on exactly the same verdicts as
 * before the escalation rule existed. Agent and Skill (readOnly,
 * needsApproval:false, riskLevel:low — design §3.4/§2.7) resolve to "allow" in
 * every mode: reading a skill is instructions, and a spawn is never gated
 * because the gate lives on the effectful tool calls, not the read/spawn.
 */
describe("ModePermissionEngine — mode × 11-tool snapshot (real tool metadata)", () => {
  const engine = new ModePermissionEngine();

  const realTools = {
    Read: readTool.metadata,
    Write: writeTool.metadata,
    Edit: editTool.metadata,
    Bash: bashTool.metadata,
    Grep: grepTool.metadata,
    Glob: globTool.metadata,
    TodoRead: todoReadTool.metadata,
    TodoWrite: todoWriteTool.metadata,
    WebFetch: webFetchTool.metadata,
    Agent: agentTool.metadata,
    Skill: skillTool.metadata,
  } satisfies Record<string, ToolMetadata>;

  const realModes: PermissionMode[] = ["yolo", "auto", "build", "edit", "plan"];

  const expectedSnapshot: Record<PermissionMode, Record<keyof typeof realTools, "allow" | "ask" | "deny">> = {
    yolo: {
      Read: "allow",
      Write: "allow",
      Edit: "allow",
      Bash: "allow",
      Grep: "allow",
      Glob: "allow",
      TodoRead: "allow",
      TodoWrite: "allow",
      WebFetch: "allow",
      Agent: "allow",
      Skill: "allow",
    },
    auto: {
      Read: "allow",
      Write: "allow",
      Edit: "allow",
      Bash: "ask", // riskLevel: high
      Grep: "allow",
      Glob: "allow",
      TodoRead: "allow",
      TodoWrite: "allow",
      WebFetch: "allow", // riskLevel: medium — auto only escalates on "high"
      Agent: "allow", // riskLevel: low
      Skill: "allow", // readOnly + riskLevel: low
    },
    build: {
      Read: "allow",
      Write: "ask",
      Edit: "ask",
      Bash: "ask",
      Grep: "allow",
      Glob: "allow",
      TodoRead: "allow",
      TodoWrite: "allow",
      WebFetch: "ask", // needsApproval escalation
      Agent: "allow", // readOnly + needsApproval:false — spawn is not gated
      Skill: "allow", // readOnly + needsApproval:false — reading instructions is not gated
    },
    edit: {
      Read: "allow",
      Write: "ask",
      Edit: "ask",
      Bash: "ask",
      Grep: "allow",
      Glob: "allow",
      TodoRead: "allow",
      TodoWrite: "allow",
      WebFetch: "ask", // needsApproval escalation
      Agent: "allow", // readOnly + needsApproval:false — spawn is not gated
      Skill: "allow", // readOnly + needsApproval:false — reading instructions is not gated
    },
    plan: {
      Read: "allow",
      Write: "deny",
      Edit: "deny",
      Bash: "deny",
      Grep: "allow",
      Glob: "allow",
      TodoRead: "allow",
      TodoWrite: "allow",
      WebFetch: "ask", // needsApproval escalation (base ruling was "allow": readOnly)
      Agent: "allow", // readOnly + needsApproval:false; child inherits plan (3.1.2 concern)
      Skill: "allow", // readOnly + needsApproval:false — skill body is instructions, not an effect
    },
  };

  it("matches the full mode × tool decision snapshot", () => {
    const actual: Record<string, Record<string, string>> = {};
    for (const mode of realModes) {
      actual[mode] = {};
      for (const name of Object.keys(realTools) as (keyof typeof realTools)[]) {
        const ruling = engine.check({ toolName: name, input: {}, metadata: realTools[name], mode });
        actual[mode]![name] = ruling.decision;
      }
    }
    expect(actual).toEqual(expectedSnapshot);
  });

  it("WebFetch: ask in plan/build/edit, allow in auto/yolo", () => {
    const decisions = realModes.map(
      (mode) => engine.check({ toolName: "WebFetch", input: {}, metadata: webFetchTool.metadata, mode }).decision,
    );
    expect(decisions).toEqual(["allow", "allow", "ask", "ask", "ask"]); // [yolo, auto, build, edit, plan]
  });

  it("the five Phase 0 tools are unaffected by the needsApproval escalation", () => {
    const phase0Names = ["Read", "Write", "Edit", "Bash", "Grep"] as const;
    for (const mode of realModes) {
      for (const name of phase0Names) {
        const withEscalation = engine.check({ toolName: name, input: {}, metadata: realTools[name], mode }).decision;
        // Same metadata but with needsApproval forced false must yield the identical verdict,
        // proving the escalation rule never fires for these five tools' real metadata.
        const withoutApprovalFlag = engine.check({
          toolName: name,
          input: {},
          metadata: { ...realTools[name], needsApproval: false },
          mode,
        }).decision;
        expect(withEscalation, `${mode}/${name}`).toBe(withoutApprovalFlag);
      }
    }
  });
});

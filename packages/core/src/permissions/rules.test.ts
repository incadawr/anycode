/**
 * Tests for SessionPermissionRules + RuleAwarePermissionEngine (design

 * behave identically to the bare ModePermissionEngine.
 */

import { describe, expect, it } from "vitest";
import { ModePermissionEngine } from "./engine.js";
import { RuleAwarePermissionEngine, SessionPermissionRules } from "./rules.js";
import { bashTool, editTool, globTool, grepTool, readTool, webFetchTool, writeTool } from "../tools/index.js";
import type { PermissionEngine, PermissionMode, PermissionRequest } from "../types/permissions.js";
import type { ToolMetadata } from "../types/tools.js";

describe("SessionPermissionRules", () => {
  it("starts empty", () => {
    expect(new SessionPermissionRules().list()).toEqual([]);
  });

  it("stores added rules in insertion order", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "git *" });
    rules.add({ toolName: "WebFetch" });
    expect(rules.list()).toEqual([
      { toolName: "Bash", pattern: "git *" },
      { toolName: "WebFetch" },
    ]);
  });
});

describe("RuleAwarePermissionEngine", () => {
  const base = new ModePermissionEngine();

  it("downgrades ask -> allow when a bare tool rule matches (build-mode write tool)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Write" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Write",
      input: { file_path: "/tmp/x", content: "y" },
      metadata: writeTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("allow");
  });

  it("Bash + pattern 'git *': allows a matching command, still asks for a non-matching one", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "git *" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const gitStatus = engine.check({
      toolName: "Bash",
      input: { command: "git status" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(gitStatus.decision).toBe("allow");

    const rm = engine.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(rm.decision).toBe("ask");
  });

  it("P7.16 W1-FIX3: an env-prefixed command does NOT match a bare-binary pattern (raw subject, reverted)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "node *" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: 'OUT="/tmp/o" node x.mjs' },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 W1-FIX3: a bare (non-prefixed) command still matches the bare-binary pattern", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "node *" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "node x.mjs" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("allow");
  });

  it("P7.16 W1-FIX3 security PoC: NODE_OPTIONS loader-injection prefix does NOT match `node *` (was auto-allow pre-revert)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "node *" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "NODE_OPTIONS=--require=/tmp/payload.js node --version" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 W1-FIX3 security PoC: LD_PRELOAD prefix does NOT match `node *` (was auto-allow pre-revert)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "node *" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "LD_PRELOAD=/tmp/e.so node x" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 W1-FIX4 security PoC: a stored '!node' pattern does NOT match 'rm -rf /' (negation disabled, matches literally)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "!node" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 W1-FIX4 security PoC: a stored '!node' pattern does NOT match an unrelated benign command either (negation disabled)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "!node" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "echo hi" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 W1-FIX4 security PoC: a stored '@(node|rm)' pattern does NOT match 'rm x' (extglob disabled, matches literally)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "@(node|rm)" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "rm x" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 W1-FIX4: a normal 'node *' pattern is unaffected by the nonegate/noext options -- still matches", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "node *" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "node x.mjs" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("allow");
  });

  it("P7.16 W1-FIX4: an undefined pattern (bare tool rule) still matches every call, unaffected by the picomatch option change", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("allow");
  });

  it("P7.16 FIX5 security PoC: a stored '*(**)' pattern does NOT match 'rm -rf /' (noext leaves bare parens as a regex group)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "*(**)" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 FIX5 security PoC: a stored '?(**)' pattern does NOT match 'rm -rf /' (noext leaves bare parens as a regex group)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "?(**)" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 FIX5 security PoC: a stored '(**)' pattern (bare, no extglob sigil) does NOT match 'rm -rf /'", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "(**)" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 FIX5 security PoC: a stored '**()' pattern (trailing empty group) does NOT match 'rm -rf /'", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "**()" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("P7.16 FIX5 regression: an unparenthesized 'node*' pattern still matches a command whose SUBJECT (not pattern) contains parens", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "node*" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "node(x)" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("allow");
  });

  it("P7.16 FIX5 sanity: brace-alternation patterns are unaffected by the paren guard", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "git {push,pull}" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Bash",
      input: { command: "git push" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("allow");
  });

  it("never overrides a plan-mode deny even when a matching rule exists", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Write" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Write",
      input: { file_path: "/tmp/x", content: "y" },
      metadata: writeTool.metadata,
      mode: "plan",
    });
    expect(ruling.decision).toBe("deny");
  });

  it("WebFetch + url glob: allows a matching URL (needsApproval escalation to ask, then downgraded)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "WebFetch", pattern: "https://example.com/**" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const allowed = engine.check({
      toolName: "WebFetch",
      input: { url: "https://example.com/docs", prompt: "x" },
      metadata: webFetchTool.metadata,
      mode: "build",
    });
    expect(allowed.decision).toBe("allow");

    const notAllowed = engine.check({
      toolName: "WebFetch",
      input: { url: "https://other.example/docs", prompt: "x" },
      metadata: webFetchTool.metadata,
      mode: "build",
    });
    expect(notAllowed.decision).toBe("ask");
  });

  it("does not match a rule scoped to a different tool name", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Edit" });
    const engine = new RuleAwarePermissionEngine(base, rules);

    const ruling = engine.check({
      toolName: "Write",
      input: { file_path: "/tmp/x", content: "y" },
      metadata: writeTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("a bare rule (no pattern) matches an unknown tool's calls regardless of input", () => {
    const askAlways: PermissionEngine = { check: () => ({ decision: "ask", reason: "test" }) };
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "CustomTool" });
    const engine = new RuleAwarePermissionEngine(askAlways, rules);

    const ruling = engine.check({
      toolName: "CustomTool",
      input: { anything: "x" },
      metadata: {} as ToolMetadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("allow");
  });

  it("a patterned rule can never match an unknown tool (no subject-extraction entry)", () => {
    const askAlways: PermissionEngine = { check: () => ({ decision: "ask", reason: "test" }) };
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "CustomTool", pattern: "*" });
    const engine = new RuleAwarePermissionEngine(askAlways, rules);

    const ruling = engine.check({
      toolName: "CustomTool",
      input: { anything: "x" },
      metadata: {} as ToolMetadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("an empty store behaves identically to the base ModePermissionEngine (regression invariant)", () => {
    const engine = new RuleAwarePermissionEngine(base, new SessionPermissionRules());
    const modes: PermissionMode[] = ["yolo", "auto", "build", "edit", "plan"];
    const tools: Record<string, ToolMetadata> = {
      Read: readTool.metadata,
      Write: writeTool.metadata,
      Edit: editTool.metadata,
      Bash: bashTool.metadata,
      Grep: grepTool.metadata,
      Glob: globTool.metadata,
      WebFetch: webFetchTool.metadata,
    };
    for (const mode of modes) {
      for (const [toolName, metadata] of Object.entries(tools)) {
        const request: PermissionRequest = { toolName, input: {}, metadata, mode };
        expect(engine.check(request)).toEqual(base.check(request));
      }
    }
  });

  it("never touches an allow ruling (passes it through unchanged)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Read" });
    const engine = new RuleAwarePermissionEngine(base, rules);
    const ruling = engine.check({
      toolName: "Read",
      input: { file_path: "/tmp/x" },
      metadata: readTool.metadata,
      mode: "build",
    });
    expect(ruling).toEqual({ decision: "allow" });
  });
});

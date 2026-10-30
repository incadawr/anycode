/** Tests for safe-command permission narrowing and its production composition. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModePermissionEngine } from "./engine.js";
import { RuleAwarePermissionEngine, SessionPermissionRules } from "./rules.js";
import { SafeCommandPermissionEngine } from "./safe-command-engine.js";
import { bashTool, writeTool } from "../tools/index.js";
import type { PermissionEngine, PermissionRequest } from "../types/permissions.js";

/** A base engine that returns a fixed "ask" for every request (isolates the narrowing logic). */
const askAlways: PermissionEngine = { check: () => ({ decision: "ask", reason: "base ask" }) };

function bashRequest(command: unknown, mode: PermissionRequest["mode"] = "build"): PermissionRequest {
  return { toolName: "Bash", input: { command }, metadata: bashTool.metadata, mode };
}

let originalPath: string | undefined;
beforeEach(() => { originalPath = process.env.PATH; process.env.PATH = "/usr/bin:/bin"; });
afterEach(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });

describe("SafeCommandPermissionEngine", () => {
  it("downgrades an ask -> allow for a provably read-only Bash command", () => {
    const engine = new SafeCommandPermissionEngine(askAlways);
    const ruling = engine.check(bashRequest("ls"));
    expect(ruling.decision).toBe("allow");
    // The reason must name the safe-command provenance (auto-approved read-only).
    expect(ruling.reason).toContain("read-only");
    expect(ruling.reason).toContain("auto-approved");
  });

  it("leaves an ask untouched for an unsafe Bash command", () => {
    const engine = new SafeCommandPermissionEngine(askAlways);
    const ruling = engine.check(bashRequest("rm -rf x"));
    expect(ruling.decision).toBe("ask");
  });

  it("never classifies a non-Bash tool — a Write ask passes through untouched [hazard b]", () => {
    // A classify that would throw if ever consulted proves the non-Bash guard
    // returns before the classifier is reached.
    const explodingClassify = (): never => {
      throw new Error("classify must not be called for a non-Bash tool");
    };
    const engine = new SafeCommandPermissionEngine(askAlways, explodingClassify);
    const ruling = engine.check({
      toolName: "Write",
      input: { file_path: "/tmp/x", content: "y" },
      metadata: writeTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("allows proven read-only plan commands and denies unsafe forms", () => {
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    for (const command of ["ls -la dir", "wc -l file", "cat file | head"]) {
      expect(engine.check(bashRequest(command, "plan")).decision, command).toBe("allow");
    }
    for (const command of ["rm file", "ls > file", "ls; rm file", "ls && rm file", "cat file | tee out", "$(touch file)"]) {
      const ruling = engine.check(bashRequest(command, "plan"));
      expect(ruling.decision, command).toBe("deny");
      expect(ruling.reason).toMatch(/not proven read-only|unsupported shell syntax/);
      for (const tool of ["Glob", "Read", "Git"]) expect(ruling.reason).toContain(tool);
    }
    expect(engine.check(bashRequest(null, "plan")).decision).toBe("deny");
  });


  it("preserves build approvals while denying path-qualified commands and Git in plan", () => {
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    for (const command of ["./tools/ls", "/bin/ls", "git diff --ext-diff", "git log --textconv", "git status"]) {
      const plan = engine.check(bashRequest(command, "plan"));
      expect(plan.decision, command).toBe("deny");
      expect(plan.reason).toContain("Git");
      expect(engine.check(bashRequest(command, "build")).decision, command).toBe("allow");
    }
    expect(engine.check(bashRequest("git status --short | head", "plan")).decision).toBe("deny");
    expect(engine.check(bashRequest("git status --short | head", "build")).decision).toBe("ask");
  });

  it("denies a PATH-shadowed binary and a writable earlier PATH directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-shadow-"));
    try {
      writeFileSync(join(dir, "ls"), "#!/bin/sh\ntouch marker\n", { mode: 0o755 });
      process.env.PATH = `${dir}:/usr/bin:/bin`;
      const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
      expect(engine.check(bashRequest("ls", "plan")).decision).toBe("deny");
      expect(engine.check(bashRequest("cat file | ls", "plan")).decision).toBe("deny");
      expect(engine.check(bashRequest("ls", "build")).decision).toBe("allow");
      rmSync(join(dir, "ls"));
      expect(engine.check(bashRequest("ls", "plan")).decision).toBe("deny");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("preserves unrelated denials and never trusts an injected classifier for plan denials", () => {
    const deny: PermissionEngine = { check: () => ({ decision: "deny", reason: "policy denial" }) };
    expect(new SafeCommandPermissionEngine(deny).check(bashRequest("ls", "plan"))).toEqual({ decision: "deny", reason: "policy denial" });
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine(), () => "read-only");
    expect(engine.check(bashRequest("rm file", "plan")).decision).toBe("deny");
    expect(engine.check({ ...bashRequest("rm file", "plan"), metadata: { ...bashTool.metadata, readOnly: true, needsApproval: true } }).decision).toBe("ask");
    expect(new SafeCommandPermissionEngine(new ModePermissionEngine()).check(bashRequest("git status --short | head", "build")).decision).toBe("ask");
  });

  it("never overrides a base allow — a yolo-mode Bash stays allow with the base's own reason", () => {
    // Real ModePermissionEngine: yolo -> allow (no reason); the narrowing engine
    // must return it verbatim, not rewrite it to the auto-approved reason.
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    const ruling = engine.check(bashRequest("git status", "yolo"));
    expect(ruling).toEqual({ decision: "allow" });
  });

  it("fails closed to ask when a Bash request has no string command", () => {
    const engine = new SafeCommandPermissionEngine(askAlways);
    // Missing command field.
    expect(engine.check({ toolName: "Bash", input: {}, metadata: bashTool.metadata, mode: "build" }).decision).toBe(
      "ask",
    );
    // Null input.
    expect(
      engine.check({ toolName: "Bash", input: null, metadata: bashTool.metadata, mode: "build" }).decision,
    ).toBe("ask");
    // Non-string command.
    expect(engine.check(bashRequest(123)).decision).toBe("ask");
  });

  it("honors the injected classify decision (the U1-P5 / unit-test seam)", () => {
    // The injected classifier — not the command text — decides: an "unknown"
    // stub keeps the ask even for a normally-safe command; a "read-only" stub
    // downgrades even a normally-unsafe one.
    const denyingEngine = new SafeCommandPermissionEngine(askAlways, () => "unknown");
    expect(denyingEngine.check(bashRequest("ls")).decision).toBe("ask");

    const allowingEngine = new SafeCommandPermissionEngine(askAlways, () => "read-only");
    expect(allowingEngine.check(bashRequest("rm -rf /")).decision).toBe("allow");
  });
});

describe("SafeCommandPermissionEngine composed with RuleAwarePermissionEngine — RuleAware(SafeCommand(Mode))", () => {
  /** Builds the exact production composition (cli/main.ts:396) around a fresh rules store. */
  function build(rules = new SessionPermissionRules()): {
    engine: RuleAwarePermissionEngine;
    rules: SessionPermissionRules;
  } {
    const engine = new RuleAwarePermissionEngine(
      new SafeCommandPermissionEngine(new ModePermissionEngine()),
      rules,
    );
    return { engine, rules };
  }

  it("safe Bash in build is auto-allowed by the safe-command layer (no rule needed)", () => {
    const { engine } = build();
    expect(engine.check(bashRequest("ls")).decision).toBe("allow");
  });

  it("unsafe Bash in build still asks when neither layer narrows it", () => {
    const { engine } = build();
    expect(engine.check(bashRequest("rm -rf x")).decision).toBe("ask");
  });

  it("unsafe Bash in build is allowed by a session /allow rule (the rules layer still works)", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash", pattern: "rm *" });
    const { engine } = build(rules);
    expect(engine.check(bashRequest("rm -rf x")).decision).toBe("allow");
  });

  it("a plan-mode Write is denied even with a matching rule — neither layer overrides deny [L3]", () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Write" });
    const { engine } = build(rules);
    const ruling = engine.check({
      toolName: "Write",
      input: { file_path: "/tmp/x", content: "y" },
      metadata: writeTool.metadata,
      mode: "plan",
    });
    expect(ruling.decision).toBe("deny");
  });

  it("a plan-mode read-only Bash is allowed through the full composition", () => {
    const { engine } = build();
    expect(engine.check(bashRequest("ls", "plan")).decision).toBe("allow");
  });
});

describe("SafeCommandPermissionEngine — pipelines", () => {
  it("EN1: the DEFAULT classifier (no injection) allows a proven read-only pipeline, same reason string as single commands", () => {
    const engine = new SafeCommandPermissionEngine(askAlways);
    const ruling = engine.check(bashRequest("sed -n '1,5p' f | cat -A"));
    expect(ruling.decision).toBe("allow");
    expect(ruling.reason).toContain("read-only");
    expect(ruling.reason).toContain("auto-approved");
  });

  it("EN2: auto mode + a safe pipeline is allowed through the composed production stack", () => {
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    const ruling = engine.check(bashRequest("sed -n '1,5p' f | cat -A", "auto"));
    expect(ruling.decision).toBe("allow");
  });

  it("EN3: pipelines with an effectful or excluded segment still ask in build", () => {
    const engine = new SafeCommandPermissionEngine(askAlways);
    expect(engine.check(bashRequest("cat f | tee out")).decision).toBe("ask");
    expect(engine.check(bashRequest("git status | cat")).decision).toBe("ask");
  });

  it("EN4: plan mode allows a proven-safe pipeline through the composed stack", () => {
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    const ruling = engine.check(bashRequest("sed -n '1p' f | cat", "plan"));
    expect(ruling.decision).toBe("allow");
  });

  it("EN5: yolo + pipeline passes the base's own ruling through verbatim (no auto-approved reason)", () => {
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    const ruling = engine.check(bashRequest("sed -n '1p' f | cat", "yolo"));
    expect(ruling).toEqual({ decision: "allow" });
  });

  it("EN6: the injected classifier still wins the seam for pipelines", () => {
    const denyingEngine = new SafeCommandPermissionEngine(askAlways, () => "unknown");
    expect(denyingEngine.check(bashRequest("sed -n '1p' f | cat")).decision).toBe("ask");

    const allowingEngine = new SafeCommandPermissionEngine(askAlways, () => "read-only");
    expect(allowingEngine.check(bashRequest("cat f | sh")).decision).toBe("allow");
  });
});

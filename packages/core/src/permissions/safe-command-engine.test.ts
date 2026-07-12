/**
 * Tests for SafeCommandPermissionEngine (Phase 5 slice-5.1-cut.md §2.2/§6).
 * The narrowing invariant mirrors RuleAwarePermissionEngine: an "ask" from the
 * base is downgraded to "allow" ONLY for a Bash command the classifier proves
 * read-only; "allow"/"deny" verdicts pass through untouched (L3), non-Bash
 * requests are never classified, and a Bash request with no string `command`

 * production composition RuleAware(SafeCommand(Mode)) — both narrowing layers
 * coexisting over the untouched mode table.
 */

import { describe, expect, it } from "vitest";
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

describe("SafeCommandPermissionEngine", () => {
  it("downgrades an ask -> allow for a provably read-only Bash command", () => {
    const engine = new SafeCommandPermissionEngine(askAlways);
    const ruling = engine.check(bashRequest("git status"));
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

  it("never overrides a base deny — a plan-mode read-only Bash stays denied [hazard g, L3]", () => {
    // Real ModePermissionEngine: Bash is not readOnly, so plan mode -> deny.
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    const ruling = engine.check(bashRequest("git status", "plan"));
    expect(ruling.decision).toBe("deny");
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
    expect(denyingEngine.check(bashRequest("git status")).decision).toBe("ask");

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
    expect(engine.check(bashRequest("git status")).decision).toBe("allow");
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

  it("a plan-mode read-only Bash is still denied through the full composition [hazard g]", () => {
    const { engine } = build();
    expect(engine.check(bashRequest("git status", "plan")).decision).toBe("deny");
  });
});

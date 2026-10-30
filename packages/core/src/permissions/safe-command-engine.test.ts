/** Tests for safe-command permission narrowing and its production composition. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModePermissionEngine } from "./engine.js";
import { RuleAwarePermissionEngine, SessionPermissionRules } from "./rules.js";
import { SafeCommandPermissionEngine } from "./safe-command-engine.js";
import { bashTool, writeTool } from "../tools/index.js";
import { executeToolCall } from "../dispatch/dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import type { DispatchContext } from "../dispatch/dispatcher.js";
import type { CorePorts } from "../ports/index.js";
import type { HookRunner } from "../types/hooks.js";
import type { PermissionEngine, PermissionRequest } from "../types/permissions.js";

// Root can write system binaries even when their mode excludes writes. Model
// ordinary-user W_OK for those paths while retaining all other real checks.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    accessSync: (path: Parameters<typeof fs.accessSync>[0], mode?: number) => {
      if (process.getuid?.() === 0 && mode === fs.constants.W_OK) {
        const stat = fs.statSync(path);
        if (stat.uid === 0 && (stat.mode & 0o022) === 0) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
      }
      return fs.accessSync(path, mode);
    },
  };
});

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

  it("resolves each command along realistic PATH entries in the command cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-path-"));
    const workspace = join(dir, "workspace");
    const relativeBin = join(workspace, "node_modules", ".bin");
    const writableBin = join(dir, "writable");
    mkdirSync(relativeBin, { recursive: true });
    mkdirSync(writableBin);
    const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
    const check = (command: string) => engine.check({ ...bashRequest(command, "plan"), cwd: workspace }).decision;
    try {
      process.env.PATH = `./node_modules/.bin:${writableBin}:/usr/bin:/bin`;
      for (const command of ["ls", "wc", "head", "ls | head"]) expect(check(command), command).toBe("allow");
      writeFileSync(join(writableBin, "ls"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(check("ls")).toBe("deny");
      expect(check("ls | head")).toBe("deny");
      rmSync(join(writableBin, "ls"));
      writeFileSync(join(relativeBin, "ls"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(check("ls")).toBe("deny");
      expect(check("git status")).toBe("deny");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("denies a PATH-shadowed binary but permits an empty writable earlier directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-shadow-"));
    try {
      writeFileSync(join(dir, "ls"), "#!/bin/sh\ntouch marker\n", { mode: 0o755 });
      process.env.PATH = `${dir}:/usr/bin:/bin`;
      const engine = new SafeCommandPermissionEngine(new ModePermissionEngine());
      expect(engine.check(bashRequest("ls", "plan")).decision).toBe("deny");
      expect(engine.check(bashRequest("cat file | ls", "plan")).decision).toBe("deny");
      expect(engine.check(bashRequest("ls", "build")).decision).toBe("allow");
      rmSync(join(dir, "ls"));
      expect(engine.check(bashRequest("ls", "plan")).decision).toBe("allow");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([["ls", "ls"], ["ls | head", "ls"], ["ls | head", "head"]])("executes checked binaries after PATH shadows appear: %s (%s)", async (command, shadow) => {
    const dir = mkdtempSync(join(tmpdir(), "plan-race-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "visible"), "content");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const exec = new NodeExecutionAdapter();
    const registry = { get: () => bashTool } as unknown as ToolRegistry;
    const hooks = { runPreToolUse: async () => ({}), runObservers: async () => {} } as unknown as HookRunner;
    try {
      const ctx = {
        registry, hooks, mode: "plan", cwd: dir,
        permissionEngine: new SafeCommandPermissionEngine(new ModePermissionEngine()),
        permissionBroker: { requestPermission: async () => ({ behavior: "deny", reason: "unexpected" }) },
        ports: { exec: { run: (request: Parameters<typeof exec.run>[0]) => {
          writeFileSync(join(bin, shadow), "#!/bin/sh\nprintf SHADOW\n", { mode: 0o755 });
          return exec.run(request);
        } } } as unknown as CorePorts,
      } as DispatchContext;
      const outcome = await executeToolCall(ctx, { id: "race", name: "Bash", input: { command } });
      expect(outcome.status, command).toBe("success");
      expect(outcome.modelText, command).toContain("visible");
      expect(outcome.modelText, command).not.toContain("SHADOW");
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

/**
 * Tests for parseRunAllowBash + RunAllowBashPermissionEngine (TASK.138 slice
 * 2). Mirrors safe-command-engine.test.ts's structure: unit tests against a
 * fixed "ask always" base to isolate the narrowing logic, then a composed
 * suite over the real production chain shape (ModePermissionEngine ->
 * SafeCommandPermissionEngine -> RunAllowBashPermissionEngine), exercised in
 * build mode where Bash always asks absent narrowing.
 */

import { describe, expect, it } from "vitest";
import { ModePermissionEngine } from "./engine.js";
import { SafeCommandPermissionEngine } from "./safe-command-engine.js";
import { parseRunAllowBash, RunAllowBashPermissionEngine } from "./run-allow-bash.js";
import { bashTool, writeTool } from "../tools/index.js";
import type { PermissionEngine, PermissionRequest } from "../types/permissions.js";

/** A base engine that returns a fixed "ask" for every request (isolates the narrowing logic). */
const askAlways: PermissionEngine = { check: () => ({ decision: "ask", reason: "base ask" }) };

function bashRequest(command: unknown, mode: PermissionRequest["mode"] = "build"): PermissionRequest {
  return { toolName: "Bash", input: { command }, metadata: bashTool.metadata, mode };
}

describe("parseRunAllowBash", () => {
  it("returns [] for undefined (env var absent) — the no-op fast path", () => {
    expect(parseRunAllowBash(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(parseRunAllowBash("")).toEqual([]);
  });

  it("splits on commas and tokenizes each entry on whitespace", () => {
    expect(parseRunAllowBash("pnpm test,pnpm typecheck")).toEqual([["pnpm", "test"], ["pnpm", "typecheck"]]);
  });

  it("trims surrounding whitespace on each comma-separated item", () => {
    expect(parseRunAllowBash("  pnpm test  , pnpm typecheck ")).toEqual([["pnpm", "test"], ["pnpm", "typecheck"]]);
  });

  it("collapses internal runs of whitespace within one entry into single-token separators", () => {
    expect(parseRunAllowBash("pnpm   test")).toEqual([["pnpm", "test"]]);
  });

  it("drops empty/whitespace-only items instead of producing a match-everything entry", () => {
    expect(parseRunAllowBash("pnpm test,,  ,pnpm typecheck")).toEqual([["pnpm", "test"], ["pnpm", "typecheck"]]);
    expect(parseRunAllowBash(",,,")).toEqual([]);
    expect(parseRunAllowBash("   ")).toEqual([]);
  });
});

describe("RunAllowBashPermissionEngine", () => {
  it("leaves ask untouched when the allow-list is empty — env-unset zero-behavior-change path", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, []);
    expect(engine.check(bashRequest("pnpm test")).decision).toBe("ask");
  });

  it("downgrades ask -> allow for an exact allow-listed command", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    const ruling = engine.check(bashRequest("pnpm test"));
    expect(ruling.decision).toBe("allow");
    expect(ruling.reason).toContain("ANYCODE_RUN_ALLOW_BASH");
    expect(ruling.reason).toContain("pnpm test");
  });

  it("matches a command with extra trailing args (prefix, not exact-string)", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test --run")).decision).toBe("allow");
  });

  it("does NOT match a token that merely shares a prefix — pnpm testify vs entry pnpm test", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm testify")).decision).toBe("ask");
  });

  it("does NOT match a command shorter than the entry", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test --run"));
    expect(engine.check(bashRequest("pnpm test")).decision).toBe("ask");
  });

  it("never matches a composite command even when its prefix is allow-listed — pnpm test && rm -rf /", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test && rm -rf /")).decision).toBe("ask");
  });

  it("never matches a piped command even when every segment looks innocuous", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test | cat")).decision).toBe("ask");
  });

  it("never matches a command carrying a shell metacharacter (redirect)", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test > out.txt")).decision).toBe("ask");
  });

  it("never matches a semicolon-separated command", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test; rm -rf /")).decision).toBe("ask");
  });

  it("never classifies a non-Bash tool — a Write ask passes through untouched", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    const ruling = engine.check({
      toolName: "Write",
      input: { file_path: "/tmp/x", content: "y" },
      metadata: writeTool.metadata,
      mode: "build",
    });
    expect(ruling.decision).toBe("ask");
  });

  it("fails closed to ask when a Bash request has no string command", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(
      engine.check({ toolName: "Bash", input: {}, metadata: bashTool.metadata, mode: "build" }).decision,
    ).toBe("ask");
    expect(
      engine.check({ toolName: "Bash", input: null, metadata: bashTool.metadata, mode: "build" }).decision,
    ).toBe("ask");
    expect(engine.check(bashRequest(123)).decision).toBe("ask");
  });

  it("never overrides a base deny — a plan-mode Bash stays denied", () => {
    const engine = new RunAllowBashPermissionEngine(new ModePermissionEngine(), parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test", "plan")).decision).toBe("deny");
  });

  it("never overrides a base allow — a yolo-mode Bash stays allow with the base's own (empty) reason", () => {
    const engine = new RunAllowBashPermissionEngine(new ModePermissionEngine(), parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test", "yolo"))).toEqual({ decision: "allow" });
  });

  it("matches whichever configured entry the command's tokens are prefixed by", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test,pnpm typecheck"));
    expect(engine.check(bashRequest("pnpm typecheck")).decision).toBe("allow");
    expect(engine.check(bashRequest("pnpm build")).decision).toBe("ask");
  });
});

describe("RunAllowBashPermissionEngine composed with the production chain shape (Mode -> SafeCommand -> RunAllowBash)", () => {
  function build(allowRaw: string | undefined): PermissionEngine {
    return new RunAllowBashPermissionEngine(
      new SafeCommandPermissionEngine(new ModePermissionEngine()),
      parseRunAllowBash(allowRaw),
    );
  }

  it("an unset ANYCODE_RUN_ALLOW_BASH leaves build-mode Bash asking exactly like before this engine existed", () => {
    const engine = build(undefined);
    expect(engine.check(bashRequest("pnpm test")).decision).toBe("ask");
    // The safe-command layer beneath still narrows a provably read-only command.
    expect(engine.check(bashRequest("git status")).decision).toBe("allow");
  });

  it("an allow-listed command runs in build mode without asking", () => {
    const engine = build("pnpm test,pnpm typecheck");
    expect(engine.check(bashRequest("pnpm test")).decision).toBe("allow");
    expect(engine.check(bashRequest("pnpm typecheck")).decision).toBe("allow");
  });

  it("a non-allow-listed command still asks in build mode", () => {
    const engine = build("pnpm test");
    expect(engine.check(bashRequest("pnpm build")).decision).toBe("ask");
  });

  it("plan mode still denies an allow-listed Bash command through the full composition", () => {
    const engine = build("pnpm test");
    expect(engine.check(bashRequest("pnpm test", "plan")).decision).toBe("deny");
  });

  it("a composite command riding on an allow-listed prefix is still denied approval in plan mode and still asks in build mode", () => {
    const engine = build("pnpm test");
    expect(engine.check(bashRequest("pnpm test && rm -rf /", "build")).decision).toBe("ask");
    expect(engine.check(bashRequest("pnpm test && rm -rf /", "plan")).decision).toBe("deny");
  });
});

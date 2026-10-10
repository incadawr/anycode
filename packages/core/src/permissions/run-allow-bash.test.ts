/**
 * Tests for parseRunAllowBash + RunAllowBashPermissionEngine (TASK.138 slices
 * 2–3). Mirrors safe-command-engine.test.ts's structure: unit tests against a
 * fixed "ask always" base to isolate the narrowing logic, then a composed
 * suite over the real production chain shape (ModePermissionEngine ->
 * SafeCommandPermissionEngine -> RunAllowBashPermissionEngine), exercised in
 * build mode where Bash always asks absent narrowing.
 *
 * Slice 3 adds compound-line coverage (`&&`, `||`, `;`, `|`, newline): a line
 * is allowed ONLY when EVERY nonempty segment independently prefix-matches an
 * explicit entry. An uncovered/unknown segment in any position, an unsafe
 * separator (single `&`, `|&`), a blank/malformed segment, any redirect,
 * substitution, escape, expansion, assignment, comment, control character, or
 * quoted metacharacter all preserve the base "ask".
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
    // Exact single-command reason (compatibility contract).
    expect(ruling.reason).toBe(
      'Bash: auto-approved (matches ANYCODE_RUN_ALLOW_BASH entry "pnpm test")',
    );
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

  it("rejects an UNCOVERED trailing segment — pnpm test && rm -rf / with only pnpm test allow-listed", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test && rm -rf /")).decision).toBe("ask");
  });

  it("rejects an UNCOVERED piped segment — pnpm test | cat with only pnpm test allow-listed", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test | cat")).decision).toBe("ask");
  });

  it("never matches a command carrying a shell metacharacter (redirect)", () => {
    const engine = new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash("pnpm test"));
    expect(engine.check(bashRequest("pnpm test > out.txt")).decision).toBe("ask");
  });

  it("rejects an UNCOVERED semicolon-separated segment — pnpm test; rm -rf / with only pnpm test allow-listed", () => {
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

describe("RunAllowBashPermissionEngine compound lines (&&, ||, ;, |, newline)", () => {
  function engineFor(allowRaw: string): PermissionEngine {
    return new RunAllowBashPermissionEngine(askAlways, parseRunAllowBash(allowRaw));
  }

  function expectAsk(allowRaw: string, command: string): void {
    expect(engineFor(allowRaw).check(bashRequest(command))).toEqual({ decision: "ask", reason: "base ask" });
  }

  it("allows every segment when each independently matches an entry", () => {
    const ruling = engineFor("cd,npx vitest run").check(
      bashRequest("cd packages/core && npx vitest run src/x.test.ts"),
    );
    expect(ruling.decision).toBe("allow");
    expect(ruling.reason).toContain("ANYCODE_RUN_ALLOW_BASH");
    expect(ruling.reason).toContain("cd");
    expect(ruling.reason).toContain("npx vitest run");
  });

  it("allows a semicolon-separated line of covered segments", () => {
    expect(engineFor("pnpm test,pnpm typecheck").check(bashRequest("pnpm test; pnpm typecheck")).decision).toBe(
      "allow",
    );
  });

  it("allows a piped line when every segment is covered", () => {
    expect(engineFor("pnpm test,rg").check(bashRequest("pnpm test | rg foo")).decision).toBe("allow");
  });

  it("allows ||-separated and newline-separated covered lines", () => {
    expect(engineFor("pnpm test,pnpm typecheck").check(bashRequest("pnpm test || pnpm typecheck")).decision).toBe(
      "allow",
    );
    expect(engineFor("pnpm test,pnpm typecheck").check(bashRequest("pnpm test\npnpm typecheck")).decision).toBe(
      "allow",
    );
  });

  it("compares token-exactly within each segment (extra args match, a near-miss does not)", () => {
    expect(
      engineFor("cd,npx vitest run").check(bashRequest("cd packages/core && npx vitest run --root x")).decision,
    ).toBe("allow");
    expectAsk("cd,npx vitest run", "cd packages/core && npx testify");
  });

  it("allows a mixed three-segment line and tolerates layout whitespace", () => {
    expect(
      engineFor("cd,pnpm test,pnpm typecheck").check(bashRequest("cd packages/core && pnpm test; pnpm typecheck"))
        .decision,
    ).toBe("allow");
    expect(engineFor("cd,pnpm test").check(bashRequest("  cd x\t&&\tpnpm test  ")).decision).toBe("allow");
  });

  it("preserves ask for an uncovered segment in any position", () => {
    expectAsk("pnpm test", "pnpm test && rm -rf /");
    expectAsk("cd", "rm -rf / && cd x");
    expectAsk("cd,pnpm typecheck", "cd x && pnpm test && pnpm typecheck");
  });

  it("rejects a single & or |& separator", () => {
    expectAsk("pnpm test,pnpm typecheck", "pnpm test & pnpm typecheck");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test |& pnpm typecheck");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test &");
  });

  it("rejects every redirect, even with covered segments", () => {
    expectAsk("cd,pnpm test", "cd x && pnpm test > out.txt");
    expectAsk("cd,pnpm test", "cd x && pnpm test > /etc/passwd");
    expectAsk("pnpm test", "pnpm test 2>&1");
    expectAsk("pnpm test", "pnpm test &> out.txt");
    expectAsk("pnpm test", "pnpm test < input.txt");
    expectAsk("pnpm test", "pnpm test << EOF");
  });

  it("rejects subshells and brace groups", () => {
    expectAsk("cd,pnpm test", "(cd x) && pnpm test");
    expectAsk("cd,pnpm test", "{ cd x; } && pnpm test");
  });

  it("rejects command and process substitution", () => {
    expectAsk("cd,pnpm test", "cd $(pwd) && pnpm test");
    expectAsk("cd,pnpm test", "cd `pwd` && pnpm test");
    expectAsk("cd,pnpm test", 'cd "$(pwd)" && pnpm test');
    expectAsk("diff", "diff <(ls) <(ls ..)");
    expectAsk("diff", "diff >(ls) x");
  });

  it("rejects unterminated quotes", () => {
    expectAsk("cd,pnpm test", 'cd "x && pnpm test');
    expectAsk("cd,pnpm test", "cd 'x && pnpm test");
  });

  it("rejects blank/malformed segments, a leading/trailing separator, and empty input", () => {
    expectAsk("pnpm test,pnpm typecheck", "pnpm test; ; pnpm typecheck");
    expectAsk("pnpm test,pnpm typecheck", "; pnpm test");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test;");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test\n");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test &&");
    expectAsk("pnpm test,pnpm typecheck", "| pnpm test");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test || || pnpm typecheck");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test &&& pnpm typecheck");
    expectAsk("pnpm test,pnpm typecheck", "");
    expectAsk("pnpm test,pnpm typecheck", "   ");
  });

  it("leaves a compound line asking when the allow-list is empty", () => {
    expectAsk("", "cd x && pnpm test");
  });

  it("preserves the base ruling for a compound line in plan and yolo modes", () => {
    const planEngine = new RunAllowBashPermissionEngine(
      new ModePermissionEngine(),
      parseRunAllowBash("cd,pnpm test"),
    );
    expect(planEngine.check(bashRequest("cd x && pnpm test", "plan")).decision).toBe("deny");
    const yoloEngine = new RunAllowBashPermissionEngine(
      new ModePermissionEngine(),
      parseRunAllowBash("cd,pnpm test"),
    );
    expect(yoloEngine.check(bashRequest("cd x && pnpm test", "yolo"))).toEqual({ decision: "allow" });
  });

  it("rejects raw quoted metacharacters and escapes, allows a balanced plain argument quote", () => {
    expectAsk("echo,pnpm test", 'echo "a;b" && pnpm test');
    expectAsk("echo,pnpm test", "echo 'a|b' && pnpm test");
    expectAsk("echo,pnpm test", "echo a\\;b && pnpm test");
    expect(engineFor("echo,pnpm test").check(bashRequest('echo "plain" && pnpm test')).decision).toBe("allow");
  });

  it("rejects expansions, globs, assignments, comments and control characters", () => {
    expectAsk("cd,pnpm test", "cd $HOME && pnpm test");
    expectAsk("cd,pnpm test", "cd ~ && pnpm test");
    expectAsk("cd,pnpm test", "cd x* && pnpm test");
    expectAsk("cd,pnpm test", "cd x #comment\npnpm test");
    expectAsk("pnpm test", "X=1 pnpm test");
    expectAsk("pnpm test,pnpm typecheck", "pnpm test\r; pnpm typecheck");
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

  it("runs a fully covered compound line in build mode and still denies it in plan mode", () => {
    const engine = build("cd,npx vitest run");
    expect(engine.check(bashRequest("cd packages/core && npx vitest run src/x")).decision).toBe("allow");
    expect(engine.check(bashRequest("cd packages/core && npx vitest run src/x", "plan")).decision).toBe("deny");
  });

  it("leaves a compound line asking when ANYCODE_RUN_ALLOW_BASH is unset", () => {
    const engine = build(undefined);
    expect(engine.check(bashRequest("cd packages/core && npx vitest run src/x")).decision).toBe("ask");
  });
});

/**
 * Pure-logic tests for PermissionModal's slice-2.2 "Always allow" additions
 * (design/slice-2.2-cut.md §5, ruling reviews/slice-2.2-forks-ruling.md §2).
 * Same `.test.ts`-only rationale as SessionPicker.test.ts: no jsdom in this
 * package's vitest config, so the exported pure functions — which carry all
 * of the checkbox's actual logic (pattern suggestion, the two-effect
 * message/rule construction) — are covered directly instead of through DOM
 * rendering.
 */
import { describe, expect, it } from "vitest";
import {
  buildAlwaysAllowRule,
  buildPermissionAllowMessage,
  canRememberPermission,
  formatPermissionTitle,
  suggestAlwaysAllowPattern,
} from "./PermissionModal.js";

describe("canRememberPermission", () => {
  it("keeps core rules available but removes all remember paths for external Codex approvals", () => {
    expect(canRememberPermission(null)).toBe(true);
    expect(canRememberPermission({
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: true,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
    })).toBe(false);
  });
});

/**
 * Slice P7.16 §4.2 wiring tests (REVISED, W1-FIX): the three "birth points"
 * (suggestion seed, control-plane rule builder, data-plane remember message)
 * all route Bash patterns through the shared sanitizer in
 * ../permission-pattern.js — these assert the env-prefix garbage never
 * reaches a stored/sent rule, and that non-Bash tools are left completely
 * untouched. `buildPermissionAllowMessage` now takes an explicit `toolName`
 * and only sanitizes for Bash (P2-divergence fix).
 */

describe("suggestAlwaysAllowPattern", () => {
  it("suggests '<first token> *' for a Bash command", () => {
    expect(suggestAlwaysAllowPattern("Bash", { command: "git status" })).toBe("git *");
    expect(suggestAlwaysAllowPattern("Bash", { command: "npm test" })).toBe("npm *");
  });

  it("returns undefined for non-Bash tools — design §5: bare tool-level rule, no pattern field shown", () => {
    expect(suggestAlwaysAllowPattern("Write", { file_path: "/x" })).toBeUndefined();
    expect(suggestAlwaysAllowPattern("Read", { file_path: "/x" })).toBeUndefined();
  });

  it("returns undefined when Bash input has no command string (defensive)", () => {
    expect(suggestAlwaysAllowPattern("Bash", {})).toBeUndefined();
    expect(suggestAlwaysAllowPattern("Bash", null)).toBeUndefined();
  });

  it("trims leading whitespace in the command before taking the first token", () => {
    expect(suggestAlwaysAllowPattern("Bash", { command: "   git status" })).toBe("git *");
  });

  it("P7.16 §4.2: skips a leading env-assignment token — the suggestion is born clean", () => {
    expect(suggestAlwaysAllowPattern("Bash", { command: 'OUT="/tmp/o" node x.mjs' })).toBe("node *");
  });
});

describe("buildAlwaysAllowRule", () => {
  it("includes a trimmed pattern when given", () => {
    expect(buildAlwaysAllowRule("Bash", "  git * ")).toEqual({ toolName: "Bash", pattern: "git *" });
  });

  it("omits pattern for a bare tool rule", () => {
    expect(buildAlwaysAllowRule("Read")).toEqual({ toolName: "Read" });
  });

  it("omits pattern when given only whitespace", () => {
    expect(buildAlwaysAllowRule("Bash", "   ")).toEqual({ toolName: "Bash" });
  });

  it("P7.16 §4.2: sanitizes a Bash pattern's leading env-assignment token", () => {
    expect(buildAlwaysAllowRule("Bash", "OUT=1 rm *")).toEqual({ toolName: "Bash", pattern: "rm *" });
  });

  it("P7.16 §4.2: leaves non-Bash tool patterns completely untouched", () => {
    expect(buildAlwaysAllowRule("Read", "OUT=1 foo")).toEqual({ toolName: "Read", pattern: "OUT=1 foo" });
    expect(buildAlwaysAllowRule("WebFetch", "env x")).toEqual({ toolName: "WebFetch", pattern: "env x" });
  });

  it("P7.16 §4.2: never-widen fallback — a pure-assignment Bash pattern stays as-is", () => {
    expect(buildAlwaysAllowRule("Bash", "FOO=1")).toEqual({ toolName: "Bash", pattern: "FOO=1" });
  });

  it("P7.16 §4.2 W1-FIX: P1 guard — hand-typed 'env *' is stored as 'env *', NOT widened to '*'", () => {
    expect(buildAlwaysAllowRule("Bash", "env *")).toEqual({ toolName: "Bash", pattern: "env *" });
  });

  it("P7.16 §4.2 W1-FIX: P1 guard — hand-typed 'FOO=* *' is stored as 'FOO=* *', NOT widened to '*'", () => {
    expect(buildAlwaysAllowRule("Bash", "FOO=* *")).toEqual({ toolName: "Bash", pattern: "FOO=* *" });
  });

  it("P7.16 §4.2 W1-FIX: hand-typed 'OUT=x rm *' still strips down to 'rm *' (guard only rejects bare wildcards)", () => {
    expect(buildAlwaysAllowRule("Bash", "OUT=x rm *")).toEqual({ toolName: "Bash", pattern: "rm *" });
  });
});

describe("buildPermissionAllowMessage", () => {
  it("plain allow (no remember) is byte-identical to the pre-2.2 message shape", () => {
    expect(buildPermissionAllowMessage("r1", "Bash")).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
    });
  });

  it("always-allow with a pattern carries remember.pattern", () => {
    expect(buildPermissionAllowMessage("r1", "Bash", { pattern: "git *" })).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: { pattern: "git *" },
    });
  });

  it("always-allow without a pattern (bare tool rule) still carries an empty remember object — the checkbox, not the pattern, drives remembering", () => {
    expect(buildPermissionAllowMessage("r1", "Bash", {})).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: {},
    });
  });

  it("a whitespace-only pattern is treated the same as no pattern", () => {
    expect(buildPermissionAllowMessage("r1", "Bash", { pattern: "   " })).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: {},
    });
  });

  it("P7.16 §4.2: sanitizes remember.pattern's leading env-assignment token — data plane never diverges from control plane", () => {
    expect(buildPermissionAllowMessage("r1", "Bash", { pattern: "OUT=1 rm *" })).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: { pattern: "rm *" },
    });
  });

  it("P7.16 §4.2 W1-FIX: P1 guard applies through this helper too — 'env *' stays 'env *'", () => {
    expect(buildPermissionAllowMessage("r1", "Bash", { pattern: "env *" })).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: { pattern: "env *" },
    });
  });

  it("P7.16 §4.2 W1-FIX: P2-divergence fix — a non-Bash toolName leaves the pattern completely untouched", () => {
    expect(buildPermissionAllowMessage("r1", "Read", { pattern: "env *" })).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: { pattern: "env *" },
    });
    expect(buildPermissionAllowMessage("r1", "Read", { pattern: "OUT=1 foo" })).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: { pattern: "OUT=1 foo" },
    });
  });
});

describe("formatPermissionTitle", () => {
  it("maps the four known tools to verb-first sentences", () => {
    expect(formatPermissionTitle("Bash")).toEqual({
      tool: "Bash", action: "run this command", sentence: "Allow Bash to run this command?",
    });
    expect(formatPermissionTitle("Write")).toEqual({
      tool: "Write", action: "write this file", sentence: "Allow Write to write this file?",
    });
    expect(formatPermissionTitle("Edit")).toEqual({
      tool: "Edit", action: "modify this file", sentence: "Allow Edit to modify this file?",
    });
    expect(formatPermissionTitle("Read")).toEqual({
      tool: "Read", action: "read this file", sentence: "Allow Read to read this file?",
    });
  });

  it("falls back to the generic question for unknown tools — never guesses a verb", () => {
    expect(formatPermissionTitle("WebFetch")).toEqual({
      tool: "WebFetch", action: null, sentence: "Allow WebFetch?",
    });
  });

  it("is case-sensitive — a mis-cased tool degrades to generic rather than mis-verbing", () => {
    expect(formatPermissionTitle("bash").action).toBeNull();
  });

  it("never normalizes or rewrites the tool name", () => {
    expect(formatPermissionTitle("mcp__server__tool").tool).toBe("mcp__server__tool");
    expect(formatPermissionTitle("mcp__server__tool").sentence).toBe("Allow mcp__server__tool?");
  });

  it("does not walk the prototype chain for hostile tool names", () => {
    expect(formatPermissionTitle("constructor").action).toBeNull();
    expect(formatPermissionTitle("toString").action).toBeNull();
    expect(formatPermissionTitle("__proto__").action).toBeNull();
  });

  it("degrades safely on an empty tool name", () => {
    expect(formatPermissionTitle("")).toEqual({ tool: "", action: null, sentence: "Allow ?" });
  });
});

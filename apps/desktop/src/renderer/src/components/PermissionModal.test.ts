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
import type { EnginePresentation } from "../../../shared/protocol.js";
import {
  PLAN_PREVIEW_MAX_CHARS,
  UNKNOWN_SHELL_HINT,
  buildAlwaysAllowRule,
  buildPermissionAllowMessage,
  canRememberPermission,
  describePermissionAsk,
  formatPermissionTitle,
  suggestAlwaysAllowPattern,
} from "./PermissionModal.js";

function caps(overrides: Partial<EnginePresentation["capabilities"]>): EnginePresentation {
  return {
    id: "codex",
    capabilities: {
      supportsCorePermissions: false,
      supportsRewind: false,
      supportsWorkflow: false,
      supportsGitMutations: false,
      supportsContextUsage: false,
      supportsContextBreakdown: false,
      supportsInteractiveApprovals: false,
      costAccounting: false,
      supportsModelSelection: false,
      supportsReasoningEffort: false,
      supportsImages: false,
      supportsTasks: false,
      supportsFileSnapshots: false,
      ...overrides,
    },
  };
}

describe("canRememberPermission", () => {
  it("keeps remember available for a core session (no engine presentation)", () => {
    expect(canRememberPermission(null)).toBe(true);
  });

  it("TASK.144: an engine with a live approval bridge may remember despite supportsCorePermissions:false", () => {
    // The whole point of TASK.144: codex/claude both report
    // supportsCorePermissions:false, and hiding the checkbox on that flag left
    // those sessions with no in-app way to stop being asked. Their rule store is
    // now read by IpcPermissionBroker itself, so a remembered rule is honoured.
    expect(canRememberPermission(caps({ supportsInteractiveApprovals: true }))).toBe(true);
  });

  it("still refuses remember when the engine has no approval bridge at all", () => {
    // Session drops a permission_response outright without this capability, so
    // a remembered rule would be born from an answer that never lands.
    expect(canRememberPermission(caps({ supportsInteractiveApprovals: false }))).toBe(false);
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

/**
 * TASK.27 — the ExitPlanMode special case. The permission engine already
 * escalates the tool into the ordinary `permission_request` tract, so the modal
 * renders it with no wiring change; what these pin is the PRESENTATION, which
 * is the whole point of the special case:
 *
 *  - a plan is rendered as markdown, not as a JSON `Input` dump;
 *  - the buttons say what they do (approve the plan / keep planning), because
 *    "Allow"/"Deny" tells a user nothing about a mode switch;
 *  - "Always allow" is impossible for a plan — a remembered rule would
 *    auto-approve every future plan without anyone reading it;
 *  - a malformed ask degrades to the generic presentation rather than
 *    rendering an empty plan well (mirror of the CLI's own fallback in
 *    terminal-broker.ts).
 */
describe("describePermissionAsk — plan approval (TASK.27)", () => {
  it("recognizes a well-formed ExitPlanMode ask and carries the plan verbatim", () => {
    const plan = "## Plan\n\n1. do the thing\n2. test it\n";
    const presentation = describePermissionAsk("ExitPlanMode", { plan });

    expect(presentation.kind).toBe("plan");
    expect(presentation.plan).toBe(plan);
    expect(presentation.elidedChars).toBe(0);
  });

  it("labels the actions by what they do, not by allow/deny", () => {
    const presentation = describePermissionAsk("ExitPlanMode", { plan: "x" });

    expect(presentation.allowLabel).toBe("Approve plan");
    expect(presentation.denyLabel).toBe("Keep planning");
    expect(presentation.hint).toContain("still ask");
  });

  it("never offers Always-allow for a plan", () => {
    expect(describePermissionAsk("ExitPlanMode", { plan: "x" }).canRemember).toBe(false);
  });

  it("caps a pathological plan and reports exactly how many characters were elided", () => {
    const elided = 137;
    const plan = "P".repeat(PLAN_PREVIEW_MAX_CHARS + elided);
    const presentation = describePermissionAsk("ExitPlanMode", { plan });

    expect(presentation.plan).toHaveLength(PLAN_PREVIEW_MAX_CHARS);
    expect(presentation.elidedChars).toBe(elided);
  });

  it("degrades to the generic presentation when the plan field is missing or not a string", () => {
    for (const input of [{}, { plan: 42 }, { plan: null }, null, "nope"]) {
      const presentation = describePermissionAsk("ExitPlanMode", input);
      expect(presentation.kind).toBe("generic");
      expect(presentation.plan).toBeNull();
    }
  });

  it("accepts an empty plan string as a plan (honest empty block beats a JSON dump)", () => {
    const presentation = describePermissionAsk("ExitPlanMode", { plan: "" });
    expect(presentation.kind).toBe("plan");
    expect(presentation.plan).toBe("");
  });

  it("is case-sensitive and never fuzzy-matches the tool name", () => {
    expect(describePermissionAsk("exitplanmode", { plan: "x" }).kind).toBe("generic");
    expect(describePermissionAsk("ExitPlanModeX", { plan: "x" }).kind).toBe("generic");
  });

  it("leaves every other ask exactly as before — generic labels, remember allowed", () => {
    const presentation = describePermissionAsk("Bash", { command: "git status" });

    expect(presentation.kind).toBe("generic");
    expect(presentation.plan).toBeNull();
    expect(presentation.allowLabel).toBe("Allow");
    expect(presentation.denyLabel).toBe("Deny");
    expect(presentation.canRemember).toBe(true);
    expect(presentation.sentence).toBe(formatPermissionTitle("Bash").sentence);
  });

  it("gives the plan dialog its own aria-label instead of 'Allow ExitPlanMode?'", () => {
    expect(describePermissionAsk("ExitPlanMode", { plan: "x" }).sentence).not.toContain("Allow");
  });
});

describe("canRememberPermission x plan ask", () => {
  it("an engine that permits remembering still cannot remember a plan", () => {
    const presentation = describePermissionAsk("ExitPlanMode", { plan: "x" });
    expect(canRememberPermission(null) && presentation.canRemember).toBe(false);
  });
});

describe("describePermissionAsk — Bash unknown shell expression (TASK.35)", () => {
  it("UM1: a Bash pipeline that cannot be proven read-only carries the hint, generic kind, remember allowed", () => {
    const presentation = describePermissionAsk("Bash", { command: "git status | cat" });
    expect(presentation.hint).toBe(UNKNOWN_SHELL_HINT);
    expect(presentation.kind).toBe("generic");
    expect(presentation.canRemember).toBe(true);
    expect(presentation.sentence).toBe(formatPermissionTitle("Bash").sentence);
  });

  it("UM2: a plain high-risk single command keeps today's presentation — no hint", () => {
    expect(describePermissionAsk("Bash", { command: "rm -rf /" }).hint).toBeNull();
  });

  it("UM3: further unknown shell expressions carry the hint", () => {
    expect(describePermissionAsk("Bash", { command: "cat f | tee out" }).hint).toBe(UNKNOWN_SHELL_HINT);
    expect(describePermissionAsk("Bash", { command: "ls > f" }).hint).toBe(UNKNOWN_SHELL_HINT);
  });

  it("UM4: fail-closed presentation — non-Bash tools and malformed Bash input never get the hint", () => {
    expect(describePermissionAsk("Write", { file_path: "/tmp/x", content: "y" }).hint).toBeNull();
    expect(describePermissionAsk("Bash", {}).hint).toBeNull();
    expect(describePermissionAsk("Bash", null).hint).toBeNull();
    expect(describePermissionAsk("Bash", { command: 42 }).hint).toBeNull();
  });

  it("UM5: a PROVEN read-only pipeline never gets called 'unknown' even if it reaches the modal via a forced ask", () => {
    expect(describePermissionAsk("Bash", { command: "sed -n '1p' f | cat" }).hint).toBeNull();
  });

  it("UM6: copy pin — exact string and honest-cause wording", () => {
    expect(UNKNOWN_SHELL_HINT).toBe(
      "Unknown shell expression — AnyCode can't prove this command is read-only, so it's asking. Unproven is not necessarily dangerous; review the command before allowing.",
    );
    expect(UNKNOWN_SHELL_HINT).toContain("Unknown shell expression");
    expect(UNKNOWN_SHELL_HINT).toContain("can't prove");
  });

  it("UM7: plan asks are unaffected — the plan hint keeps saying 'still ask' (already pinned at :261; not duplicated here)", () => {
    expect(describePermissionAsk("ExitPlanMode", { plan: "x" }).hint).toContain("still ask");
  });
});

/**
 * TASK.144: the three rule-birth points treat `CodexExec` as the command-line
 * tool it is. Without this a Codex session's "Always allow" checkbox had no
 * pattern field at all, so the only rule it could mint was a patternless
 * allow-EVERY-command one.
 */
describe("CodexExec always-allow birth points (TASK.144)", () => {
  it("suggests a binary pattern for a CodexExec command", () => {
    expect(suggestAlwaysAllowPattern("CodexExec", { command: "git status" })).toBe("git *");
  });

  it("strips a leading env-assignment from a CodexExec pattern, exactly like Bash", () => {
    expect(suggestAlwaysAllowPattern("CodexExec", { command: 'OUT="/tmp/o" node x.mjs' })).toBe("node *");
    expect(buildAlwaysAllowRule("CodexExec", 'OUT="/tmp/o" node *')).toEqual({
      toolName: "CodexExec",
      pattern: "node *",
    });
    expect(buildPermissionAllowMessage("r1", "CodexExec", { pattern: 'OUT="/tmp/o" node *' })).toEqual({
      type: "permission_response",
      requestId: "r1",
      behavior: "allow",
      remember: { pattern: "node *" },
    });
  });

  it("offers no pattern for CodexApplyPatch — a multi-file patch has no single subject", () => {
    expect(suggestAlwaysAllowPattern("CodexApplyPatch", { paths: ["/workspace/a.ts"] })).toBeUndefined();
    expect(buildAlwaysAllowRule("CodexApplyPatch", undefined)).toEqual({ toolName: "CodexApplyPatch" });
  });
});

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
  SCOPED_RUNNER_BINARIES,
  SCOPED_RUNNER_VERBS,
  formatScopedRunnerPattern,
} from "@anycode/core/permissions/safe-command";
import {
  BASH_RISK_PLAQUE,
  NEUTRAL_RISK_LABEL,
  PLAN_PREVIEW_MAX_CHARS,
  UNKNOWN_SHELL_HINT,
  alwaysAllowCheckboxText,
  bashRiskFacts,
  bashRiskPlaque,
  bashWriteCapablePlaque,
  buildAlwaysAllowRule,
  buildPermissionAllowMessage,
  canRememberPermission,
  describePermissionAsk,
  formatPermissionTitle,
  neutralRiskLabelFor,
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
 * Taskana 4070 (TASK.105 §2): the per-command risk plaque, derived from the
 * SAME lexical classifier that powers auto-allow. Presentation only — no
 * engine decision reads this. The three-way split among ASKS:
 *   (a) provably read-only pipelines → readOnly plaque,
 *   (b) named write-capable single commands → plaque naming the binary,
 *   (c) unknown single binaries → the not-a-verdict-of-danger plaque.
 * A shell expression stays UNKNOWN_SHELL_HINT's case alone (no plaque), and
 * plan asks never carry one.
 */
describe("describePermissionAsk — Bash risk plaque (Taskana 4070)", () => {
  it("read-only pipeline → readOnly plaque, no hint, generic kind", () => {
    const presentation = describePermissionAsk("Bash", { command: "ls | wc -l" });
    expect(presentation.plaque).toBe(BASH_RISK_PLAQUE.readOnly);
    expect(presentation.hint).toBeNull();
    expect(presentation.kind).toBe("generic");
  });

  it("write-capable single command → plaque names the binary; no hint (shellExpression false)", () => {
    const presentation = describePermissionAsk("Bash", { command: "rm -rf build" });
    expect(presentation.plaque).toContain("rm");
    expect(presentation.plaque).toContain("can write or execute");
    expect(presentation.hint).toBeNull();
  });

  it("unknown binary → unknownBinary plaque; no hint", () => {
    const presentation = describePermissionAsk("Bash", { command: "mytool build ." });
    expect(presentation.plaque).toBe(BASH_RISK_PLAQUE.unknownBinary);
    expect(presentation.hint).toBeNull();
  });

  it("shell expression keeps TASK.35's hint alone — plaque is null (never co-occur)", () => {
    const presentation = describePermissionAsk("Bash", { command: "cat f | tee out" });
    expect(presentation.hint).toBe(UNKNOWN_SHELL_HINT);
    expect(presentation.plaque).toBeNull();
  });

  it("fail-closed presentation: non-Bash tools and malformed Bash input never get a plaque", () => {
    expect(describePermissionAsk("Write", { file_path: "/tmp/x", content: "y" }).plaque).toBeNull();
    expect(describePermissionAsk("Bash", {}).plaque).toBeNull();
    expect(describePermissionAsk("Bash", { command: 42 }).plaque).toBeNull();
  });

  it("copy pin — exact plaque strings, single source of truth", () => {
    expect(BASH_RISK_PLAQUE.readOnly).toBe(
      "This exact command line is provably read-only — every segment passed the same classifier that auto-allows in Auto mode. It asks only because of the session mode, a hook, or an engine bridge.",
    );
    expect(bashWriteCapablePlaque("rm")).toBe(
      "This command runs rm, which can write or execute — the classifier cannot prove it read-only. Allow only if you intended this exact command.",
    );
    expect(BASH_RISK_PLAQUE.unknownBinary).toBe(
      "This command's binary is not on AnyCode's read-only list, so it asks. Not-on-the-list is not a verdict of danger; review the exact command before allowing.",
    );
  });

  it("wrappers, shells and absolute paths get the write-capable plaque, never the softer unknown-binary note", () => {
    for (const [command, binary] of [
      ["sudo rm -rf /", "sudo"],
      ["bash -c 'rm -rf /'", "bash"],
      ["env rm x", "env"],
      ["/bin/rm -rf /", "/bin/rm"],
    ] as const) {
      expect(bashRiskPlaque("Bash", { command })).toBe(bashWriteCapablePlaque(binary));
    }
  });

  it("plaque carries the binary's name (pure-function fallback for the DOM assertion)", () => {
    // No jsdom in this package's vitest config (see file header), so the
    // `.permission-risk-plaque-high` node itself is covered by the render
    // code path this input feeds; pinned here at the function boundary.
    expect(bashRiskPlaque("Bash", { command: "pnpm install" })).toContain("pnpm");
    expect(bashRiskFacts("Bash", { command: "pnpm install" })).toMatchObject({
      applies: true,
      binary: "pnpm",
    });
  });

  it("plan asks never carry a plaque (plan hint alone, as before)", () => {
    expect(describePermissionAsk("ExitPlanMode", { plan: "x" }).plaque).toBeNull();
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

/** Pinned literal: JSON.stringify of `{workspace,runner,verb}`, fixed key order. */
const SCOPED_PNPM_TEST = 'scoped-runner:{"workspace":"/ws/proj","runner":"pnpm","verb":"test"}';

/**
 * TASK.36 — the modal's scoped proposal: `cd <workspace> && <runner> <verb>
 * [inert args]` against the active tab's canonical workspace. The recognizer is
 * core's (reached through the safe-command subpath) so create and match cannot
 * drift; here we pin the proposal side and its fail-closed edges.
 */
describe("suggestAlwaysAllowPattern — scoped project-runner proposal (TASK.36)", () => {
  it("proposes the scoped pattern for the exact form against the workspace", () => {
    expect(suggestAlwaysAllowPattern("Bash", { command: "cd /ws/proj && pnpm test" }, "/ws/proj")).toBe(
      SCOPED_PNPM_TEST,
    );
  });

  it("proposes the exact serialized string for all 16 runner/verb pairs", () => {
    for (const runner of SCOPED_RUNNER_BINARIES) {
      for (const verb of SCOPED_RUNNER_VERBS) {
        const expected = formatScopedRunnerPattern("/ws/proj", runner, verb);
        expect(
          suggestAlwaysAllowPattern("Bash", { command: `cd /ws/proj && ${runner} ${verb}` }, "/ws/proj"),
          `${runner} ${verb}`,
        ).toBe(expected);
      }
    }
  });

  it("no workspace (null, or the old 2-arg call) yields no scoped proposal (fail-closed / back-compat)", () => {
    expect(suggestAlwaysAllowPattern("Bash", { command: "cd /ws/proj && pnpm test" }, null)).toBeUndefined();
    expect(suggestAlwaysAllowPattern("Bash", { command: "cd /ws/proj && pnpm test" })).toBeUndefined();
  });

  it("back-compat: a non-scoped command still gets the generic '<binary> *' suggestion when a workspace is present", () => {
    expect(suggestAlwaysAllowPattern("Bash", { command: "git status" }, "/ws/proj")).toBe("git *");
  });

  it("positive equivalents: inert changed args, horizontal spacing, no-space && reuse the scope", () => {
    for (const command of [
      "cd /ws/proj && pnpm test -- packages/a/b.test.ts",
      "cd /ws/proj && pnpm test --filter web run",
      "cd  /ws/proj  &&  pnpm  test",
      "cd\t/ws/proj\t&&\tpnpm\ttest",
      "cd /ws/proj&&pnpm test",
      "cd '/ws/proj' && pnpm test",
    ]) {
      expect(suggestAlwaysAllowPattern("Bash", { command }, "/ws/proj"), command).toBe(SCOPED_PNPM_TEST);
    }
  });

  it("positive equivalents: a correctly quoted special-character workspace proposes its own scoped pattern", () => {
    for (const ws of ["/ws/my proj", "/ws/a*b", "/ws/a[b]", "/ws/a{b,c}", "/ws/a(b)"]) {
      const expected = formatScopedRunnerPattern(ws, "pnpm", "test");
      expect(expected, ws).toBeDefined();
      expect(suggestAlwaysAllowPattern("Bash", { command: `cd "${ws}" && pnpm test` }, ws), ws).toBe(expected);
      expect(suggestAlwaysAllowPattern("Bash", { command: `cd '${ws}' && pnpm test` }, ws), ws).toBe(expected);
    }
  });

  it("unsupported quote/unquoted forms never propose the SCOPED rule (fail-closed)", () => {
    // unquoted forms of a special-character workspace
    expect(suggestAlwaysAllowPattern("Bash", { command: "cd /ws/my proj && pnpm test" }, "/ws/my proj")).toBeUndefined();
    expect(suggestAlwaysAllowPattern("Bash", { command: "cd /ws/a*b && pnpm test" }, "/ws/a*b")).toBeUndefined();
    expect(suggestAlwaysAllowPattern("Bash", { command: "cd /ws/a(b) && pnpm test" }, "/ws/a(b)")).toBeUndefined();
    // a workspace containing its own quote delimiter has no supported literal form:
    // the scoped proposal is never born (the generic path may still offer its own
    // pre-existing suggestion for such an odd one-token line, which the user reviews).
    const withApos = "/ws/a'b";
    const aposScoped = formatScopedRunnerPattern(withApos, "pnpm", "test");
    expect(aposScoped).toBeDefined();
    expect(
      suggestAlwaysAllowPattern("Bash", { command: `cd '${withApos}' && pnpm test` }, withApos),
      "single-quoted apostrophe synthesizes its own delimiter",
    ).not.toBe(aposScoped);
    const withBoth = `/ws/a'b"c`;
    const bothScoped = formatScopedRunnerPattern(withBoth, "pnpm", "test");
    expect(bothScoped).toBeDefined();
    expect(
      suggestAlwaysAllowPattern("Bash", { command: `cd "${withBoth}" && pnpm test` }, withBoth),
    ).not.toBe(bothScoped);
    expect(
      suggestAlwaysAllowPattern("Bash", { command: `cd '${withBoth}' && pnpm test` }, withBoth),
    ).not.toBe(bothScoped);
  });

  const nonProposals: [string, string][] = [
    ["other directory", "cd /ws/proj/other && pnpm test"],
    ["publish verb", "cd /ws/proj && pnpm publish"],
    ["exec verb", "cd /ws/proj && pnpm exec vitest"],
    ["run verb", "cd /ws/proj && pnpm run test"],
    ["testify verb", "cd /ws/proj && pnpm testify"],
    ["third segment", "cd /ws/proj && pnpm test && rm -rf /"],
    ["semicolon separator", "cd /ws/proj; pnpm test"],
    ["pipe separator", "cd /ws/proj | pnpm test"],
    ["or separator", "cd /ws/proj || pnpm test"],
    ["background separator", "cd /ws/proj & pnpm test"],
    ["assignment before runner", "cd /ws/proj && FOO=1 pnpm test"],
    ["assignment before cd", "FOO=1 cd /ws/proj && pnpm test"],
    ["env wrapper", "cd /ws/proj && env pnpm test"],
    ["export wrapper", "cd /ws/proj && export FOO=1 && pnpm test"],
    ["redirect", "cd /ws/proj && pnpm test > out.txt"],
    ["redirect append", "cd /ws/proj && pnpm test >> out.txt"],
    ["redirect in", "cd /ws/proj && pnpm test < in.txt"],
    ["fd redirect", "cd /ws/proj && pnpm test 2>&1"],
    ["amp redirect", "cd /ws/proj && pnpm test &>log"],
    ["command substitution", "cd /ws/proj && pnpm test $(touch /tmp/x)"],
    ["backtick", "cd /ws/proj && pnpm test `x`"],
    ["substitution inside quotes", 'cd /ws/proj && pnpm test "$(touch /tmp/x)"'],
    ["backtick inside quotes", 'cd /ws/proj && pnpm test "`x`"'],
    ["process substitution", "cd /ws/proj && pnpm test <(touch /tmp/x)"],
    ["process substitution out", "cd /ws/proj && pnpm test >(touch /tmp/x)"],
    ["comment", "cd /ws/proj && pnpm test # comment"],
    ["escaped separator", "cd /ws/proj && pnpm test \\; x"],
    ["quoted arg", 'cd /ws/proj && pnpm test -- "a b.test.ts"'],
    ["trailing separator", "cd /ws/proj && pnpm test;"],
    ["trailing separator pipe", "cd /ws/proj && pnpm test |"],
    ["trailing and", "cd /ws/proj && pnpm test &&"],
    ["empty runner segment", "cd /ws/proj &&"],
    ["empty middle segment", "cd /ws/proj &&  && pnpm test"],
    ["leading separator", "&& cd /ws/proj && pnpm test"],
    ["newline before", "\ncd /ws/proj && pnpm test"],
    ["newline after", "cd /ws/proj && pnpm test\n"],
    ["newline middle", "cd /ws/proj && pnpm test\nrm -rf /"],
    ["carriage return", "cd /ws/proj && pnpm test\r"],
    ["nul byte", "cd /ws/proj && pnpm test\u0000"],
    ["other control char", "cd /ws/proj && pnpm test\u0007"],
    ["unterminated double quote", 'cd /ws/proj && pnpm test "x'],
    ["unterminated quote", "cd /ws/proj && pnpm test 'x"],
    ["backslash newline", "cd /ws/proj && pnpm test \\\nrm -rf /"],
    ["non-shell whitespace before &&", "cd /ws/proj\u00a0 && pnpm test"],
    ["non-shell whitespace before runner", "cd /ws/proj && \u00a0pnpm test"],
    ["non-shell whitespace between runner and verb", "cd /ws/proj && pnpm\u00a0test"],
    ["non-shell whitespace before cd", "\u00a0cd /ws/proj && pnpm test"],
    ["byte-exact trailing slash", "cd /ws/proj/ && pnpm test"],
  ];
  for (const [label, command] of nonProposals) {
    it(`proposes nothing: ${label}`, () => {
      expect(suggestAlwaysAllowPattern("Bash", { command }, "/ws/proj")).toBeUndefined();
    });
  }

  it("an unquoted cd into a space-containing workspace proposes nothing", () => {
    expect(suggestAlwaysAllowPattern("Bash", { command: "cd /ws/my proj && pnpm test" }, "/ws/my proj")).toBeUndefined();
  });
});

describe("alwaysAllowCheckboxText (TASK.36)", () => {
  it("scoped command with the untouched scoped pattern -> project-scoped label", () => {
    expect(
      alwaysAllowCheckboxText("Bash", { command: "cd /ws/proj && pnpm test" }, "/ws/proj", SCOPED_PNPM_TEST),
    ).toBe("Always allow pnpm test in this project");
  });

  it("a user edit of the pattern falls back to the generic label", () => {
    expect(alwaysAllowCheckboxText("Bash", { command: "cd /ws/proj && pnpm test" }, "/ws/proj", "pnpm *")).toBe(
      "Always allow Bash matching",
    );
  });

  it("a malformed scoped edit falls back to the generic label too", () => {
    expect(
      alwaysAllowCheckboxText("Bash", { command: "cd /ws/proj && pnpm test" }, "/ws/proj", "scoped-runner:garbage"),
    ).toBe("Always allow Bash matching");
  });

  it("a generic command with the seeded glob keeps the generic label", () => {
    expect(alwaysAllowCheckboxText("Bash", { command: "git status" }, "/ws/proj", "git *")).toBe(
      "Always allow Bash matching",
    );
  });

  it("restoring the original scoped pattern brings the scoped label back", () => {
    const args = ["Bash", { command: "cd /ws/proj && pnpm test" }, "/ws/proj"] as const;
    expect(alwaysAllowCheckboxText(...args, "pnpm *")).toBe("Always allow Bash matching");
    expect(alwaysAllowCheckboxText(...args, SCOPED_PNPM_TEST)).toBe("Always allow pnpm test in this project");
  });

  it("is a command-tool label only: a non-command tool with a command-shaped input stays generic", () => {
    expect(alwaysAllowCheckboxText("Read", { command: "cd /ws/proj && pnpm test" }, "/ws/proj", SCOPED_PNPM_TEST)).toBe(
      "Always allow Read matching",
    );
  });

  it("offers the scoped label for CodexExec too (the other command-line tool)", () => {
    expect(
      alwaysAllowCheckboxText("CodexExec", { command: "cd /ws/proj && pnpm test" }, "/ws/proj", SCOPED_PNPM_TEST),
    ).toBe("Always allow pnpm test in this project");
  });

  it("no suggestion and an empty pattern -> bare tool label", () => {
    expect(alwaysAllowCheckboxText("Write", { file_path: "/x" }, "/ws/proj", "")).toBe("Always allow Write");
  });

  it("a CLEARED pattern field (empty string) on a scoped command falls back to the bare tool label", () => {
    expect(alwaysAllowCheckboxText("Bash", { command: "cd /ws/proj && pnpm test" }, "/ws/proj", "")).toBe(
      "Always allow Bash",
    );
  });
});

describe("scoped pattern survives the generic sanitizers untouched (TASK.36)", () => {
  it("buildAlwaysAllowRule is a no-op on the scoped pattern (single token, first token has '{')", () => {
    expect(buildAlwaysAllowRule("Bash", SCOPED_PNPM_TEST)).toEqual({ toolName: "Bash", pattern: SCOPED_PNPM_TEST });
  });

  it("buildPermissionAllowMessage carries the same scoped pattern verbatim on both planes", () => {
    expect(buildPermissionAllowMessage("id", "Bash", { pattern: SCOPED_PNPM_TEST })).toEqual({
      type: "permission_response",
      requestId: "id",
      behavior: "allow",
      remember: { pattern: SCOPED_PNPM_TEST },
    });
  });

  it("no remember payload without consent — the checkbox, not the scope, is what grants it", () => {
    expect(buildPermissionAllowMessage("id", "Bash")).toEqual({
      type: "permission_response",
      requestId: "id",
      behavior: "allow",
    });
  });

  it("with consent, both planes carry EXACTLY the same scoped string, even when the workspace holds spaces/quotes", () => {
    const workspaces = ["/ws/proj", "/ws/my proj", "/ws/a*b", "/ws/a(b)", "/ws/a,b", "/ws/a'b", '/ws/a"b'];
    for (const workspace of workspaces) {
      const pattern = formatScopedRunnerPattern(workspace, "pnpm", "test");
      expect(pattern, workspace).toBeDefined();
      const scoped = pattern as string;
      expect(buildAlwaysAllowRule("Bash", scoped), workspace).toEqual({ toolName: "Bash", pattern: scoped });
      expect(buildPermissionAllowMessage("id", "Bash", { pattern: scoped }), workspace).toEqual({
        type: "permission_response",
        requestId: "id",
        behavior: "allow",
        remember: { pattern: scoped },
      });
    }
  });
});

/**
 * Taskana 4070 follow-up: the plaque now covers a CodexExec ask (the Codex
 * bridge's name for a `commandExecution` approval), and a core-engine Bash
 * ask whose command the classifier PROVES read-only gets a NEUTRAL header
 * instead of the static "High risk"/"Destructive" badge — the plaque and the
 * header must never contradict each other. Presentation only: the metadata
 * object, the decision and the wire are untouched.
 */
describe("describePermissionAsk — CodexExec plaque (Taskana 4070)", () => {
  it("a read-only Codex command carries the readOnly plaque", () => {
    expect(describePermissionAsk("CodexExec", { command: "git status" }).plaque).toBe(BASH_RISK_PLAQUE.readOnly);
  });

  it("sudo, bash -c and /bin/rm carry the write-capable plaque naming the binary", () => {
    for (const [command, binary] of [
      ["sudo rm -rf /", "sudo"],
      ["bash -c 'rm -rf /'", "bash"],
      ["/bin/rm -rf /", "/bin/rm"],
    ] as const) {
      expect(bashRiskPlaque("CodexExec", { command })).toBe(bashWriteCapablePlaque(binary));
    }
  });

  it("a Codex shell expression shows no plaque", () => {
    expect(describePermissionAsk("CodexExec", { command: "cat f | tee out" }).plaque).toBeNull();
  });

  it("an argv-array command (already joined by the bridge) classifies like the string form", () => {
    expect(bashRiskPlaque("CodexExec", { command: "git status" })).toBe(
      bashRiskPlaque("CodexExec", { command: "git status" }),
    );
  });
});

describe("describePermissionAsk — header neutralisation (Taskana 4070)", () => {
  const HIGH_DESTRUCTIVE = { riskLevel: "high" as const, destructive: true };
  const LOW_SAFE = { riskLevel: "low" as const, destructive: false };

  it("a classifier-proven read-only command under high/destructive metadata gets the neutral label, not 'High risk'", () => {
    const presentation = describePermissionAsk("Bash", { command: "git status" }, HIGH_DESTRUCTIVE);
    expect(presentation.plaque).toBe(BASH_RISK_PLAQUE.readOnly);
    expect(presentation.neutralRiskLabel).toBe(NEUTRAL_RISK_LABEL);
    expect(presentation.neutralRiskLabel).not.toBe("High risk");
  });

  it("sudo, bash -c and /bin/rm keep the high/destructive header — their plaque says write-capable", () => {
    for (const command of ["sudo rm -rf /", "bash -c 'rm -rf /'", "/bin/rm -rf /"]) {
      const presentation = describePermissionAsk("Bash", { command }, HIGH_DESTRUCTIVE);
      expect(presentation.plaque).toContain("can write or execute");
      expect(presentation.neutralRiskLabel).toBeNull();
    }
  });

  it("a read-only pipeline is neutralised too (every segment passed the classifier)", () => {
    const presentation = describePermissionAsk("Bash", { command: "ls | wc -l" }, HIGH_DESTRUCTIVE);
    expect(presentation.plaque).toBe(BASH_RISK_PLAQUE.readOnly);
    expect(presentation.neutralRiskLabel).toBe(NEUTRAL_RISK_LABEL);
  });

  it("an unknown or write-capable command keeps the metadata-driven badge", () => {
    expect(describePermissionAsk("Bash", { command: "mytool build ." }, HIGH_DESTRUCTIVE).neutralRiskLabel).toBeNull();
    expect(describePermissionAsk("Bash", { command: "pnpm install" }, HIGH_DESTRUCTIVE).neutralRiskLabel).toBeNull();
  });

  it("a metadata-low ask (e.g. the Codex bridge's de-risked presentation) is NOT neutralised — it already agrees", () => {
    const presentation = describePermissionAsk("CodexExec", { command: "git status" }, LOW_SAFE);
    expect(presentation.plaque).toBe(BASH_RISK_PLAQUE.readOnly);
    expect(presentation.neutralRiskLabel).toBeNull();
  });

  it("no metadata → no neutralisation (fail-closed to today's badge)", () => {
    expect(describePermissionAsk("Bash", { command: "git status" }).neutralRiskLabel).toBeNull();
  });

  it("neutralRiskLabelFor: only the exact contradiction (readOnly plaque + high/destructive metadata) neutralises", () => {
    expect(neutralRiskLabelFor(HIGH_DESTRUCTIVE, BASH_RISK_PLAQUE.readOnly)).toBe(NEUTRAL_RISK_LABEL);
    expect(neutralRiskLabelFor(LOW_SAFE, BASH_RISK_PLAQUE.readOnly)).toBeNull();
    expect(neutralRiskLabelFor(HIGH_DESTRUCTIVE, null)).toBeNull();
    expect(neutralRiskLabelFor(HIGH_DESTRUCTIVE, BASH_RISK_PLAQUE.unknownBinary)).toBeNull();
    expect(neutralRiskLabelFor({ riskLevel: "medium", destructive: false }, BASH_RISK_PLAQUE.readOnly)).toBeNull();
  });
});

/**
 * TASK.102 CUT-S4 §4.2: the single, frozen mapping from a parent's
 * snapshotted core `PermissionMode` to the interactive posture an engine
 * child boots with. Two properties are pinned:
 *
 *  - totality against the exact §4.2 table (every `PermissionMode` maps to
 *    the documented preset/posture, no more no less);
 *  - RANGE, not call-sites: for every input, the resolved posture must never
 *    be one of the forbidden print-mode/bypass postures (§4.2's "запрещённые
 *    постуры"), proven by resolving the id through the SAME frozen preset
 *    tables (`presets.ts`, read-only import) the engine boots actually
 *    consult — not by re-asserting the id strings alone. Since TASK.179
 *    (Taskana 4078) this proof also covers the child-only `child-ask`
 *    preset: `untrusted` is not a forbidden approval policy, and the
 *    resolved preset ids are pinned to `read-only`/`child-ask`/`ask`
 *    (`child-ask` only for the asking mode `build`; the autonomy modes
 *    keep the public interactive `ask` posture).
 */

import { PERMISSION_MODES } from "@anycode/core";
import { describe, expect, it } from "vitest";
import { claudeChildPresetId, codexChildAutoAcceptsWorkspacePatches, codexChildPosture } from "./child-permission-map.js";
import { CLAUDE_PERMISSION_PRESETS, findClaudePreset } from "./claude/presets.js";
import { CODEX_PERMISSION_PRESETS, findCodexPreset } from "./codex/presets.js";

// Claude CLI modes never reachable through an engine child (§4.2): silent
// classifier auto-approve, no-control-event auto-deny, and the spawn-only
// bypass flag — none of these leaves anything for the child's approval
// bridge to show.
const FORBIDDEN_CLAUDE_MODES = ["bypassPermissions", "dontAsk", "auto"];
// Codex postures never reachable through an engine child (§4.2): approvals
// disabled outright, approvals silently auto-reviewed, and the sandbox tier
// that removes confinement entirely.
const FORBIDDEN_CODEX_APPROVAL_POLICIES = ["never"];
const FORBIDDEN_CODEX_REVIEWERS = ["auto_review"];
const FORBIDDEN_CODEX_SANDBOX_MODES = ["danger-full-access"];

describe("claudeChildPresetId (CUT-S4 §4.2)", () => {
  it("is total over every PermissionMode and matches the frozen table exactly", () => {
    expect(PERMISSION_MODES.map((mode) => [mode, claudeChildPresetId(mode)])).toEqual([
      ["plan", "read-only"],
      ["build", "ask"],
      ["edit", "workspace"],
      ["auto", "workspace"],
      ["yolo", "workspace"],
    ]);
  });

  it("only ever resolves to a preset id present in the frozen public table (never a print-mode id)", () => {
    for (const mode of PERMISSION_MODES) {
      const presetId = claudeChildPresetId(mode);
      expect(CLAUDE_PERMISSION_PRESETS.some((preset) => preset.id === presetId)).toBe(true);
    }
  });

  it("never resolves to a preset whose CLI mode is a forbidden interactive posture, on ANY input in the range", () => {
    for (const mode of PERMISSION_MODES) {
      const preset = findClaudePreset(claudeChildPresetId(mode));
      expect(preset).toBeDefined();
      expect(FORBIDDEN_CLAUDE_MODES).not.toContain(preset!.mode);
    }
  });
});

describe("codexChildPosture (CUT-S4 §4.2)", () => {
  it("is total over every PermissionMode and matches the frozen table exactly", () => {
    expect(PERMISSION_MODES.map((mode) => [mode, codexChildPosture(mode)])).toEqual([
      ["plan", "read-only"],
      ["build", "child-ask"],
      ["edit", "ask"],
      ["auto", "ask"],
      ["yolo", "ask"],
    ]);
  });

  it("narrowed to the asking mode: only build boots child-ask; the autonomy modes keep the pre-4078 ask posture", () => {
    // `build` is the one AnyCode mode the codex `ask`/`approve-for-me` presets
    // map back to (codexAgentPermissionMode) — the asking kind. The explicit
    // autonomy choices keep exactly what they had before Taskana 4078.
    expect(codexChildPosture("build")).toBe("child-ask");
    expect(codexChildPosture("edit")).toBe("ask");
    expect(codexChildPosture("auto")).toBe("ask");
    expect(codexChildPosture("yolo")).toBe("ask");
  });

  it("'read-only' resolves through findCodexPreset's legacy fallback (never returned by codexPresetChoices, §4.2)", () => {
    expect(CODEX_PERMISSION_PRESETS.some((preset) => preset.id === "read-only")).toBe(false);
    expect(findCodexPreset("read-only")).toBeDefined();
  });

  it("never resolves to a forbidden approval-policy/reviewer/sandbox posture, on ANY input in the range", () => {
    for (const mode of PERMISSION_MODES) {
      const preset = findCodexPreset(codexChildPosture(mode));
      expect(preset).toBeDefined();
      expect(["read-only", "child-ask", "ask"]).toContain(preset!.id);
      expect(FORBIDDEN_CODEX_APPROVAL_POLICIES).not.toContain(preset!.threadParams.approvalPolicy);
      expect(FORBIDDEN_CODEX_REVIEWERS).not.toContain(preset!.threadParams.approvalsReviewer);
      expect(FORBIDDEN_CODEX_SANDBOX_MODES).not.toContain(preset!.threadParams.sandbox);
    }
  });

  it("Taskana 4682: every non-plan child posture resolves to a preset whose turnOverride accepts the tmp exclusion (the boot site decorates exactly these)", () => {
    for (const mode of PERMISSION_MODES) {
      const preset = findCodexPreset(codexChildPosture(mode));
      expect(preset).toBeDefined();
      if (mode === "plan") continue; // read-only: no tmp roots to exclude
      const policy = preset!.turnOverride("/ws", { excludeTmpRoots: true }).sandboxPolicy;
      expect(policy).toMatchObject({ type: "workspaceWrite", excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    }
  });

  it("4682-on-4078: the child-ask preset threads BOTH tmp options into workspaceWritePolicy (private temp dir as second writable root)", () => {
    const preset = findCodexPreset("child-ask");
    expect(preset).toBeDefined();
    const policy = preset!.turnOverride("/ws", { excludeTmpRoots: true, extraWritableRoot: "/private/tmp/child" }).sandboxPolicy;
    expect(policy).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["/ws", "/private/tmp/child"],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    // Undecorated (owner-tab) call keeps the bare workspace sandbox.
    expect(preset!.turnOverride("/ws").sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: ["/ws"] });
    // The preset's own description must not claim /tmp and $TMPDIR are writable
    // without a prompt (the 4078 review note) — the honest text instead.
    expect(preset!.description).toContain("only this workspace and a private temp dir are writable without a prompt");
  });
});

describe("codexChildAutoAcceptsWorkspacePatches (Taskana 4265)", () => {
  it("is true exactly for edit/auto/yolo — the modes whose Claude twin gets the workspace tier", () => {
    expect(PERMISSION_MODES.map((mode) => [mode, codexChildAutoAcceptsWorkspacePatches(mode)])).toEqual([
      ["plan", false],
      ["build", false],
      ["edit", true],
      ["auto", true],
      ["yolo", true],
    ]);
  });
});

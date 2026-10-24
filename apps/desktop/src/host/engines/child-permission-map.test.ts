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
 *    consult — not by re-asserting the id strings alone.
 */

import { PERMISSION_MODES } from "@anycode/core";
import { describe, expect, it } from "vitest";
import { claudeAgentPermissionMode, claudeChildPresetId, codexChildPosture } from "./child-permission-map.js";
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

/**
 * Taskana 4056 cross-review M1: the claude door's port seam. A bridge child's
 * `ChildSpawnRequest.permissionMode` gates the spawned CORE child's own
 * permission engine, so the mapping from the parent's LIVE preset must be a
 * total, fail-narrow function of `snapshot().activePresetId` — the exact
 * analogue of `codexAgentPermissionMode` for the codex door. The posture
 * contract (never wider than the parent): `read-only` → `plan` (its Write/
 * Edit/Bash are DENIED, matching "Claude plans and reads files, but cannot
 * execute the plan"), every wider/unknown preset → `build` (asks). Codex-door
 * parity: `build`/`edit` both mean "ask first", and no claude preset is ever
 * `yolo`-adjacent, so nothing wider than `build` is ever produced.
 */
describe("claudeAgentPermissionMode (claude door port seam, Taskana 4056 M1)", () => {
  it.each([
    ["read-only", "plan"],
    ["ask", "build"],
    ["workspace", "build"],
    ["unknown-future-preset", "build"],
    ["", "build"],
  ] as const)("%s maps to %s (never wider than the parent preset)", (presetId, expected) => {
    expect(claudeAgentPermissionMode(presetId)).toBe(expected);
  });

  it("maps every preset id the frozen public table exposes", () => {
    for (const preset of CLAUDE_PERMISSION_PRESETS) {
      expect(claudeAgentPermissionMode(preset.id)).toBeDefined();
    }
  });
});

describe("codexChildPosture (CUT-S4 §4.2)", () => {
  it("is total over every PermissionMode and matches the frozen table exactly", () => {
    expect(PERMISSION_MODES.map((mode) => [mode, codexChildPosture(mode)])).toEqual([
      ["plan", "read-only"],
      ["build", "ask"],
      ["edit", "ask"],
      ["auto", "ask"],
      ["yolo", "ask"],
    ]);
  });

  it("'read-only' resolves through findCodexPreset's legacy fallback (never returned by codexPresetChoices, §4.2)", () => {
    expect(CODEX_PERMISSION_PRESETS.some((preset) => preset.id === "read-only")).toBe(false);
    expect(findCodexPreset("read-only")).toBeDefined();
  });

  it("never resolves to a forbidden approval-policy/reviewer/sandbox posture, on ANY input in the range", () => {
    for (const mode of PERMISSION_MODES) {
      const preset = findCodexPreset(codexChildPosture(mode));
      expect(preset).toBeDefined();
      expect(FORBIDDEN_CODEX_APPROVAL_POLICIES).not.toContain(preset!.threadParams.approvalPolicy);
      expect(FORBIDDEN_CODEX_REVIEWERS).not.toContain(preset!.threadParams.approvalsReviewer);
      expect(FORBIDDEN_CODEX_SANDBOX_MODES).not.toContain(preset!.threadParams.sandbox);
    }
  });
});

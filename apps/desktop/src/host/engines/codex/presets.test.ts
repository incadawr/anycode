/**
 * Pins the frozen Codex permission-preset table (cut §2(d)/§3.8) shape and its
 * consistency with the pre-existing (unchanged) `thread/start` literals in
 * `createNativeCodexSession` (codex-engine.ts) — the "ask" preset must match
 * today's actual default behavior exactly, so adopting the table later is a
 * pure refactor, never a behavior change.
 */

import { describe, expect, it } from "vitest";
import {
  CODEX_PERMISSION_PRESETS,
  DEFAULT_CODEX_PRESET,
  codexPresetChoices,
  findCodexPreset,
  isEffectivePostureWeaker,
} from "./presets.js";

describe("CODEX_PERMISSION_PRESETS", () => {
  it("carries the three Codex permission-menu ids, in order", () => {
    expect(CODEX_PERMISSION_PRESETS.map((preset) => preset.id)).toEqual(["ask", "approve-for-me", "full-access"]);
  });

  it("DEFAULT_CODEX_PRESET is a member of the table", () => {
    expect(findCodexPreset(DEFAULT_CODEX_PRESET)).toBeDefined();
  });

  it("maps the permission-menu choices to their native policy, reviewer and sandbox", () => {
    const ask = findCodexPreset("ask");
    const automatic = findCodexPreset("approve-for-me");
    const fullAccess = findCodexPreset("full-access");
    expect(ask?.threadParams).toEqual({ approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" });
    expect(automatic?.threadParams).toEqual({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
    expect(fullAccess?.threadParams).toEqual({ approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" });
  });

  it("each preset's turnOverride is a pure function of the workspace (no shared mutable state)", () => {
    const workspaceA = findCodexPreset("ask")!.turnOverride("/repo/a");
    const workspaceB = findCodexPreset("ask")!.turnOverride("/repo/b");
    expect(workspaceA).toEqual({
      approvalPolicy: "on-request", approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo/a"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    expect(workspaceB.sandboxPolicy).toMatchObject({ writableRoots: ["/repo/b"] });
  });

  it("preserves the legacy read-only preset for existing sessions without offering it", () => {
    const readOnly = findCodexPreset("read-only")!.turnOverride("/repo/a");
    expect(readOnly.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(codexPresetChoices().map((preset) => preset.id)).not.toContain("read-only");
  });

  it("findCodexPreset returns undefined for an unknown id (host-authoritative membership check)", () => {
    expect(findCodexPreset("danger-full-access")).toBeUndefined();
    expect(findCodexPreset("")).toBeUndefined();
  });
});

describe("codexPresetChoices (TASK.39 wire projection)", () => {
  it("exposes id/label/description only — never a policy object the renderer could edit", () => {
    const choices = codexPresetChoices();
    expect(choices).toEqual([
      { id: "ask", label: "Ask for approval", description: expect.any(String) },
      { id: "approve-for-me", label: "Approve for me", description: expect.any(String) },
      { id: "full-access", label: "Full access", description: expect.any(String) },
    ]);
    for (const choice of choices) {
      expect(Object.keys(choice).sort()).toEqual(["description", "id", "label"]);
    }
  });
});

describe("isEffectivePostureWeaker (drift check, cut §2(k).2)", () => {
  const ask = findCodexPreset("ask")!;

  it("is silent on the untrusted -> on-request round-trip loss (L8) — the one asymmetry the server is known not to preserve", () => {
    expect(isEffectivePostureWeaker(ask, { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } })).toBe(false);
  });

  it("is silent on the empty writableRoots echo (L8)", () => {
    expect(
      isEffectivePostureWeaker(ask, {
        approvalPolicy: "untrusted",
        sandbox: { type: "workspaceWrite", writableRoots: [] },
      }),
    ).toBe(false);
  });

  it("reports a genuinely weaker sandbox tier", () => {
    const readOnly = findCodexPreset("read-only")!;
    expect(isEffectivePostureWeaker(readOnly, { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } })).toBe(true);
    expect(isEffectivePostureWeaker(ask, { approvalPolicy: "untrusted", sandbox: { type: "dangerFullAccess" } })).toBe(true);
  });

  it("reports approvals being disabled outright", () => {
    expect(isEffectivePostureWeaker(ask, { approvalPolicy: "never", sandbox: { type: "workspaceWrite" } })).toBe(true);
  });

  it("stays silent when the posture is equal or STRONGER than asked, and when the echo is unreadable", () => {
    expect(isEffectivePostureWeaker(ask, { approvalPolicy: "untrusted", sandbox: { type: "readOnly" } })).toBe(false);
    const readOnly = findCodexPreset("read-only")!;
    expect(isEffectivePostureWeaker(readOnly, { approvalPolicy: "on-request", sandbox: { type: "readOnly" } })).toBe(false);
    // An unrecognized/absent tier is not comparable — never guess, never warn.
    expect(isEffectivePostureWeaker(readOnly, {})).toBe(false);
    expect(isEffectivePostureWeaker(readOnly, { sandbox: { type: "somethingNew" } })).toBe(false);
  });
});

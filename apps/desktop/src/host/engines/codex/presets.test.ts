/**
 * Pins the frozen Codex permission-preset table (cut §2(d)/§3.8) shape and its
 * consistency with the pre-existing (unchanged) `thread/start` literals in
 * `createNativeCodexSession` (codex-engine.ts) — the "ask" preset must match
 * today's actual default behavior exactly, so adopting the table later is a
 * pure refactor, never a behavior change.
 */

import { describe, expect, it } from "vitest";
import {
  CODEX_CHILD_ASK_PRESET_ID,
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

describe("Taskana 4682 — tmp-root exclusion", () => {
  it("default keeps the frozen workspaceWrite policy (no exclusion)", () => {
    const ask = findCodexPreset("ask")!.turnOverride("/repo/a");
    expect(ask.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/a"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("excludeTmpRoots: true flips BOTH tmp flags, nothing else", () => {
    const ask = findCodexPreset("ask")!.turnOverride("/repo/a", { excludeTmpRoots: true });
    expect(ask.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/a"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });

  it("approve-for-me honors the option too", () => {
    const approveForMe = findCodexPreset("approve-for-me")!.turnOverride("/repo/b", { excludeTmpRoots: true });
    expect(approveForMe.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/b"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });

  it("full-access ignores the option (no policy object to decorate)", () => {
    const fullAccess = findCodexPreset("full-access")!.turnOverride("/repo/a", { excludeTmpRoots: true });
    expect(fullAccess.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  it("legacy read-only ignores the option (no tmp roots exist)", () => {
    const readOnly = findCodexPreset("read-only")!.turnOverride("/repo/a", { excludeTmpRoots: true });
    expect(readOnly.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("purity: the same preset instance yields independent policies per call", () => {
    const preset = findCodexPreset("ask")!;
    const withExclusion = preset.turnOverride("/repo/a", { excludeTmpRoots: true });
    const withoutExclusion = preset.turnOverride("/repo/a");
    expect(withExclusion.sandboxPolicy).not.toBe(withoutExclusion.sandboxPolicy);
    expect(withExclusion.sandboxPolicy).toMatchObject({ excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    expect(withoutExclusion.sandboxPolicy).toMatchObject({ excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  });
});

describe("Taskana 4682 rework — extraWritableRoot (the child's private temp dir)", () => {
  it("appends the private dir AFTER the workspace, exclusion flags intact — the exact child posture", () => {
    const ask = findCodexPreset("ask")!.turnOverride("/repo/a", {
      excludeTmpRoots: true,
      extraWritableRoot: "/Users/me/.anycode/tmp/child-1",
    });
    expect(ask.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/a", "/Users/me/.anycode/tmp/child-1"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });

  it("approve-for-me honors the extra root too (both workspace-write presets share the builder)", () => {
    const approveForMe = findCodexPreset("approve-for-me")!.turnOverride("/repo/b", {
      excludeTmpRoots: true,
      extraWritableRoot: "/Users/me/.anycode/tmp/child-2",
    });
    expect(approveForMe.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/b", "/Users/me/.anycode/tmp/child-2"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });

  it("the extra root alone (no exclusion) still lands — the opts are independent axes", () => {
    const ask = findCodexPreset("ask")!.turnOverride("/repo/a", { extraWritableRoot: "/tmp-priv" });
    expect(ask.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/a", "/tmp-priv"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("full-access and legacy read-only ignore the extra root (no writableRoots axis exists there)", () => {
    expect(findCodexPreset("full-access")!.turnOverride("/repo/a", { extraWritableRoot: "/tmp-priv" }).sandboxPolicy)
      .toEqual({ type: "dangerFullAccess" });
    expect(findCodexPreset("read-only")!.turnOverride("/repo/a", { extraWritableRoot: "/tmp-priv" }).sandboxPolicy)
      .toEqual({ type: "readOnly", networkAccess: false });
  });

  it("no opts at all keeps the frozen default policy byte-identical (owner tabs)", () => {
    const ask = findCodexPreset("ask")!.turnOverride("/repo/a");
    expect(ask.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/repo/a"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
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

describe("child-ask preset (Taskana 4078 / TASK.179)", () => {
  it("resolves through findCodexPreset and boots untrusted on the same workspace-write sandbox", () => {
    const preset = findCodexPreset(CODEX_CHILD_ASK_PRESET_ID);
    expect(preset).toBeDefined();
    expect(preset!.threadParams).toEqual({ approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" });
  });

  it("turnOverride is a pure function of the workspace — sandbox identical to ask's", () => {
    expect(findCodexPreset(CODEX_CHILD_ASK_PRESET_ID)!.turnOverride("/repo/a")).toEqual({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo/a"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it("is absent from the public menu — the three Codex-menu ids are unchanged", () => {
    expect(codexPresetChoices().map((choice) => choice.id)).not.toContain(CODEX_CHILD_ASK_PRESET_ID);
    expect(CODEX_PERMISSION_PRESETS.map((preset) => preset.id)).toEqual(["ask", "approve-for-me", "full-access"]);
  });

  it("drift check ignores the untrusted -> on-request resume echo (L8)", () => {
    expect(
      isEffectivePostureWeaker(findCodexPreset(CODEX_CHILD_ASK_PRESET_ID)!, {
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite" },
      }),
    ).toBe(false);
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

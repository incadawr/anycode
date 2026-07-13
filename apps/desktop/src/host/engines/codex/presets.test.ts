/**
 * Pins the frozen Codex permission-preset table (cut §2(d)/§3.8) shape and its
 * consistency with the pre-existing (unchanged) `thread/start` literals in
 * `createNativeCodexSession` (codex-engine.ts) — the "ask" preset must match
 * today's actual default behavior exactly, so adopting the table later is a
 * pure refactor, never a behavior change.
 */

import { describe, expect, it } from "vitest";
import { CODEX_PERMISSION_PRESETS, DEFAULT_CODEX_PRESET, findCodexPreset } from "./presets.js";

describe("CODEX_PERMISSION_PRESETS", () => {
  it("carries exactly the three frozen ids, in order", () => {
    expect(CODEX_PERMISSION_PRESETS.map((preset) => preset.id)).toEqual(["read-only", "ask", "workspace"]);
  });

  it("DEFAULT_CODEX_PRESET is a member of the table", () => {
    expect(findCodexPreset(DEFAULT_CODEX_PRESET)).toBeDefined();
  });

  it("the 'ask' preset's thread/start params match the existing createNativeCodexSession literals verbatim", () => {
    const ask = findCodexPreset("ask");
    expect(ask?.threadParams).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
  });

  it("never/danger-full-access are not representable", () => {
    const ids = CODEX_PERMISSION_PRESETS.map((preset) => preset.id);
    expect(ids).not.toContain("never");
    expect(ids).not.toContain("danger-full-access");
    for (const preset of CODEX_PERMISSION_PRESETS) {
      expect(preset.threadParams.sandbox).not.toBe("danger-full-access");
    }
  });

  it("each preset's turnOverride is a pure function of the workspace (no shared mutable state)", () => {
    const workspaceA = findCodexPreset("workspace")!.turnOverride("/repo/a");
    const workspaceB = findCodexPreset("workspace")!.turnOverride("/repo/b");
    expect(workspaceA).toEqual({
      approvalPolicy: "on-request",
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

  it("read-only turnOverride carries no writableRoots at all", () => {
    const readOnly = findCodexPreset("read-only")!.turnOverride("/repo/a");
    expect(readOnly.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("findCodexPreset returns undefined for an unknown id (host-authoritative membership check)", () => {
    expect(findCodexPreset("danger-full-access")).toBeUndefined();
    expect(findCodexPreset("")).toBeUndefined();
  });
});

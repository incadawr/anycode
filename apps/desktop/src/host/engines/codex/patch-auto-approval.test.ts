/**
 * Taskana 4265: the workspace-patch auto-accept policy, over the REAL
 * filesystem — containment is proven by realpath, so every escape attempt
 * (sibling dir, `..`, relative path, symlink, move-out) is exercised against
 * a real tmp tree, not a mocked port.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystemAdapter, SessionPermissionRules } from "@anycode/core";
import {
  isPathProvablyInsideWorkspace,
  patchTargetPaths,
  shouldAutoAcceptPatch,
  type CodexPatchAutoApprovalContext,
} from "./patch-auto-approval.js";

const fs = new NodeFileSystemAdapter();
let WS = "";
let OTHER = "";

/** Realpath-resolved tmp dir (macOS `/var` -> `/private/var` makes raw mkdtemp paths unequal to their real selves). */
async function mkDir(): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "p4265-")));
}

function item(changes: unknown): Record<string, unknown> {
  return { type: "fileChange", id: "item-file", changes };
}

function ctx(over: Partial<CodexPatchAutoApprovalContext> = {}): CodexPatchAutoApprovalContext {
  return {
    fs,
    workspace: WS,
    workspaceWritesAllowed: true,
    rules: null,
    activePresetId: () => "ask",
    ...over,
  };
}

beforeEach(async () => {
  WS = await mkDir();
  OTHER = await mkDir();
  await fsp.writeFile(join(WS, "a.ts"), "a\n", "utf8");
});

afterEach(async () => {
  for (const dir of [WS, OTHER]) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("patchTargetPaths (fail-closed enumeration)", () => {
  it("returns null for undefined / non-fileChange / empty changes", () => {
    expect(patchTargetPaths(undefined)).toBeNull();
    expect(patchTargetPaths({ type: "commandExecution", changes: [] })).toBeNull();
    expect(patchTargetPaths(item([]))).toBeNull();
  });

  it("returns null for an entry without a path", () => {
    expect(patchTargetPaths(item([{ kind: { type: "add" } }]))).toBeNull();
  });

  it("returns null for an unknown top-level key", () => {
    expect(patchTargetPaths(item([{ path: "/a", extra: "x" }]))).toBeNull();
  });

  it("collects move_path alongside the source path", () => {
    expect(patchTargetPaths(item([{ path: "/a", kind: { type: "update", move_path: "/b" } }]))).toEqual(["/a", "/b"]);
  });

  it("collects just the path for a plain add with a diff", () => {
    expect(patchTargetPaths(item([{ path: "/a", kind: { type: "add" }, diff: "+a\n" }]))).toEqual(["/a"]);
  });
});

describe("shouldAutoAcceptPatch — containment over the real fs", () => {
  it("accepts an add of an absent file inside the workspace", async () => {
    await expect(shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "new.ts"), kind: { type: "add" }, diff: "+n" }]), null)).resolves.toBe(true);
  });

  it("accepts an update of an existing file inside the workspace", async () => {
    await expect(shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" }]), null)).resolves.toBe(true);
  });

  it("rejects a target in another tmp dir", async () => {
    await expect(shouldAutoAcceptPatch(ctx(), item([{ path: join(OTHER, "x.ts"), kind: { type: "add" }, diff: "+x" }]), null)).resolves.toBe(false);
  });

  it("rejects a `..` escape", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: `${WS}/../x/f.ts`, kind: { type: "add" }, diff: "+x" }]), null),
    ).resolves.toBe(false);
  });

  it("rejects a relative path (resolveWorkspaceWriteFacts refuses non-absolute)", async () => {
    await expect(shouldAutoAcceptPatch(ctx(), item([{ path: "a.ts", kind: { type: "add" }, diff: "+a" }]), null)).resolves.toBe(false);
  });

  it("rejects a target behind a symlink pointing outside the workspace", async () => {
    await fsp.symlink(OTHER, join(WS, "link"));
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "link", "f.ts"), kind: { type: "add" }, diff: "+f" }]), null),
    ).resolves.toBe(false);
  });

  it("rejects a move_path outside even when the source path is inside", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "a.ts"), kind: { type: "update", move_path: join(OTHER, "b.ts") } }]), null),
    ).resolves.toBe(false);
  });

  // Cross-review M1 (Taskana 4265): core's edit-mode containment widens ONLY
  // Write/Edit (WORKSPACE_WRITE_TOOLS) and Claude's `workspace` tier is
  // acceptEdits — file EDITS; in both, a delete rides an asked Bash instead.
  // Auto-accepting a delete-kind patch would make the codex child the only
  // posture that silently deletes contained files, so it must fall back to ask.
  it("asks for a delete-kind change even inside the workspace", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "a.ts"), kind: { type: "delete" }, diff: "-a" }]), null),
    ).resolves.toBe(false);
  });

  it("review: asks for a rename (update + move_path) even when both ends are inside the workspace", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "a.ts"), kind: { type: "update", move_path: join(WS, "b.ts") } }]), null),
    ).resolves.toBe(false);
    // A null move_path is the plain-update wire shape and still auto-accepts.
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "a.ts"), kind: { type: "update", move_path: null }, diff: "+a" }]), null),
    ).resolves.toBe(true);
  });

  it("asks when ANY change in the patch deletes (mixed add+delete)", async () => {
    await expect(
      shouldAutoAcceptPatch(
        ctx(),
        item([
          { path: join(WS, "new.ts"), kind: { type: "add" }, diff: "+n" },
          { path: join(WS, "a.ts"), kind: { type: "delete" }, diff: "-a" },
        ]),
        null,
      ),
    ).resolves.toBe(false);
  });

  it("asks for a delete even when an always-allow Edit rule would vouch for it", async () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Edit" });
    await expect(
      shouldAutoAcceptPatch(
        ctx({ workspaceWritesAllowed: false, rules }),
        item([{ path: join(WS, "a.ts"), kind: { type: "delete" }, diff: "-a" }]),
        null,
      ),
    ).resolves.toBe(false);
  });

  it("asks when kind.type is not one of the pinned add/update variants", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "a.ts"), kind: { type: "future-kind" }, diff: "x" }]), null),
    ).resolves.toBe(false);
  });

  it("never accepts a grantRoot request", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx(), item([{ path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" }]), "/x"),
    ).resolves.toBe(false);
  });

  it.each(["read-only", "full-access"] as const)("never accepts under preset %s", async (preset) => {
    await expect(
      shouldAutoAcceptPatch(ctx({ activePresetId: () => preset }), item([{ path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" }]), null),
    ).resolves.toBe(false);
  });

  it("accepts under the child-ask preset (4078-on-4265: same workspace-write sandbox)", async () => {
    // The child preset's sandbox IS workspace-write (TASK.179 / Taskana 4078),
    // so a contained patch qualifies exactly like `ask`/`approve-for-me`.
    await expect(
      shouldAutoAcceptPatch(ctx({ activePresetId: () => "child-ask" }), item([{ path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" }]), null),
    ).resolves.toBe(true);
  });

  it("never accepts when no preset is active (activePresetId null)", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx({ activePresetId: () => null }), item([{ path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" }]), null),
    ).resolves.toBe(false);
  });

  it("asks when workspace writes are not allowed and there are no rules", async () => {
    await expect(
      shouldAutoAcceptPatch(ctx({ workspaceWritesAllowed: false }), item([{ path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" }]), null),
    ).resolves.toBe(false);
  });
});

describe("shouldAutoAcceptPatch — always-allow rule fallback", () => {
  it("accepts a contained patch when an Edit rule covers every target", async () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Edit" });
    await expect(
      shouldAutoAcceptPatch(
        ctx({ workspaceWritesAllowed: false, rules }),
        item([
          { path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" },
          { path: join(WS, "b.ts"), kind: { type: "add" }, diff: "+b" },
        ]),
        null,
      ),
    ).resolves.toBe(true);
  });

  it("still refuses an OUT-of-workspace target even with the rule", async () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Edit" });
    await expect(
      shouldAutoAcceptPatch(ctx({ workspaceWritesAllowed: false, rules }), item([{ path: join(OTHER, "x.ts"), kind: { type: "add" }, diff: "+x" }]), null),
    ).resolves.toBe(false);
  });

  it("a Bash-only rule never vouches for a patch", async () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Bash" });
    await expect(
      shouldAutoAcceptPatch(ctx({ workspaceWritesAllowed: false, rules }), item([{ path: join(WS, "a.ts"), kind: { type: "update" }, diff: "+a" }]), null),
    ).resolves.toBe(false);
  });
});

describe("isPathProvablyInsideWorkspace (realpath facts)", () => {
  it("proves containment through a symlinked workspace root", async () => {
    const link = join(OTHER, "ws-link");
    await fsp.symlink(WS, link);
    await expect(isPathProvablyInsideWorkspace(fs, link, join(WS, "a.ts"))).resolves.toBe(true);
    await fsp.rm(link, { force: true });
  });
});

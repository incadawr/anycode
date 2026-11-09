import { describe, expect, it } from "vitest";
import { evaluateManagedStartupTransition, type ManagedStartupTransitionInput } from "./managed-child-startup.js";
import type { ChildWorktreeReceipt } from "./child-worktree-resource.js";

const receipt: ChildWorktreeReceipt = {
  version: 1, id: "r", appRunId: "run", parentSessionId: "parent", childSessionId: "child",
  sourceRoot: "/repo", storageRoot: "/repo", projectRoot: "/repo", baseSha: "a".repeat(40),
  path: "/repo/.anycode/worktrees/child-r", branch: "anycode-wt/child-r", phase: "active", reason: null,
};
// Every path exists as itself, except the explicitly missing ones and one symlink spelling.
const canonical = (path: string): string | null =>
  path.includes("missing") ? null : path.replace("/link/", "/real/");

const input = (overrides: Partial<ManagedStartupTransitionInput> = {}, message: Record<string, unknown> = {}): ManagedStartupTransitionInput => ({
  message: { type: "anycode:worktree-transition", sessionId: "child", fromWorkspace: "/elsewhere", toWorkspace: receipt.path, projectRoot: receipt.path, ...message },
  sessionId: "child", parentSessionId: "parent", tabWorkspace: receipt.path, tabProjectRoot: "/repo",
  receipt, runState: "starting", recoveryUsed: false, parentClosing: false, receiptSettling: false,
  ...overrides,
});

describe("evaluateManagedStartupTransition", () => {
  it("accepts the allocated checkout for a starting run, with the checkout or the project as root", () => {
    expect(evaluateManagedStartupTransition(input(), canonical)).toEqual({ ok: true, target: receipt.path });
    expect(evaluateManagedStartupTransition(input({}, { projectRoot: "/repo" }), canonical)).toEqual({ ok: true, target: receipt.path });
  });

  it("compares canonical paths, so a symlink spelling of the checkout is the same target", () => {
    const linked = { ...receipt, path: "/link/repo/.anycode/worktrees/child-r", storageRoot: "/link/repo" };
    const verdict = evaluateManagedStartupTransition(input({ receipt: linked }, { toWorkspace: "/real/repo/.anycode/worktrees/child-r", projectRoot: "/repo" }), canonical);
    expect(verdict).toEqual({ ok: true, target: linked.path });
  });

  it.each<[string, Partial<ManagedStartupTransitionInput>, Record<string, unknown>]>([
    ["a run that already started", { runState: "running" }, {}],
    ["a cancelling run", { runState: "cancelling" }, {}],
    ["a used recovery", { recoveryUsed: true }, {}],
    ["a closing parent", { parentClosing: true }, {}],
    ["a receipt in cleanup", { receiptSettling: true }, {}],
    ["a missing receipt", { receipt: undefined }, {}],
    ["a retained receipt", { receipt: { ...receipt, phase: "retained" } }, {}],
    ["another session in the message", {}, { sessionId: "other" }],
    ["a receipt of another child", { receipt: { ...receipt, childSessionId: "other" } }, {}],
    ["a receipt of another parent", { parentSessionId: "other" }, {}],
    ["an arbitrary target", {}, { toWorkspace: "/elsewhere/other" }],
    ["a missing target", {}, { toWorkspace: "/repo/.anycode/worktrees/missing" }],
    ["the project root as target", {}, { toWorkspace: "/repo" }],
    ["a host that already runs in the checkout", {}, { fromWorkspace: receipt.path }],
    ["a foreign project root", {}, { projectRoot: "/elsewhere" }],
    ["a carried worktree identity", {}, { worktree: { id: "w", path: receipt.path, branch: "b", baseRef: "main", ownedByAnyCode: true } }],
    ["a carried cleanup intent", {}, { cleanup: { path: "/x", mode: "remove", ownedByAnyCode: true } }],
    ["a receipt outside the managed storage", { receipt: { ...receipt, path: "/repo/other" } }, { toWorkspace: "/repo/other" }],
    ["an empty target", {}, { toWorkspace: "" }],
  ])("refuses %s", (_name, overrides, message) => {
    expect(evaluateManagedStartupTransition(input(overrides, message), canonical)).toMatchObject({ ok: false });
  });

  it("refuses a malformed message", () => {
    expect(evaluateManagedStartupTransition(input({ message: null }), canonical)).toMatchObject({ ok: false });
    expect(evaluateManagedStartupTransition(input({ message: { type: "x", sessionId: 1 } }), canonical)).toMatchObject({ ok: false });
  });
});

/**
 * isWithinWorkspace — lexical workspace-confinement predicate (policy-seed for 5.2).
 * Verifies inside/escape cases plus the prefix-trap hazard and the documented symlink
 * residual (R1): this predicate is purely lexical, so no real symlinks are created here.
 */

import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CONFINED_WRITE_TOOLS,
  isProvablyInsideWorkspace,
  isWithinWorkspace,
} from "./workspace-policy.js";

describe("isWithinWorkspace", () => {
  it("returns true for a nested path inside the workspace root", () => {
    expect(isWithinWorkspace("/ws/a/b", "/ws")).toBe(true);
  });

  it("returns true when the candidate is the workspace root itself", () => {
    expect(isWithinWorkspace("/ws", "/ws")).toBe(true);
  });

  it("resolves a relative candidate against the workspace root", () => {
    expect(isWithinWorkspace("a/b", "/ws")).toBe(true);
  });

  it("returns false for a lexical .. escape via the candidate path", () => {
    expect(isWithinWorkspace("/ws/../etc/passwd", "/ws")).toBe(false);
  });

  it("returns false for an absolute path outside the workspace root", () => {
    expect(isWithinWorkspace("/etc/passwd", "/ws")).toBe(false);
  });

  it("returns false for a relative candidate that traverses above the root", () => {
    expect(isWithinWorkspace("../../x", "/ws")).toBe(false);
  });

  it("returns false for a sibling directory sharing the root as a string prefix", () => {
    // Prefix-trap hazard: "/ws-sibling" starts with "/ws" as a string, but is not
    // nested under it as a path — a naive startsWith("/ws") check would wrongly
    // report this as confined.
    expect(isWithinWorkspace("/ws-sibling/x", "/ws")).toBe(false);
  });

  it("documents the symlink residual (R1): lexical containment is reported even though", () => {
    // no filesystem I/O or symlink resolution occurs here. A path lexically inside the
    // workspace (e.g. "/ws/link") that points, via a symlink, to somewhere outside the
    // workspace (e.g. "/etc") is NOT distinguishable from a genuinely confined path by
    // this predicate — real symlink-escape enforcement is the OS sandbox layer's job
    // (5.2, Seatbelt resolves actual inodes). No symlinks are created on disk for this
    // test; it fixes the *lexical* behavior only.
    expect(isWithinWorkspace("/ws/link", "/ws")).toBe(true);
  });
});

describe("isProvablyInsideWorkspace (Taskana 4294)", () => {
  it("returns false for absent facts (unprovable => fail-closed)", () => {
    expect(isProvablyInsideWorkspace(undefined)).toBe(false);
  });

  it("returns true for a resolved target inside the root", () => {
    expect(isProvablyInsideWorkspace({ root: "/ws", resolvedPath: "/ws/a.ts" })).toBe(true);
  });

  it("returns true when the resolved target IS the root", () => {
    expect(isProvablyInsideWorkspace({ root: "/ws", resolvedPath: "/ws" })).toBe(true);
  });

  it("returns false for a resolved target outside the root", () => {
    expect(isProvablyInsideWorkspace({ root: "/ws", resolvedPath: "/other/a.ts" })).toBe(false);
  });

  it("returns false for a relative root (facts must be absolute real paths)", () => {
    expect(isProvablyInsideWorkspace({ root: "ws", resolvedPath: "/ws/a" })).toBe(false);
  });

  it("returns false for a relative target (isWithinWorkspace would resolve it against the root — a sloppy caller must not get a false inside)", () => {
    expect(isProvablyInsideWorkspace({ root: "/ws", resolvedPath: "a.ts" })).toBe(false);
  });

  it("returns false for a degenerate root: filesystem root", () => {
    expect(isProvablyInsideWorkspace({ root: "/", resolvedPath: "/etc/hosts" })).toBe(false);
  });

  it("returns false for a degenerate root: '//' (resolves to '/')", () => {
    expect(isProvablyInsideWorkspace({ root: "//", resolvedPath: "/etc/hosts" })).toBe(false);
  });

  it("returns false for a degenerate root: '/x/..' (resolves to '/')", () => {
    expect(isProvablyInsideWorkspace({ root: "/x/..", resolvedPath: "/etc/hosts" })).toBe(false);
  });

  it("returns false when the parent repo contains the worktree (target in main checkout, root is the worktree)", () => {
    expect(
      isProvablyInsideWorkspace({ root: "/repo/.anycode/worktrees/x", resolvedPath: "/repo/src/f.ts" }),
    ).toBe(false);
  });

  it("returns true when the root contains the worktree (target inside the worktree)", () => {
    expect(
      isProvablyInsideWorkspace({ root: "/repo", resolvedPath: "/repo/.anycode/worktrees/x/f.ts" }),
    ).toBe(true);
  });

  it("returns false for the sibling-prefix trap (x2 shares the string prefix of x)", () => {
    expect(
      isProvablyInsideWorkspace({
        root: "/repo/.anycode/worktrees/x",
        resolvedPath: "/repo/.anycode/worktrees/x2/f.ts",
      }),
    ).toBe(false);
  });

  it("WORKSPACE_CONFINED_WRITE_TOOLS is exactly Write/Edit/MultiEdit", () => {
    expect([...WORKSPACE_CONFINED_WRITE_TOOLS].sort()).toEqual(["Edit", "MultiEdit", "Write"]);
  });
});

/**
 * isWithinWorkspace — lexical workspace-confinement predicate (policy-seed for 5.2).
 * Verifies inside/escape cases plus the prefix-trap hazard and the documented symlink
 * residual (R1): this predicate is purely lexical, so no real symlinks are created here.
 */

import { describe, expect, it } from "vitest";
import { isWithinWorkspace } from "./workspace-policy.js";

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

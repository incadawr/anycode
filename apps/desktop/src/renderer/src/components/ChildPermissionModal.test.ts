/**
 * GitHub #17 slice E: the parent-window child approval. The
 * dialog itself is a thin React shell over the production helpers tested in
 * `../child-permissions.test.ts`; what is pinned HERE is the identity surface
 * that keeps an old dialog from answering a newer ask and that names the child.
 */
import { describe, expect, it } from "vitest";
import { childPermissionOwnerLabel, childPermissionSubmissionKey } from "../child-permissions.js";

describe("child permission identity (GitHub #17 slice E)", () => {
  it("keys one (child, ask) pair, so two children can share a requestId", () => {
    expect(childPermissionSubmissionKey("tabA", "req-1")).not.toBe(childPermissionSubmissionKey("tabB", "req-1"));
    expect(childPermissionSubmissionKey("tabA", "req-1")).not.toBe(childPermissionSubmissionKey("tabA", "req-2"));
    expect(childPermissionSubmissionKey("tabA", "req-1")).toBe(childPermissionSubmissionKey("tabA", "req-1"));
  });

  it("labels the dialog with the child session it belongs to", () => {
    expect(childPermissionOwnerLabel("child-17")).toBe("Subagent: child-17");
  });
});

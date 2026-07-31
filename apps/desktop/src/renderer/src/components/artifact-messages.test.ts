/**
 * artifact-messages: every refusal reason the artifact IPC can return has to
 * turn into text a user can act on. The reason this exists: a Reveal that the
 * main process blocked used to render as a button that did nothing at all.
 */

import { describe, expect, it } from "vitest";

import { artifactActionFailureMessage, artifactFailureMessage } from "./artifact-messages.js";

/** Every `ok: false` reason the artifact IPC can send (preload's ArtifactActionResult). */
const ACTION_REASONS = ["invalid", "no_workspace", "not_found", "outside_allowed_roots", "not_openable", "io_error"];

describe("artifactActionFailureMessage", () => {
  it("names the containment refusal instead of blaming the file", () => {
    const message = artifactActionFailureMessage("outside_allowed_roots");
    // The file exists; it is the location that is refused — say so, and say where.
    expect(message).toContain("workspace");
    expect(message).not.toContain("not found");
  });

  it("distinguishes a missing file from a blocked location", () => {
    expect(artifactActionFailureMessage("not_found")).not.toBe(
      artifactActionFailureMessage("outside_allowed_roots"),
    );
  });

  it("gives every reason a non-empty message and never leaks the raw code", () => {
    for (const reason of ACTION_REASONS) {
      const message = artifactActionFailureMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(reason);
    }
  });

  it("does not reuse the preview wording — an action failure is not a preview failure", () => {
    expect(artifactActionFailureMessage("outside_allowed_roots")).not.toBe(
      artifactFailureMessage("outside_allowed_roots"),
    );
  });
});

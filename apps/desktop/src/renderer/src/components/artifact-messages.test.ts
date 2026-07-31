/**
 * artifact-messages: every refusal reason the artifact IPC can return has to
 * turn into text a user can act on. The reason this exists: a Reveal that the
 * main process blocked used to render as a button that did nothing at all.
 *
 * TASK.77-A adds `artifactChipState`, the pure state machine behind the
 * blocked-preview chip's "Allow preview" button — it is exercised here
 * because Markdown.tsx (a `.tsx`) is outside this package's vitest include
 * glob (`src/**\/*.test.ts` only, see vitest.config.ts).
 */

import { describe, expect, it } from "vitest";

import {
  artifactActionFailureMessage,
  artifactAllowFailureMessage,
  artifactChipState,
  artifactFailureMessage,
} from "./artifact-messages.js";

/** Every `ok: false` reason the artifact IPC can send (preload's ArtifactActionResult). */
const ACTION_REASONS = [
  "invalid",
  "no_workspace",
  "not_found",
  "outside_allowed_roots",
  "declined",
  "not_openable",
  "io_error",
];

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

describe("artifactFailureMessage", () => {
  it("TASK.77-A frozen copy: the blocked-preview row text is exactly this string", () => {
    expect(artifactFailureMessage("outside_allowed_roots")).toBe("Preview blocked — outside allowed roots");
  });
});

describe("artifactAllowFailureMessage", () => {
  it("has no outside_allowed_roots case — Allow is never refused for being outside (that is its whole purpose)", () => {
    // The frozen ArtifactAllowResult type carries only no_workspace | not_found;
    // an unrecognized/absent reason falls through to the generic default.
    expect(artifactAllowFailureMessage("outside_allowed_roots")).toBe(artifactAllowFailureMessage("bogus"));
  });

  it("gives every real reason a non-empty, distinct message", () => {
    const notFound = artifactAllowFailureMessage("not_found");
    const noWorkspace = artifactAllowFailureMessage("no_workspace");
    expect(notFound.length).toBeGreaterThan(0);
    expect(noWorkspace.length).toBeGreaterThan(0);
    expect(notFound).not.toBe(noWorkspace);
  });
});

describe("artifactChipState", () => {
  it("idle/loading/ready never offer Allow — only the blocked-by-roots refusal does", () => {
    for (const status of ["idle", "loading", "ready"] as const) {
      const chip = artifactChipState(status, undefined, "idle");
      expect(chip).toEqual({ showAllow: false, showOpen: true, showReveal: true, label: "" });
    }
  });

  it("blocked (outside_allowed_roots): shows Allow AND Open AND Reveal — DoD's 'no dead-end chip'", () => {
    const chip = artifactChipState("unavailable", "outside_allowed_roots", "idle");
    expect(chip.showAllow).toBe(true);
    expect(chip.showOpen).toBe(true);
    expect(chip.showReveal).toBe(true);
    expect(chip.label).toBe("Preview blocked — outside allowed roots");
  });

  it("any OTHER unavailable reason never offers Allow (it would not fix that failure)", () => {
    for (const reason of ["not_previewable", "too_large", "no_workspace", "not_found", "io_error"]) {
      const chip = artifactChipState("unavailable", reason, "idle");
      expect(chip.showAllow).toBe(false);
      expect(chip.showOpen).toBe(true);
      expect(chip.showReveal).toBe(true);
      expect(chip.label).toBe(artifactFailureMessage(reason));
    }
  });

  it("a failed Allow attempt keeps offering Allow (retry) and marks the label", () => {
    const chip = artifactChipState("unavailable", "outside_allowed_roots", "failed");
    expect(chip.showAllow).toBe(true);
    expect(chip.label).not.toBe("Preview blocked — outside allowed roots");
    expect(chip.label).toContain("Preview blocked — outside allowed roots");
  });

  it("a pending Allow attempt does not change the base label (caller renders its own busy state on the button)", () => {
    const chip = artifactChipState("unavailable", "outside_allowed_roots", "pending");
    expect(chip.label).toBe("Preview blocked — outside allowed roots");
    expect(chip.showAllow).toBe(true);
  });
});

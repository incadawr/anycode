/**
 * Pure-logic tests for TrustedFoldersSection's exported helpers (Taskana
 * 4739). Same `.test.ts`-only, no-jsdom rationale as TrustedBinariesSection
 * — the section's JSX is never rendered here, only the pure projections
 * (`trustedFolderRows`, `forgetErrorMessage`) the component and its copy
 * read. The renderer is untrusted (S1): the helpers only ever see the rows
 * main's list returned (`{ key, decision, decidedAt }` — never a hash).
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceTrustListResult } from "../../../shared/workspace-trust.js";
import { forgetErrorMessage, trustedFolderRows, trustingLabel } from "./TrustedFoldersSection.js";

const LIST: Extract<WorkspaceTrustListResult, { ok: true }> = {
  ok: true,
  folders: [
    { key: "/work/beta", decision: "trusted", decidedAt: "2026-10-25T01:00:00.000Z" },
    { key: "/work/alpha", decision: "denied", decidedAt: "2026-10-24T02:00:00.000Z" },
    { key: "/work/gamma", decision: "trusted", decidedAt: "2026-10-23T03:00:00.000Z" },
  ],
};

describe("trustedFolderRows", () => {
  it("projects listed folders to display rows sorted by key", () => {
    expect(trustedFolderRows(LIST)).toEqual([
      { key: "/work/alpha", decision: "denied", decidedAt: "2026-10-24T02:00:00.000Z" },
      { key: "/work/beta", decision: "trusted", decidedAt: "2026-10-25T01:00:00.000Z" },
      { key: "/work/gamma", decision: "trusted", decidedAt: "2026-10-23T03:00:00.000Z" },
    ]);
  });

  it("passes the row through unchanged (no hash field exists to leak)", () => {
    const rows = trustedFolderRows(LIST);
    expect(JSON.stringify(rows)).not.toContain("hash");
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["decidedAt", "decision", "key"]);
    }
  });

  it("an empty list renders an empty row array (muted empty state)", () => {
    expect(trustedFolderRows({ ok: true, folders: [] })).toEqual([]);
  });

  it("a failed read renders an empty row array, never a throw", () => {
    expect(trustedFolderRows({ ok: false, reason: "read_failed" })).toEqual([]);
  });

  it("trustingLabel maps stored decisions to display labels", () => {
    expect(trustingLabel("trusted")).toBe("Trusted");
    expect(trustingLabel("denied")).toBe("Denied");
  });
});

describe("forgetErrorMessage", () => {
  it("maps every refusal reason to actionable copy", () => {
    expect(forgetErrorMessage("invalid")).toContain("That entry is no longer valid");
    expect(forgetErrorMessage("not_found")).toContain("already gone");
    expect(forgetErrorMessage("write_failed")).toContain("could not be saved");
  });

  it("never suggests re-typing or constructing a path (S1: key comes only from main's list)", () => {
    for (const reason of ["invalid", "not_found", "write_failed"] as const) {
      const message = forgetErrorMessage(reason);
      expect(message.toLowerCase()).not.toContain("path");
    }
  });
});

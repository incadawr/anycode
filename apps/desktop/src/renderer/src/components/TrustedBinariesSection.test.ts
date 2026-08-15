/**
 * Pure-logic tests for TrustedBinariesSection's exported helper (TASK.103,
 * CUT-S4.md §6c BU3). Same `.test.ts`-only, no-jsdom rationale as every
 * other component test in this directory — the section's own JSX is never
 * rendered here, only `trustedBinaryRows`, the pure projection both the
 * component and (indirectly, through the store) the automation facade read.
 */
import { describe, expect, it } from "vitest";
import type { AnycodeSettings } from "../../../shared/settings.js";
import { trustedBinaryRows } from "./TrustedBinariesSection.js";

function security(trustedBinaries?: AnycodeSettings["security"]["trustedBinaries"]): Pick<AnycodeSettings, "security"> {
  return { security: { allowWeakSecretStorage: false, trustedBinaries } };
}

describe("trustedBinaryRows", () => {
  it("BU3 projects consents to path + grantedAt rows, dropping the fingerprint", () => {
    const settings = security([
      { path: "/opt/codex", fingerprint: { mode: 0o755, uid: 501, gid: 20, size: 42, mtimeMs: 1000 }, grantedAt: "2026-08-15T00:00:00.000Z" },
      { path: "/opt/claude", fingerprint: { mode: 0o755, uid: 501, gid: 20, size: 84, mtimeMs: 2000 }, grantedAt: "2026-08-14T00:00:00.000Z" },
    ]);
    expect(trustedBinaryRows(settings)).toEqual([
      { path: "/opt/codex", grantedAt: "2026-08-15T00:00:00.000Z" },
      { path: "/opt/claude", grantedAt: "2026-08-14T00:00:00.000Z" },
    ]);
  });

  it("BU3 an absent trustedBinaries field renders an empty list", () => {
    expect(trustedBinaryRows(security(undefined))).toEqual([]);
  });

  it("BU3 an empty trustedBinaries array renders an empty list", () => {
    expect(trustedBinaryRows(security([]))).toEqual([]);
  });

  it("BU3 an undefined settings object (pre-load) renders an empty list, not a throw", () => {
    expect(trustedBinaryRows(undefined)).toEqual([]);
  });
});

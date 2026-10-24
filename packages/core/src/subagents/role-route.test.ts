/**
 * Role-route notice text (Taskana 4729). The strings are model-visible and
 * the N3 runner notice must stay byte-identical, so the exact shapes are pinned.
 */

import { describe, expect, it } from "vitest";
import { formatRoleDegradeNotice, formatRoleFallbackNotice } from "./role-route.js";

describe("formatRoleDegradeNotice", () => {
  it("lists every skip reason, joined by '; '", () => {
    expect(
      formatRoleDegradeNotice("executor", [
        { entry: { model: "m1" }, reason: "r1" },
        { entry: { model: "m2" }, reason: "r2" },
      ]),
    ).toBe(`Agent: role "executor" ran on the parent's model (every route entry is unhealthy: r1; r2)`);
  });

  it("omits the colon suffix when there are no reasons", () => {
    expect(formatRoleDegradeNotice("planner", [])).toBe(
      `Agent: role "planner" ran on the parent's model (every route entry is unhealthy)`,
    );
  });
});

describe("formatRoleFallbackNotice", () => {
  it("names the skip reasons and the healthy entry that ran instead", () => {
    expect(formatRoleFallbackNotice("reviewer", [{ entry: { engine: "claude" }, reason: "cooling down" }])).toBe(
      'Agent: role "reviewer" skipped its primary route entry (cooling down); running on the next healthy entry',
    );
  });

  it("omits the parenthetical when there are no reasons", () => {
    expect(formatRoleFallbackNotice("reviewer", [])).toBe(
      'Agent: role "reviewer" skipped its primary route entry; running on the next healthy entry',
    );
  });
});

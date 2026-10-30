import { describe, expect, it } from "vitest";
// @ts-expect-error node smoke helper is deliberately JavaScript
import { checkAutoMerged, checkPinned, checkSplitClick, checkSplitPreconditions, expectedSplitPredicate } from "../../scripts/dock-squash-smoke-assertions.mjs";

/**
 * Unit coverage for `dock-squash-smoke.mjs`'s --split leg verdicts — the
 * shapes mirror the facade contract exactly (`renderer/src/automation.ts`
 * dockTabSplit/dockLayoutState, pinned by automation.test.ts), so this test
 * pins the LIVE smoke's own judgement logic: which split answers are green,
 * which are red, and which are the documented expected refusal. The old leg
 * hard-asserted `split.ok === true` and aborted the whole smoke on
 * split_refused with no branch for it.
 */

function state(overrides = {}) {
  return {
    mounted: true,
    mode: "column",
    width: 640,
    conversationWidth: 900,
    tabs: [
      { id: "preview:md", kind: "preview", title: "doc.md", active: false },
      { id: "preview:web", kind: "preview", title: "page", active: true },
      { id: "git", kind: "git", title: "Review", active: false },
    ],
    split: null,
    ...overrides,
  };
}

describe("dock-squash-smoke assertions — checkSplitClick", () => {
  it("accepts an ok click", () => {
    expect(checkSplitClick({ ok: true })).toEqual({ status: "PASS", label: "split right → split pinned", detail: "" });
  });

  it("records split_refused as the documented expected refusal, still a counted row", () => {
    const verdict = checkSplitClick({ ok: false, reason: "split_refused" });
    expect(verdict.status).toBe("PASS");
    expect(verdict.label).toContain("split refused (expected");
    expect(verdict.detail).toContain("split_refused");
  });

  it("fails on tab_not_present — a wiring defect the smoke must not swallow", () => {
    const verdict = checkSplitClick({ ok: false, reason: "tab_not_present" });
    expect(verdict.status).toBe("FAIL");
  });

  it("fails on a missing/unknown reason", () => {
    expect(checkSplitClick(undefined).status).toBe("FAIL");
    expect(checkSplitClick({ ok: false }).status).toBe("FAIL");
    expect(checkSplitClick({ ok: false, reason: 7 }).status).toBe("FAIL");
  });
});

describe("dock-squash-smoke assertions — expectedSplitPredicate pairs with the click", () => {
  it("an ok click waits for a pinned string", () => {
    const predicate = expectedSplitPredicate({ ok: true });
    expect(predicate(state({ split: "git" }))).toBe(true);
    expect(predicate(state({ split: null }))).toBe(false);
  });

  it("a refused click waits for split:null — no stale pin", () => {
    const predicate = expectedSplitPredicate({ ok: false, reason: "split_refused" });
    expect(predicate(state({ split: null }))).toBe(true);
    expect(predicate(state({ split: "git" }))).toBe(false);
  });

  it("a malformed click body matches nothing (the wait fails loudly)", () => {
    expect(expectedSplitPredicate(undefined)(state({ split: null }))).toBe(false);
  });
});

describe("dock-squash-smoke assertions — checkPinned", () => {
  it("an ok click with a pinned string passes", () => {
    const verdict = checkPinned({ ok: true }, state({ split: "git" }));
    expect(verdict.status).toBe("PASS");
    expect(verdict.label).toContain("split pinned");
  });

  it("an ok click that never pinned FAILS (ok-then-stuck)", () => {
    expect(checkPinned({ ok: true }, state({ split: null })).status).toBe("FAIL");
  });

  it("a refused click with split:null passes under the refusal label", () => {
    const verdict = checkPinned({ ok: false, reason: "split_refused" }, state({ split: null }));
    expect(verdict.status).toBe("PASS");
    expect(verdict.label).toContain("no stale pin");
  });

  it("a refused click that somehow pinned FAILS (refused-then-pinned)", () => {
    expect(checkPinned({ ok: false, reason: "split_refused" }, state({ split: "git" })).status).toBe("FAIL");
  });
});

describe("dock-squash-smoke assertions — checkAutoMerged", () => {
  it("split:null at 900px passes regardless of how the click went", () => {
    expect(checkAutoMerged(state({ split: null })).status).toBe("PASS");
  });

  it("a surviving pin at 900px fails", () => {
    expect(checkAutoMerged(state({ split: "git" })).status).toBe("FAIL");
  });
});

describe("dock-squash-smoke assertions — checkSplitPreconditions (the leg's premise, made explicit)", () => {
  it("green when the pin target is present and not the active primary", () => {
    const verdict = checkSplitPreconditions(state(), "git");
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("preview:web");
  });

  it("refuses when the pin target IS the active primary (the old step's hidden defect)", () => {
    const verdict = checkSplitPreconditions(state({ tabs: state().tabs.map((t) => ({ ...t, active: t.id === "git" })) }), "git");
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("active primary");
  });

  it("refuses when the pin target is missing", () => {
    const verdict = checkSplitPreconditions(state({ tabs: [] }), "git");
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("not present");
  });

  it("refuses when no tab is active at all (the premise is undefined)", () => {
    const verdict = checkSplitPreconditions(state({ tabs: state().tabs.map((t) => ({ ...t, active: false })) }), "git");
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("no active tab");
  });
});

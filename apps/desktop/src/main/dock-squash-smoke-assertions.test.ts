import { describe, expect, it } from "vitest";
// @ts-expect-error node smoke helper is deliberately JavaScript
import { checkAutoMerged, checkPinned, checkSplitPreconditions, checkSplitRetryOutcome, classifySplitClick, expectedSplitPredicate } from "../../scripts/dock-squash-smoke-assertions.mjs";

/**
 * Unit coverage for `dock-squash-smoke.mjs`'s --split leg verdicts — the
 * shapes mirror the facade contract exactly (`renderer/src/automation.ts`
 * dockTabSplit/dockLayoutState, pinned by automation.test.ts), so this test
 * pins the LIVE smoke's own judgement logic. The review 4839 follow-up made
 * the retry policy explicit: a split_refused is retried (browser-tab click →
 * precondition wait → split click, bounded attempts) and only a refusal that
 * persists with preconditions held is a FAIL — an always-refusing facade must
 * never read ALL GREEN. A refusal is PASS-expected only when the precondition
 * wait never held.
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

const REFUSED = { ok: false, reason: "split_refused" };

describe("dock-squash-smoke assertions — classifySplitClick", () => {
  it("classifies an ok click as pinned", () => {
    expect(classifySplitClick({ ok: true })).toBe("pinned");
  });

  it("classifies split_refused as refused", () => {
    expect(classifySplitClick(REFUSED)).toBe("refused");
  });

  it("classifies tab_not_present, missing and unknown reasons as failed", () => {
    expect(classifySplitClick({ ok: false, reason: "tab_not_present" })).toBe("failed");
    expect(classifySplitClick(undefined)).toBe("failed");
    expect(classifySplitClick({ ok: false })).toBe("failed");
    expect(classifySplitClick({ ok: false, reason: 7 })).toBe("failed");
  });
});

describe("dock-squash-smoke assertions — checkSplitRetryOutcome (the review 4839 fix)", () => {
  it("an ok click on the first attempt passes", () => {
    const verdict = checkSplitRetryOutcome([{ preconditionsOk: true, click: { ok: true } }]);
    expect(verdict.status).toBe("PASS");
    expect(verdict.label).toContain("split pinned");
  });

  it("a transient refusal then a pin passes — the retry exists for exactly this", () => {
    const verdict = checkSplitRetryOutcome([
      { preconditionsOk: true, click: REFUSED },
      { preconditionsOk: true, click: { ok: true } },
    ]);
    expect(verdict.status).toBe("PASS");
    expect(verdict.detail).toContain("attempt 2/2");
    expect(verdict.detail).toContain("transient refusal");
  });

  it("an always-refusing facade with preconditions met FAILS — never ALL GREEN with split broken", () => {
    const verdict = checkSplitRetryOutcome([
      { preconditionsOk: true, click: REFUSED },
      { preconditionsOk: true, click: REFUSED },
      { preconditionsOk: true, click: REFUSED },
    ]);
    expect(verdict.status).toBe("FAIL");
    expect(verdict.detail).toContain("split_refused on all 3 attempt(s)");
    expect(verdict.detail).toContain("preconditions held");
  });

  it("a refusal is PASS-expected only when preconditions never held", () => {
    const verdict = checkSplitRetryOutcome([
      { preconditionsOk: false, click: REFUSED },
      { preconditionsOk: false, click: REFUSED },
      { preconditionsOk: false, click: REFUSED },
    ]);
    expect(verdict.status).toBe("PASS");
    expect(verdict.label).toContain("split refused (expected");
    expect(verdict.detail).toContain("precondition wait never held");
  });

  it("preconditions held on ANY attempt makes an all-refused run FAIL (the premise did hold)", () => {
    const verdict = checkSplitRetryOutcome([
      { preconditionsOk: false, click: REFUSED },
      { preconditionsOk: true, click: REFUSED },
    ]);
    expect(verdict.status).toBe("FAIL");
  });

  it("a tab_not_present click fails immediately even after a pinless refusal", () => {
    const verdict = checkSplitRetryOutcome([
      { preconditionsOk: true, click: REFUSED },
      { preconditionsOk: true, click: { ok: false, reason: "tab_not_present" } },
    ]);
    expect(verdict.status).toBe("FAIL");
    expect(verdict.detail).toContain("tab_not_present");
  });

  it("a malformed click body fails", () => {
    expect(checkSplitRetryOutcome([{ preconditionsOk: true, click: undefined }]).status).toBe("FAIL");
    expect(checkSplitRetryOutcome([]).status).toBe("FAIL");
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
